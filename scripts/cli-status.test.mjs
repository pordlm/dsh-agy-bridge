import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Bridge, defaultConfig } from '../lib/bridge.js'
import { AntigravityBridgeService, createRemoteInfo } from '../lib/web-remote.js'
import {
  cliReasonTextKey,
  createCliSectionComponent,
  createCliStatusController,
  createPanelComponent,
  createRemoteBridge,
  createSidebarPage,
} from '../client/panel.js'
import { DICTIONARIES, createTranslator } from '../client/locale.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const temp = mkdtempSync(join(tmpdir(), 'antigravity-cli-'))
let passed = 0
let failed = 0

test.after(() => {
  rmSync(temp, { recursive: true, force: true })
  console.log(`cli-status-test: ${passed}/${passed + failed} passed`)
  if (failed > 0) process.exitCode = 1
})

function makeHarness({ dataDir }) {
  const mockBackend = {
    kind: 'acp',
    ready: async () => ({
      protocolVersion: 1,
      loadSession: false,
      promptCapabilities: {},
      authMethods: [{ id: 'oauth-personal', name: 'Google', description: 'Google sign-in' }],
    }),
    createSession: async () => ({ sessionId: 'probe-session-1' }),
    close: () => {},
  }
  const config = defaultConfig({
    agyExecutable: 'agy.exe',
    agyArgs: ['acp', '--gemini-dir', dataDir],
    cliProbe: async () => ({ installation: 'available', executable: 'agy.exe', version: '1.5.14' }),
    cwd: temp,
    stateFile: join(temp, `state-${Math.random().toString(36).slice(2)}.json`),
    backend: mockBackend,
  })
  const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  const bridge = new Bridge({}, config, noopLogger)
  const service = new AntigravityBridgeService({ ctx: { get: () => undefined }, bridge, config })
  return { bridge, service }
}

function findNodes(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) findNodes(item, pred, out)
    return out
  }
  if (pred(node)) out.push(node)
  if (node.props && node.props.children !== undefined) findNodes(node.props.children, pred, out)
  return out
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node.props && node.props.children !== undefined) return textOf(node.props.children)
  return ''
}

function createFakeReact() {
  const states = []
  const refs = []
  let sIdx = 0
  let rIdx = 0
  return {
    resetRender() {
      sIdx = 0
      rIdx = 0
    },
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children } }
    },
    useRef(init) {
      if (rIdx >= refs.length) refs.push({ current: init })
      return refs[rIdx++]
    },
    useState(init) {
      const idx = sIdx++
      if (idx >= states.length) states.push(typeof init === 'function' ? init() : init)
      return [
        states[idx],
        (next) => {
          states[idx] = typeof next === 'function' ? next(states[idx]) : next
        },
      ]
    },
    useEffect() {},
  }
}

function renderTree(element, fakeReact) {
  fakeReact.resetRender()
  function expand(node) {
    if (!node || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map(expand)
    if (typeof node.type === 'function') {
      return expand(node.type(node.props || {}))
    }
    if (node.props && node.props.children !== undefined) {
      return { ...node, props: { ...node.props, children: expand(node.props.children) } }
    }
    return node
  }
  return expand(element)
}

function trackedTest(name, fn) {
  test(name, async (t) => {
    try {
      await fn(t)
      passed += 1
    } catch (err) {
      failed += 1
      throw err
    }
  })
}

trackedTest('T1: authStatus is globally available with or without agent', async () => {
  const missingDir = join(temp, 'missing-dir-t1')
  const { bridge, service } = makeHarness({ dataDir: missingDir })
  try {
    const r1 = await service.authStatus()
    const r2 = await service.authStatus({ id: 'whoever' })
    for (const r of [r1, r2]) {
      assert.equal(r.ok, true)
      assert.equal(r.installation, 'available')
      assert.equal(r.version, '1.5.14')
      assert.equal(r.authStatus, 'unknown')
      assert.equal(r.reasonCode, 'protocol_ambiguous')
      assert.ok(['ok', 'skipped'].includes(r.probe.sessionProbe))
      assert.equal(r.probe.authMethodCount, 1)
    }
  } finally {
    bridge.dispose()
  }
})

trackedTest('T2: unwritable dataDir is reported with error', async () => {
  const missingDir = join(temp, 'missing-dir-t2')
  const { bridge, service } = makeHarness({ dataDir: missingDir })
  try {
    const r = await service.authStatus()
    assert.equal(r.dataDir, missingDir)
    assert.equal(r.dataDirWritable, false)
    assert.ok(typeof r.dataDirError === 'string' && /(ENOENT|Access)/i.test(r.dataDirError))
  } finally {
    bridge.dispose()
  }
})

trackedTest('T3: writable dataDir flips writable=true and cleans probe file', async () => {
  const writableDir = join(temp, 'writable-dir-t3')
  mkdirSync(writableDir, { recursive: true })
  const { bridge, service } = makeHarness({ dataDir: writableDir })
  try {
    const r = await service.authStatus()
    assert.equal(r.dataDir, writableDir)
    assert.equal(r.dataDirWritable, true)
    assert.equal(r.dataDirError, null)
    assert.equal(readdirSync(writableDir).length, 0)
  } finally {
    bridge.dispose()
  }
})

trackedTest('T4: global methods omit agent scope and parameters; scoped methods keep them', () => {
  const info = createRemoteInfo()
  const byMethod = Object.fromEntries(info.descriptors.map((d) => [d.method, d]))
  for (const m of ['authStatus', 'login']) {
    assert.equal(byMethod[m].scope, undefined)
    assert.equal(byMethod[m].parameters.length, 0)
  }
  for (const m of ['dispatch', 'status', 'reply', 'cancel']) {
    assert.deepEqual(byMethod[m].scope, { context: 'agent', wire: 'agentId' })
    assert.equal(byMethod[m].parameters[0].name, 'agent')
  }
})

trackedTest('T5: job ownership check (ownedJob / forbidden) remains unchanged', async () => {
  const dir = join(temp, 'ownership-t5')
  mkdirSync(dir, { recursive: true })
  const { bridge, service } = makeHarness({ dataDir: dir })
  try {
    const begun = bridge.beginSend({
      workspaceRoot: temp,
      agentId: 'A',
      transport: 'acp',
      message: 'hello',
    })
    assert.ok(begun.job)
    const jobId = begun.job.jobId
    const denied = await service.status({ id: 'B' }, { jobId })
    assert.equal(denied.ok, false)
    assert.equal(denied.code, 'forbidden')
    const allowed = await service.status({ id: 'A' }, { jobId })
    assert.equal(allowed.ok, true)
    assert.equal(allowed.view.jobId, jobId)
  } finally {
    bridge.dispose()
  }
})

trackedTest('T6: SidebarPage renders CLI section without any selected session and controller.login works', async () => {
  const fakeReact = createFakeReact()
  const translate = createTranslator(DICTIONARIES, 'zh')
  let loginCalls = 0
  const fakeBridge = {
    available: true,
    capabilities: async () => ({ ok: true, capabilities: { transports: ['acp'] } }),
    authStatus: async () => ({
      ok: true,
      installation: 'available',
      executable: 'agy.exe',
      version: '1.5.14',
      authStatus: 'unknown',
      reasonCode: 'protocol_ambiguous',
      probe: { authMethodCount: 1, sessionProbe: 'ok', verifiedStatus: 'unknown' },
      dataDir: 'D:\\missing-dir',
      dataDirWritable: false,
      dataDirError: 'ENOENT: no such file or directory',
    }),
    login: async () => {
      loginCalls += 1
      return { ok: true, authStatus: 'unknown', flow: 'terminal', message: 'opened' }
    },
  }
  const cliController = createCliStatusController({ bridge: fakeBridge })
  await cliController.refresh()
  const loginRes = await cliController.login()
  assert.equal(loginRes.flow, 'terminal')
  assert.equal(loginCalls, 1)
  assert.equal(cliController.getState().flow, 'terminal')

  const Panel = createPanelComponent({ React: fakeReact, translate, bridge: fakeBridge })
  const SidebarPage = createSidebarPage({
    React: fakeReact,
    translate,
    Panel,
    retainSession: () => ({ ready: Promise.resolve(), release() {} }),
    cliController,
  })
  const useSessions = (selector) => selector({ ids: [], byId: {}, phase: 'ready' })
  const tree = renderTree(fakeReact.createElement(SidebarPage, { useSessions }), fakeReact)

  const cliSections = findNodes(tree, (n) => n.props && n.props['data-cli-section'] !== undefined)
  assert.equal(cliSections.length, 1)
  const refreshBtns = findNodes(tree, (n) => n.type === 'button' && n.props?.['data-action'] === 'cli-status-refresh')
  assert.equal(refreshBtns.length, 1)
  assert.equal(textOf(refreshBtns[0]), '刷新状态')
  const loginBtns = findNodes(tree, (n) => n.type === 'button' && n.props?.['data-action'] === 'cli-login-terminal')
  assert.equal(loginBtns.length, 1)
  const loginStateNodes = findNodes(tree, (n) => n.props?.['data-cli-field'] === 'login-state')
  assert.equal(loginStateNodes.length, 1)
  assert.ok(textOf(loginStateNodes[0]).includes('未知'))
  const errorNodes = findNodes(tree, (n) => n.props && n.props['data-cli-error'] !== undefined)
  assert.ok(errorNodes.length >= 1)
  cliController.dispose()
})

trackedTest('T7: Panel standalone keeps cli-login/cli-auth-refresh; embedded omits them', () => {
  const fakeReact = createFakeReact()
  const remotePort = createRemoteBridge({
    antigravityBridge: {
      capabilities: async () => ({ ok: true, capabilities: { transports: ['acp'] } }),
      dispatch: async () => ({ ok: true }),
      status: async () => ({ ok: true }),
      reply: async () => ({ ok: true }),
      cancel: async () => ({ ok: true }),
      authStatus: async () => ({ ok: true, authStatus: 'unknown' }),
      login: async () => ({ ok: true, flow: 'terminal' }),
    },
  })
  const Panel = createPanelComponent({ React: fakeReact, bridge: remotePort })
  const standalone = renderTree(fakeReact.createElement(Panel, { sessionId: 's1' }), fakeReact)
  assert.equal(findNodes(standalone, (n) => n.type === 'button' && n.props?.['data-action'] === 'cli-login').length, 1)
  assert.equal(findNodes(standalone, (n) => n.type === 'button' && n.props?.['data-action'] === 'cli-auth-refresh').length, 1)

  const embedded = renderTree(fakeReact.createElement(Panel, { sessionId: 's1', embedded: true }), fakeReact)
  assert.equal(findNodes(embedded, (n) => n.type === 'button' && n.props?.['data-action'] === 'cli-login').length, 0)
  assert.equal(findNodes(embedded, (n) => n.type === 'button' && n.props?.['data-action'] === 'cli-auth-refresh').length, 0)
})

trackedTest('T8: client/index.js bundle contains CLI section & keeps ui-model-integration anchors', () => {
  const bundle = readFileSync(join(ROOT, 'client/index.js'), 'utf8')
  assert.ok(bundle.includes('data-cli-section'))
  assert.ok(bundle.includes('cli-status-refresh'))
  assert.ok(bundle.includes('cli-login-terminal'))
  assert.ok(bundle.includes("const keepIntent = result.status !== 'not_sent'"))
  assert.ok(bundle.includes('intentRequest: keepIntent ? payload : null'))
  assert.ok(bundle.includes('stopPoll({ generation, jobId })'))
})

trackedTest('T9: missing CLI uses real reasonCode cli_missing, disables login, and never renders protocol_ambiguous', async () => {
  assert.equal(cliReasonTextKey('cli_missing'), 'cli.reasonMissing')
  const config = defaultConfig({
    agyExecutable: 'agy.exe',
    agyArgs: ['acp', '--gemini-dir', join(temp, 'dir-t9')],
    cliProbe: async () => ({ installation: 'missing', executable: 'agy.exe', code: 'cli_missing' }),
    cwd: temp,
    stateFile: join(temp, `state-t9-${Math.random().toString(36).slice(2)}.json`),
    backend: { kind: 'acp', ready: async () => ({ authMethods: [] }), close: () => {} },
  })
  const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  const bridge = new Bridge({}, config, noopLogger)
  const service = new AntigravityBridgeService({ ctx: { get: () => undefined }, bridge, config })
  const remotePort = createRemoteBridge({
    antigravityBridge: {
      capabilities: async () => ({ ok: true }),
      dispatch: async () => ({ ok: true }),
      status: async () => ({ ok: true }),
      reply: async () => ({ ok: true }),
      cancel: async () => ({ ok: true }),
      authStatus: () => service.authStatus(),
      login: () => service.login(),
    },
  })
  const ctrl = createCliStatusController({ bridge: remotePort })
  try {
    const res = await ctrl.refresh()
    assert.equal(res.reasonCode, 'cli_missing')
    assert.notEqual(res.reasonCode, 'protocol_ambiguous')
    assert.notEqual(ctrl.getState().reasonCode, 'protocol_ambiguous')

    const fakeReact = createFakeReact()
    const translate = createTranslator(DICTIONARIES, 'zh')
    const CliSection = createCliSectionComponent({ React: fakeReact, translate, controller: ctrl })
    const tree = renderTree(fakeReact.createElement(CliSection, { bridgeAvailable: true }), fakeReact)
    const protoNodes = findNodes(tree, (n) => n.props?.['data-cli-reason'] === 'protocol_ambiguous')
    assert.equal(protoNodes.length, 0)
    const missingReasonNodes = findNodes(tree, (n) => n.props?.['data-cli-reason'] === 'cli_missing')
    assert.equal(missingReasonNodes.length, 1)
    assert.ok(textOf(missingReasonNodes[0]).includes('没有可用的 agy CLI'))
    const loginBtns = findNodes(tree, (n) => n.type === 'button' && n.props?.['data-action'] === 'cli-login-terminal')
    assert.equal(loginBtns[0].props.disabled, true)
  } finally {
    ctrl.dispose()
    bridge.dispose()
  }
})

trackedTest('T10: unconfigured dataDir returns cli_data_directory_required (not protocol_ambiguous) and EUNCONFIGURED', async () => {
  assert.equal(cliReasonTextKey('cli_data_directory_required'), 'cli.reasonDataDir')
  const config = defaultConfig({
    agyExecutable: 'agy.exe',
    agyArgs: ['acp'],
    cliProbe: async () => ({ installation: 'available', executable: 'agy.exe', version: '1.5.14' }),
    cwd: temp,
    stateFile: join(temp, `state-t10-${Math.random().toString(36).slice(2)}.json`),
    backend: {
      kind: 'acp',
      ready: async () => ({ authMethods: [{ id: 'oauth-personal', name: 'Google' }] }),
      close: () => {},
    },
  })
  const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  const bridge = new Bridge({}, config, noopLogger)
  const service = new AntigravityBridgeService({ ctx: { get: () => undefined }, bridge, config })
  try {
    const res = await service.authStatus()
    assert.equal(res.reasonCode, 'cli_data_directory_required')
    assert.notEqual(res.reasonCode, 'protocol_ambiguous')
    assert.ok(typeof res.dataDirError === 'string' && res.dataDirError.includes('EUNCONFIGURED'))
  } finally {
    bridge.dispose()
  }
})

trackedTest('T11: probe failure (backend.ready throws) returns auth_probe_failed, not protocol_ambiguous', async () => {
  const dir = join(temp, 'dir-t11')
  mkdirSync(dir, { recursive: true })
  const config = defaultConfig({
    agyExecutable: 'agy.exe',
    agyArgs: ['acp', '--gemini-dir', dir],
    cliProbe: async () => ({ installation: 'available', executable: 'agy.exe', version: '1.5.14' }),
    cwd: temp,
    stateFile: join(temp, `state-t11-${Math.random().toString(36).slice(2)}.json`),
    backend: {
      kind: 'acp',
      ready: async () => { throw new Error('spawn ENOENT') },
      close: () => {},
    },
  })
  const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  const bridge = new Bridge({}, config, noopLogger)
  const service = new AntigravityBridgeService({ ctx: { get: () => undefined }, bridge, config })
  try {
    const res = await service.authStatus()
    assert.equal(res.reasonCode, 'auth_probe_failed')
    assert.notEqual(res.reasonCode, 'protocol_ambiguous')
  } finally {
    bridge.dispose()
  }
})
