import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Bridge, defaultConfig } from '../lib/bridge.js'
import { apply } from '../lib/index.js'
import { AntigravityBridgeService, createRemoteInfo } from '../lib/web-remote.js'
import { AgyAcpAdapter, planRequest } from '../lib/model-adapter.js'
import { createPanelComponent, createPanelController, createRemoteBridge, NATIVE_POLL_MS, NATIVE_HIDDEN_POLL_MS } from '../client/panel.js'
import { DICTIONARIES, createTranslator } from '../client/locale.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const mockPath = join(ROOT, 'scripts', 'mock-agy-acp.mjs')
const temp = mkdtempSync(join(tmpdir(), 'antigravity-activity-'))
let passed = 0
let failed = 0

test.after(() => {
  rmSync(temp, { recursive: true, force: true })
  console.log(`activity-test: ${passed}/${passed + failed} passed`)
  if (failed > 0) process.exitCode = 1
})

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

function makeBridge() {
  const mockState = join(temp, `mock-state-${Math.random().toString(36).slice(2)}.json`)
  const mockLog = join(temp, `mock-log-${Math.random().toString(36).slice(2)}.jsonl`)
  const stateFile = join(temp, `bridge-state-${Math.random().toString(36).slice(2)}.json`)
  const config = defaultConfig({
    agyExecutable: process.execPath,
    agyArgs: [mockPath, `--state=${mockState}`, `--log=${mockLog}`],
    cwd: temp,
    stateFile,
    waitPollMs: 50,
    pollMs: 1000,
  })
  const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  const bridge = new Bridge({}, config, noopLogger)
  const service = new AntigravityBridgeService({ ctx: { get: () => undefined }, bridge, config })
  return { bridge, service }
}

let sharedJobId = ''
let sharedBridge = null
let sharedService = null

trackedTest('T1: mock-agy-acp send->dispatch->wait records single in-place activity event', async () => {
  const { bridge, service } = makeBridge()
  sharedBridge = bridge
  sharedService = service
  const begun = bridge.beginSend({
    workspaceRoot: temp,
    agentId: 'agent-A',
    transport: 'acp',
    message: 'hello activity',
  })
  assert.ok(begun.job)
  sharedJobId = begun.job.jobId
  await bridge.dispatch(begun.job, {
    message: 'hello activity',
    requested: begun.job.requested,
    attachments: [],
    cwd: temp,
  })
  await bridge.waitFor(begun.job, { timeoutMs: 5000 })
  const view = bridge.view(begun.job)
  assert.equal(view.activity.length, 1)
  assert.deepEqual(view.activity[0], {
    toolCallId: 'mock-tool',
    kind: 'read',
    title: 'Mock read',
    status: 'completed',
  })
})

trackedTest('T2: web-remote activity() returns normalized events matching schema', async () => {
  const res = await sharedService.activity({ id: 'agent-A' }, { jobId: sharedJobId })
  assert.equal(res.ok, true)
  assert.equal(res.jobId, sharedJobId)
  assert.deepEqual(res.events, [
    { toolCallId: 'mock-tool', kind: 'read', title: 'Mock read', status: 'completed' },
  ])
  const info = createRemoteInfo()
  const desc = info.descriptors.find((d) => d.method === 'activity')
  assert.ok(desc)
  assert.deepEqual(desc.scope, { context: 'agent', wire: 'agentId' })
  assert.equal(desc.parameters[0].name, 'agent')
  const itemSchema = desc.result.jsonSchema.properties.events.items
  assert.deepEqual(itemSchema.required, ['toolCallId', 'kind', 'title', 'status'])
  assert.deepEqual(itemSchema.properties.kind.enum, ['execute', 'edit', 'read', 'other', 'unknown'])
})

trackedTest('T3: web-remote activity() rejects foreign agentId with forbidden', async () => {
  const denied = await sharedService.activity({ id: 'agent-B' }, { jobId: sharedJobId })
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'forbidden')
  assert.equal(denied.message, 'job belongs to another session')
  sharedBridge.dispose()
})

trackedTest('T4: empty job returns 0 events and Panel renders empty message without list', async () => {
  const { bridge, service } = makeBridge()
  try {
    const begun = bridge.beginSend({
      workspaceRoot: temp,
      agentId: 'agent-A',
      transport: 'acp',
      message: 'empty job',
    })
    const emptyJobId = begun.job.jobId
    const res = await service.activity({ id: 'agent-A' }, { jobId: emptyJobId })
    assert.equal(res.ok, true)
    assert.equal(res.events.length, 0)

    const remotePort = createRemoteBridge({
      antigravityBridge: {
        capabilities: async () => ({ ok: true, capabilities: { transports: ['acp'] } }),
        dispatch: async () => ({ ok: true, jobId: emptyJobId, status: 'accepted', view: { state: 'accepted' } }),
        status: async () => ({ ok: true, view: { state: 'accepted' } }),
        reply: async () => ({ ok: true, available: false }),
        cancel: async () => ({ ok: true }),
        activity: () => service.activity({ id: 'agent-A' }, { jobId: emptyJobId }),
        authStatus: async () => ({ ok: true, authStatus: 'unknown' }),
        login: async () => ({ ok: true, flow: 'terminal' }),
      },
    })
    let currentState
    const fakeReact = {
      createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
      useRef: (init) => ({ current: init }),
      useState: (init) => {
        if (currentState === undefined) currentState = typeof init === 'function' ? init() : init
        return [currentState, (next) => { currentState = typeof next === 'function' ? next(currentState) : next }]
      },
      useEffect: () => {},
    }
    const ctrl = createPanelController({ bridge: remotePort, sessionId: 'sess-empty' })
    ctrl.setMessage('empty job')
    await ctrl.dispatch()
    await ctrl.refresh()
    await new Promise((r) => setTimeout(r, 20))
    currentState = ctrl.getState()
    const Panel = createPanelComponent({ React: fakeReact, translate: createTranslator(DICTIONARIES, 'zh'), bridge: remotePort })
    const tree = Panel({ sessionId: 'sess-empty' })
    const regions = findNodes(tree, (n) => n.props && n.props['data-activity-region'] !== undefined)
    assert.equal(regions.length, 1)
    assert.ok(textOf(regions[0]).includes('本轮没有工具活动'))
    assert.equal(findNodes(tree, (n) => n.props && n.props['data-activity-item'] !== undefined).length, 0)
    ctrl.dispose()
  } finally {
    bridge.dispose()
  }
})

trackedTest('T5: Panel renders activity item with kind, title, status, and readonly hint', async () => {
  const remotePort = createRemoteBridge({
    antigravityBridge: {
      capabilities: async () => ({ ok: true, capabilities: { transports: ['acp'] } }),
      dispatch: async () => ({ ok: true, jobId: 'job-act-1', status: 'accepted', view: { state: 'accepted' } }),
      status: async () => ({ ok: true, view: { state: 'accepted' } }),
      reply: async () => ({ ok: true, available: false }),
      cancel: async () => ({ ok: true }),
      activity: async () => ({
        ok: true,
        jobId: 'job-act-1',
        state: 'accepted',
        events: [{ toolCallId: 'mock-tool', kind: 'read', title: 'Mock read', status: 'completed' }],
      }),
      authStatus: async () => ({ ok: true, authStatus: 'unknown' }),
      login: async () => ({ ok: true, flow: 'terminal' }),
    },
  })
  let currentState
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
    useRef: (init) => ({ current: init }),
    useState: (init) => {
      if (currentState === undefined) currentState = typeof init === 'function' ? init() : init
      return [currentState, (next) => { currentState = typeof next === 'function' ? next(currentState) : next }]
    },
    useEffect: () => {},
  }
  const ctrl = createPanelController({ bridge: remotePort, sessionId: 'sess-act' })
  ctrl.setMessage('hi')
  await ctrl.dispatch()
  await ctrl.refresh()
  await new Promise((r) => setTimeout(r, 20))
  currentState = ctrl.getState()
  const Panel = createPanelComponent({ React: fakeReact, translate: createTranslator(DICTIONARIES, 'zh'), bridge: remotePort })
  const tree = Panel({ sessionId: 'sess-act' })
  const regions = findNodes(tree, (n) => n.props && n.props['data-activity-region'] !== undefined)
  assert.equal(regions.length, 1)
  assert.ok(textOf(regions[0]).includes('来自 Antigravity 的只读活动'))
  const items = findNodes(tree, (n) => n.props && n.props['data-activity-item'] !== undefined)
  assert.equal(items.length, 1)
  const itemText = textOf(items[0])
  assert.ok(itemText.includes('读取'))
  assert.ok(itemText.includes('Mock read'))
  assert.ok(itemText.includes('completed'))
  ctrl.dispose()
})

trackedTest('T6: planRequest context isolation excludes activity titles and keeps systemHash stable', () => {
  const req = {
    workspaceRoot: temp,
    model: 'test-model-a',
    systemText: 'You are a helpful assistant.',
    messages: [{ role: 'user', content: 'Summarize the repo.' }],
  }
  const plan1 = planRequest(req)
  const plan2 = planRequest(req)
  assert.ok(!JSON.stringify(plan1).includes('Mock read'))
  assert.ok(!JSON.stringify(plan1).includes('data-activity'))
  assert.equal(plan1.systemHash, plan2.systemHash)
})

function makeUnitBridge() {
  const stateFile = join(temp, `unit-state-${Math.random().toString(36).slice(2)}.json`)
  const config = defaultConfig({
    cwd: temp,
    stateFile,
    autoWake: false,
    waitPollMs: 50,
    pollMs: 1000,
    backend: { kind: 'acp', close: () => {} },
  })
  const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  const bridge = new Bridge({}, config, noopLogger)
  const begun = bridge.beginSend({
    workspaceRoot: temp,
    agentId: 'agent-unit',
    transport: 'acp',
    message: 'unit activity',
  })
  return { bridge, job: begun.job }
}

trackedTest('R1: interleaved toolCallId updates merge in place without duplicating', () => {
  const { bridge, job } = makeUnitBridge()
  try {
    bridge.recordActivity(job, { toolCallId: 't1', kind: 'read', title: 'Run tests', status: 'in_progress' })
    bridge.recordActivity(job, { toolCallId: 't2', kind: 'edit', title: 'Edit file', status: 'in_progress' })
    bridge.recordActivity(job, { toolCallId: 't1', status: 'completed' })
    const act = bridge.view(job).activity
    assert.equal(act.length, 2, `R1 interleaved merge: activity.length expected 2, got ${act.length}`)
    assert.equal(act[0].toolCallId, 't1', `R1 interleaved merge: activity[0].toolCallId expected t1, got ${act[0].toolCallId}`)
    assert.equal(act[0].status, 'completed', `R1 interleaved merge: activity[0].status expected completed, got ${act[0].status}`)
    assert.equal(act[0].title, 'Run tests', `R1 interleaved merge: activity[0].title expected Run tests, got ${act[0].title}`)
    assert.equal(act[0].kind, 'read', `R1 interleaved merge: activity[0].kind expected read, got ${act[0].kind}`)
    assert.equal(act[1].toolCallId, 't2', `R1 interleaved merge: activity[1].toolCallId expected t2, got ${act[1].toolCallId}`)
    assert.equal(act[1].status, 'in_progress', `R1 interleaved merge: activity[1].status expected in_progress, got ${act[1].status}`)
  } finally {
    bridge.dispose()
  }
})

trackedTest('R2: empty title update preserves previous title and kind', () => {
  const { bridge, job } = makeUnitBridge()
  try {
    bridge.recordActivity(job, { toolCallId: 't3', kind: 'edit', title: 'Run tests', status: 'in_progress' })
    bridge.recordActivity(job, { toolCallId: 't3', status: 'completed' })
    const act = bridge.view(job).activity
    assert.equal(act.length, 1, `R2 empty title: activity.length expected 1, got ${act.length}`)
    assert.equal(act[0].title, 'Run tests', `R2 empty title: title expected Run tests, got ${act[0].title}`)
    assert.equal(act[0].kind, 'edit', `R2 empty title: kind expected edit, got ${act[0].kind}`)
    assert.equal(act[0].status, 'completed', `R2 empty title: status expected completed, got ${act[0].status}`)
  } finally {
    bridge.dispose()
  }
})

trackedTest('R3: unknown kind does not overwrite known kind, title, or status', () => {
  const { bridge, job } = makeUnitBridge()
  try {
    bridge.recordActivity(job, { toolCallId: 't4', kind: 'read', title: 'Inspect', status: 'in_progress' })
    bridge.recordActivity(job, { toolCallId: 't4', kind: 'execute' })
    assert.equal(bridge.view(job).activity[0].kind, 'execute', `R3 kind upgrade: expected execute`)
    bridge.recordActivity(job, { toolCallId: 't4' })
    const item = bridge.view(job).activity[0]
    assert.equal(item.kind, 'execute', `R3 unknown fallback: kind expected execute, got ${item.kind}`)
    assert.equal(item.title, 'Inspect', `R3 unknown fallback: title expected Inspect, got ${item.title}`)
    assert.equal(item.status, 'in_progress', `R3 unknown fallback: status expected in_progress, got ${item.status}`)
  } finally {
    bridge.dispose()
  }
})

trackedTest('R4: activity list caps at 20 and in-place update keeps length at 20', () => {
  const { bridge, job } = makeUnitBridge()
  try {
    for (let i = 1; i <= 25; i++) {
      bridge.recordActivity(job, { toolCallId: `id-${i}`, kind: 'read', title: `Title ${i}`, status: 'in_progress' })
    }
    let act = bridge.view(job).activity
    assert.equal(act.length, 20, `R4 cap: length expected 20, got ${act.length}`)
    assert.equal(act[0].toolCallId, 'id-6', `R4 cap: first retained expected id-6, got ${act[0].toolCallId}`)
    bridge.recordActivity(job, { toolCallId: 'id-10', status: 'completed' })
    act = bridge.view(job).activity
    assert.equal(act.length, 20, `R4 cap after update: length expected 20, got ${act.length}`)
    const updated = act.find((e) => e.toolCallId === 'id-10')
    assert.equal(updated?.status, 'completed', `R4 cap after update: id-10 status expected completed, got ${updated?.status}`)
  } finally {
    bridge.dispose()
  }
})

trackedTest('R5: save() throwing does not crash recordActivity and still updates in-memory activity', () => {
  const { bridge, job } = makeUnitBridge()
  try {
    bridge.save = () => {
      throw new Error('disk full')
    }
    assert.doesNotThrow(() => {
      bridge.recordActivity(job, { toolCallId: 't5', kind: 'execute', title: 'Build', status: 'completed' })
    })
    const act = bridge.view(job).activity
    assert.equal(act.length, 1, `R5 save throw: activity.length expected 1, got ${act.length}`)
    assert.equal(act[0].toolCallId, 't5', `R5 save throw: toolCallId expected t5, got ${act[0].toolCallId}`)
  } finally {
    bridge.dispose()
  }
})

trackedTest('R6: Panel error branch, no-job omission, and paired zh/en activity locale keys', async () => {
  const remotePort = createRemoteBridge({
    antigravityBridge: {
      capabilities: async () => ({ ok: true, capabilities: { transports: ['acp'] } }),
      dispatch: async () => ({ ok: true, jobId: 'job-err-1', status: 'accepted', view: { state: 'accepted' } }),
      status: async () => ({ ok: true, view: { state: 'accepted' } }),
      reply: async () => ({ ok: true, available: false }),
      cancel: async () => ({ ok: true }),
      activity: async () => {
        throw new Error('activity probe boom')
      },
      authStatus: async () => ({ ok: true, authStatus: 'unknown' }),
      login: async () => ({ ok: true, flow: 'terminal' }),
    },
  })
  let currentState
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
    useRef: (init) => ({ current: init }),
    useState: (init) => {
      if (currentState === undefined) currentState = typeof init === 'function' ? init() : init
      return [currentState, (next) => { currentState = typeof next === 'function' ? next(currentState) : next }]
    },
    useEffect: () => {},
  }
  const Panel = createPanelComponent({ React: fakeReact, translate: createTranslator(DICTIONARIES, 'zh'), bridge: remotePort })
  const noJobTree = Panel({ sessionId: 'sess-no-job' })
  assert.equal(findNodes(noJobTree, (n) => n.props && n.props['data-activity-region'] !== undefined).length, 0, 'R6 no-job: data-activity-region must not render')

  const ctrl = createPanelController({ bridge: remotePort, sessionId: 'sess-err' })
  ctrl.setMessage('hi')
  await ctrl.dispatch()
  await ctrl.refresh()
  await new Promise((r) => setTimeout(r, 20))
  currentState = ctrl.getState()
  const errTree = Panel({ sessionId: 'sess-err' })
  const regions = findNodes(errTree, (n) => n.props && n.props['data-activity-region'] !== undefined)
  assert.equal(regions.length, 1, 'R6 error: data-activity-region expected')
  const alerts = findNodes(regions[0], (n) => n.props && n.props.role === 'alert')
  assert.equal(alerts.length, 1, 'R6 error: role=alert expected inside activity region')
  ctrl.dispose()

  const requiredKeys = [
    'activity.title', 'activity.readonly', 'activity.empty', 'activity.error',
    'activity.kind.execute', 'activity.kind.edit', 'activity.kind.read', 'activity.kind.other', 'activity.kind.unknown',
  ]
  for (const key of requiredKeys) {
    assert.ok(Object.prototype.hasOwnProperty.call(DICTIONARIES.zh, key), `R6 locale.js zh missing ${key}`)
    assert.ok(Object.prototype.hasOwnProperty.call(DICTIONARIES.en, key), `R6 locale.js en missing ${key}`)
  }
  assert.deepEqual(Object.keys(DICTIONARIES.zh).sort(), Object.keys(DICTIONARIES.en).sort(), 'R6 locale.js zh/en key sets must match')

  const zhJson = JSON.parse(readFileSync(join(ROOT, 'locale', 'zh.json'), 'utf8'))
  const enJson = JSON.parse(readFileSync(join(ROOT, 'locale', 'en.json'), 'utf8'))
  assert.deepEqual(Object.keys(zhJson.activity).sort(), ['empty', 'error', 'kind', 'readonly', 'title'])
  assert.deepEqual(Object.keys(enJson.activity).sort(), ['empty', 'error', 'kind', 'readonly', 'title'])
  assert.deepEqual(Object.keys(zhJson.activity.kind).sort(), ['edit', 'execute', 'other', 'read', 'unknown'])
  assert.deepEqual(Object.keys(enJson.activity.kind).sort(), ['edit', 'execute', 'other', 'read', 'unknown'])
  assert.deepEqual(Object.keys(zhJson.nativeActivity).sort(), ['empty', 'localDerivedNote', 'readonly', 'title', 'truncated'])
  assert.deepEqual(Object.keys(enJson.nativeActivity).sort(), ['empty', 'localDerivedNote', 'readonly', 'title', 'truncated'])
})

class NativeActivityStubTransport {
  constructor(turns) {
    this.turns = [...turns]
    this.prompts = []
    this.handlers = new Set()
    this.closed = false
    this.isClosed = false
  }

  onNotification(fn) {
    this.handlers.add(fn)
    return () => this.handlers.delete(fn)
  }

  onRequest() {
    return () => {}
  }

  start() {}

  close() {
    this.closed = true
    this.isClosed = true
  }

  async request(method, params, opts) {
    if (method === 'initialize') {
      return {
        agentCapabilities: { sessionCapabilities: { resume: true }, loadSession: true },
        models: [{ id: 'gpt-5', name: 'GPT-5' }],
      }
    }
    if (method === 'session/new' || method === 'session/resume') {
      return {
        sessionId: params.sessionId ?? 'acp-native-1',
        configOptions: [
          { id: 'model', category: 'model', currentValue: 'gpt-5', options: [{ value: 'gpt-5', name: 'GPT-5' }] },
          { id: 'thought', category: 'thought_level', currentValue: 'medium', options: [{ value: 'medium', name: 'Medium' }] },
        ],
      }
    }
    if (method === 'session/set_config_option') {
      return {
        configOptions: [
          { id: 'model', category: 'model', currentValue: 'gpt-5', options: [{ value: 'gpt-5', name: 'GPT-5' }] },
          { id: 'thought', category: 'thought_level', currentValue: 'medium', options: [{ value: 'medium', name: 'Medium' }] },
        ],
      }
    }
    if (method === 'session/prompt') {
      this.prompts.push(params)
      const updates = this.turns.shift() ?? []
      for (const update of updates) {
        for (const fn of this.handlers) {
          fn({ method: 'session/update', params: { sessionId: params.sessionId, update } })
        }
      }
      opts?.onResponse?.()
      return { stopReason: 'end_turn' }
    }
    throw new Error(`Unexpected method: ${method}`)
  }
}

async function runNativeTurn(adapter, sessionId, text, extraOptions = {}) {
  const chunks = []
  for await (const chunk of adapter.stream({
    sessionId,
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [{ id: `u-${Math.random().toString(36).slice(2)}`, role: 'user', content: [{ type: 'text', text }] }],
    ...extraOptions,
  })) {
    chunks.push(chunk)
  }
  return chunks
}

trackedTest('N1: native ACP collection whitelists metadata fields and drops update.content', async () => {
  const transport = new NativeActivityStubTransport([[
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      kind: 'read',
      title: 'src/a.js',
      status: 'in_progress',
      content: { type: 'text', text: 'FILE_BODY_SHOULD_NOT_PERSIST' },
    },
    {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'checking file' },
    },
    {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'done' },
    },
  ]])
  const adapter = new AgyAcpAdapter({ cwd: temp, transport: () => transport })
  try {
    await runNativeTurn(adapter, 'sess-n1', 'inspect')
    const act = adapter.getNativeActivity('sess-n1')
    assert.equal(act.events.length, 1)
    assert.deepEqual(Object.keys(act.events[0]).sort(), ['kind', 'source', 'status', 'title', 'toolCallId', 'updatedAt'])
    assert.equal(act.events[0].content, undefined)
    assert.equal(act.events[0].source, 'acp-native')
    assert.equal(typeof act.events[0].updatedAt, 'number')
    assert.equal(act.thoughts.length, 1)
    assert.deepEqual(Object.keys(act.thoughts[0]).sort(), ['source', 'text', 'updatedAt'])
    assert.equal(act.thoughts[0].text, 'checking file')
    assert.equal(act.truncated, false)
  } finally {
    adapter.dispose()
  }
})

trackedTest('N2: native ACP merges same toolCallId in place without duplicating entries', async () => {
  const transport = new NativeActivityStubTransport([[
    { sessionUpdate: 'tool_call', toolCallId: 'tc-merge', kind: 'edit', title: 'lib/a.js', status: 'in_progress' },
    { sessionUpdate: 'tool_call_update', toolCallId: 'tc-merge', title: 'D:\\repo\\lib\\a.js', status: 'completed' },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
  ]])
  const adapter = new AgyAcpAdapter({ cwd: temp, transport: () => transport })
  try {
    await runNativeTurn(adapter, 'sess-n2', 'edit')
    const act = adapter.getNativeActivity('sess-n2')
    assert.equal(act.events.length, 1)
    assert.equal(act.events[0].toolCallId, 'tc-merge')
    assert.equal(act.events[0].kind, 'edit')
    assert.equal(act.events[0].title, 'D:\\repo\\lib\\a.js')
    assert.equal(act.events[0].status, 'completed')
  } finally {
    adapter.dispose()
  }
})

trackedTest('N3: native ACP caps events at 40 and sets truncated=true', async () => {
  const updates = []
  for (let i = 1; i <= 45; i += 1) {
    updates.push({ sessionUpdate: 'tool_call', toolCallId: `cap-${i}`, kind: 'read', title: `file-${i}`, status: 'completed' })
  }
  updates.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } })
  const transport = new NativeActivityStubTransport([updates])
  const adapter = new AgyAcpAdapter({ cwd: temp, transport: () => transport })
  try {
    await runNativeTurn(adapter, 'sess-n3', 'many')
    const act = adapter.getNativeActivity('sess-n3')
    assert.equal(act.events.length, 40)
    assert.equal(act.events[0].toolCallId, 'cap-6')
    assert.equal(act.events.at(-1).toolCallId, 'cap-45')
    assert.equal(act.truncated, true)
  } finally {
    adapter.dispose()
  }
})

trackedTest('N4: nativeActivity isolates by sessionId and enforces scope/agent/sessionId ownership', async () => {
  const tA = new NativeActivityStubTransport([[
    { sessionUpdate: 'tool_call', toolCallId: 'a-1', kind: 'execute', title: 'npm test', status: 'completed' },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
  ]])
  const tB = new NativeActivityStubTransport([[
    { sessionUpdate: 'tool_call', toolCallId: 'b-1', kind: 'read', title: 'README.md', status: 'completed' },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
  ]])
  const adapter = new AgyAcpAdapter({ cwd: temp, transport: () => (adapter.nativeActivity.has('sess-A') ? tB : tA) })
  const { bridge } = makeBridge()
  const service = new AntigravityBridgeService({ ctx: { get: () => undefined }, bridge, config: defaultConfig({ cwd: temp }), adapter })
  try {
    await runNativeTurn(adapter, 'sess-A', 'run A')
    await runNativeTurn(adapter, 'sess-B', 'run B')

    const info = createRemoteInfo()
    const desc = info.descriptors.find((d) => d.method === 'nativeActivity')
    assert.ok(desc)
    assert.deepEqual(desc.scope, { context: 'agent', wire: 'agentId' })

    const resA = await service.nativeActivity({ id: 'agent-A', sessionId: 'sess-A', scope: 's1' }, { sessionId: 'sess-A', scope: 's1', agentId: 'agent-A' })
    assert.equal(resA.ok, true)
    assert.equal(resA.events.length, 1)
    assert.equal(resA.events[0].toolCallId, 'a-1')

    const foreignSess = await service.nativeActivity({ id: 'agent-B', sessionId: 'sess-B' }, { sessionId: 'sess-A' })
    assert.equal(foreignSess.ok, false)
    assert.equal(foreignSess.code, 'forbidden')

    const foreignScope = await service.nativeActivity({ id: 'agent-A', sessionId: 'sess-A', scope: 's1' }, { sessionId: 'sess-A', scope: 's2' })
    assert.equal(foreignScope.ok, false)
    assert.equal(foreignScope.code, 'forbidden')

    const foreignAgent = await service.nativeActivity({ id: 'agent-A', sessionId: 'sess-A' }, { sessionId: 'sess-A', agentId: 'agent-X' })
    assert.equal(foreignAgent.ok, false)
    assert.equal(foreignAgent.code, 'forbidden')
  } finally {
    bridge.dispose()
    adapter.dispose()
  }
})

trackedTest('N5: nativeActivityEnabled=false does not register callbacks and preserves existing records', async () => {
  const transport = new NativeActivityStubTransport([
    [
      { sessionUpdate: 'tool_call', toolCallId: 'keep-1', kind: 'read', title: 'keep.txt', status: 'completed' },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'first' } },
    ],
    [
      { sessionUpdate: 'tool_call', toolCallId: 'skip-2', kind: 'edit', title: 'skip.txt', status: 'completed' },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'skip thought' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'second' } },
    ],
  ])
  const adapter = new AgyAcpAdapter({ cwd: temp, transport: () => transport })
  try {
    let regCount = 0
    await runNativeTurn(adapter, 'sess-n5', 'turn 1', { onRegisterActivityCallbacks: () => { regCount += 1 } })
    assert.equal(regCount, 1)
    assert.equal(adapter.getNativeActivity('sess-n5').events.length, 1)

    let disabledRegCount = 0
    adapter.config.nativeActivityEnabled = false
    await runNativeTurn(adapter, 'sess-n5-b', 'turn 2', { onRegisterActivityCallbacks: () => { disabledRegCount += 1 } })
    assert.equal(disabledRegCount, 0, 'callbacks must NOT be registered when switch is off')
    assert.equal(adapter.nativeActivityListeners.size, 0)
    assert.equal(adapter.getNativeActivity('sess-n5-b').events.length, 0)
    assert.equal(adapter.getNativeActivity('sess-n5').events.length, 1, 'existing records must not be cleared')
  } finally {
    adapter.dispose()
  }
})

trackedTest('N6: SECRET probe in tool/thought notifications never leaks across turns into prompt, planRequest, nativeStateFile, wakeText, or listJobs', async () => {
  const secretTitle = 'SECRET_TITLE_1'
  const secretContent = 'SECRET_CONTENT_1'
  const secretThought = 'SECRET_THOUGHT_1'
  const nativeStateFile = join(temp, `n6-native-state-${Math.random().toString(36).slice(2)}.json`)
  const transport = new NativeActivityStubTransport([
    [
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'sec-1',
        kind: 'read',
        title: `read ${secretTitle}`,
        status: 'completed',
        content: [{ type: 'text', text: secretContent }],
      },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: `thinking ${secretThought}` } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'safe reply 1' } },
    ],
    [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'safe reply 2' } },
    ],
  ])
  const adapter = new AgyAcpAdapter({ cwd: temp, nativeStateFile, transport: () => transport })
  const { bridge } = makeBridge()
  try {
    const u1 = { id: 'u-n6-1', role: 'user', content: [{ type: 'text', text: 'first turn' }] }
    const turn1Opts = {
      sessionId: 'sess-n6',
      model: 'gpt-5',
      reasoningEffort: 'medium',
      system: 'You are a helpful assistant.',
      messages: [u1],
    }
    const plan1 = planRequest(turn1Opts)
    for await (const _ of adapter.stream(turn1Opts)) {}

    // (f) Positive assertion: SECRET_TITLE_1 and SECRET_THOUGHT_1 actually entered collection layer, while content did not.
    const act1 = adapter.getNativeActivity('sess-n6')
    assert.equal(act1.events.length, 1, 'N6 turn1: expected 1 collected event')
    assert.equal(act1.events[0].toolCallId, 'sec-1', 'N6 turn1: expected toolCallId sec-1')
    assert.ok(act1.events[0].title.includes(secretTitle), 'N6 turn1: collected title must contain SECRET_TITLE_1')
    assert.equal(act1.thoughts.length, 1, 'N6 turn1: expected 1 collected thought')
    assert.ok(act1.thoughts[0].text.includes(secretThought), 'N6 turn1: collected thought must contain SECRET_THOUGHT_1')
    assert.equal(JSON.stringify(act1).includes(secretContent), false, 'N6 turn1: update.content must never persist in nativeActivity')

    // Turn 2: full history + same nativeStateFile
    const a1 = { id: 'a-n6-1', role: 'assistant', content: [{ type: 'text', text: 'safe reply 1' }] }
    const u2 = { id: 'u-n6-2', role: 'user', content: [{ type: 'text', text: 'second turn' }] }
    const turn2Opts = {
      sessionId: 'sess-n6',
      model: 'gpt-5',
      reasoningEffort: 'medium',
      system: 'You are a helpful assistant.',
      messages: [u1, a1, u2],
    }
    const plan2 = planRequest(turn2Opts)
    for await (const _ of adapter.stream(turn2Opts)) {}

    assert.equal(transport.prompts.length, 2, 'N6 turn2: expected 2 dispatched session/prompt calls')
    const turn2PromptText = JSON.stringify(transport.prompts[1])
    const plan2Text = JSON.stringify(plan2)
    const stateFileText = readFileSync(nativeStateFile, 'utf8')
    const jobsText = JSON.stringify(bridge.listJobs())
    for (const secret of [secretTitle, secretContent, secretThought]) {
      assert.equal(turn2PromptText.includes(secret), false, `N6 (a): turn2 session/prompt must not contain ${secret}`)
      assert.equal(plan2Text.includes(secret), false, `N6 (b): turn2 planRequest must not contain ${secret}`)
      assert.equal(stateFileText.includes(secret), false, `N6 (c): nativeStateFile must not contain ${secret}`)
      assert.equal(jobsText.includes(secret), false, `N6 (d): listJobs must not contain ${secret}`)
      assert.equal(plan2.userText.includes(secret), false, `N6 (d): wake/userText must not contain ${secret}`)
    }
    assert.equal(stateFileText.includes('toolCallId'), false, 'N6 (c): nativeStateFile must not contain toolCallId')
    assert.equal(/"source"\s*:\s*"acp-native"/.test(stateFileText), false, 'N6 (c): nativeStateFile must not contain source=acp-native')

    const sysHash1 = createHash('sha256').update(plan1.systemText).digest('hex')
    const sysHash2 = createHash('sha256').update(plan2.systemText).digest('hex')
    assert.equal(sysHash1, sysHash2, 'N6 (e): systemHash must remain identical across turns')
  } finally {
    bridge.dispose()
    adapter.dispose()
  }
})

trackedTest('N7: Panel renders session-source nativeActivity when no jobId and keeps job vs session sources mutually exclusive', async () => {
  const remotePort = createRemoteBridge({
    antigravityBridge: {
      capabilities: async () => ({ ok: true, capabilities: { transports: ['acp'] } }),
      dispatch: async () => ({ ok: true, jobId: 'job-n7', status: 'accepted', view: { state: 'accepted' } }),
      status: async () => ({ ok: true, view: { state: 'accepted' } }),
      reply: async () => ({ ok: true, available: false }),
      cancel: async () => ({ ok: true }),
      activity: async () => ({
        ok: true,
        events: [{ toolCallId: 'job-ev', kind: 'execute', title: 'Job Run', status: 'completed' }],
        thoughts: [],
        thoughtSummaryEnabled: true,
      }),
      nativeActivity: async () => ({
        ok: true,
        events: [{ toolCallId: 'nat-ev', kind: 'read', title: 'Native Read', status: 'completed' }],
        thoughts: [{ text: 'native thinking' }],
        truncated: true,
        thoughtSummaryEnabled: true,
      }),
      authStatus: async () => ({ ok: true, authStatus: 'unknown' }),
      login: async () => ({ ok: true, flow: 'terminal' }),
    },
  })
  let currentState
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
    useRef: (init) => ({ current: init }),
    useState: (init) => {
      if (currentState === undefined) currentState = typeof init === 'function' ? init() : init
      return [currentState, (next) => { currentState = typeof next === 'function' ? next(currentState) : next }]
    },
    useEffect: () => {},
  }
  const ctrl = createPanelController({ bridge: remotePort, sessionId: 'sess-n7' })
  await ctrl.refreshNativeActivity()
  currentState = ctrl.getState()
  const zhDict = {
    ...DICTIONARIES.zh,
    'nativeActivity.title': '原生 ACP 活动流',
    'nativeActivity.readonly': '来自原生 ACP 会话的只读活动',
    'nativeActivity.empty': '本会话暂无原生工具活动',
    'nativeActivity.truncated': '仅保留最近部分活动记录',
  }
  const Panel = createPanelComponent({ React: fakeReact, translate: createTranslator({ zh: zhDict, en: DICTIONARIES.en }, 'zh'), bridge: remotePort })
  const sessionTree = Panel({ sessionId: 'sess-n7' })
  const sessionRegions = findNodes(sessionTree, (n) => n.props && n.props['data-activity-region'] !== undefined)
  assert.equal(sessionRegions.length, 1)
  assert.equal(sessionRegions[0].props['data-activity-source'], 'session')
  assert.ok(textOf(sessionRegions[0]).includes('Native Read'))
  assert.ok(!textOf(sessionRegions[0]).includes('Job Run'))
  assert.equal(findNodes(sessionTree, (n) => n.props && n.props['data-activity-truncated'] !== undefined).length, 1)

  ctrl.setMessage('run job')
  await ctrl.dispatch()
  // F-2: immediately after dispatch() and before refresh(), native activity/thoughts must be cleared
  currentState = ctrl.getState()
  assert.equal(currentState.activitySource, 'job', 'N7 post-dispatch: activitySource must switch to job')
  assert.equal(currentState.activityEvents.length, 0, 'N7 post-dispatch: stale native events must be cleared')
  assert.equal(currentState.thoughts.length, 0, 'N7 post-dispatch: stale native thoughts must be cleared')
  const preRefreshTree = Panel({ sessionId: 'sess-n7' })
  assert.equal(textOf(preRefreshTree).includes('Native Read'), false, 'N7 post-dispatch: Native Read must not appear before refresh')
  assert.equal(textOf(preRefreshTree).includes('native thinking'), false, 'N7 post-dispatch: native thinking must not appear before refresh')

  await ctrl.refresh()
  await new Promise((r) => setTimeout(r, 20))
  currentState = ctrl.getState()
  const jobTree = Panel({ sessionId: 'sess-n7' })
  const jobRegions = findNodes(jobTree, (n) => n.props && n.props['data-activity-region'] !== undefined)
  assert.equal(jobRegions.length, 1)
  assert.equal(jobRegions[0].props['data-activity-source'], 'job')
  assert.ok(textOf(jobRegions[0]).includes('Job Run'))
  assert.ok(!textOf(jobRegions[0]).includes('Native Read'))
  ctrl.dispose()
})

trackedTest('N8: native session polling refreshes Panel DOM automatically without refreshNativeActivity and stops on session switch, jobId, or dispose', async () => {
  let nativeCalls = 0
  let currentEvents = []
  const remotePort = createRemoteBridge({
    antigravityBridge: {
      capabilities: async () => ({ ok: true, capabilities: { transports: ['acp'] } }),
      dispatch: async () => ({ ok: true, jobId: 'job-n8', status: 'accepted', view: { state: 'accepted' } }),
      status: async () => ({ ok: true, view: { state: 'accepted' } }),
      reply: async () => ({ ok: true, available: false }),
      cancel: async () => ({ ok: true }),
      activity: async () => ({ ok: true, events: [], thoughts: [], thoughtSummaryEnabled: true }),
      nativeActivity: async () => {
        nativeCalls += 1
        return { ok: true, events: currentEvents, thoughts: [], truncated: false, thoughtSummaryEnabled: true }
      },
      authStatus: async () => ({ ok: true, authStatus: 'unknown' }),
      login: async () => ({ ok: true, flow: 'terminal' }),
    },
  })

  const scheduled = []
  let nextHandle = 1
  const fakeSetTimer = (fn, ms) => {
    const id = nextHandle++
    scheduled.push({ id, fn, ms, cleared: false })
    return id
  }
  const fakeClearTimer = (id) => {
    const item = scheduled.find((entry) => entry.id === id)
    if (item) item.cleared = true
  }

  let currentState
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
    useRef: (init) => ({ current: init }),
    useState: (init) => {
      if (currentState === undefined) currentState = typeof init === 'function' ? init() : init
      return [currentState, (next) => { currentState = typeof next === 'function' ? next(currentState) : next }]
    },
    useEffect: () => {},
  }
  const zhDict = {
    ...DICTIONARIES.zh,
    'nativeActivity.title': '原生 ACP 活动流',
    'nativeActivity.readonly': '来自原生 ACP 会话的只读活动',
    'nativeActivity.empty': '本会话暂无原生工具活动',
    'nativeActivity.truncated': '仅保留最近部分活动记录',
    'nativeActivity.localDerivedNote': '说明：updatedAt、source、truncated 为插件本地派生字段，非 ACP 原生字段。',
  }
  const Panel = createPanelComponent({ React: fakeReact, translate: createTranslator({ zh: zhDict, en: DICTIONARIES.en }, 'zh'), bridge: remotePort })

  const ctrl = createPanelController({
    bridge: remotePort,
    sessionId: 'sess-n8',
    setTimer: fakeSetTimer,
    clearTimer: fakeClearTimer,
  })
  // Simulate mount lifecycle: refreshCapabilities() without calling refreshNativeActivity()
  await ctrl.refreshCapabilities()
  await new Promise((r) => setTimeout(r, 15))
  assert.equal(nativeCalls, 1)
  assert.equal(ctrl.getState().activityEvents.length, 0)
  assert.ok(scheduled.some((t) => !t.cleared && t.ms === NATIVE_POLL_MS), 'must schedule native poll at NATIVE_POLL_MS=2500')

  // Model emits a tool event in background; advance the active native timer (no session switch, no manual refresh)
  currentEvents = [{ toolCallId: 'nat-poll-1', kind: 'execute', title: 'Native Polled', status: 'completed' }]
  const active1 = scheduled.filter((t) => !t.cleared).at(-1)
  assert.ok(active1)
  active1.fn()
  await new Promise((r) => setTimeout(r, 15))
  assert.equal(nativeCalls, 2)

  currentState = ctrl.getState()
  assert.equal(currentState.activityEvents.length, 1)
  assert.equal(currentState.activityEvents[0].title, 'Native Polled')
  const domTree = Panel({ sessionId: 'sess-n8' })
  assert.ok(textOf(domTree).includes('Native Polled'), 'polled event must appear in Panel DOM')
  assert.equal(findNodes(domTree, (n) => n.props && n.props['data-activity-local-derived'] !== undefined).length, 1)

  // Verify document.hidden slows down polling to NATIVE_HIDDEN_POLL_MS (10000ms)
  const prevDoc = globalThis.document
  globalThis.document = { hidden: true }
  try {
    const active2 = scheduled.filter((t) => !t.cleared).at(-1)
    assert.ok(active2)
    active2.fn()
    await new Promise((r) => setTimeout(r, 15))
    assert.equal(scheduled.filter((t) => !t.cleared).at(-1)?.ms, NATIVE_HIDDEN_POLL_MS)
  } finally {
    globalThis.document = prevDoc
  }

  // Switching session cancels old native timer and stops old session requests
  const oldActive = scheduled.filter((t) => !t.cleared).at(-1)
  ctrl.setSession('sess-n8-other')
  assert.equal(oldActive.cleared, true, 'setSession must clear old nativeTimer')
  const callsAtSwitch = nativeCalls
  oldActive.fn()
  await new Promise((r) => setTimeout(r, 15))
  assert.equal(nativeCalls, callsAtSwitch, 'old timer callback must not fire after setSession')

  // dispatch() getting a jobId stops native polling; dispose() clears all timers
  ctrl.setMessage('start job')
  await ctrl.dispatch()
  assert.equal(ctrl._internal.hasNativeTimer(), false, 'dispatch with jobId must stop native polling')
  ctrl.dispose()
  assert.equal(ctrl._internal.hasNativeTimer(), false)
  const callsAfterDispose = nativeCalls
  for (const t of scheduled) {
    if (!t.cleared) t.fn()
  }
  await new Promise((r) => setTimeout(r, 15))
  assert.equal(nativeCalls, callsAfterDispose, 'no nativeActivity calls after dispose')
})

trackedTest('N9: apply() wires nativeActivityEnabled to AgyAcpAdapter and defaultConfig rejects non-boolean values', async () => {
  const noop = () => {}
  const makeStubCtx = (registered) => {
    const disposers = []
    const ctx = {
      tools: { register: () => noop },
      effect(fn) {
        const d = fn()
        if (typeof d === 'function') disposers.push(d)
        return d
      },
      get(name) {
        if (name === 'llm') {
          return {
            registerAdapter(routes, adapter) {
              registered.push({ routes, adapter })
              return noop
            },
          }
        }
        if (name === 'workingDirectory') return { cwd: temp }
        return undefined
      },
      agents: { get: (id) => (id ? { session: { id } } : undefined) },
      on: () => noop,
      logger: { debug: noop, info: noop, warn: noop, error: noop, trace: noop },
      reflect: { provide: noop },
      root: {},
    }
    return {
      ctx,
      disposeAll() {
        for (const d of [...disposers].reverse()) d()
      },
    }
  }

  // 1) nativeActivityEnabled: false via apply() -> 0 callback registrations
  const regFalse = []
  const stubFalse = makeStubCtx(regFalse)
  try {
    const tFalse = new NativeActivityStubTransport([[
      { sessionUpdate: 'tool_call', toolCallId: 'f-1', kind: 'read', title: 'secret.txt', status: 'completed' },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
    ]])
    await apply(stubFalse.ctx, {
      agyExecutable: 'agy',
      agyArgs: ['acp'],
      cwd: temp,
      stateFile: join(temp, 'apply-false-state.json'),
      modelProvider: true,
      nativeActivityEnabled: false,
      transport: () => tFalse,
    })
    assert.equal(regFalse.length, 1)
    const adapterFalse = regFalse[0].adapter
    assert.equal(adapterFalse.config.nativeActivityEnabled, false)
    let regCountFalse = 0
    await runNativeTurn(adapterFalse, 'sess-apply-false', 'hi', {
      onRegisterActivityCallbacks: () => { regCountFalse += 1 },
    })
    assert.equal(regCountFalse, 0, 'nativeActivityEnabled=false via apply() must register 0 callbacks')
    assert.equal(adapterFalse.nativeActivityListeners.size, 0)
    assert.equal(adapterFalse.getNativeActivity('sess-apply-false').events.length, 0)
  } finally {
    stubFalse.disposeAll()
  }

  // 2) nativeActivityEnabled: true (and omitted) via apply() -> callback registered >= 1
  const regTrue = []
  const stubTrue = makeStubCtx(regTrue)
  try {
    const tTrue = new NativeActivityStubTransport([[
      { sessionUpdate: 'tool_call', toolCallId: 't-1', kind: 'edit', title: 'ok.txt', status: 'completed' },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
    ]])
    await apply(stubTrue.ctx, {
      agyExecutable: 'agy',
      agyArgs: ['acp'],
      cwd: temp,
      stateFile: join(temp, 'apply-true-state.json'),
      modelProvider: true,
      transport: () => tTrue,
    })
    assert.equal(regTrue.length, 1)
    const adapterTrue = regTrue[0].adapter
    assert.equal(adapterTrue.config.nativeActivityEnabled, true)
    let regCountTrue = 0
    await runNativeTurn(adapterTrue, 'sess-apply-true', 'hi', {
      onRegisterActivityCallbacks: () => { regCountTrue += 1 },
    })
    assert.ok(regCountTrue >= 1, 'default nativeActivityEnabled=true via apply() must register callback')
    assert.equal(adapterTrue.getNativeActivity('sess-apply-true').events.length, 1)
  } finally {
    stubTrue.disposeAll()
  }

  // 3) non-boolean nativeActivityEnabled rejected by defaultConfig() and apply()
  for (const bad of ['true', 'false', 1, null]) {
    assert.throws(
      () => defaultConfig({ nativeActivityEnabled: bad }),
      (err) => err instanceof Error && err.message === 'antigravity-bridge: nativeActivityEnabled must be a boolean',
      `defaultConfig must reject ${JSON.stringify(bad)}`,
    )
    const stubBad = makeStubCtx([])
    assert.throws(
      () => apply(stubBad.ctx, { cwd: temp, stateFile: join(temp, 'bad.json'), nativeActivityEnabled: bad }),
      (err) => err instanceof Error && err.message === 'antigravity-bridge: nativeActivityEnabled must be a boolean',
    )
    stubBad.disposeAll()
  }
})
