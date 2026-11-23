/**
 * Offline tests for the explicit desktop fallback.
 *
 * Everything here runs against a scripted driver runner: no PowerShell, no UIA,
 * no Antigravity window, no ACP child process. The assertions cover exactly the
 * properties the shipped code must keep: ACP stays the default, desktop is
 * opt-in and pinned, one UIA Send at most, and a reply is delivered only after
 * the round was observed running and two complete idle snapshots agree.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

import { Bridge, defaultConfig } from '../lib/bridge.js'
import { AntigravityBridgeService } from '../lib/web-remote.js'

// The bridge deliberately unrefs its internal sleeps so a plugin never holds the
// host process open. Under `node --test` that also means a test can be reported
// as "event loop has already resolved" while a timer is still pending. One
// referenced timer keeps the loop alive for the lifetime of this suite.
const keepAlive = setInterval(() => {}, 250)
after(() => clearInterval(keepAlive))

const TARGET = {
  pid: 27168,
  startedAt: '2026-11-21T14:39:31.0444144Z',
  hwnd: '0x90A54',
  uri: 'https://127.0.0.1:48107/c/3252a463-a106-4805-8356-d23f8cbbe958',
}
const TARGET_KEY = 'aguia1:0123456789abcdef'

let tick = 0
function nextObservedAt() {
  tick += 1
  return new Date(1_790_000_000_000 + tick * 1000).toISOString()
}

function fakeScenario() {
  const node = (type, name, extra = {}) => ({ type, name, ...extra })
  return {
    process: {
      pid: TARGET.pid,
      exePath: 'C:\\Users\\pordl\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe',
      startedAtUs: TARGET.startedAt,
      productName: 'Antigravity',
      fileVersion: '2.34.0',
      companyName: 'Google',
    },
    window: { class: 'Chrome_WidgetWin_1', visible: true, minimized: false, cloaked: 0, isTopLevel: true, foreground: false },
    tree: node('Window', 'DSH model probe xhigh', {
      children: [
        node('Group', 'Sidebar', {
          children: [node('Hyperlink', 'DSH model probe xhigh', { value: TARGET.uri, patterns: ['Value', 'Invoke'] })],
        }),
        node('Document', 'DSH model probe xhigh', { value: TARGET.uri, patterns: ['Value', 'Text'] }),
        node('Group', 'Composer', {
          automationId: 'antigravity.agentSidePanelInputBox',
          children: [
            node('ComboBox', 'Message input', { patterns: ['Value', 'Text', 'ExpandCollapse'] }),
            node('Button', 'Send', { patterns: ['Invoke'] }),
          ],
        }),
        node('Text', 'Conversation Log', {
          patterns: ['Text', 'Scroll'],
          children: [
            node('Text', 'You said', { patterns: ['Text', 'Scroll'] }),
            node('Text', 'earlier question', { patterns: ['Text'] }),
            node('Text', 'Agent said', { patterns: ['Text', 'Scroll'] }),
            node('Text', 'earlier answer', { patterns: ['Text'] }),
            node('Group', 'Response actions', { children: [node('Button', 'Copy', { patterns: ['Invoke'] })] }),
          ],
        }),
        node('Text', 'No more older messages, showing 4 of 4', { patterns: ['Text'] }),
      ],
    }),
    readback: 'exact',
    invokeBehavior: 'normal',
    appendTurnOnInvoke: false,
  }
}

async function dispatchAndSettle(bridge, job, payload) {
  await bridge.dispatch(job, payload)
  const active = bridge.activePrompts.get(job.jobId)
  if (active) {
    try {
      await active.promise
    } catch {
      // The observation records its own failure; the test asserts the view.
    }
  }
  return job
}

function snapshot({ turns = [], phase = 'idle', complete = true, targetKey = TARGET_KEY } = {}) {
  return {
    ok: true,
    targetKey,
    verified: {
      process: true,
      startTime: true,
      executable: true,
      window: true,
      documentUri: true,
      sessionLink: 'unique',
    },
    snapshot: {
      targetKey,
      observedAt: nextObservedAt(),
      turns,
      phase,
      history: { complete, loaded: turns.length, total: turns.length, text: '' },
      composer: { present: true, unique: true, empty: true, editable: true, valueLength: 0 },
      evidence: {
        roleSource: 'explicit_labels',
        roleLabels: turns.length,
        endActions: true,
        endActionButtons: ['Copy'],
        stopControl: phase === 'busy',
        stopControlName: phase === 'busy' ? 'Stop' : null,
        permissionCard: phase === 'permission',
        permissionKeyword: phase === 'permission' ? 'Allow' : null,
        baselineAgeMs: null,
        baselineTextStable: false,
        completionRule: 'stable_baseline+assistant_text+end_actions+no_stop+no_permission',
      },
    },
    unreadable: [],
  }
}

function scriptedDriver({ inspects = [], dispatchResult = { status: 'invoked' } } = {}) {
  const calls = []
  let inspectIndex = 0
  return {
    calls,
    async run(request) {
      calls.push({
        action: request.action,
        message: typeof request.message === 'string' ? request.message : '',
        baseline: request.baseline ?? null,
      })
      if (request.action === 'dispatch') return dispatchResult
      const step = inspects[Math.min(inspectIndex, inspects.length - 1)]
      inspectIndex += 1
      if (typeof step === 'function') return step(inspectIndex)
      return step
    },
  }
}

function fakeAcpBackend({ reply = 'ACP-OK' } = {}) {
  const calls = { createSession: 0, promptSession: 0 }
  return {
    calls,
    async ready() {
      return {
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
        loadSession: false,
      }
    },
    async capabilities() {
      return { promptCapabilities: { image: false, audio: false, embeddedContext: true } }
    },
    async createSession() {
      calls.createSession += 1
      return { sessionId: 'acp-session-1', configOptions: [] }
    },
    async resumeSession({ sessionId }) {
      return { sessionId, configOptions: [] }
    },
    async setConfigOption() {
      return { configOptions: [] }
    },
    promptSession() {
      calls.promptSession += 1
      return Promise.resolve({ stopReason: 'end_turn', text: reply })
    },
    cancelSession() {},
    close() {},
  }
}

function makeAgent(id = 'agent-a') {
  const delivered = []
  const agent = {
    id,
    session: { id },
    delivered,
    async followup(message) {
      delivered.push(message)
    },
  }
  return agent
}

function makeBridge({ desktop, agent = makeAgent(), backend = fakeAcpBackend() } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'antigravity-desktop-'))
  const config = defaultConfig({
    backend,
    stateFile: join(dir, 'state.json'),
    pollMs: 60_000,
    desktop: {
      enabled: true,
      pollMs: 100,
      replyTimeoutMs: 1200,
      timeoutMs: 5000,
      ...desktop,
    },
  })
  const bridge = new Bridge({}, config, { warn() {}, info() {} })
  bridge.remember(agent)
  const send = (overrides = {}) => {
    const begun = bridge.beginSend({
      agentId: agent.id,
      transport: 'desktop',
      message: 'ship it',
      requested: { pathRefs: [] },
      ...overrides,
    })
    assert.equal(begun.error, undefined, begun.error?.message)
    return begun.job
  }
  return { bridge, agent, backend, dir, send }
}

const BASE_TURNS = [
  { role: 'user', text: 'earlier question' },
  { role: 'assistant', text: 'earlier answer' },
]

test('ACP remains the default and never touches the desktop driver', async () => {
  const driver = scriptedDriver({ inspects: [snapshot()] })
  const { bridge, backend } = makeBridge({ desktop: { enabled: false, target: TARGET, driver } })
  assert.deepEqual(bridge.desktop.capabilities().transports, ['acp'])
  const begun = bridge.beginSend({
    agentId: 'agent-a',
    transport: 'acp',
    message: 'hello',
    requested: { pathRefs: [] },
  })
  assert.equal(begun.error, undefined)
  await dispatchAndSettle(bridge, begun.job, { message: 'hello', requested: begun.job.requested })
  assert.equal(begun.job.transport, 'acp')
  assert.equal(backend.calls.promptSession, 1)
  assert.equal(driver.calls.length, 0)
})

test('desktop stays opt-in: without enabled=true a desktop send is refused before any write', () => {
  const driver = scriptedDriver({ inspects: [snapshot()] })
  const { bridge } = makeBridge({ desktop: { enabled: false, target: TARGET, driver } })
  const begun = bridge.beginSend({
    agentId: 'agent-a',
    transport: 'desktop',
    message: 'ship it',
    requested: { pathRefs: [] },
  })
  assert.equal(begun.error?.code, 'desktop_disabled')
  assert.equal(begun.job, undefined)
  assert.equal(driver.calls.length, 0)
  assert.equal(bridge.listJobs('agent-a').length, 0)
})

test('a desktop target must be pinned; an unconfigured target sends nothing', () => {
  const driver = scriptedDriver({ inspects: [snapshot()] })
  const { bridge } = makeBridge({ desktop: { enabled: true, target: null, driver } })
  const begun = bridge.beginSend({
    agentId: 'agent-a',
    transport: 'desktop',
    message: 'x',
    requested: { pathRefs: [] },
  })
  assert.equal(begun.error?.code, 'desktop_target_not_configured')
  assert.equal(driver.calls.length, 0)
  assert.equal(bridge.listJobs('agent-a').length, 0)
})

test('desktop refuses conversationId, model, effort and native attachments before inspecting', () => {
  const driver = scriptedDriver({ inspects: [snapshot()] })
  const { bridge } = makeBridge({ desktop: { target: TARGET, driver } })
  const withConversation = bridge.beginSend({
    agentId: 'agent-a',
    transport: 'desktop',
    conversationId: 'acp-1',
    message: 'x',
    requested: { pathRefs: [] },
  })
  assert.equal(withConversation.error?.code, 'invalid_request')

  const job = bridge.beginSend({
    agentId: 'agent-a',
    transport: 'desktop',
    message: 'x',
    requested: { pathRefs: [], attachments: ['C:\\tmp\\a.png'] },
  }).job
  return bridge
    .dispatch(job, { message: 'x', requested: job.requested })
    .then(() => {
      assert.fail('dispatch should have been refused')
    })
    .catch((error) => {
      assert.equal(error.code, 'unsupported_capability')
      assert.equal(driver.calls.length, 0)
      assert.equal(bridge.job(job.jobId).status, 'not_sent')
    })
})

test('a busy or incompletely harvested desktop history is never written to', async () => {
  const busyDriver = scriptedDriver({ inspects: [snapshot({ turns: BASE_TURNS, phase: 'busy' })] })
  const busy = makeBridge({ desktop: { target: TARGET, driver: busyDriver } })
  const busyJob = busy.send()
  await assert.rejects(
    () => busy.bridge.dispatch(busyJob, { message: 'ship it', requested: busyJob.requested }),
    (error) => error.code === 'desktop_not_idle',
  )
  assert.equal(busyJob.status, 'not_sent')
  assert.equal(busyDriver.calls.filter((call) => call.action === 'dispatch').length, 0)

  const partialDriver = scriptedDriver({
    inspects: [snapshot({ turns: BASE_TURNS, complete: false })],
  })
  const partial = makeBridge({ desktop: { target: TARGET, driver: partialDriver } })
  const partialJob = partial.send()
  await assert.rejects(
    () => partial.bridge.dispatch(partialJob, { message: 'ship it', requested: partialJob.requested }),
    (error) => error.code === 'desktop_history_incomplete',
  )
  assert.equal(partialJob.status, 'not_sent')
  assert.equal(partialDriver.calls.filter((call) => call.action === 'dispatch').length, 0)
})

test('a completed desktop round is delivered once with the app text and woken once', async () => {
  const userTurn = { role: 'user', text: 'ship it' }
  const running = [...BASE_TURNS, userTurn]
  const settled = [...running, { role: 'assistant', text: 'DESKTOP-FINAL' }]
  const driver = scriptedDriver({
    inspects: [
      snapshot({ turns: BASE_TURNS }),
      snapshot({ turns: BASE_TURNS }),
      snapshot({ turns: running, phase: 'busy' }),
      snapshot({ turns: settled }),
      snapshot({ turns: settled }),
    ],
  })
  const { bridge, agent, send } = makeBridge({ desktop: { target: TARGET, driver } })
  const job = send()
  await dispatchAndSettle(bridge, job, { message: 'ship it', requested: job.requested })
  // maybeWake runs after the reply is recorded; give the followup a turn to land.
  await new Promise((resolve) => setTimeout(resolve, 100))

  const view = bridge.view(bridge.job(job.jobId))
  assert.equal(view.status, 'replied')
  assert.equal(view.reply, 'DESKTOP-FINAL')
  assert.equal(view.wakeState, 'delivered')
  assert.equal(view.transport, 'desktop')
  assert.equal(view.desktopConversationId, TARGET_KEY)
  assert.equal(driver.calls.filter((call) => call.action === 'dispatch').length, 1)
  assert.equal(agent.delivered.length, 1)
  assert.match(agent.delivered[0].content[0].text, /DESKTOP-FINAL/)
  assert.match(agent.delivered[0].content[0].text, /桌面会话/)
})

test('a stale assistant text from the previous round is never delivered', async () => {
  const driver = scriptedDriver({
    inspects: [
      snapshot({ turns: BASE_TURNS }),
      // Dispatch was invoked, yet no new user turn ever appears: the old answer
      // must not be attributed to this job.
      snapshot({ turns: BASE_TURNS }),
      snapshot({ turns: BASE_TURNS }),
    ],
  })
  const { bridge, agent, send } = makeBridge({
    desktop: { target: TARGET, driver, replyTimeoutMs: 1000 },
  })
  const job = send()
  await dispatchAndSettle(bridge, job, { message: 'ship it', requested: job.requested })

  const view = bridge.view(bridge.job(job.jobId))
  assert.equal(view.status, 'acceptance_unknown')
  assert.equal(view.code, 'desktop_reply_timeout')
  assert.ok(!view.reply, 'no reply text may be attributed to a round that never started')
  assert.equal(agent.delivered.length, 0)
  assert.equal(driver.calls.filter((call) => call.action === 'dispatch').length, 1)
})

test('a permission prompt is reported as pending and never auto-approved or woken', async () => {
  const running = [...BASE_TURNS, { role: 'user', text: 'ship it' }]
  const driver = scriptedDriver({
    inspects: [
      snapshot({ turns: BASE_TURNS }),
      snapshot({ turns: BASE_TURNS }),
      snapshot({ turns: running, phase: 'busy' }),
      snapshot({ turns: running, phase: 'permission' }),
      snapshot({ turns: running, phase: 'permission' }),
    ],
  })
  const { bridge, agent, send } = makeBridge({
    desktop: { target: TARGET, driver, replyTimeoutMs: 1000 },
  })
  const job = send()
  await dispatchAndSettle(bridge, job, { message: 'ship it', requested: job.requested })

  const view = bridge.view(bridge.job(job.jobId))
  assert.equal(view.permissionPending, true)
  assert.equal(view.status, 'accepted')
  assert.equal(view.detail ?? '', '')
  assert.equal(agent.delivered.length, 0)
  assert.equal(driver.calls.filter((call) => call.action === 'dispatch').length, 1)
})

test('a driver refusal before Send is not_sent and never observed or retried', async () => {
  const driver = scriptedDriver({
    inspects: [snapshot({ turns: BASE_TURNS }), snapshot({ turns: BASE_TURNS })],
    dispatchResult: { status: 'not_sent', reason: 'composer_not_empty' },
  })
  const { bridge, agent, send } = makeBridge({ desktop: { target: TARGET, driver } })
  const job = send()
  await dispatchAndSettle(bridge, job, { message: 'ship it', requested: job.requested })

  const view = bridge.view(bridge.job(job.jobId))
  assert.equal(view.status, 'not_sent')
  assert.equal(view.code, 'composer_not_empty')
  assert.equal(agent.delivered.length, 0)
  assert.equal(driver.calls.filter((call) => call.action === 'inspect').length, 2)
  assert.equal(driver.calls.filter((call) => call.action === 'dispatch').length, 1)
})

test('an ambiguous invoke outcome stays acceptance_unknown and is not resent', async () => {
  const driver = scriptedDriver({
    inspects: [snapshot({ turns: BASE_TURNS }), snapshot({ turns: BASE_TURNS })],
    dispatchResult: { status: 'acceptance_unknown', code: 'invoke_exception' },
  })
  const { bridge, agent, send } = makeBridge({ desktop: { target: TARGET, driver } })
  const job = send()
  await dispatchAndSettle(bridge, job, { message: 'ship it', requested: job.requested })

  const view = bridge.view(bridge.job(job.jobId))
  assert.equal(view.status, 'acceptance_unknown')
  assert.equal(view.code, 'desktop_acceptance_unknown')
  assert.equal(agent.delivered.length, 0)
  assert.equal(driver.calls.filter((call) => call.action === 'dispatch').length, 1)
})

test('a target change during observation stops attribution without waking', async () => {
  const running = [...BASE_TURNS, { role: 'user', text: 'ship it' }]
  const driver = scriptedDriver({
    inspects: [
      snapshot({ turns: BASE_TURNS }),
      snapshot({ turns: BASE_TURNS }),
      snapshot({ turns: running, phase: 'busy' }),
      snapshot({ turns: running, phase: 'busy', targetKey: 'aguia1:ffffffffffffffff' }),
    ],
  })
  const { bridge, agent, send } = makeBridge({
    desktop: { target: TARGET, driver, replyTimeoutMs: 4000 },
  })
  const job = send()
  await dispatchAndSettle(bridge, job, { message: 'ship it', requested: job.requested })

  const view = bridge.view(bridge.job(job.jobId))
  assert.equal(view.status, 'acceptance_unknown')
  assert.equal(view.code, 'desktop_target_changed')
  assert.equal(agent.delivered.length, 0)
})

test('cancel stops local observation and reports that no Stop control exists', async () => {
  const running = [...BASE_TURNS, { role: 'user', text: 'ship it' }]
  const driver = scriptedDriver({
    inspects: [
      snapshot({ turns: BASE_TURNS }),
      snapshot({ turns: BASE_TURNS }),
      snapshot({ turns: running, phase: 'busy' }),
      snapshot({ turns: running, phase: 'busy' }),
      snapshot({ turns: running, phase: 'busy' }),
      snapshot({ turns: running, phase: 'busy' }),
    ],
  })
  const { bridge, agent, send } = makeBridge({
    desktop: { target: TARGET, driver, replyTimeoutMs: 3000 },
  })
  const job = send()
  const dispatched = bridge.dispatch(job, { message: 'ship it', requested: job.requested })
  // Wait past the two preflight reads so cancel hits the live observation loop.
  await new Promise((resolve) => setTimeout(resolve, 900))
  const outcome = await bridge.cancelJob(job, { timeoutMs: 2000 })
  await dispatched

  assert.equal(outcome.cancelSent, false)
  assert.equal(outcome.stopControl, 'unavailable')
  const view = bridge.view(bridge.job(job.jobId))
  assert.equal(view.status, 'failed')
  assert.equal(view.code, 'cancelled')
  assert.equal(agent.delivered.length, 0)
})

test('one pinned window accepts one unfinished desktop job at a time', async () => {
  const driver = scriptedDriver({
    inspects: [
      snapshot({ turns: BASE_TURNS }),
      snapshot({ turns: BASE_TURNS }),
      snapshot({ turns: BASE_TURNS, phase: 'busy' }),
    ],
  })
  const { bridge, send } = makeBridge({
    desktop: { target: TARGET, driver, replyTimeoutMs: 1000 },
  })
  const first = send()
  const second = bridge.beginSend({
    agentId: 'agent-a',
    transport: 'desktop',
    message: 'second',
    requested: { pathRefs: [] },
  })
  assert.equal(second.error?.code, 'busy')
  await dispatchAndSettle(bridge, first, { message: 'ship it', requested: first.requested })
  assert.equal(bridge.job(first.jobId).status, 'acceptance_unknown')
  assert.equal(driver.calls.filter((call) => call.action === 'dispatch').length, 1)
})

test('a desktop job is only readable by its owner', async () => {
  const driver = scriptedDriver({
    inspects: [snapshot({ turns: BASE_TURNS }), snapshot({ turns: BASE_TURNS })],
    dispatchResult: { status: 'not_sent', reason: 'window_minimized' },
  })
  const { bridge, send } = makeBridge({ desktop: { target: TARGET, driver } })
  const job = send()
  await dispatchAndSettle(bridge, job, { message: 'ship it', requested: job.requested })
  const foreign = bridge.resolveJob({ jobId: job.jobId, agentId: 'agent-b' })
  assert.equal(foreign.error?.code, 'forbidden')
  assert.equal(bridge.listJobs('agent-b').length, 0)
})

test('the desktop driver is invoked with the request body on stdin, never a shell string', async () => {
  const driver = scriptedDriver({
    inspects: [
      snapshot({ turns: BASE_TURNS }),
      snapshot({ turns: BASE_TURNS }),
      snapshot({ turns: BASE_TURNS, phase: 'busy' }),
    ],
  })
  const { bridge, send } = makeBridge({
    desktop: { target: TARGET, driver, replyTimeoutMs: 1000 },
  })
  const message = 'say "hi" & $(Get-Process); `id`'
  const job = send({ message })
  await dispatchAndSettle(bridge, job, { message, requested: job.requested })
  assert.equal(driver.calls[0].action, 'inspect')
  assert.equal(driver.calls[0].message, '')
  const dispatched = driver.calls.filter((call) => call.action === 'dispatch')
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0].message, message)
})

test('a baseline-less idle window is provable from evidence, not from the idle label', async () => {
  const userTurn = { role: 'user', text: 'ship it' }
  const running = [...BASE_TURNS, userTurn]
  const settled = [...running, { role: 'assistant', text: 'EVIDENCE-FINAL' }]
  const driver = scriptedDriver({
    inspects: [
      // First read has no baseline, so the driver can only report `unknown`;
      // the bridge must still be able to dispatch using the evidence fields.
      snapshot({ turns: BASE_TURNS, phase: 'unknown' }),
      snapshot({ turns: BASE_TURNS, phase: 'unknown' }),
      snapshot({ turns: running, phase: 'busy' }),
      snapshot({ turns: settled, phase: 'idle' }),
      snapshot({ turns: settled, phase: 'idle' }),
    ],
  })
  const { bridge, agent, send } = makeBridge({ desktop: { target: TARGET, driver } })
  const job = send()
  await dispatchAndSettle(bridge, job, { message: 'ship it', requested: job.requested })
  await new Promise((resolve) => setTimeout(resolve, 100))

  const view = bridge.view(bridge.job(job.jobId))
  assert.equal(view.status, 'replied')
  assert.equal(view.reply, 'EVIDENCE-FINAL')
  assert.equal(agent.delivered.length, 1)
  assert.equal(driver.calls.filter((call) => call.action === 'dispatch').length, 1)
})

test('the two pre-dispatch reads must agree before anything is written', async () => {
  const changed = [...BASE_TURNS, { role: 'user', text: 'someone else' }]
  const driver = scriptedDriver({
    inspects: [snapshot({ turns: BASE_TURNS }), snapshot({ turns: changed })],
  })
  const { bridge, send } = makeBridge({ desktop: { target: TARGET, driver } })
  const job = send()
  await assert.rejects(
    () => bridge.dispatch(job, { message: 'ship it', requested: job.requested }),
    (error) => error.code === 'desktop_not_idle',
  )
  assert.equal(bridge.job(job.jobId).status, 'not_sent')
  assert.equal(driver.calls.filter((call) => call.action === 'dispatch').length, 0)
})

test('a first user bubble that does not match the dispatch is never searched past', async () => {
  const foreign = [...BASE_TURNS, { role: 'user', text: 'another question' }, { role: 'assistant', text: 'OTHER' }]
  const driver = scriptedDriver({
    inspects: [
      snapshot({ turns: BASE_TURNS }),
      snapshot({ turns: BASE_TURNS }),
      snapshot({ turns: foreign, phase: 'busy' }),
      snapshot({ turns: foreign }),
    ],
  })
  const { bridge, agent, send } = makeBridge({
    desktop: { target: TARGET, driver, replyTimeoutMs: 1000 },
  })
  const job = send()
  await dispatchAndSettle(bridge, job, { message: 'ship it', requested: job.requested })

  const view = bridge.view(bridge.job(job.jobId))
  assert.equal(view.status, 'acceptance_unknown')
  assert.equal(view.code, 'desktop_dispatch_not_observed')
  assert.ok(!view.reply)
  assert.equal(agent.delivered.length, 0)
})

test('a replaced user anchor stops attribution instead of borrowing another round', async () => {
  const anchor = { role: 'user', text: 'ship it' }
  const edited = { role: 'user', text: 'ship it (rewritten)' }
  const driver = scriptedDriver({
    inspects: [
      snapshot({ turns: BASE_TURNS }),
      snapshot({ turns: BASE_TURNS }),
      snapshot({ turns: [...BASE_TURNS, anchor], phase: 'busy' }),
      snapshot({ turns: [...BASE_TURNS, edited, { role: 'assistant', text: 'NOT-OURS' }] }),
    ],
  })
  const { bridge, agent, send } = makeBridge({
    desktop: { target: TARGET, driver, replyTimeoutMs: 2000 },
  })
  const job = send()
  await dispatchAndSettle(bridge, job, { message: 'ship it', requested: job.requested })

  const view = bridge.view(bridge.job(job.jobId))
  assert.equal(view.status, 'acceptance_unknown')
  assert.equal(view.code, 'desktop_baseline_diverged')
  assert.ok(!view.reply)
  assert.equal(agent.delivered.length, 0)
})

test('a state write failure before the desktop write aborts without Send', async () => {
  const driver = scriptedDriver({
    inspects: [snapshot({ turns: BASE_TURNS }), snapshot({ turns: BASE_TURNS })],
  })
  const { bridge, send } = makeBridge({ desktop: { target: TARGET, driver } })
  const job = send()
  const original = bridge.save.bind(bridge)
  bridge.save = () => false
  await assert.rejects(
    () => bridge.dispatch(job, { message: 'ship it', requested: job.requested }),
    (error) => error.code === 'state_write_failed',
  )
  bridge.save = original
  assert.equal(bridge.job(job.jobId).status, 'not_sent')
  assert.equal(driver.calls.filter((call) => call.action === 'dispatch').length, 0)
})

test('the bundled PowerShell driver answers over the JSON stdin/stdout protocol', (t) => {
  const pwsh = process.env.AGUIATEST_PWSH || 'pwsh'
  const driver = fileURLToPath(new URL('../lib/uia-driver.ps1', import.meta.url))
  const probe = spawnSync(
    pwsh,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver],
    { input: JSON.stringify({ action: 'dispatch', message: 'x' }), encoding: 'utf8', timeout: 30000 },
  )
  if (probe.error) {
    t.skip(`pwsh is not available here: ${probe.error.message}`)
    return
  }
  assert.equal(probe.status, 0, probe.stderr)
  const lines = String(probe.stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  assert.equal(lines.length, 1, 'the driver must print exactly one JSON line')
  const out = JSON.parse(lines[0])
  assert.equal(out.ok, false)
  assert.equal(out.action, 'dispatch')
  assert.equal(out.status, 'not_sent')
  assert.equal(out.code, 'bad_request')
})

test('Bridge -> real pwsh -> synthetic UIA tree: one Send, then a safe timeout', { timeout: 180_000 }, async (t) => {
  const pwsh = process.env.AGUIATEST_PWSH || 'pwsh'
  const probe = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {
    encoding: 'utf8',
    timeout: 30000,
  })
  if (probe.error || probe.status !== 0) {
    t.skip(`pwsh is not available here: ${probe.error?.message ?? probe.stderr}`)
    return
  }
  const driverPath = fileURLToPath(new URL('../lib/uia-driver.ps1', import.meta.url))
  assert.ok(existsSync(driverPath), 'the bundled driver must ship next to the bridge')

  const dir = mkdtempSync(join(tmpdir(), 'antigravity-desktop-driver-'))
  const scenarioPath = join(dir, 'scenario.json')
  writeFileSync(scenarioPath, JSON.stringify(fakeScenario()), 'utf8')

  const { bridge, send, agent, dir: bridgeDir } = makeBridge({
    desktop: {
      target: TARGET,
      driverPath,
      powershell: pwsh,
      pollMs: 250,
      replyTimeoutMs: 1500,
      timeoutMs: 20000,
      env: { AGUIA_FAKE_SCENARIO: scenarioPath },
    },
  })
  const job = send({ message: 'cross process check' })
  await dispatchAndSettle(bridge, job, { message: 'cross process check', requested: job.requested })

  const view = bridge.view(job)
  // The window is healthy and was written once, but the static synthetic tree never
  // gains a reply turn, so the round must end as a queryable, non-delivered result.
  assert.equal(view.status, 'acceptance_unknown')
  assert.equal(view.code, 'desktop_reply_timeout')
  assert.match(view.desktopConversationId, /^aguia1:[0-9a-f]{16}$/)
  assert.ok(!view.reply, 'nothing may be delivered from a round that never completed')
  assert.notEqual(view.wakeState, 'delivered')
  assert.equal(agent.delivered.length, 0, 'an unproven round must not wake the agent')

  const persisted = JSON.parse(readFileSync(join(bridgeDir, 'state.json'), 'utf8'))
  const record = persisted.jobs[job.jobId]
  assert.ok(record, 'the job must be persisted before the write')
  assert.equal(record.transport, 'desktop')
  assert.equal(record.targetKey, view.desktopConversationId)

  // The pinned window stays locked while the result is ambiguous: no second write.
  const again = bridge.beginSend({
    agentId: agent.id,
    transport: 'desktop',
    message: 'second attempt',
    requested: { pathRefs: [] },
  })
  assert.equal(again.error?.code, 'busy', 'an unfinished desktop job must hold the window lock')
})

test('state files stay inside the temporary bridge directory', () => {
  const { dir, send } = makeBridge({ desktop: { target: TARGET } })
  send()
  const names = readdirSync(dir)
  assert.ok(names.includes('state.json'))
})

// ---------------------------------------------------------------------------
// t52: submission boundary, lifecycle, cancel and capability mapping
// ---------------------------------------------------------------------------

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function waitFor(predicate, { timeoutMs = 8000, stepMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

function lastJsonLine(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i])
    } catch {
      // keep looking
    }
  }
  return null
}

function hasPwsh() {
  const probe = spawnSync(process.env.AGUIATEST_PWSH || 'pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {
    encoding: 'utf8',
    timeout: 30000,
  })
  return !probe.error && probe.status === 0
}

test('a disposed bridge cannot commit, release or wake from a late inspect', { timeout: 60_000 }, async () => {
  const gate = deferred()
  const latePage = snapshot({
    turns: [...BASE_TURNS, { role: 'user', text: 'ship it' }, { role: 'assistant', text: 'LATE-REPLY' }],
  })
  const driver = scriptedDriver({
    inspects: [snapshot({ turns: BASE_TURNS }), snapshot({ turns: BASE_TURNS }), () => gate.promise],
  })
  const { bridge, agent, dir, send } = makeBridge({ desktop: { target: TARGET, driver, replyTimeoutMs: 5000 } })
  const job = send()
  await bridge.dispatch(job, { message: job.message, requested: job.requested })
  const active = bridge.activePrompts.get(job.jobId)
  assert.ok(active, 'the observation must be registered as an active promise')
  assert.ok(await waitFor(() => driver.calls.filter((call) => call.action === 'inspect').length >= 3), 'observation must reach its third read')

  bridge.dispose()

  // A new instance takes over the same state file while the old inspect is stuck.
  const agentB = makeAgent('agent-b')
  const bridge2 = new Bridge(
    {},
    defaultConfig({
      backend: fakeAcpBackend({ reply: 'SECOND-OK' }),
      stateFile: join(dir, 'state.json'),
      pollMs: 60_000,
      desktop: { enabled: true, target: TARGET, driver: scriptedDriver({ inspects: [snapshot()] }) },
    }),
    { warn() {}, info() {} },
  )
  bridge2.remember(agentB)
  const begun2 = bridge2.beginSend({ agentId: 'agent-b', transport: 'acp', message: 'second', requested: {} })
  assert.equal(begun2.error, undefined)
  await bridge2.dispatch(begun2.job, { message: 'second', requested: begun2.job.requested })
  assert.equal(begun2.job.status, 'replied')
  bridge2.dispose()

  gate.resolve(latePage)
  await active.promise.catch(() => {})

  assert.notEqual(job.status, 'replied', 'a disposed instance must not adopt a late page')
  assert.equal(job.reply, null)
  assert.notEqual(job.wakeState, 'delivered')
  assert.equal(agent.delivered.length, 0, 'a disposed instance must not wake anyone')

  const persisted = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  assert.ok(persisted.jobs[begun2.job.jobId], 'the new job must survive the disposed instance')
  assert.equal(persisted.jobs[begun2.job.jobId].status, 'replied')
  assert.notEqual(persisted.jobs[job.jobId]?.status, 'replied')
})

test('a cancel that lands before the last inspect is never overridden by the late page', { timeout: 60_000 }, async () => {
  const gate = deferred()
  const latePage = snapshot({
    turns: [...BASE_TURNS, { role: 'user', text: 'ship it' }, { role: 'assistant', text: 'LATE-REPLY' }],
  })
  const driver = scriptedDriver({
    inspects: [snapshot({ turns: BASE_TURNS }), snapshot({ turns: BASE_TURNS }), () => gate.promise],
  })
  const { bridge, agent, send } = makeBridge({ desktop: { target: TARGET, driver, replyTimeoutMs: 5000 } })
  const job = send()
  await bridge.dispatch(job, { message: job.message, requested: job.requested })
  const active = bridge.activePrompts.get(job.jobId)
  assert.ok(await waitFor(() => driver.calls.filter((call) => call.action === 'inspect').length >= 3), 'observation must reach its third read')

  const outcome = await bridge.cancelJob(job, { timeoutMs: 300 })
  assert.equal(outcome.cancelSent, false)
  assert.equal(outcome.stopControl, 'unavailable')
  assert.equal(job.cancelRequested, true)

  gate.resolve(latePage)
  await active.promise.catch(() => {})

  assert.equal(job.status, 'failed')
  assert.equal(job.code, 'cancelled')
  assert.equal(job.reply, null, 'a cancelled round must not adopt the late reply')
  assert.notEqual(job.wakeState, 'delivered')
  assert.equal(agent.delivered.length, 0)
})

test('cancel followed by dispose leaves no wake behind', { timeout: 60_000 }, async () => {
  const gate = deferred()
  const latePage = snapshot({
    turns: [...BASE_TURNS, { role: 'user', text: 'ship it' }, { role: 'assistant', text: 'LATE-REPLY' }],
  })
  const driver = scriptedDriver({
    inspects: [snapshot({ turns: BASE_TURNS }), snapshot({ turns: BASE_TURNS }), () => gate.promise],
  })
  const { bridge, agent, send } = makeBridge({ desktop: { target: TARGET, driver, replyTimeoutMs: 5000 } })
  const job = send()
  await bridge.dispatch(job, { message: job.message, requested: job.requested })
  const active = bridge.activePrompts.get(job.jobId)
  assert.ok(await waitFor(() => driver.calls.filter((call) => call.action === 'inspect').length >= 3))

  await bridge.cancelJob(job, { timeoutMs: 200 })
  bridge.dispose()
  gate.resolve(latePage)
  await active.promise.catch(() => {})

  assert.equal(agent.delivered.length, 0)
  assert.notEqual(job.wakeState, 'delivered')
  assert.notEqual(job.status, 'replied')
})

test('dispatch returns the jobId right after the single Send and waitFor only waits when asked', { timeout: 60_000 }, async () => {
  const gate = deferred()
  const driver = scriptedDriver({
    inspects: [snapshot({ turns: BASE_TURNS }), snapshot({ turns: BASE_TURNS }), () => gate.promise],
  })
  const { bridge, send } = makeBridge({ desktop: { target: TARGET, driver, replyTimeoutMs: 5000 } })
  const job = send()
  const started = Date.now()
  await bridge.dispatch(job, { message: job.message, requested: job.requested })
  const elapsed = Date.now() - started
  assert.ok(elapsed < 2000, 'dispatch must return after the Send, not after the whole observation')
  assert.equal(job.status, 'accepted')
  assert.equal(job.code, 'desktop_invoked')
  assert.match(job.jobId, /^agj-/)
  const active = bridge.activePrompts.get(job.jobId)
  assert.ok(active, 'the observation must keep running independently')

  const wait = await bridge.waitFor(job, { timeoutMs: 150 })
  assert.equal(wait.timedOut, true)
  assert.equal(job.status, 'accepted', 'a wait timeout must leave the job queryable')
  assert.equal(driver.calls.filter((call) => call.action === 'dispatch').length, 1, 'a wait timeout must never resend')

  await bridge.cancelJob(job, { timeoutMs: 500 })
  gate.resolve(snapshot({ turns: BASE_TURNS }))
  await active.promise.catch(() => {})
})

test('the driver reports a post-invoke focus or tree fault as acceptance_unknown with invokeAttempted', { timeout: 120_000 }, (t) => {
  if (!hasPwsh()) {
    t.skip('pwsh is not available here')
    return
  }
  const pwsh = process.env.AGUIATEST_PWSH || 'pwsh'
  const driverPath = fileURLToPath(new URL('../lib/uia-driver.ps1', import.meta.url))
  const dir = mkdtempSync(join(tmpdir(), 'antigravity-driver-fault-'))

  const run = (scenario, name) => {
    const scenarioPath = join(dir, name + '.json')
    writeFileSync(scenarioPath, JSON.stringify(scenario), 'utf8')
    const result = spawnSync(
      pwsh,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driverPath],
      {
        input: JSON.stringify({ action: 'dispatch', target: TARGET, message: 't52 boundary check' }),
        encoding: 'utf8',
        timeout: 90000,
        env: { ...process.env, AGUIA_FAKE_SCENARIO: scenarioPath },
      },
    )
    assert.equal(result.status, 0, result.stderr || 'driver must exit 0')
    const parsed = lastJsonLine(result.stdout)
    assert.ok(parsed, 'driver must print exactly one JSON line')
    return parsed
  }

  const base = fakeScenario()
  const focusFault = run({ ...base, window: { ...base.window, foregroundThrowsAfterInvoke: true } }, 'focus')
  assert.equal(focusFault.status, 'acceptance_unknown', 'a focus probe fault after Invoke must not claim not_sent')
  assert.equal(focusFault.invokeAttempted, true)
  assert.equal(focusFault.invokeCount, 1)

  const treeFault = run({ ...base, failAfterInvoke: 'tree' }, 'tree')
  assert.equal(treeFault.status, 'acceptance_unknown')
  assert.equal(treeFault.reason, 'post_invoke_observation_failed')
  assert.equal(treeFault.invokeAttempted, true)
  assert.equal(treeFault.invokeCount, 1)
})

test('Bridge -> real pwsh -> synthetic tree: a post-invoke tree fault stays ambiguous and locked', { timeout: 180_000 }, async (t) => {
  if (!hasPwsh()) {
    t.skip('pwsh is not available here')
    return
  }
  const pwsh = process.env.AGUIATEST_PWSH || 'pwsh'
  const driverPath = fileURLToPath(new URL('../lib/uia-driver.ps1', import.meta.url))
  const dir = mkdtempSync(join(tmpdir(), 'antigravity-desktop-fault-'))
  const scenarioPath = join(dir, 'scenario.json')
  writeFileSync(scenarioPath, JSON.stringify({ ...fakeScenario(), failAfterInvoke: 'tree' }), 'utf8')

  const { bridge, agent, send } = makeBridge({
    desktop: {
      target: TARGET,
      driverPath,
      powershell: pwsh,
      pollMs: 200,
      replyTimeoutMs: 1500,
      timeoutMs: 20000,
      env: { AGUIA_FAKE_SCENARIO: scenarioPath },
    },
  })
  const job = send()
  await bridge.dispatch(job, { message: job.message, requested: job.requested })
  const active = bridge.activePrompts.get(job.jobId)
  if (active) await active.promise.catch(() => {})

  const view = bridge.view(job)
  assert.equal(view.status, 'acceptance_unknown')
  assert.equal(view.code, 'desktop_acceptance_unknown')
  assert.ok(!view.reply)
  assert.notEqual(view.wakeState, 'delivered')
  assert.equal(agent.delivered.length, 0)

  const again = bridge.beginSend({ agentId: agent.id, transport: 'desktop', message: 'second', requested: { pathRefs: [] } })
  assert.equal(again.error?.code, 'busy', 'an ambiguous desktop round keeps the window lock')
})

test('the Web capability contract maps desktop as a boolean plus its pinned target', async () => {
  const driver = scriptedDriver({ inspects: [snapshot()] })
  const { bridge } = makeBridge({ desktop: { target: TARGET, driver } })
  const service = new AntigravityBridgeService({
    ctx: { get: () => undefined },
    bridge,
    config: { models: ['flash'], efforts: ['low'] },
  })
  const agent = { id: 'agent-a', session: { id: 'agent-a' } }
  const result = await service.capabilities(agent)
  assert.equal(result.ok, true)
  const caps = result.capabilities
  assert.deepEqual(caps.transports, ['acp', 'desktop'])
  assert.equal(caps.desktop, true)
  assert.equal(typeof caps.desktopCapabilities, 'object')
  assert.equal(caps.desktopCapabilities.enabled, true)
  assert.equal(caps.target.pid, TARGET.pid)
  assert.ok(caps.target.uri.startsWith('https://127.0.0.1:48107/c/'), 'the target URI is redacted but kept')
  assert.ok(!caps.target.uri.includes('?') && !caps.target.uri.includes('#'))
  assert.ok(!('sessionId' in caps.target))
  assert.deepEqual(caps.desktopCapabilities.models, [], 'desktop exposes no verified models')
  assert.deepEqual(caps.desktopCapabilities.efforts, [], 'desktop exposes no verified efforts')
  assert.equal(caps.desktopCapabilities.attachments.native, false, 'native attachments are verified unavailable')
  assert.match(caps.desktopCapabilities.evidence, /unverified/i)
})

test('the Web dispatch returns the jobId before the desktop round finishes', { timeout: 60_000 }, async () => {
  const gate = deferred()
  const driver = scriptedDriver({
    inspects: [snapshot({ turns: BASE_TURNS }), snapshot({ turns: BASE_TURNS }), () => gate.promise],
  })
  const { bridge, agent } = makeBridge({ desktop: { target: TARGET, driver, replyTimeoutMs: 5000 } })
  const service = new AntigravityBridgeService({
    ctx: { get: () => undefined },
    bridge,
    config: { models: [], efforts: [] },
  })
  const agentForService = { id: agent.id, session: { id: agent.id } }
  const started = Date.now()
  const result = await service.dispatch(agentForService, {
    message: 'web desktop',
    transport: 'desktop',
    clientRequestId: 'web-1',
  })
  assert.ok(Date.now() - started < 3000, 'the Web dispatch must not block on observation')
  assert.equal(result.ok, true)
  assert.match(result.jobId, /^agj-/)
  assert.equal(result.status, 'accepted')

  const status = await service.status(agentForService, { jobId: result.jobId })
  assert.equal(status.ok, true)
  assert.equal(status.view.transport, 'desktop')

  const cancelled = await service.cancel(agentForService, { jobId: result.jobId })
  assert.equal(cancelled.ok, true)
  assert.equal(cancelled.cancelSent, false)
  assert.equal(cancelled.stopControl, 'unavailable')
  gate.resolve(snapshot({ turns: BASE_TURNS }))
  const active = bridge.activePrompts.get(result.jobId)
  if (active) await active.promise.catch(() => {})
})
