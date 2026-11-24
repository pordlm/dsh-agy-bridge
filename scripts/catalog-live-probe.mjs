/**
 * Live catalog probe for Round 3 verification.
 * Note on sharedDiff: `isAuthOrConfigPath` uses exclusion-based filtering (excluding `brain/**`,
 * `*.log`, `*.db-wal`, `*.db-shm`, etc.), so `sharedDiff` has false negatives for excluded runtime
 * paths and cannot alone prove the shared gemini dir was untouched. Default `AGY_GEMINI_DIR`
 * points to the shared `agy-data` dir (copied to a temp dir before spawning `agy`). Read-only proof
 * requires combining `promptCount === 0` + unchanged `native-sessions.json` (content & mtime) +
 * running on a temporary `gemini-dir` copy; `sharedDiff`/`sharedDiffRaw` are auxiliary signals only.
 * Prints model id list, per-model effort probe elapsedMs, degraded entries, and carbon=yes/no.
 */

import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AcpStdioTransport } from '../lib/model-adapter.js'
import { discoverCatalog } from '../lib/model-catalog.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const defaultExe = join(repoRoot, 'desktop-staging', 'verification', 'official-cli', 'agy.exe')
const defaultGeminiDir = join(repoRoot, 'desktop-staging', 'verification', 'agy-data')

const agyExecutable = process.env.AGY_EXECUTABLE || defaultExe
const sharedGeminiDir = process.env.AGY_GEMINI_DIR || defaultGeminiDir
const cwd = process.env.AGY_CWD || repoRoot

function snapshotDir(rootDir) {
  const out = new Map()
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        const st = statSync(full)
        out.set(relative(rootDir, full), { size: st.size, mtimeMs: st.mtimeMs })
      }
    }
  }
  walk(rootDir)
  return out
}

/**
 * 判定路径是否属于共享认证/配置类文件。
 * 规则：仅包含认证与配置类文件（如 settings.json、oauth_creds.json、installation_id 及非运行时 json）；
 * 排除 agy / CLI 运行时产物（brain/**、conversations/*.db-wal/.db-shm、*.log、*.db-wal、*.db-shm、*-wal、*-shm、*.tmp），
 * 因为正在运行的会话必然写运行时日志与 WAL，这不等于修改共享认证或配置。
 */
function isAuthOrConfigPath(relPath) {
  const norm = relPath.replace(/\\/g, '/')
  if (/(^|\/)brain\//i.test(norm)) return false
  if (/\.(log|tmp|db-wal|db-shm)$/i.test(norm) || /-(wal|shm)$/i.test(norm)) return false
  return /(^|\/)(settings\.json|oauth_creds\.json|installation_id|[^/]+\.json)$/i.test(norm) || !norm.includes('/')
}

function diffSnapshots(before, after) {
  const diff = []
  for (const [p, s] of after) {
    const prev = before.get(p)
    if (!prev) diff.push({ path: p, change: 'added' })
    else if (prev.size !== s.size || prev.mtimeMs !== s.mtimeMs) diff.push({ path: p, change: 'modified' })
  }
  for (const p of before.keys()) {
    if (!after.has(p)) diff.push({ path: p, change: 'removed' })
  }
  return diff
}

async function main() {
  if (!existsSync(agyExecutable)) {
    console.log(JSON.stringify({ status: 'BLOCKED', code: 'ENOENT', message: `agyExecutable not found: ${agyExecutable}`, carbon: 'no', promptCount: 0, sharedDiff: [] }, null, 2))
    process.exitCode = 1
    return
  }
  if (!existsSync(sharedGeminiDir)) {
    console.log(JSON.stringify({ status: 'BLOCKED', code: 'ENOENT', message: `agy-data not found: ${sharedGeminiDir}`, carbon: 'no', promptCount: 0, sharedDiff: [] }, null, 2))
    process.exitCode = 1
    return
  }
  const sharedBefore = snapshotDir(sharedGeminiDir)
  const tempDir = mkdtempSync(join(process.env.TEMP || tmpdir(), 'agy-cat-live-'))
  const geminiDir = join(tempDir, 'login-copy')
  cpSync(sharedGeminiDir, geminiDir, { recursive: true })
  const transport = new AcpStdioTransport({
    agyExecutable,
    agyArgs: ['acp', '--gemini-dir', geminiDir],
    cwd,
  })
  let promptCount = 0
  const origRequest = transport.request.bind(transport)
  transport.request = (method, params, opts) => {
    if (method === 'session/prompt') promptCount += 1
    return origRequest(method, params, opts)
  }
  try {
    const snapshot = await discoverCatalog(transport, cwd, {
      timeoutMs: 30_000,
      perModelTimeoutMs: 6000,
      logger: console,
    })
    const ids = snapshot.entries.map((e) => e.id)
    const hasCarbon = ids.some((id) => /carbon/i.test(id))
    const sharedDiffRaw = diffSnapshots(sharedBefore, snapshotDir(sharedGeminiDir))
    const sharedDiff = sharedDiffRaw.filter((item) => isAuthOrConfigPath(item.path))
    const sharedStatus = sharedDiff.length === 0 ? 'UNCHANGED' : 'CHANGED'
    console.log(JSON.stringify({
      status: 'OK',
      discoveredAt: snapshot.discoveredAt,
      elapsedMs: snapshot.elapsedMs,
      promptCount,
      sharedDiff,
      sharedDiffRaw,
      sharedStatus,
      modelIds: ids,
      perModelProbeMs: snapshot.entries.map((e) => ({ id: e.id, probeMs: e.probeMs ?? null, efforts: e.efforts?.map((x) => x.id) ?? [], degraded: Boolean(e.degraded) })),
      degraded: snapshot.degraded ?? [],
      carbon: hasCarbon ? 'yes' : 'no',
    }, null, 2))
  } catch (error) {
    const code = error?.code || 'PROBE_FAILED'
    const message = String(error?.message ?? error)
    const blocked = /EACCES|EPERM|ENOENT|SPAWN_FAILED/i.test(`${code} ${message}`)
    const sharedDiffRaw = diffSnapshots(sharedBefore, snapshotDir(sharedGeminiDir))
    const sharedDiff = sharedDiffRaw.filter((item) => isAuthOrConfigPath(item.path))
    const sharedStatus = sharedDiff.length === 0 ? 'UNCHANGED' : 'CHANGED'
    console.log(JSON.stringify({
      status: blocked ? 'BLOCKED' : 'FAILED',
      code,
      message,
      promptCount,
      sharedDiff,
      sharedDiffRaw,
      sharedStatus,
      carbon: 'no',
    }, null, 2))
    process.exitCode = 1
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

await main()
