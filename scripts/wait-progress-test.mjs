import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { apply, waitTimeoutMessage } from '../lib/index.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const temp = mkdtempSync(join(tmpdir(), 'antigravity-wait-progress-'))
let passed = 0
let failed = 0

function discoverValidator() {
  const explicit = process.env.DSH_JSON_SCHEMA_VALIDATOR || ''
  if (explicit !== '' && existsSync(explicit)) return explicit
  const candidates = []
  for (const home of [process.env.DSH_HOME, 'D:\\dsh-home', 'D:\\dsh-data'].filter(Boolean)) {
    const versions = join(home, 'versions')
    if (!existsSync(versions)) continue
    for (const entry of readdirSync(versions)) {
      const file = join(versions, entry, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'types', 'json-schema.js')
      if (existsSync(file)) candidates.push({ file, mtime: statSync(file).mtimeMs })
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  if (!candidates.length) throw new Error('DSH json-schema validator not found')
  return candidates[0].file
}

const validator = await import(pathToFileURL(discoverValidator()).href)
const { assertSupportedJsonSchema, validateJsonSchemaValue } = validator

function makeStubBackend() {
  let promptCalls = 0
  let pending = null
  const configOptions = [
    { id: 'model', category: 'model', type: 'select', currentValue: 'test-model-a', options: [{ value: 'test-model-a', name: 'Test A' }] },
    { id: 'thought_level', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }] },
  ]
  const backend = {
    kind: 'acp',
    async ready() {
      return {
        protocolVersion: 1,
        loadSession: false,
        promptCapabilities: { image: false, embeddedContext: false },
        authMethods: [],
      }
    },
    async createSession() {
      return { sessionId: 'acp-wait-progress-1', configOptions }
    },
    async setConfigOption(_sessionId, configId, value) {
      const item = configOptions.find((x) => x.id === configId)
      if (item) item.currentValue = String(value)
      return { configOptions }
    },
    promptSession({ onToolEvent }) {
      promptCalls += 1
      let resolveFn
      let rejectFn
      const promise = new Promise((resolve, reject) => {
        resolveFn = resolve
        rejectFn = reject
      })
      pending = {
        resolve(val) {
          resolveFn(val)
          pending = null
        },
        reject(err) {
          rejectFn(err)
          pending = null
        },
        emitTool(ev) {
          onToolEvent?.(ev)
        },
      }
      return promise
    },
    cancelSession() {
      if (pending) pending.resolve({ text: '', stopReason: 'cancelled', permissions: [], configOptions })
    },
    async close() {},
  }
  return {
    backend,
    getPromptCalls: () => promptCalls,
    getPending: () => pending,
  }
}

async function createHarness() {
  const disposers = []
  const registrations = []
  const ctx = {
    tools: {
      register(def) {
        registrations.push(def)
        return () => {}
      },
    },
    effect(fn) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
      return () => {}
    },
    get: () => undefined,
    logger: { debug() {}, info() {}, warn() {}, error() {}, trace() {} },
    on: () => () => {},
    reflect: { provide() {}, get: () => undefined },
    root: {},
  }
  const stub = makeStubBackend()
  const config = {
    cwd: temp,
    stateFile: join(temp, `state-${Math.random().toString(36).slice(2)}.json`),
    autoWake: false,
    pollMs: 1000,
    waitPollMs: 50,
    permissionPolicy: 'reject',
    backend: stub.backend,
  }
  await apply(ctx, config)
  const tools = new Map(registrations.map((d) => [d.name, d]))
  return {
    tools,
    stub,
    async dispose() {
      for (const d of [...disposers].reverse()) await d()
    },
  }
}

const exec = { agent: { id: 'agent-wp-1' } }
const harness = await createHarness()
const sendTool = harness.tools.get('antigravity_send')
const waitTool = harness.tools.get('antigravity_wait')
const readTool = harness.tools.get('antigravity_read')
const listTool = harness.tools.get('antigravity_list')

let activeJobId = ''

test.after(async () => {
  await harness.dispose()
  rmSync(temp, { recursive: true, force: true })
  console.log(`wait-progress-test: ${passed}/${passed + failed} passed`)
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

trackedTest('T1: progress mode returns immediately without blocking and validates against schema', async () => {
  const sent = await sendTool.execute({ message: 'long running task' }, exec)
  activeJobId = sent.jobId
  assert.equal(sent.status, 'accepted')

  const t0 = performance.now()
  const res = await waitTool.execute({ job_id: activeJobId, mode: 'progress' }, exec)
  const dt = performance.now() - t0
  assert.ok(dt < 2000, `expected < 2000ms, got ${dt}ms`)
  assert.equal(res.progress.mode, 'progress')
  assert.ok(res.progress.elapsedMs >= 0)
  assert.ok(Array.isArray(res.progress.recentActivity))
  assert.equal(res.progress.terminal, false)
  assert.equal(res.progress.activityCount, res.progress.recentActivity.length)
  assert.deepEqual(validateJsonSchemaValue(waitTool.output.schema, res, 'value'), [])
})

trackedTest('T3: waitTimeoutMessage and real wait timeout include bilingual no-resend guidance', async () => {
  const msg = waitTimeoutMessage(30, '已受理，ACP 运行中')
  assert.ok(msg.includes('不要重发'))
  assert.ok(msg.includes('antigravity_read'))
  assert.ok(msg.includes('Do not resend'))

  const keepAlive = setInterval(() => {}, 1000)
  let res
  try {
    res = await waitTool.execute({ job_id: activeJobId, timeout_sec: 1 }, exec)
  } finally {
    clearInterval(keepAlive)
  }
  assert.equal(res.code, 'wait_timeout')
  for (const text of [res.message, res.markdown]) {
    assert.ok(text.includes('不要重发'))
    assert.ok(text.includes('antigravity_read'))
    assert.ok(text.includes('Do not resend'))
  }
  assert.equal(harness.stub.getPromptCalls(), 1)
})

trackedTest('T2: progress reflects recentActivity and terminal=true after job replies', async () => {
  const pending = harness.stub.getPending()
  assert.ok(pending)
  pending.emitTool({ toolCallId: 'tool-1', kind: 'read', title: 'Mock read', status: 'completed' })
  pending.resolve({ text: 'done', stopReason: 'end_turn', permissions: [] })

  for (let i = 0; i < 40; i++) {
    const r = await readTool.execute({ job_id: activeJobId }, exec)
    if (r.status === 'replied') break
    await new Promise((r) => setTimeout(r, 25))
  }

  const res = await waitTool.execute({ job_id: activeJobId, mode: 'progress' }, exec)
  assert.equal(res.status, 'replied')
  assert.equal(res.progress.terminal, true)
  assert.equal(res.progress.activityCount, 1)
  assert.equal(res.progress.recentActivity[0].title, 'Mock read')
  assert.equal(res.progress.recentActivity[0].kind, 'read')
  assert.ok(res.markdown.includes('已达到终态，progress 不会再变化'))
})

trackedTest('T4: default wait (no mode) has no progress key and keeps backward-compatible keys', async () => {
  const res = await waitTool.execute({ job_id: activeJobId }, exec)
  assert.equal('progress' in res, false)
  assert.equal(res.status, 'replied')
  assert.equal(res.reply, 'done')
  assert.deepEqual(validateJsonSchemaValue(waitTool.output.schema, res, 'value'), [])
  const requiredKeys = [
    'markdown', 'jobId', 'workspaceRoot', 'transport', 'conversationId', 'sessionId',
    'desktopConversationId', 'targetKind', 'status', 'code', 'message', 'reply',
    'tools', 'permissions', 'wakeState', 'stopReason', 'cancelRequested', 'runStatus',
    'fileMode', 'requested', 'effective', 'confirmed', 'configOptions', 'title', 'ack',
    'createdAt', 'updatedAt',
  ]
  for (const key of requiredKeys) assert.ok(key in res, `missing key ${key}`)
})

trackedTest('T5: wait parameters and output.schema conform to DSH JSON-schema subset', () => {
  assert.doesNotThrow(() => assertSupportedJsonSchema(waitTool.parameters))
  assert.doesNotThrow(() => assertSupportedJsonSchema(waitTool.output.schema))
  const combined = JSON.stringify({ p: waitTool.parameters, o: waitTool.output.schema })
  for (const forbidden of ['"minimum"', '"maximum"', '"pattern"', '"format"']) {
    assert.ok(!combined.includes(forbidden), `unexpected ${forbidden} in schema`)
  }
})

trackedTest('T6: progress and timeout never create duplicate jobs', async () => {
  assert.equal(harness.stub.getPromptCalls(), 1)
  const listRes = await listTool.execute({ limit: 10 }, exec)
  assert.equal(listRes.jobs.length, 1)
  assert.equal(listRes.jobs[0].jobId, activeJobId)
})
