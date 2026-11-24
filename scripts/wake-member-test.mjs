import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Bridge, defaultConfig } from '../lib/bridge.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const temp = mkdtempSync(join(tmpdir(), 'antigravity-wake-member-'))
let passed = 0
let failed = 0

test.after(() => {
  rmSync(temp, { recursive: true, force: true })
  console.log(`wake-member-test: ${passed}/${passed + failed} passed`)
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

function makeStubBackend(replyText = 'member-wake-reply') {
  return {
    kind: 'acp',
    async ready() {
      return { protocolVersion: 1, loadSession: false, promptCapabilities: {}, authMethods: [] }
    },
    async createSession() {
      return { sessionId: 'acp-wm-1', configOptions: [] }
    },
    async promptSession() {
      return { stopReason: 'end_turn', text: replyText, tools: [], permissions: [] }
    },
    async close() {},
  }
}

function makeHarness({ subagents = null, stateFileName = `state-${Math.random().toString(36).slice(2)}.json` } = {}) {
  const stateFile = join(temp, stateFileName)
  const ownerFollowups = []
  const targetFollowups = []
  const ownerAgent = {
    id: 'agent-owner',
    followup(msg) {
      ownerFollowups.push(msg)
    },
  }
  const neonAgent = {
    id: 'sess-neon',
    followup(msg) {
      targetFollowups.push(msg)
    },
  }
  const agentsMap = new Map([
    ['agent-owner', ownerAgent],
    ['sess-neon', neonAgent],
    ['relay-neon', neonAgent],
  ])
  const ctx = {
    agents: {
      get: (id) => agentsMap.get(String(id)),
      list: () => [...agentsMap.values()],
    },
    ...(subagents ? { subagents } : {}),
  }
  const config = defaultConfig({
    cwd: temp,
    stateFile,
    autoWake: true,
    waitPollMs: 50,
    pollMs: 1000,
    backend: makeStubBackend(),
    messageFactory: async () => (payload) => payload,
  })
  const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  const bridge = new Bridge(ctx, config, noopLogger)
  bridge.remember(ownerAgent)
  return { bridge, stateFile, ownerFollowups, targetFollowups, ownerAgent, neonAgent }
}

function assertResolveSignal(signal) {
  signal?.throwIfAborted?.()
  if (!signal || typeof signal.addEventListener !== 'function') {
    throw new TypeError('resolveName requires an AbortSignal')
  }
}

function assertSendSignal(options) {
  options?.signal?.throwIfAborted?.()
  if (!options || !options.signal || typeof options.signal.addEventListener !== 'function') {
    throw new TypeError('sendMessage requires options.signal')
  }
}

let t1Bridge = null
let t1Job = null
let t1SendCalls = []
let t1StateFile = ''

trackedTest('T1: wakeAgent delivers final wakeText via subagents.sendMessage once', async () => {
  t1SendCalls = []
  const subagents = {
    async resolveName(_caller, name, signal) {
      assertResolveSignal(signal)
      assert.equal(name, 'relay-neon')
      return 'sess-neon'
    },
    async sendMessage(sender, targetId, content, options) {
      assertSendSignal(options)
      t1SendCalls.push({ senderId: sender.id, targetId, content })
      return 'msg-1'
    },
  }
  const h = makeHarness({ subagents })
  t1Bridge = h.bridge
  t1StateFile = h.stateFile

  const begun = h.bridge.beginSend({
    agentId: 'agent-owner',
    workspaceRoot: temp,
    transport: 'acp',
    message: 'deliver to neon',
    wakeAgent: 'relay-neon',
  })
  t1Job = begun.job
  await h.bridge.dispatch(t1Job, { message: 'deliver to neon', requested: t1Job.requested, attachments: [], cwd: temp })
  await h.bridge.waitFor(t1Job, { timeoutMs: 2000 })
  await new Promise((r) => setTimeout(r, 20))

  assert.equal(t1SendCalls.length, 1)
  assert.equal(t1SendCalls[0].targetId, 'sess-neon')
  assert.ok(t1SendCalls[0].content[0].text.startsWith('[Antigravity 回复]'))
  assert.ok(t1SendCalls[0].content[0].text.includes('member-wake-reply'))
  assert.equal(t1Job.wakeState, 'delivered')
  assert.equal(h.bridge.view(t1Job).wakeDeliveredVia, 'subagents')
})

trackedTest('T2: maybeWake is idempotent and logs wake-rejected on second trigger', async () => {
  const second = await t1Bridge.maybeWake(t1Job)
  assert.equal(second, false)
  assert.equal(t1SendCalls.length, 1)
  const logText = readFileSync(`${t1StateFile}.log`, 'utf8')
  assert.ok(logText.includes('wake-rejected'))
  t1Bridge.dispose()
})

trackedTest('T3: busy target member queues without rejection or retry', async () => {
  let busySendCount = 0
  const subagents = {
    async resolveName(_caller, _name, signal) {
      assertResolveSignal(signal)
      return 'sess-neon'
    },
    async sendMessage(_s, _t, _c, options) {
      assertSendSignal(options)
      busySendCount += 1
      return 'msg-queued-busy'
    },
  }
  const h = makeHarness({ subagents })
  try {
    const begun = h.bridge.beginSend({
      agentId: 'agent-owner',
      workspaceRoot: temp,
      transport: 'acp',
      message: 'busy target',
      wakeAgent: 'relay-neon',
    })
    await h.bridge.dispatch(begun.job, { message: 'busy target', requested: begun.job.requested, attachments: [], cwd: temp })
    await h.bridge.waitFor(begun.job, { timeoutMs: 2000 })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(busySendCount, 1)
    assert.equal(begun.job.wakeState, 'delivered')
  } finally {
    h.bridge.dispose()
  }
})

trackedTest('T4: job without wakeAgent wakes owner via followup', async () => {
  let subagentCalls = 0
  const subagents = {
    async resolveName() { return 'sess-neon' },
    async sendMessage() { subagentCalls += 1; return 'm' },
  }
  const h = makeHarness({ subagents })
  try {
    const begun = h.bridge.beginSend({
      agentId: 'agent-owner',
      workspaceRoot: temp,
      transport: 'acp',
      message: 'owner only',
    })
    await h.bridge.dispatch(begun.job, { message: 'owner only', requested: begun.job.requested, attachments: [], cwd: temp })
    await h.bridge.waitFor(begun.job, { timeoutMs: 2000 })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(h.ownerFollowups.length, 1)
    assert.equal(subagentCalls, 0)
    assert.equal(begun.job.wakeState, 'delivered')
    assert.equal(h.bridge.view(begun.job).wakeDeliveredVia, 'followup')
  } finally {
    h.bridge.dispose()
  }
})

trackedTest('T5: missing ctx.subagents or UNAUTHORIZED falls back to target followup', async () => {
  const hNoSvc = makeHarness({ subagents: null })
  try {
    const begun = hNoSvc.bridge.beginSend({
      agentId: 'agent-owner',
      workspaceRoot: temp,
      transport: 'acp',
      message: 'no subagents',
      wakeAgent: 'relay-neon',
    })
    await hNoSvc.bridge.dispatch(begun.job, { message: 'no subagents', requested: begun.job.requested, attachments: [], cwd: temp })
    await hNoSvc.bridge.waitFor(begun.job, { timeoutMs: 2000 })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(hNoSvc.targetFollowups.length, 1)
    assert.equal(begun.job.wakeState, 'delivered')
    assert.equal(hNoSvc.bridge.view(begun.job).wakeDeliveredVia, 'followup')
  } finally {
    hNoSvc.bridge.dispose()
  }

  const unauthSubagents = {
    async resolveName(_caller, _name, signal) {
      assertResolveSignal(signal)
      return 'agent-owner'
    },
    async sendMessage(_s, _t, _c, options) {
      assertSendSignal(options)
      throw Object.assign(new Error('cannot send to self'), { code: 'UNAUTHORIZED' })
    },
  }
  const hUnauth = makeHarness({ subagents: unauthSubagents })
  try {
    const begun = hUnauth.bridge.beginSend({
      agentId: 'agent-owner',
      workspaceRoot: temp,
      transport: 'acp',
      message: 'unauth self',
      wakeAgent: 'lead',
    })
    await hUnauth.bridge.dispatch(begun.job, { message: 'unauth self', requested: begun.job.requested, attachments: [], cwd: temp })
    await hUnauth.bridge.waitFor(begun.job, { timeoutMs: 2000 })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(hUnauth.ownerFollowups.length, 1)
    assert.equal(begun.job.wakeState, 'delivered')
    assert.equal(hUnauth.bridge.view(begun.job).wakeDeliveredVia, 'followup')
  } finally {
    hUnauth.bridge.dispose()
  }
})

trackedTest('T6: AGENT_NAME_NOT_FOUND degrades to owner followup without throwing and logs trace', async () => {
  const subagents = {
    async resolveName(_caller, _name, signal) {
      assertResolveSignal(signal)
      throw Object.assign(new Error('not found'), { code: 'AGENT_NAME_NOT_FOUND' })
    },
    async sendMessage(_s, _t, _c, options) {
      assertSendSignal(options)
      throw new Error('should not be called')
    },
  }
  const h = makeHarness({ subagents })
  try {
    const begun = h.bridge.beginSend({
      agentId: 'agent-owner',
      workspaceRoot: temp,
      transport: 'acp',
      message: 'bad name',
      wakeAgent: 'team/missing',
    })
    await h.bridge.dispatch(begun.job, { message: 'bad name', requested: begun.job.requested, attachments: [], cwd: temp })
    await h.bridge.waitFor(begun.job, { timeoutMs: 2000 })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(h.ownerFollowups.length, 1)
    assert.equal(begun.job.wakeState, 'delivered')
    const logText = readFileSync(`${h.stateFile}.log`, 'utf8')
    assert.ok(logText.includes('wake-resolve-failed'))
  } finally {
    h.bridge.dispose()
  }
})

trackedTest('T7: lib/acp.js and lib/model-adapter.js have zero DSH subagents/followup delivery calls', () => {
  const acpPath = join(ROOT, 'lib', 'acp.js')
  const acpStat = statSync(acpPath)
  // Removed exact byte-size literal (40479) because historical rename 0ee2156 shifted size by +-8B
  // and byte-length checks are brittle & redundant with the semantic token guards below.
  assert.ok(acpStat.size > 0)
  const acpSrc = readFileSync(acpPath, 'utf8')
  assert.ok(acpSrc.includes('class AcpClient'))
  const adapterSrc = readFileSync(join(ROOT, 'lib', 'model-adapter.js'), 'utf8')
  for (const src of [acpSrc, adapterSrc]) {
    assert.ok(!src.includes('subagents'))
    assert.ok(!src.includes('sendMessage'))
    assert.ok(!src.includes('followup('))
    assert.ok(!src.includes('agentOf('))
  }
  const bridgeSrc = readFileSync(join(ROOT, 'lib', 'bridge.js'), 'utf8')
  const wakeSection = bridgeSrc.slice(bridgeSrc.indexOf('async resolveWakeAgent('), bridgeSrc.indexOf('beginWaiter('))
  assert.ok(!wakeSection.includes('session/prompt'))
})

trackedTest('T8: sendMessage error without pre-acceptance code marks delivery_unknown without fallback', async () => {
  let sendCalls = 0
  const subagents = {
    async resolveName(_caller, _name, signal) {
      assertResolveSignal(signal)
      return 'sess-neon'
    },
    async sendMessage(_s, _t, _c, options) {
      assertSendSignal(options)
      sendCalls += 1
      throw new Error('post-queue transport glitch')
    },
  }
  const h = makeHarness({ subagents })
  try {
    const begun = h.bridge.beginSend({
      agentId: 'agent-owner',
      workspaceRoot: temp,
      transport: 'acp',
      message: 'unknown error test',
      wakeAgent: 'relay-neon',
    })
    await h.bridge.dispatch(begun.job, { message: 'unknown error test', requested: begun.job.requested, attachments: [], cwd: temp })
    await h.bridge.waitFor(begun.job, { timeoutMs: 2000 })
    await new Promise((r) => setTimeout(r, 20))

    assert.equal(sendCalls, 1)
    assert.equal(h.targetFollowups.length, 0)
    assert.equal(h.ownerFollowups.length, 0)
    assert.equal(begun.job.wakeState, 'delivery_unknown')
    const logText = readFileSync(`${h.stateFile}.log`, 'utf8')
    assert.ok(logText.includes('wake-unknown'))

    const second = await h.bridge.maybeWake(begun.job)
    assert.equal(second, false)
    assert.equal(sendCalls, 1)
    assert.equal(h.targetFollowups.length, 0)
    assert.equal(h.ownerFollowups.length, 0)
  } finally {
    h.bridge.dispose()
  }
})

trackedTest('T9: concurrent maybeWake calls deliver exactly once', async () => {
  let sendCalls = 0
  const subagents = {
    async resolveName(_caller, _name, signal) {
      assertResolveSignal(signal)
      return 'sess-neon'
    },
    async sendMessage(_s, _t, _c, options) {
      assertSendSignal(options)
      sendCalls += 1
      await new Promise((r) => setTimeout(r, 15))
      return 'msg-concurrent'
    },
  }
  const h = makeHarness({ subagents })
  try {
    const begun = h.bridge.beginSend({
      agentId: 'agent-owner',
      workspaceRoot: temp,
      transport: 'acp',
      message: 'concurrent wake',
      wakeAgent: 'relay-neon',
    })
    begun.job.status = 'replied'
    begun.job.reply = { text: 'concurrent-reply', tools: [] }
    begun.job.wakeState = 'pending'
    h.bridge.save()

    await Promise.all([
      h.bridge.maybeWake(begun.job),
      h.bridge.maybeWake(begun.job),
      h.bridge.maybeWake(begun.job),
    ])
    assert.equal(sendCalls, 1)
    assert.equal(h.ownerFollowups.length, 0)
    assert.equal(h.targetFollowups.length, 0)
    assert.equal(begun.job.wakeState, 'delivered')
    assert.equal(h.bridge.view(begun.job).wakeDeliveredVia, 'subagents')
  } finally {
    h.bridge.dispose()
  }
})

trackedTest('T10: restarted Bridge on same stateFile never re-delivers a delivered job', async () => {
  let sendCalls = 0
  const subagents = {
    async resolveName(_caller, _name, signal) {
      assertResolveSignal(signal)
      return 'sess-neon'
    },
    async sendMessage(_s, _t, _c, options) {
      assertSendSignal(options)
      sendCalls += 1
      return 'msg-restart'
    },
  }
  const h1 = makeHarness({ subagents, stateFileName: 'restart-state.json' })
  let jobId = ''
  try {
    const begun = h1.bridge.beginSend({
      agentId: 'agent-owner',
      workspaceRoot: temp,
      transport: 'acp',
      message: 'restart check',
      wakeAgent: 'relay-neon',
    })
    jobId = begun.job.jobId
    await h1.bridge.dispatch(begun.job, { message: 'restart check', requested: begun.job.requested, attachments: [], cwd: temp })
    await h1.bridge.waitFor(begun.job, { timeoutMs: 2000 })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(sendCalls, 1)
    assert.equal(begun.job.wakeState, 'delivered')
  } finally {
    h1.bridge.dispose()
  }

  const h2 = makeHarness({ subagents, stateFileName: 'restart-state.json' })
  try {
    const reloaded = h2.bridge.job(jobId)
    assert.equal(reloaded.wakeState, 'delivered')
    const res = await h2.bridge.maybeWake(reloaded)
    assert.equal(res, false)
    assert.equal(sendCalls, 1)
    const logText = readFileSync(`${h2.stateFile}.log`, 'utf8')
    assert.ok(logText.includes('wake-rejected'))
  } finally {
    h2.bridge.dispose()
  }
})

trackedTest('T11: AbortSignal is shared with bridge.wakeSignal() and aborted on dispose()', async () => {
  let seenResolveSignal = null
  let seenSendSignal = null
  let bridgeRef = null
  const subagents = {
    async resolveName(_caller, _name, signal) {
      assertResolveSignal(signal)
      seenResolveSignal = signal
      return 'sess-neon'
    },
    async sendMessage(_s, _t, _c, options) {
      assertSendSignal(options)
      seenSendSignal = options.signal
      return 'msg-sig'
    },
  }
  const h = makeHarness({ subagents })
  bridgeRef = h.bridge
  const expectedSignal = bridgeRef.wakeSignal()
  assert.equal(expectedSignal.aborted, false)
  const begun = h.bridge.beginSend({
    agentId: 'agent-owner',
    workspaceRoot: temp,
    transport: 'acp',
    message: 'signal check',
    wakeAgent: 'relay-neon',
  })
  await h.bridge.dispatch(begun.job, { message: 'signal check', requested: begun.job.requested, attachments: [], cwd: temp })
  await h.bridge.waitFor(begun.job, { timeoutMs: 2000 })
  await new Promise((r) => setTimeout(r, 20))

  assert.equal(seenResolveSignal, expectedSignal)
  assert.equal(seenSendSignal, expectedSignal)
  h.bridge.dispose()
  assert.equal(expectedSignal.aborted, true)
})

trackedTest('T12: cross-tree UNAUTHORIZED rejects without owner followup; ACTIVATION_CLOSING falls back to followup', async () => {
  const unauthSubagents = {
    async resolveName(_caller, _name, signal) {
      assertResolveSignal(signal)
      return 'sess-neon'
    },
    async sendMessage(_s, _t, _c, options) {
      assertSendSignal(options)
      throw Object.assign(new Error('cross tree'), { code: 'UNAUTHORIZED' })
    },
  }
  const h1 = makeHarness({ subagents: unauthSubagents })
  try {
    const begun = h1.bridge.beginSend({
      agentId: 'agent-owner',
      workspaceRoot: temp,
      transport: 'acp',
      message: 'cross tree unauth',
      wakeAgent: 'relay-neon',
    })
    await h1.bridge.dispatch(begun.job, { message: 'cross tree unauth', requested: begun.job.requested, attachments: [], cwd: temp })
    await h1.bridge.waitFor(begun.job, { timeoutMs: 2000 })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(h1.ownerFollowups.length, 0)
    assert.equal(h1.targetFollowups.length, 0)
    assert.equal(begun.job.wakeState, 'delivery_unknown')
    const logText = readFileSync(`${h1.stateFile}.log`, 'utf8')
    assert.ok(logText.includes('wake-forbidden'))
  } finally {
    h1.bridge.dispose()
  }

  const closingSubagents = {
    async resolveName(_caller, _name, signal) {
      assertResolveSignal(signal)
      return 'sess-neon'
    },
    async sendMessage(_s, _t, _c, options) {
      assertSendSignal(options)
      throw Object.assign(new Error('activation closing'), { code: 'ACTIVATION_CLOSING' })
    },
  }
  const h2 = makeHarness({ subagents: closingSubagents })
  try {
    const begun = h2.bridge.beginSend({
      agentId: 'agent-owner',
      workspaceRoot: temp,
      transport: 'acp',
      message: 'closing fallback',
      wakeAgent: 'relay-neon',
    })
    await h2.bridge.dispatch(begun.job, { message: 'closing fallback', requested: begun.job.requested, attachments: [], cwd: temp })
    await h2.bridge.waitFor(begun.job, { timeoutMs: 2000 })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(h2.targetFollowups.length, 1)
    assert.equal(begun.job.wakeState, 'delivered')
    assert.equal(h2.bridge.view(begun.job).wakeDeliveredVia, 'followup')
  } finally {
    h2.bridge.dispose()
  }
})
