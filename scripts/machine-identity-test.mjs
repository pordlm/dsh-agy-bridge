import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Bridge, defaultConfig } from '../lib/bridge.js'
import { DesktopChannel } from '../lib/desktop.js'
import { getMachineId, isValidUuidV4, quarantineFile, readMachineId, stampMachineId } from '../lib/machine-identity.js'
import { AcpStdioTransport, AgyAcpAdapter } from '../lib/model-adapter.js'
import { AntigravityBridgeService } from '../lib/web-remote.js'

const __dirname = resolve(fileURLToPath(new URL('.', import.meta.url)))
const PKG_ROOT = resolve(__dirname, '..')

function makeTempDir(prefix = 'r36-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

test('1) machine identity is stable, valid uuid v4, rebuilds after delete, and quarantines corrupt machine.json', () => {
  const dir = makeTempDir('r36-id-')
  try {
    const id1 = getMachineId(dir)
    const id2 = getMachineId(dir)
    assert.equal(id1, id2)
    assert.equal(isValidUuidV4(id1), true)
    const raw = JSON.parse(readFileSync(join(dir, 'machine.json'), 'utf8'))
    assert.equal(raw.id, id1)
    assert.equal(typeof raw.createdAt, 'string')

    rmSync(join(dir, 'machine.json'))
    const id3 = getMachineId(dir)
    assert.equal(isValidUuidV4(id3), true)
    assert.notEqual(id3, id1)

    writeFileSync(join(dir, 'machine.json'), '{broken-json', 'utf8')
    const warns = []
    const id4 = getMachineId(dir, { warn: (m) => warns.push(m) })
    assert.equal(isValidUuidV4(id4), true)
    assert.notEqual(id4, id3)
    const corruptFiles = readdirSync(dir).filter((f) => f.startsWith('machine.json.corrupt-'))
    assert.equal(corruptFiles.length, 1)
    assert.ok(warns.some((w) => w.includes('machine_identity_corrupt_quarantined')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('2) foreign state.json is quarantined without deletion and Bridge starts empty', () => {
  const dir = makeTempDir('r36-state-')
  try {
    const stateFile = join(dir, 'state.json')
    writeFileSync(
      stateFile,
      JSON.stringify({
        version: 2,
        machineId: 'other-machine-12345678',
        jobs: { j1: { jobId: 'j1', status: 'queued' } },
        owners: { j1: 's1' },
        locks: { c1: 'j1' },
      }),
      'utf8',
    )
    const warns = []
    const bridge = new Bridge(
      {},
      { ...defaultConfig(), stateFile, backend: { capabilities: async () => ({}) } },
      { warn: (m) => warns.push(m), info: () => {}, error: () => {} },
    )
    assert.deepEqual(bridge.state.jobs, {})
    assert.deepEqual(bridge.state.locks, {})
    assert.equal(existsSync(stateFile), false)
    assert.equal(bridge.quarantined.length, 1)
    assert.equal(bridge.quarantined[0].foreignMachineId, 'other-ma')
    const foreignFiles = readdirSync(dir).filter((f) => f.startsWith('state.foreign-other-ma-') && f.endsWith('.json'))
    assert.equal(foreignFiles.length, 1)
    assert.ok(warns.some((w) => w.includes('state_foreign_machine_quarantined')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('3) legacy state.json without machineId loads normally and stamps machineId on save', () => {
  const dir = makeTempDir('r36-legacy-')
  try {
    const stateFile = join(dir, 'state.json')
    writeFileSync(
      stateFile,
      JSON.stringify({
        version: 2,
        jobs: { j1: { jobId: 'j1', status: 'failed' } },
        owners: { j1: 's1' },
        locks: {},
        workspaces: {},
        legacy: {},
      }),
      'utf8',
    )
    const bridge = new Bridge(
      {},
      { ...defaultConfig(), stateFile, backend: { capabilities: async () => ({}) } },
      { warn: () => {}, info: () => {}, error: () => {} },
    )
    assert.equal(bridge.state.jobs.j1.status, 'failed')
    assert.equal(bridge.quarantined.length, 0)
    assert.equal(bridge.save(), true)
    const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.equal(saved.machineId, bridge.machineId)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('4) foreign desktop-target.json is quarantined and treated as unconfigured', () => {
  const dir = makeTempDir('r36-pin-')
  try {
    const stateFile = join(dir, 'state.json')
    const pinFile = join(dir, 'desktop-target.json')
    writeFileSync(
      pinFile,
      JSON.stringify({
        version: 1,
        machineId: 'foreign-pin-9999',
        pinnedAt: new Date().toISOString(),
        targetKey: 'k1',
        target: { pid: 100, hwnd: '0x10', startedAt: '2026-11-25T00:00:00Z', uri: 'http://localhost' },
      }),
      'utf8',
    )
    const warns = []
    const desktop = new DesktopChannel({
      config: { stateFile, desktop: { enabled: true } },
      logger: { warn: (m) => warns.push(m) },
    })
    assert.equal(desktop.readPin(), null)
    assert.equal(existsSync(pinFile), false)
    const foreignFiles = readdirSync(dir).filter((f) => f.startsWith('desktop-target.foreign-foreign--') && f.endsWith('.json'))
    assert.equal(foreignFiles.length, 1)
    assert.ok(warns.some((w) => w.includes('state_foreign_machine_quarantined')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('5) foreign native-sessions.json is quarantined and adapter starts with empty sessions', async () => {
  const dir = makeTempDir('r36-acp-')
  try {
    const nativeStateFile = join(dir, 'native-sessions.json')
    writeFileSync(
      nativeStateFile,
      JSON.stringify({
        version: 1,
        machineId: 'foreign-acp-7777',
        sessions: { s1: { acpSessionId: 'old-1', history: [] } },
      }),
      'utf8',
    )
    const warns = []
    const adapter = new AgyAcpAdapter({
      cwd: dir,
      nativeStateFile,
      logger: { warn: (m) => warns.push(m) },
    })
    assert.deepEqual(adapter.nativeSessions, {})
    assert.equal(adapter.quarantined.length, 1)
    assert.equal(existsSync(nativeStateFile), false)
    const foreignFiles = readdirSync(dir).filter((f) => f.startsWith('native-sessions.foreign-foreign--') && f.endsWith('.json'))
    assert.equal(foreignFiles.length, 1)
    await adapter.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('6) build-portable --verify-only rejects forbidden state.json and passes on clean package', () => {
  const dirtyDir = makeTempDir('r36-port-dirty-')
  const cleanDir = makeTempDir('r36-port-clean-')
  try {
    for (const dir of [dirtyDir, cleanDir]) {
      mkdirSync(join(dir, 'lib'), { recursive: true })
      writeFileSync(join(dir, 'lib', 'index.js'), 'export {}\n', 'utf8')
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-agy-bridge', version: '0.5.4' }), 'utf8')
    }
    writeFileSync(join(dirtyDir, 'state.json'), '{}', 'utf8')

    let failed = false
    let output = ''
    try {
      execFileSync(process.execPath, [join(PKG_ROOT, 'scripts', 'build-portable.mjs'), '--verify-only', '--root', dirtyDir], {
        encoding: 'utf8',
      })
    } catch (err) {
      failed = true
      output = `${err.stdout || ''}${err.stderr || ''}`
    }
    assert.equal(failed, true)
    assert.ok(output.includes('FORBIDDEN state.json'))

    const cleanOut = execFileSync(
      process.execPath,
      [join(PKG_ROOT, 'scripts', 'build-portable.mjs'), '--verify-only', '--root', cleanDir],
      { encoding: 'utf8' },
    )
    assert.ok(cleanOut.includes('PORTABLE_VERIFY_OK'))
  } finally {
    rmSync(dirtyDir, { recursive: true, force: true })
    rmSync(cleanDir, { recursive: true, force: true })
  }
})

test('7) AcpStdioTransport.close() waits for child exit within 3s and kills lingering process', async () => {
  const dir = makeTempDir('r36-close-')
  try {
    const pidFile = join(dir, 'child.pid')
    const transport = new AcpStdioTransport({
      agyExecutable: 'pwsh',
      agyArgs: ['-NoProfile', '-Command', `$PID | Set-Content -Path '${pidFile.replace(/'/g, "''")}'; Start-Sleep -Seconds 30`],
      cwd: dir,
    })
    transport.start()
    for (let i = 0; i < 40 && !existsSync(pidFile); i += 1) {
      await new Promise((r) => setTimeout(r, 100))
    }
    assert.equal(existsSync(pidFile), true, 'child pid file should be written')
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    assert.ok(Number.isInteger(pid) && pid > 0)

    const t0 = Date.now()
    await transport.close()
    await transport.close() // idempotent
    const elapsed = Date.now() - t0
    assert.ok(elapsed < 4000, `close() took too long: ${elapsed}ms`)

    let alive = true
    try {
      process.kill(pid, 0)
    } catch {
      alive = false
    }
    assert.equal(alive, false, 'child process must be dead after close()')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('8) desktopDetect is strictly read-only and never writes desktop-target.json', async () => {
  const dir = makeTempDir('r36-detect-')
  try {
    const stateFile = join(dir, 'state.json')
    const pinFile = join(dir, 'desktop-target.json')
    const disabledSvc = new AntigravityBridgeService({
      ctx: {},
      bridge: {
        machineId: 'm-1',
        quarantined: [],
        desktop: { enabled: false, capabilities: () => ({ desktop: false, target: null }) },
      },
      config: {},
      adapter: null,
    })
    const disabledRes = await disabledSvc.desktopDetect({ session: { id: 's1' } })
    assert.deepEqual(disabledRes, { ok: true, enabled: false, reason: 'desktop_disabled', candidates: [] })
    assert.equal(existsSync(pinFile), false)

    const enabledSvc = new AntigravityBridgeService({
      ctx: {},
      bridge: {
        machineId: 'm-1',
        quarantined: [],
        desktop: {
          enabled: true,
          capabilities: () => ({ desktop: true, target: null }),
          driver: () => ({
            run: async (payload) => {
              assert.equal(payload.action, 'inspect')
              assert.equal(payload.target, undefined)
              return {
                ok: true,
                candidates: [
                  { pid: 1234, hwnd: '0x99', window: { title: 'Antigravity' }, documentUris: ['http://127.0.0.1'], isForeground: true },
                ],
              }
            },
          }),
        },
      },
      config: {},
      adapter: null,
    })
    const enabledRes = await enabledSvc.desktopDetect({ session: { id: 's1' } })
    assert.equal(enabledRes.ok, true)
    assert.equal(enabledRes.enabled, true)
    assert.equal(enabledRes.candidates.length, 1)
    assert.equal(enabledRes.candidates[0].title, 'Antigravity')
    assert.equal(enabledRes.candidates[0].pid, 1234)
    assert.equal(enabledRes.candidates[0].hwnd, '0x99')
    assert.equal(enabledRes.candidates[0].documentUriCount, 1)
    assert.equal(enabledRes.candidates[0].isForeground, true)
    assert.equal(existsSync(pinFile), false)
    assert.equal(existsSync(stateFile), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('6b) build-portable --verify-only forbids *.tmp in whitelist and prints SKIP_NOT_PACKAGED for top-level non-whitelist dirs', () => {
  const dirA = makeTempDir('r39-port-tmp-')
  const dirB = makeTempDir('r39-port-skip-')
  try {
    for (const dir of [dirA, dirB]) {
      mkdirSync(join(dir, 'lib'), { recursive: true })
      writeFileSync(join(dir, 'lib', 'index.js'), 'export {}\n', 'utf8')
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-agy-bridge', version: '0.5.4' }), 'utf8')
    }
    writeFileSync(join(dirA, 'lib', 'x.tmp'), 'tmp', 'utf8')
    writeFileSync(join(dirA, 'lib', 'machine.json.tmp-999'), 'tmp', 'utf8')

    let failed = false
    let outA = ''
    try {
      execFileSync(process.execPath, [join(PKG_ROOT, 'scripts', 'build-portable.mjs'), '--verify-only', '--root', dirA], {
        encoding: 'utf8',
      })
    } catch (err) {
      failed = true
      outA = `${err.stdout || ''}${err.stderr || ''}`
    }
    assert.equal(failed, true)
    assert.ok(outA.includes('FORBIDDEN lib/x.tmp'))
    assert.ok(outA.includes('FORBIDDEN lib/machine.json.tmp-999'))

    mkdirSync(join(dirB, 'results'), { recursive: true })
    mkdirSync(join(dirB, 'tmp-xyz'), { recursive: true })
    mkdirSync(join(dirB, 'node_modules'), { recursive: true })
    const outB = execFileSync(
      process.execPath,
      [join(PKG_ROOT, 'scripts', 'build-portable.mjs'), '--verify-only', '--root', dirB],
      { encoding: 'utf8' },
    )
    assert.ok(outB.includes('SKIP_NOT_PACKAGED results'))
    assert.ok(outB.includes('SKIP_NOT_PACKAGED tmp-xyz'))
    assert.ok(outB.includes('SKIP_NOT_PACKAGED node_modules'))
    assert.ok(outB.includes('PORTABLE_VERIFY_OK'))
  } finally {
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  }
})

test('9) capabilities() merges, deduplicates, and sorts quarantined entries from bridge, desktop, and adapter', async () => {
  const svc = new AntigravityBridgeService({
    ctx: {},
    bridge: {
      machineId: 'm-1',
      quarantined: [
        { file: 'state.json', renamedTo: 'state.foreign-1.json', foreignMachineId: '11111111', at: '2026-11-25T10:00:03.000Z' },
      ],
      desktop: {
        enabled: false,
        capabilities: () => ({ desktop: false, target: null, models: [], efforts: [], attachments: {}, evidence: '' }),
        quarantined: [
          { file: 'desktop-target.json', renamedTo: 'desktop-target.foreign-2.json', foreignMachineId: '22222222', at: '2026-11-25T10:00:01.000Z' },
          { file: 'state.json', renamedTo: 'state.foreign-1.json', foreignMachineId: '11111111', at: '2026-11-25T10:00:03.000Z' },
        ],
      },
    },
    config: { models: ['m1'], efforts: ['medium'] },
    adapter: {
      quarantined: [
        { file: 'native-sessions.json', renamedTo: 'native-sessions.foreign-3.json', foreignMachineId: '33333333', at: '2026-11-25T10:00:02.000Z' },
      ],
    },
  })
  const res = await svc.capabilities({ session: { id: 's1' } })
  assert.equal(res.ok, true)
  const q = res.capabilities.quarantined
  assert.equal(q.length, 3)
  assert.deepEqual(
    q.map((item) => item.file),
    ['desktop-target.json', 'native-sessions.json', 'state.json'],
  )
})

test('10) desktopDetect normalizes driver error codes via normalizeDesktopError', async () => {
  const makeSvc = (runImpl) =>
    new AntigravityBridgeService({
      ctx: {},
      bridge: {
        machineId: 'm-1',
        quarantined: [],
        desktop: {
          enabled: true,
          capabilities: () => ({ desktop: true, target: null }),
          driver: () => ({ run: runImpl }),
        },
      },
      config: {},
      adapter: null,
    })

  const r1 = await makeSvc(async () => ({ ok: false, code: 'driver_protocol_error', message: 'bad json' })).desktopDetect({ session: { id: 's1' } })
  assert.equal(r1.ok, false)
  assert.equal(r1.code, 'desktop_driver_protocol')

  const r2 = await makeSvc(async () => { throw Object.assign(new Error('timed out'), { code: 'driver_timeout' }) }).desktopDetect({ session: { id: 's1' } })
  assert.equal(r2.ok, false)
  assert.equal(r2.code, 'desktop_observation_failed')

  const r3 = await makeSvc(async () => { throw new Error('boom') }).desktopDetect({ session: { id: 's1' } })
  assert.equal(r3.ok, false)
  assert.equal(r3.code, 'desktop_target_unverified')
})
