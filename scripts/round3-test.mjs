// Round3.a 离线用例：ACP 原生工具事件结构化、正文白名单、绝不发射 tool-call。
//
// 全部使用内存假 Transport，不启动 agy、不产生任何计费请求。
//
// 样本形状的证据强弱（review t21 F-1，诚实边界）：
// - `toolCallId` / `title` / `kind` 的**字段形状**有 `session/request_permission`
//   的权限记录支持（results/round1-live-probe.json 里 `kind=execute` / `kind=edit`）；
// - `status` 字段、以及「`session/update` 的 tool_call 一定带 kind」**都没有证据**：
//   该探针的 fsTrue/fsFalse 两组 `events` 都是空数组、requests 只有
//   initialize 与 session/new，全文没有一条 `session/update`；
// - 本轮没有向真实 agy 发请求核实（零计费），所以下面的 update 序列是**构造值**，
//   用来锁定我们自己的处理语义，不是对 agent 行为的断言。
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AgyAcpAdapter } from '../lib/model-adapter.js'
import { normalizeToolEvent, normalizeToolKind } from '../lib/acp.js'
import { PROVIDER_ID } from '../lib/model-catalog.js'

const temp = mkdtempSync(path.join(tmpdir(), 'agy-round3-'))
test.after(() => { try { rmSync(temp, { recursive: true, force: true }) } catch { /* Windows 可能短暂占用 */ } })

const models = ['neon', 'hydrogen']
const user = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }] })
const request = (messages, extra = {}) => ({ provider: PROVIDER_ID, model: 'neon', sessionId: 'dsh-r3', messages, ...extra })

/**
 * 假 Transport：`script` 是「session/prompt 期间要发的事件序列」。
 * 每个事件是 {update} 或 {request:(sessionId, transport)=>void}。
 */
class ScriptedTransport {
  constructor(script = []) {
    this.script = script
    this.requests = []
    this.handlers = []
    this.state = {}
    this.counter = 0
    this.closed = false
  }
  start() {}
  close() { this.closed = true }
  onNotification(fn) {
    this.handlers.push(fn)
    return () => { const i = this.handlers.indexOf(fn); if (i >= 0) this.handlers.splice(i, 1) }
  }
  onRequest(fn) { this.requestHandler = fn; return () => { this.requestHandler = null } }
  notify() {}
  update(sessionId, update) {
    for (const fn of this.handlers) fn({ method: 'session/update', params: { sessionId, update } })
  }
  emit(sessionId, text) { this.update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }) }
  options(id) {
    const s = this.state[id]
    return [
      { id: 'model', category: 'model', type: 'select', currentValue: s.model, options: [{ group: 'all', options: models.map((value) => ({ value, name: value })) }] },
      { id: 'thought_level', category: 'thought_level', type: 'select', currentValue: s.effort, options: ['low', 'medium'].map((value) => ({ value, name: value })) },
    ]
  }
  async request(method, params, options) {
    this.requests.push({ method, params })
    if (method === 'initialize') return { agentCapabilities: { sessionCapabilities: { resume: {}, systemPrompt: {} } } }
    if (method === 'session/new') {
      const sessionId = `r3-session-${++this.counter}`
      this.state[sessionId] = { model: 'neon', effort: 'medium' }
      return { sessionId, configOptions: this.options(sessionId) }
    }
    if (method === 'session/resume' || method === 'session/load') {
      this.state[params.sessionId] ??= { model: 'neon', effort: 'medium' }
      return { configOptions: this.options(params.sessionId) }
    }
    if (method === 'session/set_config_option') {
      const s = this.state[params.sessionId]
      if (params.configId === 'model') s.model = params.value
      else s.effort = params.value
      return { configOptions: this.options(params.sessionId) }
    }
    if (method === 'session/prompt') {
      for (const step of this.script) {
        if (typeof step.request === 'function') step.request(params.sessionId, this)
        else this.update(params.sessionId, step.update)
      }
      options?.onResponse?.()
      return { stopReason: 'end_turn' }
    }
    throw Error(`unexpected ${method}`)
  }
}

async function collect(adapter, options) {
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

const TOOL_CALL = (id, kind, title, status = 'pending') => ({
  sessionUpdate: 'tool_call', toolCallId: id, kind, title, status,
})
const TOOL_UPDATE = (id, kind, title, status) => ({
  sessionUpdate: 'tool_call_update', toolCallId: id, kind, title, status,
})

// 一次「有工具事件 + thought + 未知 content + 正文」的完整轮次。
const MIXED_SCRIPT = [
  { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'THOUGHT-SHOULD-NOT-LEAK' } } },
  { update: TOOL_CALL('call-1', 'execute', 'powershell: Get-ChildItem', 'in_progress') },
  { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '正文第一段。' } } },
  { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType: 'image/png', data: 'AAAA' } } },
  { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'resource_link', uri: 'file:///x' } } },
  { update: TOOL_UPDATE('call-1', 'execute', 'powershell: Get-ChildItem', 'completed') },
  { update: TOOL_CALL('call-2', 'edit', 'src/app.js', 'completed') },
  { update: TOOL_CALL('call-3', 'read', 'README.md', 'completed') },
  // agent 未来的新 kind：必须落 other，不能丢
  { update: TOOL_CALL('call-4', 'terminal_v2', 'weird new tool', 'completed') },
  { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '正文第二段。' } } },
  { update: { sessionUpdate: 'plan', entries: [{ content: 'step', status: 'pending' }] } },
]

test('normalizeToolKind maps known kinds and folds every unknown value into other without dropping it', () => {
  for (const kind of ['execute', 'edit', 'read', 'other']) assert.equal(normalizeToolKind(kind), kind)
  assert.equal(normalizeToolKind('EXECUTE'), 'execute')
  assert.equal(normalizeToolKind(' execute '), 'execute')
  for (const kind of ['terminal', 'terminal_v2', 'search', 'fetch', '', undefined, null, 42]) {
    assert.equal(normalizeToolKind(kind), 'other')
  }
})

test('normalizeToolEvent keeps toolCallId, normalized kind, title and status, and returns null when an update carries nothing', () => {
  assert.deepEqual(normalizeToolEvent('tool_call', { toolCallId: 'c1', kind: 'execute', title: 'powershell: x', status: 'in_progress' }),
    { toolCallId: 'c1', kind: 'execute', title: 'powershell: x', status: 'in_progress', sessionUpdate: 'tool_call' })
  assert.deepEqual(normalizeToolEvent('tool_call_update', { toolCallId: 'c1', kind: 'weird', title: 'y', status: 'completed' }),
    { toolCallId: 'c1', kind: 'other', title: 'y', status: 'completed', sessionUpdate: 'tool_call_update' })
  // 没有任何 kind 依据（无 update.kind、无 content.kind/type、无继承）时保持
  // 'unknown'，不再伪造成 'other'——否则同一次调用会从 execute 被降级成 other。
  assert.deepEqual(normalizeToolEvent('tool_call_update', { toolCallId: 'c1', status: 'completed' }),
    { toolCallId: 'c1', kind: 'unknown', title: '', status: 'completed', sessionUpdate: 'tool_call_update' })
  assert.equal(normalizeToolEvent('tool_call', { status: 'completed' }), null)
  assert.equal(normalizeToolEvent('tool_call', undefined), null)
})

test('a kind-less update for the same toolCallId inherits the kind seen earlier and never downgrades execute to other', () => {
  const seen = new Map([['c1', 'execute'], ['c2', 'edit']])
  const kindOf = (id) => seen.get(id) ?? ''
  assert.deepEqual(normalizeToolEvent('tool_call_update', { toolCallId: 'c1', status: 'completed' }, kindOf),
    { toolCallId: 'c1', kind: 'execute', title: '', status: 'completed', sessionUpdate: 'tool_call_update' })
  assert.deepEqual(normalizeToolEvent('tool_call_update', { toolCallId: 'c2', status: 'completed' }, kindOf),
    { toolCallId: 'c2', kind: 'edit', title: '', status: 'completed', sessionUpdate: 'tool_call_update' })
  // 没见过的 toolCallId：不猜，保持 unknown
  assert.equal(normalizeToolEvent('tool_call_update', { toolCallId: 'c9', status: 'completed' }, kindOf).kind, 'unknown')
  // 已知继承值也不会把「未知非空 kind」这条规则改掉
  assert.equal(normalizeToolEvent('tool_call_update', { toolCallId: 'c1', kind: 'terminal_v2' }, kindOf).kind, 'other')
  // content 兜底优先于继承（agent 在 content 里自报了类别）
  assert.equal(normalizeToolEvent('tool_call_update', { toolCallId: 'c1', content: { kind: 'read' } }, kindOf).kind, 'read')
})

test('a prompt that dispatches one message still reports its structured tool events and legacy labels', async () => {
  const t = new ScriptedTransport(MIXED_SCRIPT)
  const reports = []
  const a = new AgyAcpAdapter({ cwd: temp, transport: () => t, onToolEvents: (report) => reports.push(report) })
  const chunks = await collect(a, request([user('u1', 'go')]))
  const prompt = t.requests.find((r) => r.method === 'session/prompt')
  assert.ok(prompt, 'one prompt dispatched')
  assert.equal(prompt.params.prompt[0].text, 'go')
  // 名字里承诺的结构化事件与旧标签：真的断言到
  assert.equal(reports.length, 1)
  assert.equal(reports[0].events.length, 5)
  assert.equal(reports[0].diagnostics.toolEvents, 5)
  assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), '正文第一段。正文第二段。')
  a.dispose()
})

test('a throwing tool callback is counted in diagnostics instead of being swallowed silently, and never breaks the turn', async () => {
  const { AcpClient } = await import('../lib/acp.js')
  const client = new AcpClient({ cwd: temp }, { logger: { info() {}, warn() {} } })
  client.sessions.set('s1', { configOptions: [], activePrompt: null })
  const state = {
    requestId: null, text: '', tools: [], toolEvents: [], toolKinds: new Map(), permissions: [],
    diagnostics: { toolEvents: 0, thoughtChunks: 0, nonTextMessageChunks: 0, otherUpdates: 0, toolCallbackErrors: 0, lastToolCallbackError: '' },
    onToolEvent: (event) => { throw new Error(`callback exploded for ${event.toolCallId}`) },
  }
  client.sessions.get('s1').activePrompt = state
  assert.doesNotThrow(() => client.onMessage({
    jsonrpc: '2.0', method: 'session/update',
    params: { sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 'call-x', kind: 'execute', title: 'powershell: x', status: 'completed' } },
  }))
  assert.equal(state.diagnostics.toolCallbackErrors, 1)
  assert.equal(state.diagnostics.lastToolCallbackError, 'callback exploded for call-x')
  assert.equal(state.diagnostics.toolEvents, 1)
  assert.equal(state.toolEvents.length, 1)
})

test('ACP source keeps toolCallId/kind/title/status and pushes exactly one event per tool notification, legacy label included', async () => {
  const { AcpClient } = await import('../lib/acp.js')
  const client = new AcpClient({ cwd: temp }, { logger: { info() {}, warn() {} } })
  // 不启动子进程：直接注册一个假会话并喂通知，等价于已初始化的会话。
  client.sessions.set('s1', { configOptions: [], activePrompt: null })
  client.sessions.get('s1').loading = false
  const state = {
    requestId: null, text: '', tools: [], toolEvents: [], toolKinds: new Map(),
    diagnostics: { toolEvents: 0, thoughtChunks: 0, nonTextMessageChunks: 0, otherUpdates: 0, toolCallbackErrors: 0, lastToolCallbackError: '' },
    permissions: [],
  }
  client.sessions.get('s1').activePrompt = state
  const feed = (update) => client.onMessage({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update } })
  for (const step of MIXED_SCRIPT) feed(step.update)

  // 结构化事件：4 个 tool_call(_update)，call-1 出现两次
  assert.deepEqual(state.toolEvents, [
    { toolCallId: 'call-1', kind: 'execute', title: 'powershell: Get-ChildItem', status: 'in_progress', sessionUpdate: 'tool_call' },
    { toolCallId: 'call-1', kind: 'execute', title: 'powershell: Get-ChildItem', status: 'completed', sessionUpdate: 'tool_call_update' },
    { toolCallId: 'call-2', kind: 'edit', title: 'src/app.js', status: 'completed', sessionUpdate: 'tool_call' },
    { toolCallId: 'call-3', kind: 'read', title: 'README.md', status: 'completed', sessionUpdate: 'tool_call' },
    { toolCallId: 'call-4', kind: 'other', title: 'weird new tool', status: 'completed', sessionUpdate: 'tool_call' },
  ])
  // 旧字符串字段仍在（去重后按出现顺序）
  assert.deepEqual(state.tools, [
    'execute:powershell: Get-ChildItem',
    'edit:src/app.js',
    'read:README.md',
    'terminal_v2:weird new tool',
  ])
  // 正文白名单：只有 type=text 的两段进入正文
  assert.equal(state.text, '正文第一段。正文第二段。')
  // 诊断计数：thought=1、非文本 message chunk=2、其它 update=1、工具事件=5
  assert.deepEqual(state.diagnostics, {
    toolEvents: 5,
    thoughtChunks: 1,
    nonTextMessageChunks: 2,
    otherUpdates: 1,
    toolCallbackErrors: 0,
    lastToolCallbackError: '',
  })

  // F-2 端到端：同一条 tool_call 之后来一条只有 status 的 update，
  // 不得把该 toolCallId 从 execute 降级成 other。
  feed({ sessionUpdate: 'tool_call', toolCallId: 'call-5', kind: 'execute', title: 'powershell: npm test', status: 'in_progress' })
  feed({ sessionUpdate: 'tool_call_update', toolCallId: 'call-5', status: 'completed' })
  const call5 = state.toolEvents.filter((event) => event.toolCallId === 'call-5')
  assert.deepEqual(call5.map((event) => `${event.kind}/${event.status}`), ['execute/in_progress', 'execute/completed'])
  // 未知的非空 kind 仍然归 other（既有规则不变）
  feed({ sessionUpdate: 'tool_call', toolCallId: 'call-6', kind: 'terminal_v2', title: 'future tool' })
  assert.equal(state.toolEvents.at(-1).kind, 'other')
})

test('tool titles, thought chunks and unknown content types never enter the reply text; only text chunks do', async () => {
  const t = new ScriptedTransport(MIXED_SCRIPT)
  const a = new AgyAcpAdapter({ cwd: temp, transport: () => t })
  const chunks = await collect(a, request([user('u1', 'go')]))
  const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(deltas, '正文第一段。正文第二段。')
  for (const banned of ['powershell: Get-ChildItem', 'src/app.js', 'README.md', 'weird new tool', 'THOUGHT-SHOULD-NOT-LEAK', 'image/png', 'file:///x']) {
    assert.ok(!deltas.includes(banned), `reply text must not contain ${banned}`)
  }
  const end = chunks.find((c) => c.type === 'block-end')
  assert.deepEqual(end.block, { type: 'text', text: '正文第一段。正文第二段。' })
  const finish = chunks.find((c) => c.type === 'finish')
  assert.deepEqual(finish.reason, { kind: 'stop' })
  a.dispose()
})

test('a turn full of native tool events emits only text chunks and one final message: no tool-call shape at all', async () => {
  const t = new ScriptedTransport(MIXED_SCRIPT)
  const a = new AgyAcpAdapter({ cwd: temp, transport: () => t })
  const chunks = await collect(a, request([user('u1', 'go')]))
  const shapes = chunks.map((c) => `${c.type}/${c.index ?? ''}/emit=${c.emit ?? ''}`)
  assert.deepEqual([...new Set(chunks.map((c) => c.type))].sort(), ['block-end', 'block-start', 'finish', 'text-delta'])
  for (const chunk of chunks) {
    assert.ok(chunk.type !== 'tool-call', `no tool-call chunk (got ${JSON.stringify(chunk)})`)
    assert.ok(chunk.type !== 'tool-call-delta', `no tool-call-delta chunk (got ${JSON.stringify(chunk)})`)
    // 任何 chunk 里都不能出现 tool-call 形状的 block/emit 字段
    if (chunk.block) assert.equal(chunk.block.type, 'text')
    assert.ok(!('emit' in chunk) || chunk.emit === undefined, `chunk must not carry emit (${shapes.join(', ')})`)
    assert.ok(!('toolCall' in chunk) && !('toolName' in chunk), `chunk must not carry tool identity (${JSON.stringify(chunk)})`)
  }
  const blocks = chunks.filter((c) => c.type === 'block-start' || c.type === 'block-end')
  assert.equal(blocks.length, 2, 'exactly one text block')
  assert.equal(chunks.filter((c) => c.type === 'block-start').length, 1)
  assert.equal(chunks.filter((c) => c.type === 'finish').length, 1)
  a.dispose()
})

test('tool events reach the diagnostic sink only, with dedup-free structured fields and the text whitelist counters', async () => {
  const t = new ScriptedTransport(MIXED_SCRIPT)
  const reports = []
  const a = new AgyAcpAdapter({ cwd: temp, transport: () => t, onToolEvents: (report) => reports.push(report) })
  await collect(a, request([user('u1', 'go')]))
  assert.equal(reports.length, 1, 'one diagnostic report per turn')
  const [report] = reports
  assert.equal(report.events.length, 5)
  assert.deepEqual(report.events.map((e) => `${e.toolCallId}/${e.kind}/${e.status}`), [
    'call-1/execute/in_progress',
    'call-1/execute/completed',
    'call-2/edit/completed',
    'call-3/read/completed',
    'call-4/other/completed',
  ])
  assert.deepEqual(report.diagnostics, { toolEvents: 5, thoughtChunks: 1, nonTextMessageChunks: 2, otherUpdates: 1 })
  // 诊断报告不是 turn 结果：正文仍然是白名单后的两段
  assert.ok(!JSON.stringify(report.events).includes('THOUGHT-SHOULD-NOT-LEAK'))
  a.dispose()
})