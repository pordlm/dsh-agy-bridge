/**
 * Integration checks for the two non-tool delivery channels:
 *
 *  - the real installed AgentLoop drives the native `agy` ACP model adapter with
 *    an in-memory transport (no account, no real `agy`, one prompt per call);
 *  - the Web panel controller uploads files through a DSH-like uploader and sends
 *    only receipt ids, while the Host service resolves those receipts to host
 *    paths and the ACP mock receives the exact synthetic bytes;
 *  - invalid/cross-session receipts fail before any prompt.
 *
 * Run: node --test antigravity-bridge/plugin/dsh-agy-bridge/scripts/ui-model-integration.test.mjs
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

import { AcpStdioTransport, AgyAcpAdapter, ERROR_CODES } from '../lib/model-adapter.js'
import { EFFORT_LOW_ID, MODEL_ID, PROVIDER_ID, listModelInfos, providerInfo } from '../lib/model-catalog.js'
import { createPanelController } from '../client/panel.js'
import { Bridge, defaultConfig } from '../lib/bridge.js'
import { AntigravityBridgeService } from '../lib/web-remote.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const mockPath = path.join(here, 'mock-agy-acp.mjs')

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function scopeDir() {
  const candidates = []
  if (process.env.DSH_INSTALL_DIR) candidates.push(path.resolve(process.env.DSH_INSTALL_DIR, '..', '..'))
  const root = 'D:/dsh-data/versions'
  if (existsSync(root)) {
    for (const entry of ['0.2.2-rc.5']) candidates.push(path.join(root, entry, 'node_modules', '@deepseek-ai'))
  }
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'dsh-llm', 'package.json'))) return candidate
  }
  throw new Error(`找不到安装版 DSH 的 @deepseek-ai 目录；候选：${candidates.join(', ')}`)
}

const SCOPE = scopeDir()
const requireFromScope = createRequire(path.join(SCOPE, 'dsh', 'package.json'))

async function load(name) {
  let target
  try {
    target = requireFromScope.resolve(name)
  } catch {
    target = path.join(SCOPE, name.replace('@deepseek-ai/', ''), 'lib', 'index.js')
  }
  return import(pathToFileURL(target).href)
}

class FakeTransport {
  constructor(promptText) {
    this.promptText = promptText
    this.requests = []
    this.notificationHandlers = []
    this.responded = []
    this.config = { model: MODEL_ID, thought: 'default' }
  }

  start() {}
  onNotification(handler) {
    this.notificationHandlers.push(handler)
    // Paired unregister: the adapter detaches per-turn handlers when a turn
    // ends, so this fake must honour the returned disposer like AcpStdioTransport.
    return () => {
      const index = this.notificationHandlers.indexOf(handler)
      if (index >= 0) this.notificationHandlers.splice(index, 1)
    }
  }
  onRequest() {
    return () => {}
  }
  notify() {}
  respond(id, result) { this.responded.push({ id, result }) }
  respondError() {}
  close() {}

  update(update) {
    for (const handler of this.notificationHandlers) {
      handler({ method: 'session/update', params: { sessionId: 'loop-session', update } })
    }
  }

  async request(method, params) {
    this.requests.push({ method, params })
    if (method === 'initialize') return { protocolVersion: 1 }
    if (method === 'session/new') {
      return {
        sessionId: 'loop-session',
        configOptions: [
          { id: 'model', category: 'model', currentValue: this.config.model, options: [{ value: MODEL_ID, name: MODEL_ID }] },
          { id: 'thought', category: 'thought_level', currentValue: this.config.thought, options: [{ value: EFFORT_LOW_ID, name: EFFORT_LOW_ID }] },
        ],
      }
    }
    if (method === 'session/set_config_option') {
      if (params.configId === 'model') this.config.model = String(params.value)
      if (params.configId === 'thought') this.config.thought = String(params.value)
      return {
        configOptions: [
          { id: 'model', category: 'model', currentValue: this.config.model, options: [{ value: MODEL_ID, name: MODEL_ID }] },
          { id: 'thought', category: 'thought_level', currentValue: this.config.thought, options: [{ value: EFFORT_LOW_ID, name: EFFORT_LOW_ID }] },
        ],
      }
    }
    if (method === 'session/prompt') {
      this.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: this.promptText } })
      return { stopReason: 'end_turn' }
    }
    throw new Error(`unexpected ACP method ${method}`)
  }
}

async function bootHost() {
  const { Context } = await load('@deepseek-ai/cordis')
  const packages = [
    ['@deepseek-ai/dsh-llm', {}],
    ['@deepseek-ai/dsh-session', {}],
    ['@deepseek-ai/dsh-session-projection', {}],
    ['@deepseek-ai/dsh-agent', {}],
    ['@deepseek-ai/dsh-tools', {}],
    ['@deepseek-ai/dsh-tool-executor-native', {}],
    ['@deepseek-ai/dsh-system-prompt', {}],
    ['@deepseek-ai/dsh-agent-loop', { agents: [] }],
  ]
  const ctx = new Context()
  for (const [name, config] of packages) {
    const mod = await load(name)
    ctx.plugin(mod.default ?? mod, config)
  }
  await ctx.lifecycle?.ready?.()
  await new Promise((resolve) => setTimeout(resolve, 50))
  const transport = new FakeTransport('循环里得到的回答。')
  const adapter = new AgyAcpAdapter({ transport: () => transport })
  ctx.llm.registerAdapter([PROVIDER_ID], adapter)
  return { ctx, transport }
}

test('native provider: installed AgentLoop accepts the ACP model catalog and zero-retry policy', async () => {
  const { ctx } = await bootHost()
  try {
    const models = await ctx.llm.listModels(PROVIDER_ID)
    assert.equal(models.length, 1)
    assert.equal(models[0].id, MODEL_ID)
    assert.equal(models[0].name, MODEL_ID)
    assert.match(providerInfo(PROVIDER_ID).name, /纯文本多轮/)
    assert.match(models[0].description, /不支持工具调用/)
    const resolved = await ctx.llm.resolveModelInfo(PROVIDER_ID, MODEL_ID)
    assert.equal(resolved.provider, PROVIDER_ID)
    assert.deepEqual(resolved.reasoning.efforts.map((effort) => effort.id), [EFFORT_LOW_ID])
    assert.equal(resolved.reasoning.defaultEffort, undefined)
    const policy = ctx.llm.providerRetryPolicy(PROVIDER_ID)
    assert.equal(policy.mode, 'normal')
    assert.equal(policy.maxRetries, 0)
    assert.deepEqual([...policy.retryableCodes], [])
  } finally {
    await ctx.dispose?.()
  }
})

test('preset tool scope removes a real root tool from a real agent request', async () => {
  const { ctx, transport } = await bootHost()
  const llm = await load('@deepseek-ai/dsh-llm')
  const toolScope = await import('../preset/tool-scope.js')
  try {
    ctx.tools.register({
      name: 'preset_probe_tool',
      description: 'A root tool that the preset must hide.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: () => ({ ok: true }),
    })
    const handle = await ctx.agents.create({
      sessionId: 'ui-model-preset-scope',
      meta: { cwd: process.cwd() },
      agentOptions: { provider: PROVIDER_ID, model: MODEL_ID, reasoningEffort: EFFORT_LOW_ID },
      setup: (agentCtx) => toolScope.apply(agentCtx),
    })
    handle.agent.followup(
      llm.createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: '工具应该为空。' }],
      }),
    )
    await handle.agent.whenIdle()
    const header = handle.agent.session
      .snapshotEvents()
      .find((event) => event.type === 'request/header')
    assert.ok(header)
    assert.deepEqual(header.data.header.tools ?? [], [])
    assert.equal(
      transport.requests.filter((entry) => entry.method === 'session/prompt').length,
      1,
    )
  } finally {
    await ctx.dispose?.()
  }
})

test('native provider: real AgentLoop drives two incremental prompts without replaying history', async () => {
  const { ctx, transport } = await bootHost()
  const llm = await load('@deepseek-ai/dsh-llm')
  try {
    const handle = await ctx.agents.create({
      sessionId: 'ui-model-loop-one',
      meta: { cwd: process.cwd() },
      agentOptions: { provider: PROVIDER_ID, model: MODEL_ID, reasoningEffort: EFFORT_LOW_ID },
    })
    const session = handle.agent.session
    handle.agent.followup(llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '你好，请回一句。' }] }))
    await handle.agent.whenIdle()

    assert.deepEqual(
      transport.requests.slice(-5).map((entry) => entry.method),
      ['initialize', 'session/new', 'session/set_config_option', 'session/set_config_option', 'session/prompt'],
    )
    assert.deepEqual(
      transport.requests.filter((entry) => entry.method === 'session/set_config_option').slice(-2).map((entry) => entry.params.configId),
      ['model', 'thought'],
    )
    const text = session
      .snapshotEvents()
      .filter((event) => event.type === 'assistant/message')
      .flatMap((event) => event.data.message.content)
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
    assert.equal(text, '循环里得到的回答。')
    const header = session.snapshotEvents().find((event) => event.type === 'request/header')
    assert.ok(header)
    assert.deepEqual(header.data.header.tools ?? [], [])
    assert.deepEqual(header.data.header.config, {
      provider: PROVIDER_ID,
      model: MODEL_ID,
      reasoningEffort: EFFORT_LOW_ID,
    })

    const promptsAfterFirst = transport.requests.filter((entry) => entry.method === 'session/prompt').length
    handle.agent.followup(llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '第二轮' }] }))
    await handle.agent.whenIdle()
    assert.equal(transport.requests.filter((entry) => entry.method === 'session/prompt').length, promptsAfterFirst + 1)
    assert.equal(transport.requests.filter((entry) => entry.method === 'session/prompt').at(-1).params.prompt[0].text, '第二轮')
    const turnEnd = session.snapshotEvents().findLast((event) => event.type === 'turn/end')
    assert.equal(turnEnd.data.reason.kind, 'completed')
    handle.dispose()
  } finally {
    await ctx.dispose?.()
  }
})

test('native adapter ignores foreign, pre-prompt and post-settlement assistant chunks', async () => {
  class NoisyTransport extends FakeTransport {
    constructor() {
      super('本会话正文')
    }
    updateFor(sessionId, text) {
      for (const handler of this.notificationHandlers) {
        handler({
          method: 'session/update',
          params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
        })
      }
    }
    async request(method, params) {
      if (method === 'session/new') {
        const result = await super.request(method, params)
        this.updateFor('loop-session', 'PRELUDE-ALIEN')
        this.updateFor('other-session', 'FOREIGN-BEFORE')
        return result
      }
      if (method === 'session/prompt') {
        this.updateFor('other-session', 'FOREIGN-AFTER')
        const result = await super.request(method, params)
        return result
      }
      return super.request(method, params)
    }
  }
  const transport = new NoisyTransport()
  const adapter = new AgyAcpAdapter({ transport: () => transport })
  const chunks = []
  for await (const chunk of adapter.stream({
    model: MODEL_ID,
    reasoningEffort: EFFORT_LOW_ID,
    messages: [{ role: 'user', content: [{ type: 'text', text: '只收本会话正文' }] }],
  })) {
    chunks.push(chunk)
  }
  transport.updateFor('loop-session', 'LATE-AFTER')
  const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
  assert.equal(text, '本会话正文')
  assert.equal(JSON.stringify(chunks).includes('FOREIGN'), false)
  assert.equal(JSON.stringify(chunks).includes('PRELUDE'), false)
  assert.equal(JSON.stringify(chunks).includes('LATE'), false)
})

test('native adapter: one stdout batch closes collection at the prompt response', async () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'ag-native-batch-'))
  const server = String.raw`
    import process from 'node:process'
    let sessionId = 'native-batch-session'
    let promptCount = 0
    const model = 'gemini-4-argon'
    const options = () => [
      { id: 'model', category: 'model', currentValue: model, options: [{ value: model, name: model }] },
      { id: 'thought', category: 'thought_level', currentValue: 'low', options: [{ value: 'low', name: 'low' }] },
    ]
    const send = (value) => process.stdout.write(JSON.stringify(value) + '\n')
    const update = (text) => ({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
    })
    let buffer = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      buffer += chunk
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line === '') continue
        const message = JSON.parse(line)
        if (message.method === 'initialize') {
          send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
        } else if (message.method === 'session/new') {
          send({ jsonrpc: '2.0', id: message.id, result: { sessionId, configOptions: options() } })
        } else if (message.method === 'session/set_config_option') {
          send({ jsonrpc: '2.0', id: message.id, result: { configOptions: options() } })
        } else if (message.method === 'session/prompt') {
          promptCount += 1
          // Deliberately one stdout write, in protocol order:
          // final assistant chunk -> matching response -> same-session replay.
          process.stdout.write(
            JSON.stringify(update('NATIVE-FINAL')) + '\n' +
            JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } }) + '\n' +
            JSON.stringify(update('AFTER-END-REPLAY')) + '\n',
          )
        }
      }
    })
    process.stdin.on('end', () => process.exit(0))
  `
  const transport = new AcpStdioTransport({
    agyExecutable: process.execPath,
    agyArgs: ['-e', server],
    cwd: temp,
  })
  const adapter = new AgyAcpAdapter({ transport: () => transport })
  try {
    const chunks = []
    for await (const chunk of adapter.stream({
      model: MODEL_ID,
      reasoningEffort: EFFORT_LOW_ID,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'single batch boundary' }] }],
    })) {
      chunks.push(chunk)
    }
    const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
    assert.equal(text, 'NATIVE-FINAL')
    assert.equal(JSON.stringify(chunks).includes('AFTER-END-REPLAY'), false)
    assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1)
  } finally {
    transport.close()
    await new Promise((resolve) => setTimeout(resolve, 100))
    try {
      rmSync(temp, { recursive: true, force: true })
    } catch {
      // Windows may hold the child cwd briefly; the assertions already ran.
    }
  }
})

test('web panel controller uploads receipts through a session uploader and never sends file contents', async () => {
  const calls = []
  const bridge = {
    available: true,
    capabilities: async () => ({
      ok: true,
      capabilities: {
        transports: ['acp'],
        models: [MODEL_ID],
        efforts: [EFFORT_LOW_ID],
        attachments: { pathRefs: true, uploadReceipt: true },
      },
    }),
    dispatch: async (payload) => {
      calls.push(payload)
      return { ok: true, jobId: 'job-1', status: 'accepted', view: { jobId: 'job-1', status: 'accepted' } }
    },
    status: async () => ({ ok: true, view: { jobId: 'job-1', status: 'accepted' } }),
    reply: async () => ({ ok: true, available: false }),
    cancel: async () => ({ ok: true }),
  }
  const uploaded = []
  const uploader = {
    upload: async (sessionId, file, name) => {
      uploaded.push({ sessionId, name, size: file.size })
      return { ok: true, value: { receiptId: `receipt-${uploaded.length}`, file: { name, bytes: file.size } } }
    },
  }
  const controller = createPanelController({ bridge, sessionId: 'session-a', uploader })
  try {
    await controller.refreshCapabilities()
    controller.setMessage('看这两个附件')
    const added = await controller.addFiles([
      { name: 'fixture.txt', size: 17 },
      { name: 'pixel.png', size: 68 },
    ])
    assert.equal(added.ok, true)
    assert.deepEqual(uploaded.map((entry) => entry.sessionId), ['session-a', 'session-a'])
    const result = await controller.dispatch()
    assert.equal(result.ok, true)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].attachments, ['receipt-1', 'receipt-2'])
    assert.equal(JSON.stringify(calls[0]).includes('fixture.txt'), false)
    assert.deepEqual(controller.getState().files, [])
    assert.equal(controller.getState().pathRefs.length, 0)
  } finally {
    controller.dispose()
  }
})

function makeHostContext({ fileUploads, attachments }) {
  return {
    get(name) {
      if (name === 'fileUploads') return fileUploads
      if (name === 'attachments') return attachments
      return undefined
    },
    agents: { get: () => undefined, list: () => [] },
  }
}

test('host service resolves session receipts to host paths; ACP receives exact text/image bytes', async () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'ag-ui-model-'))
  const logPath = path.join(temp, 'events.jsonl')
  const statePath = path.join(temp, 'state.json')
  const textPath = path.join(temp, 'fixture.txt')
  const imagePath = path.join(temp, 'pixel.png')
  const text = 'exact fixture bytes 123'
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  writeFileSync(textPath, text)
  writeFileSync(imagePath, png)
  const bridge = new Bridge(
    { agents: { get: () => undefined, list: () => [] }, logger: { warn: () => {} } },
    defaultConfig({
      agyExecutable: process.execPath,
      agyArgs: [mockPath, `--state=${statePath}`, `--log=${logPath}`, `--write-root=${temp}`],
      cwd: temp,
      stateFile: statePath,
      waitPollMs: 50,
      autoWake: false,
    }),
  )
  bridge.start()
  const fileUploads = {
    resolve(agent, receiptId) {
      if (agent.id !== 'agent-a') return undefined
      if (receiptId === 'text-receipt') return { type: 'file', attachment: { name: 'fixture.txt', bytes: text.length } }
      if (receiptId === 'image-receipt') return { type: 'file', attachment: { name: 'pixel.png', bytes: png.length } }
      return undefined
    },
  }
  const attachments = {
    fileHostPath(ref) {
      return ref.name === 'pixel.png' ? imagePath : textPath
    },
  }
  const ctx = makeHostContext({ fileUploads, attachments })
  const service = new AntigravityBridgeService({
    ctx,
    bridge,
    config: { models: [MODEL_ID], efforts: [EFFORT_LOW_ID], cwd: temp },
  })
  try {
    const agent = { id: 'agent-a', session: { id: 'session-a' } }
    const dispatched = await service.dispatch(agent, {
      clientRequestId: 'intent-1',
      message: '请核对附件',
      transport: 'acp',
      attachments: ['text-receipt', 'image-receipt'],
    })
    assert.equal(dispatched.ok, true, JSON.stringify(dispatched))
    assert.notEqual(dispatched.reused, true)
    const duplicate = await service.dispatch(agent, {
      clientRequestId: 'intent-1',
      message: '这个正文不能产生第二个 prompt',
      transport: 'acp',
      attachments: ['text-receipt', 'image-receipt'],
    })
    assert.equal(duplicate.ok, true, JSON.stringify(duplicate))
    assert.equal(duplicate.reused, true)
    assert.equal(duplicate.jobId, dispatched.jobId)
    const foreignIntent = await service.dispatch({ id: 'agent-b', session: { id: 'session-b' } }, {
      clientRequestId: 'intent-1',
      message: '另一个 owner 的同名意图必须独立',
      transport: 'acp',
    })
    assert.equal(foreignIntent.ok, true, JSON.stringify(foreignIntent))
    assert.notEqual(foreignIntent.jobId, dispatched.jobId)

    const [concurrentA, concurrentB] = await Promise.all([
      service.dispatch(agent, {
        clientRequestId: 'intent-concurrent',
        message: '并发意图 A',
        transport: 'acp',
      }),
      service.dispatch(agent, {
        clientRequestId: 'intent-concurrent',
        message: '并发意图 B',
        transport: 'acp',
      }),
    ])
    assert.equal(concurrentA.ok, true, JSON.stringify(concurrentA))
    assert.equal(concurrentB.ok, true, JSON.stringify(concurrentB))
    assert.equal(concurrentA.jobId, concurrentB.jobId)
    assert.equal([concurrentA.reused, concurrentB.reused].filter(Boolean).length, 1)

    const reloaded = new AntigravityBridgeService({
      ctx,
      bridge,
      config: { models: [MODEL_ID], efforts: [EFFORT_LOW_ID], cwd: temp },
    })
    const afterReload = await reloaded.dispatch(agent, {
      clientRequestId: 'intent-1',
      message: '重载后同一意图不能新建',
      transport: 'acp',
    })
    assert.equal(afterReload.ok, true, JSON.stringify(afterReload))
    assert.equal(afterReload.reused, true)
    assert.equal(afterReload.jobId, dispatched.jobId)

    await bridge.waitFor(bridge.job(foreignIntent.jobId), { timeoutMs: 5000 })
    await bridge.waitFor(bridge.job(concurrentA.jobId), { timeoutMs: 5000 })
    const job = bridge.job(dispatched.jobId)
    await bridge.waitFor(job, { timeoutMs: 5000 })
    const events = readFileSync(logPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    const prompt = events.find((entry) => entry.event === 'prompt')
    assert.ok(
      prompt,
      JSON.stringify({ status: job.status, code: job.code, message: job.message, events: events.slice(-8) }),
    )
    assert.equal(dispatched.view.fileMode, 'attachment')
    assert.deepEqual(prompt.attachments.map((entry) => entry.kind), ['resource', 'image'])
    assert.equal(prompt.attachments[0].sha256, sha256(text))
    assert.equal(prompt.attachments[1].sha256, sha256(png))
    assert.equal(prompt.attachments[1].bytes, png.length)

    const pathJob = await service.dispatch(agent, {
      clientRequestId: 'intent-path',
      message: '只引用路径',
      transport: 'acp',
      pathRefs: [textPath],
    })
    assert.equal(pathJob.ok, true, JSON.stringify(pathJob))
    await bridge.waitFor(bridge.job(pathJob.jobId), { timeoutMs: 5000 })
    const eventsAfterPath = readFileSync(logPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    const pathPrompt = eventsAfterPath.find(
      (entry) => entry.event === 'prompt' && String(entry.text).includes('[path_reference]'),
    )
    assert.equal(pathJob.view.fileMode, 'path_reference')
    assert.ok(pathPrompt, JSON.stringify({ pathJob, job: bridge.job(pathJob.jobId), events: events.slice(-8) }))
    assert.ok(pathPrompt.text.includes(`- ${textPath}`))
    assert.equal(pathPrompt.text.includes(text), false)
    assert.equal(pathPrompt.attachments.length, 0)

    const denied = await service.dispatch(agent, { message: '越权', attachments: ['other-session-receipt'] })
    assert.equal(denied.ok, false)
    assert.equal(denied.code, 'attachment_receipt_invalid')
    const promptCount = eventsAfterPath.filter((entry) => entry.event === 'prompt').length
    assert.equal(bridge.listJobs('agent-a').length, 3)
    assert.equal(promptCount, 4)
  } finally {
    bridge.dispose()
    await new Promise((resolve) => setTimeout(resolve, 150))
    try {
      rmSync(temp, { recursive: true, force: true })
    } catch {
      // Windows may still hold the mock process cwd for a moment; the temp
      // directory is disposable and the assertions above already ran.
    }
  }
})

test('web panel keeps an ambiguous intent, cancel observes the real view, and business errors stay terminal', async () => {
  let timerCallback = null
  const payloads = []
  let dispatchCount = 0
  let cancelReply = { ok: true, view: { jobId: 'job-1', state: 'accepted', stopReason: '' } }
  let statusReply = { ok: true, view: { jobId: 'job-1', state: 'accepted', stopReason: '' } }
  const bridge = {
    available: true,
    async capabilities() {
      return {
        ok: true,
        capabilities: {
          transports: ['acp'],
          models: [MODEL_ID],
          efforts: [EFFORT_LOW_ID],
          attachments: { pathRefs: true, uploadReceipt: true },
        },
      }
    },
    async dispatch(payload) {
      payloads.push(payload)
      dispatchCount += 1
      if (dispatchCount === 1) {
        return { ok: false, code: 'acceptance_unknown', status: 'acceptance_unknown', jobId: 'job-1' }
      }
      return { ok: true, reused: true, jobId: 'job-1', status: 'acceptance_unknown', view: { jobId: 'job-1', state: 'acceptance_unknown' } }
    },
    async status() {
      return statusReply
    },
    async reply() {
      return { ok: true, available: true, text: 'cached final reply' }
    },
    async cancel() {
      return cancelReply
    },
  }
  const controller = createPanelController({
    bridge,
    sessionId: 'session-a',
    setTimer: (fn) => {
      timerCallback = fn
      return 1
    },
    clearTimer: () => {},
  })
  try {
    await controller.refreshCapabilities()
    controller.setMessage('first intent')
    const first = await controller.dispatch()
    assert.equal(first.ok, false)
    assert.equal(controller.getState().intentId, payloads[0].clientRequestId)
    controller.setMessage('retry the same intent')
    const second = await controller.dispatch()
    assert.equal(second.ok, true)
    assert.equal(payloads[1].clientRequestId, payloads[0].clientRequestId)
    assert.equal(controller.getState().intentId, payloads[0].clientRequestId)

    // A third click after the reused/unknown acknowledgement must still be the
    // same intent: only the explicit "new intent" action may change the id.
    controller.setMessage('third click without a new intent')
    const third = await controller.dispatch()
    assert.equal(third.ok, true)
    assert.equal(payloads[2].clientRequestId, payloads[0].clientRequestId)
    assert.equal(payloads[2].message, payloads[0].message)
    assert.deepEqual(payloads[2], payloads[0])
    assert.equal(controller.getState().intentId, payloads[0].clientRequestId)

    controller.setMessage('cancel while pending')
    await controller.dispatch()
    controller.setMessage('cancel this pending job')
    const pending = await controller.cancel()
    assert.equal(pending.phase, 'cancel_pending')
    assert.equal(controller.getState().jobId, 'job-1')
    assert.equal(controller.getState().phase, 'accepted')

    cancelReply = {
      ok: true,
      view: { jobId: 'job-1', state: 'failed', code: 'cancelled', stopReason: 'cancelled' },
    }
    const cancelled = await controller.cancel()
    assert.equal(cancelled.phase, 'cancelled')
    assert.equal(controller.getState().jobId, 'job-1')

    cancelReply = { ok: true, view: { jobId: 'job-1', state: 'replied', stopReason: 'end_turn' } }
    const replied = await controller.cancel()
    assert.equal(replied.phase, 'replied')
    assert.equal(controller.getState().replyText, 'cached final reply')

    const already = await controller.cancel()
    assert.equal(already.phase, 'replied')
    assert.equal(controller.getState().replyText, 'cached final reply')

    statusReply = { ok: false, code: 'backend_unavailable', view: { jobId: 'job-1', state: 'accepted', stopReason: '' } }
    controller.setMessage('retry status')
    await controller.dispatch()
    await new Promise((resolve) => setImmediate(resolve))
    if (timerCallback) await Promise.resolve(timerCallback())
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(controller.getState().error, 'backend_unavailable')
    assert.equal(controller.getState().jobId, 'job-1')
    assert.equal(controller.getState().view.state, 'accepted')
  } finally {
    controller.dispose()
  }
})

test('web panel: a late cancel reply for A cannot stop B polling', async () => {
  let timerCallback = null
  let jobSeq = 0
  let resolveReply
  const replyPromise = new Promise((resolve) => {
    resolveReply = resolve
  })
  const bridge = {
    available: true,
    async capabilities() {
      return {
        ok: true,
        capabilities: { transports: ['acp'], models: [MODEL_ID], efforts: [EFFORT_LOW_ID], attachments: {} },
      }
    },
    async dispatch(payload) {
      jobSeq += 1
      return {
        ok: true,
        jobId: `job-${jobSeq}`,
        status: 'accepted',
        view: { jobId: `job-${jobSeq}`, state: 'accepted' },
        payload,
      }
    },
    async status(jobId) {
      return { ok: true, view: { jobId, state: 'accepted', stopReason: '' } }
    },
    async reply() {
      return replyPromise
    },
    async cancel() {
      return { ok: true, view: { jobId: 'job-1', state: 'replied', stopReason: 'end_turn' } }
    },
  }
  const controller = createPanelController({
    bridge,
    sessionId: 'session-a',
    setTimer: (fn) => {
      timerCallback = fn
      return 1
    },
    clearTimer: () => {},
  })
  try {
    await controller.refreshCapabilities()
    controller.setMessage('A request')
    await controller.dispatch()
    assert.equal(controller.getState().jobId, 'job-1')
    assert.ok(timerCallback)

    const cancelled = controller.cancel()
    await new Promise((resolve) => setImmediate(resolve))
    controller.setSession('session-b')
    controller.setMessage('B request')
    await controller.dispatch()
    assert.equal(controller.getState().jobId, 'job-2')
    assert.ok(timerCallback)

    resolveReply({ ok: true, available: true, text: 'late A reply' })
    const result = await cancelled
    assert.equal(result.code, 'stale_session')
    assert.equal(controller.getState().jobId, 'job-2')
    assert.ok(timerCallback, 'B timer must survive A late reply')
    await timerCallback()
    assert.equal(controller.getState().jobId, 'job-2')
  } finally {
    controller.dispose()
  }
})

test('preset helper installs the tool-scope row instead of inheriting global tools', async () => {
  const { presetDefinition } = await import('../preset/index.js')
  const toolScope = await import('../preset/tool-scope.js')
  const definition = presetDefinition()
  assert.equal(definition.id, 'antigravity-acp-text')
  assert.deepEqual(definition.plugins, [{ name: 'dsh-agy-bridge/preset/tool-scope' }])

  const restrictions = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    tools: {
      view: () => ({ restrictableNames: new Set(['bridge_send', 'bridge_read']) }),
      restrict(filter) {
        restrictions.push(filter)
        return () => {}
      },
    },
  }
  toolScope.apply(ctx)
  assert.deepEqual(restrictions, [{ deny: ['bridge_send', 'bridge_read'] }])
})

test('client bundle registers its panel, upload-capable remote, and file uploader at the session slot', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const source = readFileSync(path.join(root, 'client/index.js'), 'utf8')
  // The generated bundle must carry the same intent/timer fixes as panel.js.
  assert.match(source, /const keepIntent = result\.status !== 'not_sent'/)
  assert.match(source, /intentRequest: keepIntent \? payload : null/)
  assert.match(source, /stopPoll\(\{ generation, jobId \}\)/)
  let loaded
  const mounts = []
  const injections = []
  const window = { __ModuleLoader__: { load(spec) { loaded = spec } } }
  const React = {
    createElement: () => null,
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useState: (value) => [value, () => {}],
  }
  runInNewContext(source, { window, console, setTimeout, clearTimeout })
  assert.ok(loaded, 'bundle must call __ModuleLoader__.load')
  assert.equal(loaded.id, 'dsh-agy-bridge')
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    slots: {
      inject(slot, register) {
        injections.push({ slot, register })
      },
    },
    locale: { register: () => {} },
    remote: {
      $mount(info) {
        mounts.push(info)
        return Promise.resolve(() => {})
      },
    },
    get: (name) => (name === 'fileUpload' ? { upload: async () => ({ ok: true, value: { receiptId: 'r' } }) } : undefined),
  }
  const plugin = loaded.factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require ${id}`)
  })
  plugin.apply(ctx)
  assert.equal(injections.length, 1)
  assert.equal(injections[0].slot, 'conversation.composer.dock')
  assert.equal(typeof injections[0].register, 'function')
  assert.equal(mounts.length, 1)
  assert.equal(mounts[0].package, 'dsh-agy-bridge')
  const dispatch = mounts[0].descriptors.find((entry) => entry.method === 'dispatch')
  const request = dispatch.parameters.find((entry) => entry.name === 'request')
  assert.equal(request.codec.jsonSchema.properties.attachments.items.type, 'string')
  assert.equal(request.codec.jsonSchema.properties.attachments.maxItems, 10)
  assert.equal(request.codec.jsonSchema.additionalProperties, false)
})