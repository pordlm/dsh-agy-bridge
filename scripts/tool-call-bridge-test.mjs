import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig } from '../lib/bridge.js'
import { apply } from '../lib/index.js'
import {
  AgyAcpAdapter,
  AgyAcpError,
  ERROR_CODES,
  TOOL_BRIDGE_ALLOWLIST,
  TOOL_BRIDGE_CORRECTION,
  canonicalJson,
  parseToolCalls,
  planRequest,
  renderToolBridgeNotice,
} from '../lib/model-adapter.js'

const VALID_STREAM_CHUNK_TYPES = new Set([
  'block-start',
  'text-delta',
  'reasoning-delta',
  'tool-call-delta',
  'block-end',
  'usage',
  'finish',
])

function user(text, id = 'u-1') {
  return { id, role: 'user', content: [{ type: 'text', text }] }
}

function assistant(content, id = 'a-1') {
  return {
    id,
    role: 'assistant',
    content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
  }
}

function toolResult(callId, text, isError = false, id = 't-1') {
  return {
    id,
    role: 'tool',
    toolCallId: callId,
    source: { kind: 'tool', callId },
    isError,
    content: [{ type: 'text', text }],
  }
}

class StubTransport {
  constructor(responses, options = {}) {
    this.responses = [...responses]
    this.prompts = []
    this.handlers = new Set()
    this.requestHandlers = []
    this.responded = []
    this.permissionOptions = options.permissionOptions ?? null
    this.closed = false
    this.isClosed = false
    this.selectedModel = 'gpt-5'
    this.selectedThought = 'medium'
  }

  onNotification(fn) {
    this.handlers.add(fn)
    return () => this.handlers.delete(fn)
  }

  onRequest(fn) {
    this.requestHandlers.push(fn)
    return () => {
      const i = this.requestHandlers.indexOf(fn)
      if (i >= 0) this.requestHandlers.splice(i, 1)
    }
  }

  respond(id, payload) {
    this.responded.push({ id, payload })
  }

  start() {}

  async request(method, params, opts) {
    if (method === 'initialize') {
      return {
        agentCapabilities: { sessionCapabilities: { resume: true }, loadSession: true },
        models: [{ id: 'gpt-5', name: 'GPT-5' }],
      }
    }
    if (method === 'session/new' || method === 'session/resume') {
      return {
        sessionId: params.sessionId ?? 'acp-sess-1',
        configOptions: [
          {
            id: 'model',
            category: 'model',
            currentValue: this.selectedModel,
            options: [
              { value: 'gpt-5', name: 'GPT-5' },
              { value: 'test-model', name: 'Test Model' },
            ],
          },
          {
            id: 'thought',
            category: 'thought_level',
            currentValue: this.selectedThought,
            options: [{ value: 'medium', name: 'Medium' }],
          },
        ],
      }
    }
    if (method === 'session/set_config_option') {
      if (params.configId === 'model') this.selectedModel = params.value
      if (params.configId === 'thought') this.selectedThought = params.value
      return {
        configOptions: [
          {
            id: 'model',
            category: 'model',
            currentValue: this.selectedModel,
            options: [
              { value: 'gpt-5', name: 'GPT-5' },
              { value: 'test-model', name: 'Test Model' },
            ],
          },
          {
            id: 'thought',
            category: 'thought_level',
            currentValue: this.selectedThought,
            options: [{ value: 'medium', name: 'Medium' }],
          },
        ],
      }
    }
    if (method === 'session/prompt') {
      this.prompts.push(params)
      if (Array.isArray(this.permissionOptions)) {
        for (const fn of this.requestHandlers) {
          fn({
            id: 'perm-1',
            method: 'session/request_permission',
            params: { sessionId: params.sessionId, options: this.permissionOptions },
          })
        }
      }
      const replyText = this.responses.shift() ?? ''
      for (const fn of this.handlers) {
        fn({
          method: 'session/update',
          params: {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: replyText },
            },
          },
        })
      }
      opts?.onResponse?.()
      return { stopReason: 'end_turn' }
    }
    throw new Error(`Unexpected method: ${method}`)
  }

  notify() {}

  close() {
    this.closed = true
    this.isClosed = true
  }
}

async function collect(adapter, options) {
  const chunks = []
  for await (const chunk of adapter.stream(options)) {
    assert.ok(
      VALID_STREAM_CHUNK_TYPES.has(chunk.type),
      `Unexpected StreamChunk type: ${JSON.stringify(chunk.type)}`,
    )
    chunks.push(chunk)
  }
  return chunks
}

const CLAIM_TOOL = {
  name: 'claim_task',
  description: 'Claim a team task',
  inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
}

const UPDATE_TOOL = {
  name: 'update_task',
  description: 'Update a team task',
  inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, status: { type: 'string' } } },
}

test('T1: acpToolBridge disabled by default rejects claim_task and update_task', () => {
  const adapter = new AgyAcpAdapter({ transport: () => new StubTransport([]) })
  assert.equal(adapter.config.acpToolBridge, false)
  assert.throws(
    () => planRequest({ messages: [user('hi')], tools: [CLAIM_TOOL] }),
    (err) => err instanceof AgyAcpError && err.code === ERROR_CODES.UNSUPPORTED_TOOLS,
  )
  assert.throws(
    () => planRequest({ messages: [user('hi')], tools: [UPDATE_TOOL] }, { acpToolBridge: false }),
    (err) => err instanceof AgyAcpError && err.code === ERROR_CODES.UNSUPPORTED_TOOLS,
  )
})

test('T2: acpToolBridge enabled accepts claim_task/update_task with deterministic notice and systemHash', () => {
  assert.deepEqual(TOOL_BRIDGE_ALLOWLIST, ['claim_task', 'update_task'])
  const p1 = planRequest(
    { system: 'You are a member.', messages: [user('work')], tools: [CLAIM_TOOL, UPDATE_TOOL] },
    { acpToolBridge: true },
  )
  const p2 = planRequest(
    { system: 'You are a member.', messages: [user('work')], tools: [UPDATE_TOOL, CLAIM_TOOL] },
    { acpToolBridge: true },
  )
  assert.equal(p1.bridgedTools.length, 2)
  assert.equal(p1.droppedTools, 0)
  assert.ok(p1.systemText.includes(renderToolBridgeNotice([CLAIM_TOOL, UPDATE_TOOL])))
  const h1 = createHash('sha256').update(p1.systemText).digest('hex')
  const h2 = createHash('sha256').update(p2.systemText).digest('hex')
  assert.equal(h1, h2)
})

test('T3: acpToolBridge enabled drops disallowed team tool create_task and discloses it in systemText', () => {
  const plan = planRequest(
    { messages: [user('hi')], tools: [CLAIM_TOOL, { name: 'create_task' }] },
    { acpToolBridge: true },
  )
  assert.deepEqual(plan.bridgedTools.map((t) => t.name), ['claim_task'])
  assert.equal(plan.droppedTools, 1)
  assert.ok(plan.systemText.includes('create_task'))
  assert.ok(plan.systemText.includes('不要尝试调用'))
})

test('T4: acpToolBridge enabled drops non-allowlisted tool read and discloses it in systemText', () => {
  const plan = planRequest(
    { messages: [user('hi')], tools: [{ name: 'read' }] },
    { acpToolBridge: true },
  )
  assert.deepEqual(plan.bridgedTools, [])
  assert.equal(plan.droppedTools, 1)
  assert.ok(plan.systemText.includes('read'))
  assert.ok(plan.systemText.includes('本次没有可用的团队工具'))
  assert.ok(plan.systemText.includes('不要尝试调用'))
})

test('T5: valid standalone tool_call fence emits tool-call chunk with deterministic callId and tool-calls finish', async () => {
  const reply = [
    'I will claim the task now.',
    '```tool_call',
    '{"name":"claim_task","arguments":{"owner":"member-a","taskId":"t-42"}}',
    '```',
  ].join('\n')
  const transport = new StubTransport([reply])
  const adapter = new AgyAcpAdapter({ acpToolBridge: true, transport: () => transport })

  const chunks = await collect(adapter, {
    sessionId: 's-t5',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('please claim t-42', 'u-1')],
    tools: [CLAIM_TOOL, UPDATE_TOOL],
  })

  const expectedArgs = canonicalJson({ taskId: 't-42', owner: 'member-a' })
  const expectedId = `call-${createHash('sha256').update(`claim_task|${expectedArgs}`).digest('hex').slice(0, 20)}`

  const textEnd = chunks.find((c) => c.type === 'block-end' && c.block.type === 'text')
  assert.equal(textEnd?.block.text, 'I will claim the task now.')

  const toolDelta = chunks.find((c) => c.type === 'tool-call-delta')
  assert.equal(toolDelta?.id, expectedId)
  assert.equal(toolDelta?.name, 'claim_task')
  assert.equal(toolDelta?.argumentsDelta, expectedArgs)

  const toolEnd = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
  assert.deepEqual(toolEnd?.block, {
    type: 'tool-call',
    id: expectedId,
    name: 'claim_task',
    arguments: expectedArgs,
  })

  const finish = chunks.at(-1)
  assert.deepEqual(finish, { type: 'finish', reason: { kind: 'tool-calls' } })
  assert.deepEqual(adapter.bridgeCalls.get(expectedId), { name: 'claim_task', arguments: expectedArgs })
})

test('T6: malformed JSON in tool_call fence fails closed and appends TOOL_BRIDGE_CORRECTION', async () => {
  const reply = ['```tool_call', '{not valid json', '```'].join('\n')
  const parsed = parseToolCalls(reply)
  assert.equal(parsed.problem, 'json')
  assert.equal(parsed.calls.length, 0)

  const adapter = new AgyAcpAdapter({ acpToolBridge: true, transport: () => new StubTransport([reply]) })
  const chunks = await collect(adapter, {
    sessionId: 's-t6',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('go', 'u-1')],
    tools: [CLAIM_TOOL],
  })
  assert.equal(chunks.some((c) => c.type === 'tool-call-delta'), false)
  const textEnd = chunks.find((c) => c.type === 'block-end' && c.block.type === 'text')
  assert.ok(textEnd?.block.text.includes(TOOL_BRIDGE_CORRECTION))
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('T7: unknown tool inside tool_call fence fails closed with problem=unknown_tool', async () => {
  const reply = ['```tool_call', '{"name":"create_task","arguments":{"title":"x"}}', '```'].join('\n')
  const parsed = parseToolCalls(reply)
  assert.equal(parsed.problem, 'unknown_tool')
  assert.equal(parsed.calls.length, 0)

  const adapter = new AgyAcpAdapter({ acpToolBridge: true, transport: () => new StubTransport([reply]) })
  const chunks = await collect(adapter, {
    sessionId: 's-t7',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('go', 'u-1')],
    tools: [CLAIM_TOOL],
  })
  assert.equal(chunks.some((c) => c.type === 'tool-call-delta'), false)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('T8: multiple tool_call fences fail closed with problem=count', async () => {
  const reply = [
    '```tool_call',
    '{"name":"claim_task","arguments":{"taskId":"1"}}',
    '```',
    '```tool_call',
    '{"name":"update_task","arguments":{"taskId":"1"}}',
    '```',
  ].join('\n')
  const parsed = parseToolCalls(reply)
  assert.equal(parsed.problem, 'count')
  assert.equal(parsed.calls.length, 0)

  const adapter = new AgyAcpAdapter({ acpToolBridge: true, transport: () => new StubTransport([reply]) })
  const chunks = await collect(adapter, {
    sessionId: 's-t8',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('go', 'u-1')],
    tools: [CLAIM_TOOL, UPDATE_TOOL],
  })
  assert.equal(chunks.some((c) => c.type === 'tool-call-delta'), false)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('T9: bare tool_call mention in prose fails closed with problem=inline_mention', async () => {
  const reply = 'Please see my tool_call below without a fence.'
  const parsed = parseToolCalls(reply)
  assert.equal(parsed.problem, 'inline_mention')
  assert.equal(parsed.calls.length, 0)

  const adapter = new AgyAcpAdapter({ acpToolBridge: true, transport: () => new StubTransport([reply]) })
  const chunks = await collect(adapter, {
    sessionId: 's-t9',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('go', 'u-1')],
    tools: [CLAIM_TOOL],
  })
  assert.equal(chunks.some((c) => c.type === 'tool-call-delta'), false)
  const textEnd = chunks.find((c) => c.type === 'block-end' && c.block.type === 'text')
  assert.ok(textEnd?.block.text.includes(TOOL_BRIDGE_CORRECTION))
})

test('T10: role=tool with isError=false feeds back as text without polluting history', async () => {
  const callReply = [
    'Claiming now.',
    '```tool_call',
    '{"name":"claim_task","arguments":{"taskId":"t-10"}}',
    '```',
  ].join('\n')
  const transport = new StubTransport([callReply, 'Task claimed, proceeding.'])
  const adapter = new AgyAcpAdapter({ acpToolBridge: true, transport: () => transport })

  const c1 = await collect(adapter, {
    sessionId: 's-t10',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('start', 'u-1')],
    tools: [CLAIM_TOOL, UPDATE_TOOL],
  })
  const toolBlock = c1.find((c) => c.type === 'block-end' && c.block.type === 'tool-call').block

  const c2 = await collect(adapter, {
    sessionId: 's-t10',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [
      user('start', 'u-1'),
      assistant([{ type: 'text', text: 'Claiming now.' }, toolBlock], 'a-1'),
      toolResult(toolBlock.id, '{"ok":true,"taskId":"t-10"}', false, 't-1'),
    ],
    tools: [CLAIM_TOOL, UPDATE_TOOL],
  })
  assert.equal(transport.prompts.length, 2)
  assert.ok(transport.prompts[1].prompt[0].text.includes('tool=claim_task'))
  assert.ok(transport.prompts[1].prompt[0].text.includes('status=completed'))
  assert.ok(transport.prompts[1].prompt[0].text.includes('{"ok":true,"taskId":"t-10"}'))
  assert.equal(adapter.nativeSessions['s-t10'].history.length, 2)
  assert.deepEqual(c2.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('T11: role=tool with isError=true negative control and dispose() clears bridgeCalls', async () => {
  const callReply = [
    '```tool_call',
    '{"name":"update_task","arguments":{"taskId":"t-11","status":"done"}}',
    '```',
  ].join('\n')
  const transport = new StubTransport([callReply, 'Acknowledged error.'])
  const adapter = new AgyAcpAdapter({ acpToolBridge: true, transport: () => transport })

  const c1 = await collect(adapter, {
    sessionId: 's-t11',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('finish t-11', 'u-1')],
    tools: [CLAIM_TOOL, UPDATE_TOOL],
  })
  const toolBlock = c1.find((c) => c.type === 'block-end' && c.block.type === 'tool-call').block
  assert.equal(adapter.bridgeCalls.size, 1)

  const msgs2 = [
    user('finish t-11', 'u-1'),
    assistant([toolBlock], 'a-1'),
    toolResult(toolBlock.id, 'task not owned by caller', true, 't-1'),
  ]
  const plan2 = planRequest({ messages: msgs2, tools: [CLAIM_TOOL, UPDATE_TOOL] }, { ...adapter.config, toolNames: adapter.bridgeCalls })
  assert.equal(plan2.history.some((h) => h.role === 'tool'), false)

  const c2 = await collect(adapter, {
    sessionId: 's-t11',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: msgs2,
    tools: [CLAIM_TOOL, UPDATE_TOOL],
  })
  assert.ok(transport.prompts[1].prompt[0].text.includes('tool=update_task'))
  assert.ok(transport.prompts[1].prompt[0].text.includes('status=failed'))
  assert.ok(transport.prompts[1].prompt[0].text.includes('task not owned by caller'))
  assert.equal(adapter.nativeSessions['s-t11'].history.length, 2)
  assert.deepEqual(c2.at(-1), { type: 'finish', reason: { kind: 'stop' } })

  adapter.dispose()
  assert.equal(adapter.bridgeCalls.size, 0)
})

test('T12: missing toolName and empty bridgeCalls falls back to tool=unknown without throwing or faking role=tool', () => {
  const plan = planRequest(
    {
      messages: [
        user('start', 'u-1'),
        assistant([{ type: 'tool-call', id: 'call-missing', name: 'claim_task', arguments: '{}' }], 'a-1'),
        toolResult('call-missing', 'orphan result', false, 't-1'),
      ],
      tools: [CLAIM_TOOL],
    },
    { acpToolBridge: true, toolNames: new Map() },
  )
  assert.ok(plan.userText.includes('tool=unknown'))
  assert.ok(plan.userText.includes('status=completed'))
  assert.ok(plan.userText.includes('orphan result'))
  assert.equal(plan.history.some((h) => h.role === 'tool'), false)
  assert.equal(plan.history.length, 2)
})

test('T13: apply() wires acpToolBridge=true to adapter and streams bridged tool prompt; default/invalid values stay false', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'antigravity-toolbridge-'))
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
        if (name === 'workingDirectory') return { cwd: tempDir }
        return undefined
      },
      agents: { get: () => undefined },
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

  const transports = []
  const makeTransport = (responses = []) => () => {
    const t = new StubTransport(responses)
    transports.push(t)
    return t
  }

  try {
    // (a) & (b): acpToolBridge: true
    const regTrue = []
    const stubTrue = makeStubCtx(regTrue)
    try {
      await apply(stubTrue.ctx, {
        agyExecutable: 'agy',
        agyArgs: ['acp'],
        cwd: tempDir,
        stateFile: join(tempDir, 'state-true.json'),
        modelProvider: true,
        transport: makeTransport(['好的，我先领取任务。']),
        acpToolBridge: true,
      })
      assert.equal(regTrue.length, 1)
      const adapterTrue = regTrue[0].adapter
      assert.equal(adapterTrue.config.acpToolBridge, true)

      const chunks = await collect(adapterTrue, {
        tools: [{ name: 'claim_task', description: 'claim', parameters: { type: 'object', properties: {} } }],
        messages: [user('请领任务')],
        model: 'test-model',
        sessionId: undefined,
      })
      assert.ok(chunks.some((c) => c.type === 'finish' && c.reason.kind === 'stop'))
      const sentPrompt = transports.at(-1)?.prompts?.[0]?.prompt?.[0]?.text ?? ''
      assert.ok(sentPrompt.includes('claim_task'))
      assert.ok(sentPrompt.includes('```tool_call'))
    } finally {
      stubTrue.disposeAll()
    }

    // (c): default (omitted acpToolBridge) -> false, rejects claim_task
    const regDefault = []
    const stubDefault = makeStubCtx(regDefault)
    try {
      await apply(stubDefault.ctx, {
        agyExecutable: 'agy',
        agyArgs: ['acp'],
        cwd: tempDir,
        stateFile: join(tempDir, 'state-default.json'),
        modelProvider: true,
        transport: makeTransport([]),
      })
      assert.equal(regDefault.length, 1)
      const adapterDefault = regDefault[0].adapter
      assert.equal(adapterDefault.config.acpToolBridge, false)
      await assert.rejects(
        () =>
          collect(adapterDefault, {
            tools: [{ name: 'claim_task', description: 'claim', parameters: { type: 'object', properties: {} } }],
            messages: [user('请领任务')],
            model: 'test-model',
            sessionId: undefined,
          }),
        (err) => err instanceof AgyAcpError && err.code === ERROR_CODES.UNSUPPORTED_TOOLS,
      )
    } finally {
      stubDefault.disposeAll()
    }

    // (d): invalid non-boolean values ('true', 1) are rejected at apply() / defaultConfig
  } finally {
    for (const t of transports) t.close()
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('T14: apply() rejects non-boolean acpToolBridge="true" and preserves explicit acpToolBridge=false', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'antigravity-toolbridge-t14-'))
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
        if (name === 'workingDirectory') return { cwd: tempDir }
        return undefined
      },
      agents: { get: () => undefined },
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
  try {
    for (const badValue of ['true', 1, null]) {
      const stubBad = makeStubCtx([])
      await assert.rejects(
        async () =>
          apply(stubBad.ctx, {
            agyExecutable: 'agy',
            agyArgs: ['acp'],
            cwd: tempDir,
            stateFile: join(tempDir, `state-bad-${String(badValue)}.json`),
            modelProvider: true,
            acpToolBridge: badValue,
          }),
        /acpToolBridge.*boolean/,
      )
      stubBad.disposeAll()
    }

    const regFalse = []
    const stubFalse = makeStubCtx(regFalse)
    try {
      await apply(stubFalse.ctx, {
        agyExecutable: 'agy',
        agyArgs: ['acp'],
        cwd: tempDir,
        stateFile: join(tempDir, 'state-false.json'),
        modelProvider: true,
        acpToolBridge: false,
      })
      assert.equal(regFalse.length, 1)
      assert.equal(regFalse[0].adapter.config.acpToolBridge, false)
    } finally {
      stubFalse.disposeAll()
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('T15: planRequest clears prior toolResults across user/assistant turns and keeps only trailing turn results', () => {
  const plan = planRequest(
    {
      messages: [
        user('turn 1', 'u-1'),
        assistant([{ type: 'tool-call', id: 'c1', name: 'claim_task', arguments: '{"taskId":"1"}' }], 'a-1'),
        toolResult('c1', 'OLD-TOOL-RESULT-1', false, 'tr-1'),
        user('turn 2', 'u-2'),
        assistant([{ type: 'tool-call', id: 'c2', name: 'claim_task', arguments: '{"taskId":"2"}' }], 'a-2'),
        toolResult('c2', 'NEW-TOOL-RESULT-2', false, 'tr-2'),
      ],
      tools: [CLAIM_TOOL],
    },
    { acpToolBridge: true, toolNames: new Map([['c1', 'claim_task'], ['c2', 'claim_task']]) },
  )
  assert.equal(plan.toolResults.length, 1)
  assert.ok(plan.toolResults[0].text.includes('NEW-TOOL-RESULT-2'))
  assert.ok(plan.userText.includes('NEW-TOOL-RESULT-2'))
  assert.equal(plan.promptText.includes('OLD-TOOL-RESULT-1'), false)
})

test('T16: stream() enforces per-request bridgedTools allowlist and fails closed on update_task when only claim_task is provided', async () => {
  const reply = ['```tool_call', '{"name":"update_task","arguments":{}}', '```'].join('\n')
  assert.equal(parseToolCalls(reply, ['claim_task']).problem, 'unknown_tool')

  const adapter = new AgyAcpAdapter({ acpToolBridge: true, transport: () => new StubTransport([reply]) })
  const chunks = await collect(adapter, {
    sessionId: 's-t16',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('go', 'u-1')],
    tools: [CLAIM_TOOL],
  })
  assert.equal(chunks.some((c) => c.type === 'tool-call-delta'), false)
  const textEnd = chunks.find((c) => c.type === 'block-end' && c.block.type === 'text')
  assert.ok(textEnd?.block.text.includes(TOOL_BRIDGE_CORRECTION))
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('T17: parseToolCalls fails closed with problem=unknown_fields when extra top-level keys exist', () => {
  const reply = ['```tool_call', '{"name":"claim_task","arguments":{},"extra":123}', '```'].join('\n')
  const parsed = parseToolCalls(reply, ['claim_task'])
  assert.equal(parsed.problem, 'unknown_fields')
  assert.equal(parsed.calls.length, 0)
})

test('T18: orphan tool result before a trailing user message is concatenated into userText/promptText instead of dropped', () => {
  const plan = planRequest(
    {
      messages: [
        user('turn 1', 'u-1'),
        assistant([{ type: 'tool-call', id: 'c1', name: 'claim_task', arguments: '{}' }], 'a-1'),
        toolResult('c1', 'ORPHAN-RESULT', false, 'tr-1'),
        user('next question', 'u-2'),
      ],
      tools: [CLAIM_TOOL],
    },
    { acpToolBridge: true, toolNames: new Map([['c1', 'claim_task']]) },
  )
  assert.equal(plan.toolResults.length, 0)
  assert.ok(plan.promptText.includes('ORPHAN-RESULT'))
  assert.ok(plan.promptText.includes('next question'))

  const plan2 = planRequest(
    {
      messages: [
        user('turn 1', 'u-1'),
        assistant([{ type: 'tool-call', id: 'c1', name: 'claim_task', arguments: '{}' }], 'a-1'),
        toolResult('c1', 'ORPHAN-RESULT', false, 'tr-1'),
        user('next question', 'u-2'),
        assistant('handled', 'a-2'),
        user('after handled', 'u-3'),
      ],
      tools: [CLAIM_TOOL],
    },
    { acpToolBridge: true, toolNames: new Map([['c1', 'claim_task']]) },
  )
  assert.equal(plan2.userText, 'after handled')
  assert.equal(String(plan2.promptText).includes('ORPHAN-RESULT'), false)
  assert.equal(plan2.toolResults.length, 0)
})

test('T19: a tool result consumed by the following assistant turn is not replayed in a later user turn', () => {
  const plan = planRequest(
    {
      messages: [
        user('turn 1', 'u-1'),
        assistant([{ type: 'tool-call', id: 'c1', name: 'claim_task', arguments: '{}' }], 'a-1'),
        toolResult('c1', 'CONSUMED', false, 'tr-1'),
        assistant('done', 'a-2'),
        user('next', 'u-2'),
      ],
      tools: [CLAIM_TOOL],
    },
    { acpToolBridge: true, toolNames: new Map([['c1', 'claim_task']]) },
  )
  assert.equal(plan.userText, 'next')
  assert.equal(plan.promptText.includes('CONSUMED'), false)
  assert.equal(plan.toolResults.length, 0)
})

test('T20: real member catalog splits prefixed claim/update and drops extra tools order-independently', () => {
  const realCatalog = [
    { name: 'agent_teams_claim_task', description: 'claim', inputSchema: { type: 'object' } },
    { name: 'agent_teams_update_task', description: 'update', inputSchema: { type: 'object' } },
    { name: 'agent_teams_send_message', description: 'msg', inputSchema: { type: 'object' } },
    { name: 'agent_teams_status', description: 'status', inputSchema: { type: 'object' } },
    { name: 'send_message', description: 'msg2', inputSchema: { type: 'object' } },
  ]
  const plan1 = planRequest(
    { messages: [user('hello', 'u-1')], tools: realCatalog },
    { acpToolBridge: true },
  )
  const plan2 = planRequest(
    { messages: [user('hello', 'u-1')], tools: [...realCatalog].reverse() },
    { acpToolBridge: true },
  )
  assert.deepEqual(
    plan1.bridgedTools.map((t) => t.name),
    ['agent_teams_claim_task', 'agent_teams_update_task'],
  )
  // bridgedTools 保持传入顺序，逆序输入后比较排序后的名字集合
  assert.deepEqual(
    plan2.bridgedTools.map((t) => t.name).sort(),
    ['agent_teams_claim_task', 'agent_teams_update_task'].sort(),
  )
  assert.equal(plan1.droppedTools, 3)
  assert.equal(plan2.droppedTools, 3)

  const iSend = plan1.systemText.indexOf('agent_teams_send_message')
  const iStatus = plan1.systemText.indexOf('agent_teams_status')
  const iBareSend = plan1.systemText.indexOf('send_message', iStatus)
  assert.ok(iSend >= 0 && iStatus > iSend && iBareSend > iStatus)
  assert.ok(plan1.systemText.includes('不要尝试调用'))

  assert.equal(plan1.systemText, plan2.systemText)
  const h1 = createHash('sha256').update(plan1.systemText).digest('hex')
  const h2 = createHash('sha256').update(plan2.systemText).digest('hex')
  assert.equal(h1, h2)
})

test('T21: fence calling a dropped tool agent_teams_send_message fails closed with unknown_tool', async () => {
  const reply = [
    '```tool_call',
    '{"name":"agent_teams_send_message","arguments":{"text":"hi"}}',
    '```',
  ].join('\n')
  const parsed = parseToolCalls(reply, ['agent_teams_claim_task', 'agent_teams_update_task'])
  assert.equal(parsed.problem, 'unknown_tool')
  assert.equal(parsed.calls.length, 0)

  const realCatalog = [
    { name: 'agent_teams_claim_task', description: 'claim', inputSchema: { type: 'object' } },
    { name: 'agent_teams_update_task', description: 'update', inputSchema: { type: 'object' } },
    { name: 'agent_teams_send_message', description: 'msg', inputSchema: { type: 'object' } },
    { name: 'agent_teams_status', description: 'status', inputSchema: { type: 'object' } },
    { name: 'send_message', description: 'msg2', inputSchema: { type: 'object' } },
  ]
  const adapter = new AgyAcpAdapter({ acpToolBridge: true, transport: () => new StubTransport([reply]) })
  const chunks = await collect(adapter, {
    sessionId: 's-t21',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('hello', 'u-1')],
    tools: realCatalog,
  })
  assert.equal(chunks.some((c) => c.type === 'tool-call-delta'), false)
  const textEnd = chunks.find((c) => c.type === 'block-end' && c.block.type === 'text')
  assert.ok(textEnd?.block.text.includes(TOOL_BRIDGE_CORRECTION))
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('T22: acpToolBridge ignores 218-entry toolHistory.tools cleanly with identical systemHash and promptText', () => {
  const decl218 = Array.from({ length: 218 }, (_, i) => ({ name: `mcp_tool_${String(i).padStart(3, '0')}` }))
  const withoutHistory = planRequest(
    { messages: [user('go', 'u-1')], tools: [CLAIM_TOOL] },
    { acpToolBridge: true },
  )
  const withHistory = planRequest(
    { messages: [user('go', 'u-1')], tools: [CLAIM_TOOL], toolHistory: { tools: decl218, updates: [] } },
    { acpToolBridge: true },
  )
  const withHistoryAgain = planRequest(
    { messages: [user('go', 'u-1')], tools: [CLAIM_TOOL], toolHistory: { tools: decl218, updates: [] } },
    { acpToolBridge: true },
  )

  assert.equal(withHistory.systemText, withoutHistory.systemText)
  assert.equal(
    createHash('sha256').update(withHistory.systemText).digest('hex'),
    createHash('sha256').update(withoutHistory.systemText).digest('hex'),
  )
  // stream() 中 systemHash 直接等于 sha256(plan.systemText)（model-adapter.js），此处验证两轮 systemText 与 sha256 均相等
  assert.equal(withHistory.systemText, withHistoryAgain.systemText)
  assert.equal(
    createHash('sha256').update(withHistory.systemText).digest('hex'),
    createHash('sha256').update(withHistoryAgain.systemText).digest('hex'),
  )
  assert.deepEqual(withHistory.bridgedTools.map((t) => t.name), ['claim_task'])
  assert.equal(withHistory.droppedTools, 0)
  assert.equal(withHistory.promptText, withoutHistory.promptText)
  assert.equal(withHistory.promptText.includes('mcp_tool_'), false)
})

test('T23: acpToolBridge ignores toolHistory.updates additions without leaking into systemText or promptText', () => {
  const decl218 = Array.from({ length: 218 }, (_, i) => ({ name: `mcp_tool_${String(i).padStart(3, '0')}` }))
  const withoutHistory = planRequest(
    { messages: [user('go', 'u-1')], tools: [CLAIM_TOOL] },
    { acpToolBridge: true },
  )
  const withUpdates = planRequest(
    {
      messages: [user('go', 'u-1')],
      tools: [CLAIM_TOOL],
      toolHistory: {
        tools: decl218,
        updates: [{ messageId: 'dev-1', additions: [{ name: 'mcp_added_tool', description: 'ADDED-TOOL-CONTENT' }] }],
      },
    },
    { acpToolBridge: true },
  )

  assert.equal(withUpdates.systemText, withoutHistory.systemText)
  assert.equal(withUpdates.systemText.includes('mcp_added_tool'), false)
  assert.equal(withUpdates.systemText.includes('ADDED-TOOL-CONTENT'), false)
  assert.equal(withUpdates.promptText.includes('mcp_added_tool'), false)
  assert.equal(withUpdates.promptText.includes('ADDED-TOOL-CONTENT'), false)
})

test('T24: acpToolBridge=false still rejects toolHistory verbatim with exact counts', () => {
  const decl218 = Array.from({ length: 218 }, (_, i) => ({ name: `mcp_tool_${String(i).padStart(3, '0')}` }))
  assert.throws(
    () =>
      planRequest(
        { messages: [user('hi')], tools: [{ name: 'read' }], toolHistory: { tools: decl218, updates: [] } },
        { acpToolBridge: false },
      ),
    (err) =>
      err instanceof AgyAcpError &&
      err.code === ERROR_CODES.UNSUPPORTED_TOOLS &&
      err.message === '本适配器不接工具历史（218 个声明、0 个更新）；没有派发 prompt。',
  )
  assert.throws(
    () =>
      planRequest(
        {
          messages: [user('hi')],
          tools: [{ name: 'read' }],
          toolHistory: {
            tools: decl218,
            updates: [{ messageId: 'dev-1', additions: [{ name: 'mcp_added_tool' }] }],
          },
        },
        { acpToolBridge: false },
      ),
    (err) =>
      err instanceof AgyAcpError &&
      err.code === ERROR_CODES.UNSUPPORTED_TOOLS &&
      err.message === '本适配器不接工具历史（218 个声明、1 个更新）；没有派发 prompt。',
  )
})

test('T25: first turn with multiple user messages binds ACP session and joins userText with \\n\\n', async () => {
  const transport = new StubTransport(['ok'])
  const adapter = new AgyAcpAdapter({ acpToolBridge: true, transport: () => transport })
  const msgs = [user('u1', 'u-1'), user('u2', 'u-2')]
  const plan = planRequest({ messages: msgs, tools: [CLAIM_TOOL] }, { acpToolBridge: true })
  assert.equal(plan.userText, 'u1\n\nu2')

  const chunks = await collect(adapter, {
    sessionId: 'sess-t25',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: msgs,
    tools: [CLAIM_TOOL],
  })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  assert.ok(transport.prompts[0].prompt[0].text.includes('u1\n\nu2'))
})

test('T26: planRequest userText for [u1, a1, u2] is u2', () => {
  const plan = planRequest(
    { messages: [user('u1', 'u-1'), assistant('a1', 'a-1'), user('u2', 'u-2')], tools: [CLAIM_TOOL] },
    { acpToolBridge: true },
  )
  assert.equal(plan.userText, 'u2')
})

test('T27: planRequest userText for [u1, a1, u2, a2, u3] is u3', () => {
  const plan = planRequest(
    {
      messages: [
        user('u1', 'u-1'),
        assistant('a1', 'a-1'),
        user('u2', 'u-2'),
        assistant('a2', 'a-2'),
        user('u3', 'u-3'),
      ],
      tools: [CLAIM_TOOL],
    },
    { acpToolBridge: true },
  )
  assert.equal(plan.userText, 'u3')
})

test('T28: unbound history containing assistant still throws AGY_ACP_BINDING_UNKNOWN verbatim', async () => {
  const adapter = new AgyAcpAdapter({ acpToolBridge: true, transport: () => new StubTransport(['ok']) })
  await assert.rejects(
    () =>
      collect(adapter, {
        model: 'gpt-5',
        reasoningEffort: 'medium',
        messages: [user('u1', 'u-1'), assistant('a1', 'a-1'), user('u2', 'u-2')],
        tools: [CLAIM_TOOL],
      }),
    (err) =>
      err instanceof AgyAcpError &&
      err.code === 'AGY_ACP_BINDING_UNKNOWN' &&
      err.message === '多轮历史没有原生 ACP 绑定；不重放历史，请新建会话。',
  )
})

test('T29: orphan tool result before trailing user joins ORPHAN and u2 via joinedUserText', () => {
  const plan = planRequest(
    {
      messages: [
        user('u1', 'u-1'),
        assistant([{ type: 'tool-call', id: 'c1', name: 'claim_task', arguments: '{}' }], 'a-1'),
        toolResult('c1', 'ORPHAN', false, 'tr-1'),
        user('u2', 'u-2'),
      ],
      tools: [CLAIM_TOOL],
    },
    { acpToolBridge: true, toolNames: new Map([['c1', 'claim_task']]) },
  )
  const orphanText = '[DSH 工具结果 / tool result] tool=claim_task status=completed\nORPHAN'
  assert.equal(plan.userText, `${orphanText}\n\nu2`)
  assert.equal(plan.userText.endsWith('ORPHAN\n\nu2'), true)   // 防止未来有人把 header 拼到 ORPHAN 之后
  assert.equal(plan.promptText.includes('ORPHAN-OLD'), false)
  assert.equal(plan.toolResults.length, 0)
})

test('T30: acpPermissionPolicy defaults to reject and cancels permission requests', async () => {
  const transport = new StubTransport(['ok'], {
    permissionOptions: [
      { optionId: 'opt-reject', kind: 'reject_once', name: 'Reject' },
      { optionId: 'opt-allow', kind: 'allow_once', name: 'Allow' },
    ],
  })
  const adapter = new AgyAcpAdapter({ acpToolBridge: true, transport: () => transport })
  assert.equal(adapter.config.acpPermissionPolicy, 'reject')

  const chunks = await collect(adapter, {
    sessionId: 's-t30',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('read file', 'u-1')],
    tools: [CLAIM_TOOL],
  })
  assert.deepEqual(transport.responded[0].payload, { outcome: { outcome: 'cancelled' } })
  const finish = chunks.at(-1)
  assert.equal(finish?.reason?.kind, 'error')
  assert.equal(finish?.reason?.failure?.code, 'AGY_ACP_PERMISSION_REQUIRED')
  assert.equal(
    finish?.reason?.failure?.message,
    'ACP 会话请求了权限确认；本适配器不自动批准，本轮视为未完成，请用户在 Antigravity 侧处理后重试。',
  )
})

test('T31: acpPermissionPolicy=allow_once selects server-provided allow_once optionId and completes', async () => {
  const transport = new StubTransport(['ok'], {
    permissionOptions: [
      { optionId: 'opt-reject', kind: 'reject_once', name: 'Reject' },
      { optionId: 'opt-allow', kind: 'allow_once', name: 'Allow' },
    ],
  })
  const adapter = new AgyAcpAdapter({
    acpToolBridge: true,
    acpPermissionPolicy: 'allow_once',
    transport: () => transport,
  })
  const chunks = await collect(adapter, {
    sessionId: 's-t31',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('read file', 'u-1')],
    tools: [CLAIM_TOOL],
  })
  assert.deepEqual(transport.responded[0].payload, { outcome: { outcome: 'selected', optionId: 'opt-allow' } })
  assert.notEqual(transport.responded[0].payload.outcome.optionId, 'opt-reject')
  assert.equal(chunks.some((c) => c.type === 'finish' && c.reason?.failure?.code === 'AGY_ACP_PERMISSION_REQUIRED'), false)
  assert.equal(chunks.at(-1)?.reason?.kind, 'stop')
})

test('T32: acpPermissionPolicy=allow_once cancels when server offers no valid allow_once option', async () => {
  const transport = new StubTransport(['ok'], {
    permissionOptions: [{ optionId: 'opt-reject', kind: 'reject_once', name: 'Reject' }],
  })
  const adapter = new AgyAcpAdapter({
    acpToolBridge: true,
    acpPermissionPolicy: 'allow_once',
    transport: () => transport,
  })
  const chunks = await collect(adapter, {
    sessionId: 's-t32',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('read file', 'u-1')],
    tools: [CLAIM_TOOL],
  })
  assert.deepEqual(transport.responded[0].payload, { outcome: { outcome: 'cancelled' } })
  const finish = chunks.at(-1)
  assert.equal(finish?.reason?.kind, 'error')
  assert.equal(finish?.reason?.failure?.code, 'AGY_ACP_PERMISSION_REQUIRED')
})

test('T33: invalid acpPermissionPolicy is rejected by both AgyAcpAdapter and defaultConfig', () => {
  assert.throws(
    () => new AgyAcpAdapter({ acpToolBridge: true, acpPermissionPolicy: 'always' }),
    (err) =>
      err instanceof AgyAcpError &&
      err.code === ERROR_CODES.INVALID_REQUEST &&
      err.message.includes('reject') &&
      err.message.includes('allow_once'),
  )
  assert.throws(
    () => defaultConfig({ acpPermissionPolicy: 'always' }),
    /acpPermissionPolicy/,
  )
})

test('T34: normal second turn [u1, a1, u2] dispatches only u2 and commits length-3 history', async () => {
  const transport = new StubTransport(['first reply', 'second reply'])
  const adapter = new AgyAcpAdapter({ transport: () => transport })
  const first = await collect(adapter, {
    sessionId: 's-t34',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('first task', 'u-1')],
  })
  assert.deepEqual(first.at(-1), { type: 'finish', reason: { kind: 'stop' } })

  const second = await collect(adapter, {
    sessionId: 's-t34',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('first task', 'u-1'), assistant('first reply', 'a-1'), user('second task', 'u-2')],
  })
  assert.deepEqual(second.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  assert.equal(transport.prompts.length, 2)
  assert.equal(transport.prompts[1].prompt[0].text, 'second task')
  assert.equal(adapter.nativeSessions['s-t34'].history.length, 3)
  assert.equal(adapter.nativeSessions['s-t34'].dirty, false)
})

test('T35: multi-user turn (new task + runtime context, len+3, at(-2)=user) dispatches both joined by \\n\\n', async () => {
  const transport = new StubTransport(['r1', 'r2'])
  const adapter = new AgyAcpAdapter({ transport: () => transport })
  await collect(adapter, {
    sessionId: 's-t35',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('u1', 'u-1')],
  })

  const chunks = await collect(adapter, {
    sessionId: 's-t35',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [
      user('u1', 'u-1'),
      assistant('r1', 'a-1'),
      user('new task body', 'u-2'),
      user('runtime context body', 'u-3'),
    ],
  })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  assert.equal(transport.prompts.length, 2)
  assert.equal(transport.prompts[1].prompt[0].text, 'new task body\n\nruntime context body')
  assert.equal(transport.prompts[1].prompt[0].text.includes('u1'), false)
  assert.equal(transport.prompts[1].prompt[0].text.includes('r1'), false)
})

test('T36: framework-injected reminder messages in trailing user segment are joined and dispatched without replay', async () => {
  const transport = new StubTransport(['r1', 'r2'])
  const adapter = new AgyAcpAdapter({ transport: () => transport })
  await collect(adapter, {
    sessionId: 's-t36',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('u1', 'u-1')],
  })

  const chunks = await collect(adapter, {
    sessionId: 's-t36',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [
      user('u1', 'u-1'),
      assistant('r1', 'a-1'),
      user('user query', 'u-2'),
      user('[system-reminder] keep concise', 'u-3'),
      user('[system-reminder] cite files', 'u-4'),
    ],
  })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  assert.equal(transport.prompts[1].prompt[0].text, 'user query\n\n[system-reminder] keep concise\n\n[system-reminder] cite files')
  assert.equal(transport.prompts[1].prompt[0].text.includes('u1'), false)
})

test('T37: tool reply turn (isToolReplyTurn) and subsequent user turn succeed with shape validation', async () => {
  const fence = '```tool_call\n{"name":"claim_task","arguments":{"taskId":"task-37"}}\n```'
  const transport = new StubTransport([fence, 'claimed ok', 'next ok'])
  const adapter = new AgyAcpAdapter({ acpToolBridge: true, transport: () => transport })

  const t1 = await collect(adapter, {
    sessionId: 's-t37',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('claim it', 'u-1')],
    tools: [CLAIM_TOOL],
  })
  assert.equal(t1.at(-1)?.reason?.kind, 'tool-calls')
  const callChunk = t1.find((c) => c.type === 'tool-call-delta')
  assert.ok(callChunk)

  const a1 = assistant([{ type: 'tool-call', id: callChunk.id, name: 'claim_task', arguments: callChunk.argumentsDelta }], 'a-1')
  const t2 = await collect(adapter, {
    sessionId: 's-t37',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('claim it', 'u-1'), a1, toolResult(callChunk.id, '{"ok":true}', false, 'tr-1')],
    tools: [CLAIM_TOOL],
  })
  assert.equal(t2.at(-1)?.reason?.kind, 'stop')
  assert.ok(transport.prompts[1].prompt[0].text.includes('{"ok":true}'))

  const t3 = await collect(adapter, {
    sessionId: 's-t37',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [
      user('claim it', 'u-1'),
      a1,
      toolResult(callChunk.id, '{"ok":true}', false, 'tr-1'),
      assistant('claimed ok', 'a-2'),
      user('continue', 'u-2'),
    ],
    tools: [CLAIM_TOOL],
  })
  assert.equal(t3.at(-1)?.reason?.kind, 'stop')
  assert.equal(transport.prompts[2].prompt[0].text, 'continue')
})

test('T38: interruption (cancelled stopReason, abort signal, generator early exit) marks dirty and re-baselines while keeping hard guards', async () => {
  // 1) stopReason=cancelled sets dirty=true and clears inFlight
  class CancelTransport extends StubTransport {
    constructor() {
      super(['r1', 'partial', 'r3'])
      this.turn = 0
    }
    async request(method, params, opts) {
      if (method === 'session/prompt') {
        this.turn += 1
        if (this.turn === 2) {
          this.prompts.push(params)
          this.responses.shift()
          opts?.onResponse?.()
          return { stopReason: 'cancelled' }
        }
      }
      return super.request(method, params, opts)
    }
  }
  const adapter1 = new AgyAcpAdapter({ transport: () => new CancelTransport() })
  await collect(adapter1, { sessionId: 's-t38a', model: 'gpt-5', reasoningEffort: 'medium', messages: [user('u1', 'u-1')] })
  const cancelled = await collect(adapter1, {
    sessionId: 's-t38a',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('u1', 'u-1'), assistant('r1', 'a-1'), user('u2', 'u-2')],
  })
  assert.equal(cancelled.at(-1)?.reason?.kind, 'aborted')
  assert.equal(adapter1.nativeSessions['s-t38a'].dirty, true)
  assert.equal(adapter1.nativeSessions['s-t38a'].inFlight, null)

  // Hard guards still apply while dirty:
  await assert.rejects(
    () => collect(adapter1, {
      sessionId: 's-t38a',
      model: 'gpt-5',
      reasoningEffort: 'medium',
      system: 'changed-system',
      messages: [user('u1', 'u-1'), assistant('r1', 'a-1'), user('u3', 'u-3')],
    }),
    (err) => err instanceof AgyAcpError && err.code === 'AGY_ACP_SYSTEM_CHANGED',
  )
  await assert.rejects(
    () => collect(adapter1, {
      sessionId: 's-t38a',
      model: 'gpt-5',
      reasoningEffort: 'medium',
      messages: [user('u1', 'u-1'), assistant('wrong-assistant', 'a-1'), user('u3', 'u-3')],
    }),
    (err) => err instanceof AgyAcpError && err.code === ERROR_CODES.UNSUPPORTED_HISTORY && err.message === '上轮 assistant 与 ACP 已确认回复不一致；没有派发 prompt。',
  )
  await assert.rejects(
    () => collect(adapter1, {
      sessionId: 's-t38a',
      model: 'gpt-5',
      reasoningEffort: 'medium',
      messages: [user('u1', 'u-1'), assistant('r1', 'a-1')],
    }),
    (err) => err instanceof AgyAcpError && err.code === ERROR_CODES.UNSUPPORTED_HISTORY && err.message === '历史必须以新增用户输入结束；没有派发 prompt。',
  )

  // Dirty recovery succeeds and clears dirty:
  const recovered = await collect(adapter1, {
    sessionId: 's-t38a',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('u1', 'u-1'), assistant('r1', 'a-1'), user('u2', 'u-2'), assistant('partial', 'a-2'), user('u3', 'u-3')],
  })
  assert.equal(recovered.at(-1)?.reason?.kind, 'stop')
  assert.equal(adapter1.nativeSessions['s-t38a'].dirty, false)

  // 2) AbortSignal during prompt sets dirty=true and clears inFlight
  class AbortTransport extends StubTransport {
    async request(method, params, opts) {
      if (method === 'session/prompt' && this.prompts.length === 1) {
        this.prompts.push(params)
        opts?.onResponse?.()
        throw new AgyAcpError('ABORTED', 'aborted by signal')
      }
      return super.request(method, params, opts)
    }
  }
  const adapter2 = new AgyAcpAdapter({ transport: () => new AbortTransport(['r1', 'r3']) })
  await collect(adapter2, { sessionId: 's-t38b', model: 'gpt-5', reasoningEffort: 'medium', messages: [user('u1', 'u-1')] })
  const ac = new AbortController()
  const abortedTurn = await collect(adapter2, {
    sessionId: 's-t38b',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    signal: ac.signal,
    messages: [user('u1', 'u-1'), assistant('r1', 'a-1'), user('u2', 'u-2')],
  })
  assert.equal(abortedTurn.at(-1)?.reason?.kind, 'aborted')
  assert.equal(adapter2.nativeSessions['s-t38b'].dirty, true)
  assert.equal(adapter2.nativeSessions['s-t38b'].inFlight, null)
  const afterAbort = await collect(adapter2, {
    sessionId: 's-t38b',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('u1', 'u-1'), assistant('r1', 'a-1'), user('u3', 'u-3')],
  })
  assert.equal(afterAbort.at(-1)?.reason?.kind, 'stop')
  assert.equal(adapter2.nativeSessions['s-t38b'].dirty, false)

  // 3) Generator early return in finally sets dirty=true and clears inFlight
  const adapter3 = new AgyAcpAdapter({ transport: () => new StubTransport(['r1', 'r2', 'r3']) })
  await collect(adapter3, { sessionId: 's-t38c', model: 'gpt-5', reasoningEffort: 'medium', messages: [user('u1', 'u-1')] })
  const gen = adapter3.stream({
    sessionId: 's-t38c',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('u1', 'u-1'), assistant('r1', 'a-1'), user('u2', 'u-2')],
  })
  for await (const chunk of gen) {
    if (chunk.type === 'text-delta') break
  }
  assert.equal(adapter3.nativeSessions['s-t38c'].dirty, true)
  assert.equal(adapter3.nativeSessions['s-t38c'].inFlight, null)
  const afterBreak = await collect(adapter3, {
    sessionId: 's-t38c',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('u1', 'u-1'), assistant('r1', 'a-1'), user('u3', 'u-3')],
  })
  assert.equal(afterBreak.at(-1)?.reason?.kind, 'stop')
  assert.equal(adapter3.nativeSessions['s-t38c'].dirty, false)
})

test('T39: tampered prefix re-baselines without AGY_ACP_UNSUPPORTED_HISTORY (intentional Contract/Acceptance semantics)', async () => {
  // Intentional semantic change per Contract/Acceptance: shape-only check no longer compares
  // committed prefix items role/hash/id one-by-one; modified prefix re-baselines cleanly.
  const transport = new StubTransport(['r1', 'r2'])
  const adapter = new AgyAcpAdapter({ transport: () => transport })
  await collect(adapter, {
    sessionId: 's-t39',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('original u1', 'u-1')],
  })
  const second = await collect(adapter, {
    sessionId: 's-t39',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('tampered u1', 'u-1-edited'), assistant('r1', 'a-1'), user('u2', 'u-2')],
  })
  assert.equal(second.at(-1)?.reason?.kind, 'stop')
  assert.equal(transport.prompts[1].prompt[0].text, 'u2')
  assert.equal(adapter.nativeSessions['s-t39'].history[0].id, 'u-1-edited')
})

test('T40: non-prefix committed history with valid suffix shape re-baselines without AGY_ACP_UNSUPPORTED_HISTORY (intentional Contract/Acceptance semantics)', async () => {
  // Intentional semantic change per Contract/Acceptance: when currentHistory.length > committed.length
  // and suffix shape is valid, committed is not compared item-by-item as a strict prefix.
  const transport = new StubTransport(['r1', 'r2', 'r3'])
  const adapter = new AgyAcpAdapter({ transport: () => transport })
  await collect(adapter, {
    sessionId: 's-t40',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('u1', 'u-1')],
  })
  await collect(adapter, {
    sessionId: 's-t40',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('u1', 'u-1'), assistant('r1', 'a-1'), user('u2', 'u-2')],
  })
  // committed.length is now 3, assistantHash is hash('r2').
  // Next call has length 5 (> committed.length) with rebuilt non-prefix history whose suffix [a-2, u-3] is valid:
  const third = await collect(adapter, {
    sessionId: 's-t40',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [
      user('summary', 'u-sum'),
      assistant('old', 'a-old'),
      user('ctx', 'u-ctx'),
      assistant('r2', 'a-2'),
      user('u3', 'u-3'),
    ],
  })
  assert.equal(third.at(-1)?.reason?.kind, 'stop')
  assert.equal(transport.prompts[2].prompt[0].text, 'u3')
  assert.equal(adapter.nativeSessions['s-t40'].history.length, 5)
})

test('T41: fail-closed when suffix contains two assistants', async () => {
  const transport = new StubTransport(['r1'])
  const adapter = new AgyAcpAdapter({ transport: () => transport })
  await collect(adapter, {
    sessionId: 's-t41',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('u1', 'u-1')],
  })
  await assert.rejects(
    () => collect(adapter, {
      sessionId: 's-t41',
      model: 'gpt-5',
      reasoningEffort: 'medium',
      messages: [user('u1', 'u-1'), assistant('r1', 'a-1'), assistant('extra', 'a-2'), user('u2', 'u-2')],
    }),
    (err) =>
      err instanceof AgyAcpError &&
      err.code === ERROR_CODES.UNSUPPORTED_HISTORY &&
      err.message === '历史前缀不匹配、重复输入或有未提交轮次；不重放，没有派发 prompt。',
  )
  assert.equal(transport.prompts.length, 1)
})

test('T42: fail-closed when suffix contains no assistant', async () => {
  const transport = new StubTransport(['r1'])
  const adapter = new AgyAcpAdapter({ transport: () => transport })
  await collect(adapter, {
    sessionId: 's-t42',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('u1', 'u-1')],
  })
  await assert.rejects(
    () => collect(adapter, {
      sessionId: 's-t42',
      model: 'gpt-5',
      reasoningEffort: 'medium',
      messages: [user('u1', 'u-1'), user('u2', 'u-2')],
    }),
    (err) =>
      err instanceof AgyAcpError &&
      err.code === ERROR_CODES.UNSUPPORTED_HISTORY &&
      err.message === '历史前缀不匹配、重复输入或有未提交轮次；不重放，没有派发 prompt。',
  )
  assert.equal(transport.prompts.length, 1)
})

test('T43: fail-closed when suffix contains tool entry on non-tool-reply turn', async () => {
  const transport = new StubTransport(['r1'])
  const adapter = new AgyAcpAdapter({ acpToolBridge: true, transport: () => transport })
  await collect(adapter, {
    sessionId: 's-t43',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('u1', 'u-1')],
    tools: [CLAIM_TOOL],
  })
  await assert.rejects(
    () => collect(adapter, {
      sessionId: 's-t43',
      model: 'gpt-5',
      reasoningEffort: 'medium',
      messages: [user('u1', 'u-1'), assistant('r1', 'a-1'), toolResult('c1', 'out', false, 'tr-1'), user('u2', 'u-2')],
      tools: [CLAIM_TOOL],
    }),
    (err) =>
      err instanceof AgyAcpError &&
      err.code === ERROR_CODES.UNSUPPORTED_HISTORY &&
      err.message === '历史前缀不匹配、重复输入或有未提交轮次；不重放，没有派发 prompt。',
  )
  assert.equal(transport.prompts.length, 1)
})

test('T44: fail-closed when trailing message is not user', async () => {
  const transport = new StubTransport(['r1'])
  const adapter = new AgyAcpAdapter({ transport: () => transport })
  await collect(adapter, {
    sessionId: 's-t44',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('u1', 'u-1')],
  })
  await assert.rejects(
    () => collect(adapter, {
      sessionId: 's-t44',
      model: 'gpt-5',
      reasoningEffort: 'medium',
      messages: [user('u1', 'u-1'), assistant('r1', 'a-1')],
    }),
    (err) =>
      err instanceof AgyAcpError &&
      err.code === ERROR_CODES.UNSUPPORTED_HISTORY &&
      err.message === '历史必须以新增用户输入结束；没有派发 prompt。',
  )
  assert.equal(transport.prompts.length, 1)
})

test('T45: clean-state replay (length === committed.length) and shortened history (length < committed.length) throw AGY_ACP_UNSUPPORTED_HISTORY with zero prompt', async () => {
  const transport = new StubTransport(['same-reply', 'same-reply'])
  const adapter = new AgyAcpAdapter({ transport: () => transport })
  await collect(adapter, {
    sessionId: 's-t45',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('first', 'u-1')],
  })
  const turn2Msgs = [user('first', 'u-1'), assistant('same-reply', 'a-1'), user('second', 'u-2')]
  await collect(adapter, {
    sessionId: 's-t45',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: turn2Msgs,
  })
  assert.equal(transport.prompts.length, 2)
  assert.equal(adapter.nativeSessions['s-t45'].dirty, false)

  const beforeCount = transport.prompts.length
  await assert.rejects(
    () => collect(adapter, {
      sessionId: 's-t45',
      model: 'gpt-5',
      reasoningEffort: 'medium',
      messages: turn2Msgs,
    }),
    (err) => err instanceof AgyAcpError && err.code === ERROR_CODES.UNSUPPORTED_HISTORY,
  )
  assert.equal(transport.prompts.length, beforeCount, 'exact replay must not dispatch prompt')

  await assert.rejects(
    () => collect(adapter, {
      sessionId: 's-t45',
      model: 'gpt-5',
      reasoningEffort: 'medium',
      messages: [user('first', 'u-1')],
    }),
    (err) => err instanceof AgyAcpError && err.code === ERROR_CODES.UNSUPPORTED_HISTORY,
  )
  assert.equal(transport.prompts.length, beforeCount, 'shortened history in clean state must not dispatch prompt')
})

test('T46: clean-state +3 multi-user shape dispatches only new trailing users (no old assistant)', async () => {
  const transport = new StubTransport(['r1', 'r2'])
  const adapter = new AgyAcpAdapter({ transport: () => transport })
  await collect(adapter, {
    sessionId: 's-t46',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('u1', 'u-1')],
  })
  const res = await collect(adapter, {
    sessionId: 's-t46',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('u1', 'u-1'), assistant('r1', 'a-1'), user('task body', 'u-2'), user('runtime context', 'u-3')],
  })
  assert.equal(res.at(-1)?.reason?.kind, 'stop')
  assert.equal(transport.prompts.length, 2)
  assert.equal(transport.prompts[1].prompt[0].text, 'task body\n\nruntime context')
  assert.equal(transport.prompts[1].prompt[0].text.includes('r1'), false)
})

class InterleavedUpdateTransport extends StubTransport {
  constructor(turns) {
    super([])
    this.turns = [...turns]
  }
  async request(method, params, opts) {
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
    return super.request(method, params, opts)
  }
}

test('T47: inline reasoning blocks interleave with text blocks with monotonic index and zero cross-bleed', async () => {
  const transport = new InterleavedUpdateTransport([[
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'first ' } },
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thought' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'visible answer' } },
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'second thought' } },
  ]])
  const adapter = new AgyAcpAdapter({ transport: () => transport })
  const chunks = await collect(adapter, {
    sessionId: 's-t47',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('hello', 'u-1')],
  })

  const starts = chunks.filter((c) => c.type === 'block-start')
  const ends = chunks.filter((c) => c.type === 'block-end')
  assert.deepEqual(starts.map((s) => [s.index, s.blockType]), [
    [0, 'reasoning'],
    [1, 'text'],
    [2, 'reasoning'],
  ])
  assert.deepEqual(ends, [
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'first thought' } },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'visible answer' } },
    { type: 'block-end', index: 2, block: { type: 'reasoning', text: 'second thought' } },
  ])
  const rDeltas0 = chunks.filter((c) => c.type === 'reasoning-delta' && c.index === 0).map((c) => c.text).join('')
  const rDeltas2 = chunks.filter((c) => c.type === 'reasoning-delta' && c.index === 2).map((c) => c.text).join('')
  const tDeltas1 = chunks.filter((c) => c.type === 'text-delta' && c.index === 1).map((c) => c.text).join('')
  assert.equal(rDeltas0, 'first thought')
  assert.equal(rDeltas2, 'second thought')
  assert.equal(tDeltas1, 'visible answer')
  assert.equal(tDeltas1.includes('thought'), false)
  assert.equal(rDeltas0.includes('visible'), false)
})

test('T48: no agent_thought_chunk emits 0 reasoning blocks and preserves index=0 text sequence', async () => {
  const transport = new InterleavedUpdateTransport([[
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '   ' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'plain reply' } },
  ]])
  const adapter = new AgyAcpAdapter({ transport: () => transport })
  const chunks = await collect(adapter, {
    sessionId: 's-t48',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('hi', 'u-1')],
  })
  assert.equal(chunks.some((c) => c.type === 'block-start' && c.blockType === 'reasoning'), false)
  assert.deepEqual(chunks.slice(0, 3), [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'plain reply' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'plain reply' } },
  ])
})

test('T49: SECRET inline thought probe never leaks across turns into prompt, planRequest, nativeStateFile, or systemHash', async () => {
  const secret = 'SECRET_THOUGHT_INLINE_1'
  const tempDir = mkdtempSync(join(tmpdir(), 'antigravity-t49-'))
  const nativeStateFile = join(tempDir, 'native-sessions.json')
  try {
    const transport = new InterleavedUpdateTransport([
      [
        { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: `internal ${secret}` } },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'clean answer 1' } },
      ],
      [
        { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'normal thought 2' } },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'clean answer 2' } },
      ],
    ])
    const adapter = new AgyAcpAdapter({ cwd: tempDir, nativeStateFile, transport: () => transport })
    const u1 = user('turn 1', 'u-1')
    const opts1 = { sessionId: 's-t49', model: 'gpt-5', reasoningEffort: 'medium', system: 'sys', messages: [u1] }
    const plan1 = planRequest(opts1)
    const chunks1 = await collect(adapter, opts1)
    // Positive proof that turn 1 reasoning block actually contained the SECRET
    const reasoningBlocks1 = chunks1.filter((c) => c.type === 'block-end' && c.block?.type === 'reasoning')
    assert.equal(reasoningBlocks1.length, 1)
    assert.ok(reasoningBlocks1[0].block.text.includes(secret), 'turn 1 reasoning block must contain SECRET')
    assert.equal(chunks1.filter((c) => c.type === 'text-delta').map((c) => c.text).join('').includes(secret), false)

    const a1 = assistant('clean answer 1', 'a-1')
    const u2 = user('turn 2', 'u-2')
    const opts2 = { sessionId: 's-t49', model: 'gpt-5', reasoningEffort: 'medium', system: 'sys', messages: [u1, a1, u2] }
    const plan2 = planRequest(opts2)
    await collect(adapter, opts2)

    assert.equal(transport.prompts.length, 2)
    assert.equal(JSON.stringify(transport.prompts[1]).includes(secret), false, 'turn 2 session/prompt must not contain SECRET')
    assert.equal(JSON.stringify(plan2).includes(secret), false, 'turn 2 planRequest must not contain SECRET')
    assert.equal(JSON.stringify(adapter.nativeSessions['s-t49']).includes(secret), false, 'in-memory ledger must not contain SECRET')
    assert.equal(readFileSync(nativeStateFile, 'utf8').includes(secret), false, 'nativeStateFile must not contain SECRET')
    const sysHash1 = createHash('sha256').update(plan1.systemText).digest('hex')
    const sysHash2 = createHash('sha256').update(plan2.systemText).digest('hex')
    assert.equal(sysHash1, sysHash2, 'systemHash must stay identical across turns')
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('T50: inlineThought switch disables reasoning blocks while preserving text, defaultConfig validation, and apply() wiring', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'antigravity-t50-'))
  const noop = () => {}
  const makeStubCtx = (registered) => {
    const disposers = []
    const ctx = {
      tools: { register: () => noop },
      effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
      get(name) {
        if (name === 'llm') return { registerAdapter(routes, adapter) { registered.push({ routes, adapter }); return noop } }
        if (name === 'workingDirectory') return { cwd: tempDir }
        return undefined
      },
      agents: { get: (id) => (id ? { session: { id } } : undefined) },
      on: () => noop,
      logger: { debug: noop, info: noop, warn: noop, error: noop, trace: noop },
      reflect: { provide: noop },
      root: {},
    }
    return { ctx, disposeAll() { for (const d of [...disposers].reverse()) d() } }
  }

  try {
    for (const bad of ['true', 1, null]) {
      assert.throws(
        () => defaultConfig({ inlineThought: bad }),
        (err) => err instanceof Error && err.message === 'antigravity-bridge: inlineThought must be a boolean',
      )
    }

    const reg = []
    const stub = makeStubCtx(reg)
    try {
      const transport = new InterleavedUpdateTransport([[
        { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hidden thought' } },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'normal text' } },
      ]])
      apply(stub.ctx, {
        agyExecutable: 'agy',
        agyArgs: ['acp'],
        cwd: tempDir,
        stateFile: join(tempDir, 'state.json'),
        modelProvider: true,
        inlineThought: false,
        transport: () => transport,
      })
      assert.equal(reg.length, 1)
      const adapter = reg[0].adapter
      assert.equal(adapter.config.inlineThought, false)

      let diagChunks = -1
      adapter.config.onToolEvents = (info) => { diagChunks = info.diagnostics.thoughtChunks }
      const chunks = await collect(adapter, {
        sessionId: 's-t50',
        model: 'gpt-5',
        reasoningEffort: 'medium',
        messages: [user('hi', 'u-1')],
      })
      assert.equal(chunks.some((c) => c.type === 'block-start' && c.blockType === 'reasoning'), false)
      assert.equal(chunks.some((c) => c.type === 'reasoning-delta'), false)
      assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'normal text')
      assert.equal(diagChunks, 1, 'thoughtChunks diagnostic count must still be recorded when inlineThought=false')
    } finally {
      stub.disposeAll()
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('T51: acpToolBridge=true streams reasoning blocks before bridged tool-call/text blocks without index collision', async () => {
  const fence = '```tool_call\n{"name":"claim_task","arguments":{"taskId":"t-51"}}\n```'
  const transport = new InterleavedUpdateTransport([[
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'deciding to claim' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: fence } },
  ]])
  const adapter = new AgyAcpAdapter({ acpToolBridge: true, transport: () => transport })
  const chunks = await collect(adapter, {
    sessionId: 's-t51',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    messages: [user('claim', 'u-1')],
    tools: [CLAIM_TOOL],
  })
  const starts = chunks.filter((c) => c.type === 'block-start')
  assert.deepEqual(starts.map((s) => [s.index, s.blockType]), [
    [0, 'reasoning'],
    [1, 'tool-call'],
  ])
  assert.equal(chunks.at(-1)?.reason?.kind, 'tool-calls')
})

let summaryPrinted = false
process.on('exit', (code) => {
  if (!summaryPrinted && code === 0) {
    summaryPrinted = true
    console.log('tool-call-bridge-test: 51/51 passed')
  }
})
