import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  AgyAcpAdapter,
  ERROR_CODES,
  NO_TOOLS_NOTICE,
  isLoadBearingTool,
  planRequest,
} from '../lib/model-adapter.js'
import { PROVIDER_ID } from '../lib/model-catalog.js'

const temp = mkdtempSync(path.join(tmpdir(), 'agy-tool-scope-'))
const models = ['neon', 'argon', 'hydrogen']

class Transport {
  constructor() {
    this.requests = []
    this.handlers = []
    this.state = {}
    this.counter = 0
    this.closed = false
  }
  start() {}
  close() {
    this.closed = true
  }
  onNotification(fn) {
    this.handlers.push(fn)
    return () => {
      const i = this.handlers.indexOf(fn)
      if (i >= 0) this.handlers.splice(i, 1)
    }
  }
  onRequest(fn) {
    this.requestHandler = fn
    return () => {
      this.requestHandler = null
    }
  }
  notify() {}
  emit(sessionId, text) {
    this.handlers.forEach((fn) =>
      fn({
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text },
          },
        },
      }),
    )
  }
  options(id) {
    const s = this.state[id]
    return [
      {
        id: 'choose-model',
        category: 'model',
        type: 'select',
        currentValue: s.model,
        options: [{ group: 'all', options: models.map((value) => ({ value, name: value })) }],
      },
      {
        id: 'reason',
        category: 'thought_level',
        type: 'select',
        currentValue: s.effort,
        options: ['low', 'high'].map((value) => ({ value, name: value })),
      },
    ]
  }
  async request(method, params, options) {
    this.requests.push({ method, params })
    if (method === 'initialize') {
      return {
        agentCapabilities: {
          sessionCapabilities: { resume: {}, systemPrompt: {} },
        },
      }
    }
    if (method === 'session/new') {
      const sessionId = `session-${++this.counter}`
      this.state[sessionId] = { model: 'neon', effort: 'high' }
      return { sessionId, configOptions: this.options(sessionId) }
    }
    if (method === 'session/resume') {
      this.state[params.sessionId] ??= { model: 'neon', effort: 'high' }
      return { configOptions: this.options(params.sessionId) }
    }
    if (method === 'session/set_config_option') {
      const s = this.state[params.sessionId]
      if (params.configId === 'choose-model') s.model = params.value
      else s.effort = params.value
      return { configOptions: this.options(params.sessionId) }
    }
    if (method === 'session/prompt') {
      this.emit(params.sessionId, 'answer')
      options?.onResponse?.()
      return { stopReason: 'end_turn' }
    }
    throw Error(`unexpected ${method}`)
  }
}

const user = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }] })
const assistant = (id, text = 'answer') => ({ id, role: 'assistant', content: [{ type: 'text', text }] })
const makeRequest = (messages, extra = {}) => ({
  provider: PROVIDER_ID,
  model: 'neon',
  sessionId: 'dsh-1',
  messages,
  ...extra,
})
async function collect(adapter, options) {
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

function assertNoToolsParam(transport) {
  for (const { method, params } of transport.requests) {
    if (params && typeof params === 'object') {
      assert.equal(
        Object.prototype.hasOwnProperty.call(params, 'tools'),
        false,
        `RPC ${method} must never carry a tools property`,
      )
    }
  }
}

let total = 0
let passed = 0
function runCase(name, fn) {
  total += 1
  test(name, async () => {
    await fn()
    passed += 1
  })
}

runCase('T1 普通会话成功：非承重工具被丢弃并注入 NO_TOOLS_NOTICE', () => {
  const plan = planRequest({
    provider: PROVIDER_ID,
    model: 'neon',
    sessionId: 'dsh-1',
    messages: [{ role: 'system', content: 'sys' }, user('u1', 'hi')],
    tools: [{ name: 'read' }, { name: 'write' }, { name: 'bash' }, { name: 'grep' }],
  })
  assert.ok(plan.systemText.includes(NO_TOOLS_NOTICE))
  assert.ok(plan.promptText.includes(NO_TOOLS_NOTICE))
  assert.equal(plan.droppedTools, 4)
  assert.deepEqual(plan.loadBearingTools, [])
})

runCase('T2 承重工具硬拒绝：claim_task 抛出含指引的 UNSUPPORTED_TOOLS', () => {
  assert.throws(
    () =>
      planRequest(
        makeRequest([user('u1', 'hi')], { tools: [{ name: 'claim_task' }] }),
      ),
    (err) => {
      assert.equal(err.code, ERROR_CODES.UNSUPPORTED_TOOLS)
      assert.ok(err.message.includes('claim_task'))
      assert.ok(err.message.includes('antigravity-acp-text'))
      assert.ok(err.message.includes('antigravity_send'))
      return true
    },
  )
})

runCase('T3 负向对照：同一请求只换工具名，结果翻转', () => {
  const buildReq = (toolName) =>
    makeRequest([user('u1', 'hi')], { tools: [{ name: toolName }] })
  assert.throws(() => planRequest(buildReq('claim_task')), {
    code: ERROR_CODES.UNSUPPORTED_TOOLS,
  })
  const acceptedPlan = planRequest(buildReq('read'))
  assert.equal(acceptedPlan.droppedTools, 1)
  assert.equal(isLoadBearingTool('team_task_create'), true)
  assert.equal(isLoadBearingTool('team_task_list'), true)
  assert.equal(isLoadBearingTool('read'), false)
  assert.throws(
    () => planRequest(makeRequest([user('u1', 'hi')], { tools: [{ name: 'team_task_update' }] })),
    (err) => {
      assert.equal(err.code, ERROR_CODES.UNSUPPORTED_TOOLS)
      assert.ok(err.message.includes('team_task_update'))
      return true
    },
  )
  console.log('negative-control: claim_task→rejected, read→accepted')
})

runCase('T4 前缀规则：agent_teams_update_task 硬拒绝且消息含该名', () => {
  assert.throws(
    () =>
      planRequest(
        makeRequest([user('u1', 'hi')], {
          tools: [{ name: 'agent_teams_update_task' }],
        }),
      ),
    (err) => {
      assert.equal(err.code, ERROR_CODES.UNSUPPORTED_TOOLS)
      assert.ok(err.message.includes('agent_teams_update_task'))
      return true
    },
  )
})

runCase('T5 跨轮 systemHash 稳定 + 声明只进 system', async () => {
  const t = new Transport()
  const file = path.join(temp, 'tool-scope-state.json')
  const a = new AgyAcpAdapter({ cwd: temp, nativeStateFile: file, transport: () => t })
  try {
    const turn1Messages = [{ role: 'system', content: 'sys rules' }, user('u1', 'first question')]
    const turn1Req = makeRequest(turn1Messages, {
      tools: [{ name: 'read' }, { name: 'write' }],
    })
    const res1 = await collect(a, turn1Req)
    assert.equal(
      res1.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''),
      'answer',
    )

    const turn2Messages = [...turn1Messages, assistant('a1', 'answer'), user('u2', 'second question')]
    const turn2Req = makeRequest(turn2Messages, {
      tools: [{ name: 'grep' }],
    })
    const res2 = await collect(a, turn2Req)
    assert.equal(
      res2.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''),
      'answer',
    )

    const promptReqs = t.requests.filter((r) => r.method === 'session/prompt')
    assert.equal(promptReqs.length, 2)
    assert.equal(promptReqs[0].params.prompt[0].text, 'first question')
    assert.equal(promptReqs[1].params.prompt[0].text, 'second question')
    for (const req of promptReqs) {
      const txt = req.params.prompt[0].text
      assert.equal(txt.includes(NO_TOOLS_NOTICE), false)
      assert.equal(txt.includes('read,write'), false)
    }

    const newReq = t.requests.find((r) => r.method === 'session/new')
    assert.ok(newReq.params.systemPrompt.content[0].text.includes(NO_TOOLS_NOTICE))

    const p1 = planRequest(turn1Req)
    const p2 = planRequest(turn2Req)
    assert.equal(p1.systemText, p2.systemText)
    const h1 = createHash('sha256').update(p1.systemText).digest('hex')
    const h2 = createHash('sha256').update(p2.systemText).digest('hex')
    assert.equal(h1, h2)
    assertNoToolsParam(t)
  } finally {
    a.dispose()
  }
})

runCase('T6 toolHistory 与 tool/developer 角色拒绝逻辑未被放宽', () => {
  assert.throws(
    () =>
      planRequest(
        makeRequest([user('u1', 'hi')], {
          tools: [],
          toolHistory: { tools: [{ name: 'read' }] },
        }),
      ),
    { code: ERROR_CODES.UNSUPPORTED_TOOLS },
  )
  assert.throws(
    () =>
      planRequest(
        makeRequest([user('u1', 'hi')], {
          tools: [],
          toolHistory: { updates: [{}] },
        }),
      ),
    { code: ERROR_CODES.UNSUPPORTED_TOOLS },
  )
  assert.throws(
    () => planRequest(makeRequest([{ role: 'tool', content: 'res' }, user('u1', 'hi')])),
    { code: ERROR_CODES.UNSUPPORTED_TOOLS },
  )
  assert.throws(
    () => planRequest(makeRequest([{ role: 'developer', content: 'dev' }, user('u1', 'hi')])),
    { code: ERROR_CODES.UNSUPPORTED_DEVELOPER },
  )
})

runCase('T7 声明顺序稳定：连续两次 planRequest 的 systemText 全等且以 NO_TOOLS_NOTICE 结尾', () => {
  const req = makeRequest([{ role: 'system', content: 'sys' }, user('u1', 'hi')], {
    tools: [{ name: 'read' }],
  })
  const p1 = planRequest(req)
  const p2 = planRequest(req)
  assert.equal(p1.systemText, p2.systemText)
  assert.ok(p1.systemText.endsWith(NO_TOOLS_NOTICE))
})

class UserPrefixTransport extends Transport {
  async request(method, params, options) {
    if (method === 'initialize') {
      this.requests.push({ method, params })
      return { agentCapabilities: { sessionCapabilities: { resume: {} } } }
    }
    return super.request(method, params, options)
  }
}

runCase('T8 user-prefix 降级路径：首轮注入声明，第二轮不重复，且 RPC 无 tools 键', async () => {
  const t = new UserPrefixTransport()
  const file = path.join(temp, 'user-prefix-state.json')
  const a = new AgyAcpAdapter({ cwd: temp, nativeStateFile: file, transport: () => t })
  try {
    const turn1Messages = [{ role: 'system', content: 'sys' }, user('u1', 'first question')]
    await collect(a, makeRequest(turn1Messages, { sessionId: 'dsh-up-1', tools: [{ name: 'read' }] }))
    const turn2Messages = [...turn1Messages, assistant('a1', 'answer'), user('u2', 'second question')]
    await collect(a, makeRequest(turn2Messages, { sessionId: 'dsh-up-1', tools: [{ name: 'grep' }] }))

    const newReq = t.requests.find((r) => r.method === 'session/new')
    assert.equal(Object.prototype.hasOwnProperty.call(newReq.params, 'systemPrompt'), false)
    const promptReqs = t.requests.filter((r) => r.method === 'session/prompt')
    assert.equal(promptReqs.length, 2)
    assert.ok(promptReqs[0].params.prompt[0].text.includes(NO_TOOLS_NOTICE))
    assert.equal(promptReqs[1].params.prompt[0].text.includes(NO_TOOLS_NOTICE), false)
    assert.equal(promptReqs[1].params.prompt[0].text, 'second question')
    assertNoToolsParam(t)
  } finally {
    a.dispose()
  }
})

runCase('T9 resume 路径：重建 adapter 走 session/resume 并带声明，prompt 不带声明且 RPC 无 tools 键', async () => {
  const file = path.join(temp, 'resume-state.json')
  const t1 = new Transport()
  const a1 = new AgyAcpAdapter({ cwd: temp, nativeStateFile: file, transport: () => t1 })
  const turn1Messages = [{ role: 'system', content: 'sys' }, user('u1', 'turn one')]
  await collect(a1, makeRequest(turn1Messages, { sessionId: 'dsh-res-1', tools: [{ name: 'read' }] }))
  a1.dispose()

  const t2 = new Transport()
  const a2 = new AgyAcpAdapter({ cwd: temp, nativeStateFile: file, transport: () => t2 })
  try {
    const turn2Messages = [...turn1Messages, assistant('a1', 'answer'), user('u2', 'turn two')]
    await collect(a2, makeRequest(turn2Messages, { sessionId: 'dsh-res-1', tools: [{ name: 'grep' }] }))

    const resumeReq = t2.requests.find((r) => r.method === 'session/resume')
    assert.ok(resumeReq, 'expected session/resume on second adapter')
    assert.equal(t2.requests.some((r) => r.method === 'session/new'), false)
    assert.ok(resumeReq.params.systemPrompt.content[0].text.includes(NO_TOOLS_NOTICE))
    const promptReqs = t2.requests.filter((r) => r.method === 'session/prompt')
    assert.equal(promptReqs.length, 1)
    assert.equal(promptReqs[0].params.prompt[0].text, 'turn two')
    assert.equal(promptReqs[0].params.prompt[0].text.includes(NO_TOOLS_NOTICE), false)
    assert.equal(promptReqs[0].params.prompt[0].text.includes('grep'), false)
    assertNoToolsParam(t2)
  } finally {
    a2.dispose()
  }
})

test.after(() => {
  console.log(`tool-scope-test: ${passed}/${total} passed`)
  rmSync(temp, { recursive: true, force: true })
})
