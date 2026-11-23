import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AcpClient } from '../lib/acp.js'
import { Bridge, defaultConfig } from '../lib/bridge.js'
import { AgyAcpAdapter, planRequest } from '../lib/model-adapter.js'
import { PROVIDER_ID } from '../lib/model-catalog.js'
import { createPanelComponent, createPanelController, createRemoteBridge } from '../client/panel.js'
import { DICTIONARIES, createTranslator } from '../client/locale.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const mockPath = join(ROOT, 'scripts', 'mock-agy-acp.mjs')
const temp = mkdtempSync(join(tmpdir(), 'antigravity-thought-'))
let passed = 0
let failed = 0

test.after(() => {
  rmSync(temp, { recursive: true, force: true })
  console.log(`thought-test: ${passed}/${passed + failed} passed`)
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

function makeBridge(extra = {}) {
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
    ...extra,
  })
  const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  return new Bridge({}, config, noopLogger)
}

let sharedJobView = null

trackedTest('T1: independent channel collects agent_thought_chunk into view.thoughts', async () => {
  const bridge = makeBridge()
  try {
    const begun = bridge.beginSend({
      workspaceRoot: temp,
      agentId: 'agent-T1',
      transport: 'acp',
      message: 'hello thought',
    })
    await bridge.dispatch(begun.job, {
      message: 'hello thought',
      requested: begun.job.requested,
      attachments: [],
      cwd: temp,
    })
    await bridge.waitFor(begun.job, { timeoutMs: 5000 })
    sharedJobView = bridge.view(begun.job)
    assert.ok(sharedJobView.thoughts.length >= 1)
    assert.equal(sharedJobView.thoughts[0].text, 'THOUGHT-SHOULD-NOT-BE-REPLY')
  } finally {
    bridge.dispose()
  }
})

trackedTest('T2: reply and tools exclude thought text', () => {
  assert.ok(sharedJobView)
  assert.ok(sharedJobView.reply.startsWith('MOCK-REPLY:'))
  assert.ok(!sharedJobView.reply.includes('THOUGHT-SHOULD-NOT-BE-REPLY'))
  assert.ok(!sharedJobView.tools.some((t) => String(t).includes('THOUGHT-SHOULD-NOT-BE-REPLY')))
})

trackedTest('T3: thoughtSummary=false disables collection and recordThought', async () => {
  const bridge = makeBridge({ thoughtSummary: false })
  try {
    const begun = bridge.beginSend({
      workspaceRoot: temp,
      agentId: 'agent-T3',
      transport: 'acp',
      message: 'hello disabled',
    })
    await bridge.dispatch(begun.job, {
      message: 'hello disabled',
      requested: begun.job.requested,
      attachments: [],
      cwd: temp,
    })
    await bridge.waitFor(begun.job, { timeoutMs: 5000 })
    assert.equal(bridge.view(begun.job).thoughts.length, 0)
    bridge.recordThought(begun.job, { text: 'direct-should-be-ignored' })
    assert.equal(bridge.view(begun.job).thoughts.length, 0)
  } finally {
    bridge.dispose()
  }
})

trackedTest('T4: recordThought enforces max 20, <=200 chars, deduplication, and ignores whitespace', () => {
  const bridge = makeBridge({ backend: { kind: 'acp', close: () => {} } })
  try {
    const begun = bridge.beginSend({
      workspaceRoot: temp,
      agentId: 'agent-T4',
      transport: 'acp',
      message: 'cap check',
    })
    const job = begun.job
    bridge.recordThought(job, { text: '   ' })
    assert.equal(bridge.view(job).thoughts.length, 0)

    const longText = 'x'.repeat(500)
    bridge.recordThought(job, { text: longText })
    bridge.recordThought(job, { text: longText })
    assert.equal(bridge.view(job).thoughts.length, 1)
    assert.equal(bridge.view(job).thoughts[0].text.length, 200)

    for (let i = 0; i < 25; i++) {
      bridge.recordThought(job, { text: `thought-${i}-${'y'.repeat(250)}` })
    }
    const thoughts = bridge.view(job).thoughts
    assert.ok(thoughts.length <= 20)
    assert.ok(thoughts.every((e) => e.text.length <= 200))
  } finally {
    bridge.dispose()
  }
})

trackedTest('T5: Panel renders single-line thought summary when enabled and hides when disabled', async () => {
  let thoughtSummaryEnabled = true
  const remotePort = createRemoteBridge({
    antigravityBridge: {
      capabilities: async () => ({ ok: true, capabilities: { transports: ['acp'] } }),
      dispatch: async () => ({ ok: true, jobId: 'job-th-1', status: 'accepted', view: { state: 'accepted' } }),
      status: async () => ({ ok: true, view: { state: 'accepted' } }),
      reply: async () => ({ ok: true, available: false }),
      cancel: async () => ({ ok: true }),
      activity: async () => ({
        ok: true,
        jobId: 'job-th-1',
        state: 'accepted',
        events: [],
        thoughts: [{ text: 'THOUGHT-SHOULD-NOT-BE-REPLY' }],
        thoughtSummaryEnabled,
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
  const ctrl = createPanelController({ bridge: remotePort, sessionId: 'sess-th' })
  ctrl.setMessage('hi')
  await ctrl.dispatch()
  await ctrl.refresh()
  await new Promise((r) => setTimeout(r, 20))
  currentState = ctrl.getState()
  const Panel = createPanelComponent({ React: fakeReact, translate: createTranslator(DICTIONARIES, 'zh'), bridge: remotePort })
  const treeOn = Panel({ sessionId: 'sess-th' })
  const regionsOn = findNodes(treeOn, (n) => n.props && n.props['data-thought-region'] !== undefined)
  assert.equal(regionsOn.length, 1)
  assert.ok(textOf(regionsOn[0]).includes('思考概况：THOUGHT-SHOULD-NOT-BE-REPLY'))

  thoughtSummaryEnabled = false
  await ctrl.refresh()
  await new Promise((r) => setTimeout(r, 20))
  currentState = ctrl.getState()
  const treeOff = Panel({ sessionId: 'sess-th' })
  const regionsOff = findNodes(treeOff, (n) => n.props && n.props['data-thought-region'] !== undefined)
  assert.equal(regionsOff.length, 0)
  ctrl.dispose()
})

trackedTest('T6: model-adapter isolates thought chunks from chunks, systemHash, and transport requests', async () => {
  const models = ['neon']
  class StubTransport {
    constructor(thoughtText) {
      this.thoughtText = thoughtText
      this.requests = []
      this.handlers = []
      this.counter = 0
    }
    start() {}
    close() {}
    onNotification(fn) {
      this.handlers.push(fn)
      return () => { const i = this.handlers.indexOf(fn); if (i >= 0) this.handlers.splice(i, 1) }
    }
    onRequest() { return () => {} }
    async request(method, params, options) {
      this.requests.push({ method, params })
      if (method === 'initialize') {
        return { agentCapabilities: { sessionCapabilities: { resume: {}, systemPrompt: {} } } }
      }
      if (method === 'session/new') {
        const sessionId = `s-${++this.counter}`
        return {
          sessionId,
          configOptions: [
            { id: 'choose-model', category: 'model', type: 'select', currentValue: 'neon', options: models.map((v) => ({ value: v, name: v })) },
          ],
        }
      }
      if (method === 'session/set_config_option') {
        return {
          configOptions: [
            { id: 'choose-model', category: 'model', type: 'select', currentValue: 'neon', options: models.map((v) => ({ value: v, name: v })) },
          ],
        }
      }
      if (method === 'session/prompt') {
        for (const fn of this.handlers) {
          fn({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: this.thoughtText } } } })
          fn({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'clean-answer' } } } })
        }
        options?.onResponse?.()
        return { stopReason: 'end_turn' }
      }
      throw new Error(`unexpected ${method}`)
    }
  }

  const runOne = async (thoughtText, idx) => {
    const t = new StubTransport(thoughtText)
    const nativeStateFile = join(temp, `t6-native-state-${idx}.json`)
    const adapter = new AgyAcpAdapter({ cwd: temp, nativeStateFile, transport: () => t })
    const reqOpts1 = {
      provider: PROVIDER_ID,
      sessionId: `s-t6-${idx}`,
      model: 'neon',
      system: 'Stable system prompt.',
      messages: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    }
    const plan1 = planRequest(reqOpts1)
    const chunks = []
    for await (const c of adapter.stream(reqOpts1)) {
      chunks.push(c)
    }

    // Positive proof: default inlineThought=true emits reasoning block containing thoughtText
    const reasoningEnds = chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'reasoning')
    assert.equal(reasoningEnds.length, 1, 'T6: expected 1 reasoning block-end')
    assert.ok(reasoningEnds[0].block.text.includes(thoughtText), 'T6: reasoning block must contain thoughtText')
    const textJoined = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
    assert.equal(textJoined, 'clean-answer')
    assert.equal(textJoined.includes(thoughtText), false, 'T6: text-delta must not contain thoughtText')

    // Whitelist check: ONLY reasoning chunks may contain thoughtText; all other chunks must have 0 hits
    const isReasoningChunk = (c) =>
      (c?.type === 'block-start' && c?.blockType === 'reasoning') ||
      c?.type === 'reasoning-delta' ||
      (c?.type === 'block-end' && c?.block?.type === 'reasoning')
    for (const chunk of chunks.filter((c) => !isReasoningChunk(c))) {
      assert.equal(
        JSON.stringify(chunk).includes(thoughtText),
        false,
        `T6: non-reasoning chunk ${chunk.type} must not contain thoughtText`,
      )
    }

    // Turn 2 with complete history to verify zero cross-turn leakage
    const reqOpts2 = {
      provider: PROVIDER_ID,
      sessionId: `s-t6-${idx}`,
      model: 'neon',
      system: 'Stable system prompt.',
      messages: [
        { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'clean-answer' }] },
        { id: 'u2', role: 'user', content: [{ type: 'text', text: 'follow up' }] },
      ],
    }
    const plan2 = planRequest(reqOpts2)
    t.thoughtText = 'CLEAN-TURN-2'
    for await (const _ of adapter.stream(reqOpts2)) {}

    const serializedReqs = JSON.stringify(t.requests.filter((r) => ['session/new', 'session/resume', 'session/prompt'].includes(r.method)))
    assert.ok(!serializedReqs.includes(thoughtText), 'T6: transport requests must not contain thoughtText')
    assert.equal(JSON.stringify(plan1).includes(thoughtText), false, 'T6: turn 1 planRequest must not contain thoughtText')
    assert.equal(JSON.stringify(plan2).includes(thoughtText), false, 'T6: turn 2 planRequest must not contain thoughtText')
    assert.equal(plan2.systemText.includes(thoughtText), false, 'T6: systemText must not contain thoughtText')
    assert.equal(readFileSync(nativeStateFile, 'utf8').includes(thoughtText), false, 'T6: nativeStateFile must not contain thoughtText')
    adapter.dispose()
    return createHash('sha256').update(plan2.systemText).digest('hex')
  }

  const baselineHash = createHash('sha256').update(planRequest({
    provider: PROVIDER_ID,
    model: 'neon',
    system: 'Stable system prompt.',
    messages: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  }).systemText).digest('hex')
  const h1 = await runOne('SECRET-THOUGHT-ONE', 1)
  const h2 = await runOne('SECRET-THOUGHT-TWO', 2)
  assert.equal(h1, baselineHash)
  assert.equal(h2, baselineHash)
})

trackedTest('T7: throwing onThought callback does not interrupt prompt and increments thoughtCallbackErrors', async () => {
  const client = new AcpClient({ executable: 'agy', args: ['acp'], cwd: temp })
  client.sessions.set('s-cb', { configOptions: [], activePrompt: null, resuming: false })
  client.request = async (_method, _params, opts) => {
    opts?.onSent?.('req-1')
    client.onNotification({
      method: 'session/update',
      params: { sessionId: 's-cb', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'THOUGHT-ERR-TEST' } } },
    })
    client.onNotification({
      method: 'session/update',
      params: { sessionId: 's-cb', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'FINAL-TEXT' } } },
    })
    return { stopReason: 'end_turn' }
  }
  const res = await client.promptSession({
    sessionId: 's-cb',
    prompt: [{ type: 'text', text: 'hi' }],
    onThought: () => { throw new Error('boom') },
  })
  assert.equal(res.stopReason, 'end_turn')
  assert.equal(res.text, 'FINAL-TEXT')
  assert.equal(res.diagnostics.thoughtCallbackErrors, 1)
})

trackedTest('T8: inlineThought=false suppresses reasoning blocks while preserving text and context isolation', async () => {
  const models = ['neon']
  const thoughtText = 'SECRET-THOUGHT-OFF'
  const requests = []
  const handlers = []
  const transport = {
    start() {},
    close() {},
    onNotification(fn) {
      handlers.push(fn)
      return () => { const i = handlers.indexOf(fn); if (i >= 0) handlers.splice(i, 1) }
    },
    onRequest() { return () => {} },
    async request(method, params, options) {
      requests.push({ method, params })
      if (method === 'initialize') return { agentCapabilities: { sessionCapabilities: { resume: {}, systemPrompt: {} } } }
      if (method === 'session/new') {
        return {
          sessionId: 's-t8-acp',
          configOptions: [{ id: 'choose-model', category: 'model', type: 'select', currentValue: 'neon', options: models.map((v) => ({ value: v, name: v })) }],
        }
      }
      if (method === 'session/set_config_option') {
        return { configOptions: [{ id: 'choose-model', category: 'model', type: 'select', currentValue: 'neon', options: models.map((v) => ({ value: v, name: v })) }] }
      }
      if (method === 'session/prompt') {
        for (const fn of handlers) {
          fn({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: thoughtText } } } })
          fn({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'clean-answer' } } } })
        }
        options?.onResponse?.()
        return { stopReason: 'end_turn' }
      }
      throw new Error(`unexpected ${method}`)
    },
  }

  const nativeStateFile = join(temp, 't8-native-state.json')
  const adapter = new AgyAcpAdapter({ cwd: temp, nativeStateFile, inlineThought: false, transport: () => transport })
  try {
    const chunks = []
    for await (const c of adapter.stream({
      provider: PROVIDER_ID,
      sessionId: 's-t8',
      model: 'neon',
      system: 'Stable system prompt.',
      messages: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    })) {
      chunks.push(c)
    }
    assert.equal(chunks.filter((c) => c.type === 'block-start' && c.blockType === 'reasoning').length, 0)
    assert.equal(chunks.filter((c) => c.type === 'reasoning-delta').length, 0)
    assert.equal(chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'reasoning').length, 0)
    assert.equal(JSON.stringify(chunks).includes(thoughtText), false)
    assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'clean-answer')
    assert.equal(JSON.stringify(requests).includes(thoughtText), false)
    assert.equal(readFileSync(nativeStateFile, 'utf8').includes(thoughtText), false)
  } finally {
    adapter.dispose()
  }
})
