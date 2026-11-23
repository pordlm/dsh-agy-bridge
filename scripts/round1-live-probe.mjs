import { accessSync, constants, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { defaultConfig } from '../lib/bridge.js'
import { AcpClient } from '../lib/acp.js'
import { resolveHostWorkspace } from '../lib/workspace.js'
import { createProbeHandler } from './fs-probe-handler.mjs'

const root = resolve('D:/lnu-seat')
const out = resolve(root, 'antigravity-bridge/results')
const sharedData = resolve(root, 'antigravity-bridge/desktop-staging/verification/agy-data')
const output = resolve(out, 'round2-live-probe.json')

export function parseProbeArgs(args) {
  let geminiDir
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const value = arg === '--gemini-dir' ? args[++i] : arg.startsWith('--gemini-dir=') ? arg.slice(13) : undefined
    if (value === undefined || value === '' || value.startsWith('--')) throw Object.assign(Error('probe_arguments_invalid: expected --gemini-dir <absolute existing writable directory>'), { code: 'probe_arguments_invalid' })
    if (geminiDir !== undefined) throw Object.assign(Error('probe_arguments_invalid: duplicate --gemini-dir'), { code: 'probe_arguments_invalid' })
    if (!isAbsolute(value)) throw Object.assign(Error('probe_data_invalid: --gemini-dir must be absolute'), { code: 'probe_data_invalid' })
    try {
      geminiDir = realpathSync(value)
      if (!statSync(geminiDir).isDirectory()) throw Error('not a directory')
      accessSync(geminiDir, constants.R_OK | constants.W_OK | constants.X_OK)
    } catch (error) {
      throw Object.assign(Error(`probe_data_unavailable: ${value}: ${error.message}`), { code: 'probe_data_unavailable' })
    }
    // Never resume writing shared verification or deployed/profile state, even via a junction.
    for (const forbidden of ['antigravity-bridge/desktop-staging', 'antigravity-bridge/dist', 'antigravity-bridge/local-probes', 'antigravity-bridge/model-staging', 'antigravity-bridge/web-staging', 'D:/dsh-home']) {
      const rel = relative(resolve(root, forbidden), geminiDir)
      if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw Object.assign(Error('probe_data_forbidden: shared/deployed data directory is not a probe destination'), { code: 'probe_data_forbidden' })
    }
  }
  // Omit --gemini-dir by default: an empty newly created directory has no login state.
  // The captain explicitly authorized CLI-owned default session/log side effects for this probe.
  // A prepared, separately authorized copy may be passed explicitly; never silently fall back.
  return geminiDir
}

function snapshot(dir) {
  const files = []
  function walk(folder) {
    for (const item of readdirSync(folder, { withFileTypes: true })) {
      const path = resolve(folder, item.name)
      if (item.isSymbolicLink()) throw Error(`snapshot_symlink: ${path}`)
      if (item.isDirectory()) walk(path)
      else {
        const info = statSync(path)
        files.push({ path: relative(dir, path), size: info.size, mtimeMs: info.mtimeMs })
      }
    }
  }
  walk(dir)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}
function compare(before, after) {
  const old = new Map(before.map((item) => [item.path, item]))
  const current = new Map(after.map((item) => [item.path, item]))
  return {
    added: after.filter((item) => !old.has(item.path)),
    removed: before.filter((item) => !current.has(item.path)),
    changed: after.filter((item) => old.has(item.path) && (old.get(item.path).size !== item.size || old.get(item.path).mtimeMs !== item.mtimeMs)),
  }
}

export async function runProbe(args = process.argv.slice(2)) {
  // Validate BEFORE spawning ACP or touching any evidence/output file.
  const geminiDir = parseProbeArgs(args)
  let previousAttempt
  try {
    const previous = JSON.parse(readFileSync(output, 'utf8'))
    if (previous.error) previousAttempt = { startedAt: previous.startedAt, finishedAt: previous.finishedAt, dataMode: previous.dataMode, geminiDir: previous.geminiDir, error: previous.error, sharedDiff: previous.sharedDiff }
  } catch {}
  const trace = []
  const logger = Object.fromEntries(['info', 'warn', 'error'].map((level) => [level, (...values) => trace.push(values.join(' '))]))
  const config = defaultConfig({
    cwd: root, permissionPolicy: 'allow_once',
    agyExecutable: resolve(root, 'antigravity-bridge/desktop-staging/verification/official-cli/agy.exe'),
    agyArgs: ['acp', ...(geminiDir ? ['--gemini-dir', geminiDir] : [])],
  })
  const evidence = { startedAt: new Date().toISOString(), cli: config.agyExecutable, args: config.agyArgs, dataMode: geminiDir ? 'explicit-authorized-directory' : 'cli-user-default', geminiDir: geminiDir ?? null, baseline: 'round1-live-probe.json (fs=false Bridge job and first fs=true observation)', sharedData, sharedBefore: snapshot(sharedData), fsTrue: { events: [], requests: [] } }
  if (previousAttempt) evidence.previousAttempt = previousAttempt
  const probe = new AcpClient({ ...config, fsProbeHandler: createProbeHandler(), onFsRequest: (event) => evidence.fsTrue.events.push(event) }, logger)
  const send = probe.write.bind(probe)
  probe.write = (message) => { if (['initialize', 'session/new'].includes(message.method)) evidence.fsTrue.requests.push(message); return send(message) }
  const deadline = setTimeout(() => probe.close(), 240000)
  try {
    const workspaceRoot = resolveHostWorkspace({ workingDirectory: { get: (session) => session.workspace } }, { session: { workspace: root } }, config)
    evidence.fsTrue.capabilities = await probe.ready()
    const session = await probe.createSession({ cwd: workspaceRoot })
    evidence.fsTrue.sessionId = session.sessionId
    evidence.fsTrue.workspaceRoot = workspaceRoot
    await probe.setConfigOption(session.sessionId, 'model', 'gemini-4-hydrogen')
    await probe.setConfigOption(session.sessionId, 'thought_level', 'medium')
    evidence.fsTrue.answer = await probe.promptSession({ sessionId: session.sessionId, prompt: [{ type: 'text', text: `Use tools to read first line of ${resolve(root, 'antigravity-bridge/PLAN.md')}; then write exactly round2-fs-true-ok to ${output}. If client fs/read_text_file and fs/write_text_file are available please use them. Reply which tools were used and the exact first line. Only modify that one output file.` }] })
    evidence.fsTrue.file = readFileSync(output, 'utf8')
    if (evidence.fsTrue.file !== 'round2-fs-true-ok') throw Error('probe_disk_mismatch: native write did not match expected marker')
    evidence.nativeDiskVerified = true
  } catch (error) {
    evidence.error = { code: error.code, message: error.message, stack: error.stack }
    process.exitCode = 1
  } finally {
    clearTimeout(deadline)
    probe.close()
    evidence.sharedAfter = snapshot(sharedData)
    evidence.sharedDiff = compare(evidence.sharedBefore, evidence.sharedAfter)
    evidence.finishedAt = new Date().toISOString()
    evidence.trace = trace
    // The native marker was independently read above; replace it with complete structured evidence.
    writeFileSync(output, JSON.stringify(evidence, null, 2))
    console.log(JSON.stringify(evidence, null, 2))
  }
  return evidence
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runProbe().catch((error) => { console.error(`${error.code ?? 'probe_failed'}: ${error.message}`); process.exitCode = 1 })
}
