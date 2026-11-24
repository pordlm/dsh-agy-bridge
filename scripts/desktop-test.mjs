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
    cwd: dir,
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
  const { bridge, backend, dir } = makeBridge({ desktop: { enabled: false, target: TARGET, driver } })
  assert.deepEqual(bridge.desktop.capabilities().transports, ['acp'])
  const begun = bridge.beginSend({
    agentId: 'agent-a',
    transport: 'acp',
    workspaceRoot: dir,
    message: 'hello',
    requested: { pathRefs: [] },
  })
  assert.equal(begun.error, undefined)
  await dispatchAndSettle(bridge, begun.job, { message: 'hello', requested: begun.job.requested, cwd: dir })
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
      cwd: dir,
      pollMs: 60_000,
      desktop: { enabled: true, target: TARGET, driver: scriptedDriver({ inspects: [snapshot()] }) },
    }),
    { warn() {}, info() {} },
  )
  bridge2.remember(agentB)
  const begun2 = bridge2.beginSend({ agentId: 'agent-b', transport: 'acp', workspaceRoot: dir, message: 'second', requested: {} })
  assert.equal(begun2.error, undefined)
  await bridge2.dispatch(begun2.job, { message: 'second', requested: begun2.job.requested, cwd: dir })
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
  assert.equal(typeof caps.desktopCapabilities.evidence, 'string')
  assert.ok(caps.desktopCapabilities.evidence.includes('uia-driver 1.0.0'))
  assert.ok(caps.desktopCapabilities.evidence.includes('single-turn Send verified'))
  assert.ok(!caps.desktopCapabilities.evidence.includes('live Send/permission controls unverified'))
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

test('t18-1: pin unique candidate writes desktop-target.json and returns target+evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-t18-pin-'))
  const stateFile = join(dir, 'state.json')
  const { DesktopChannel } = await import('../lib/desktop.js')
  const fakeDriver = {
    async run(req) {
      if (req.action === 'inspect') {
        return {
          ok: true,
          candidates: [{ pid: 4321, startedAt: '2026-11-24T00:00:00.000Z', hwnd: '0x1234', window: { visible: true, cloaked: 0, minimized: false }, executableOk: true }],
        }
      }
      if (req.action === 'probe_window') {
        return {
          ok: true,
          action: 'probe_window',
          driverVersion: '1.0.0',
          targetKey: 'aguia1:abcd1234',
          target: { pid: 4321, startedAt: '2026-11-24T00:00:00.000Z', hwnd: '0x1234', uri: 'https://antigravity.local/session/1' },
          verified: { process: true, startTime: true, executable: true, window: true, documentUri: true, sessionLink: 'unique', linkEvidence: 'sidebar' },
          diagnostics: { documentUriCount: 1, elapsedMs: 12, foreground: { before: '0x99', after: '0x99', changed: false } },
        }
      }
      throw new Error(`unexpected action ${req.action}`)
    },
  }
  const channel = new DesktopChannel({
    bridge: {},
    config: { stateFile, desktop: { enabled: true, driver: fakeDriver } },
    logger: { warn: () => {} },
  })
  const pinned = await channel.pin()
  assert.equal(pinned.ok, true)
  assert.equal(pinned.target.pid, 4321)
  assert.equal(pinned.targetKey, 'aguia1:abcd1234')
  assert.equal(pinned.evidence.verified.sessionLink, 'unique')
  const pinFile = join(dir, 'desktop-target.json')
  assert.equal(existsSync(pinFile), true)
  const disk = JSON.parse(readFileSync(pinFile, 'utf8'))
  assert.equal(disk.version, 1)
  assert.equal(disk.target.hwnd, 0x1234)
})

test('t18-2: multiple candidates without hwnd refuses with desktop_target_ambiguous and writes nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-t18-ambig-'))
  const stateFile = join(dir, 'state.json')
  const { DesktopChannel } = await import('../lib/desktop.js')
  const fakeDriver = {
    async run(req) {
      if (req.action === 'inspect') {
        return {
          ok: true,
          candidates: [
            { pid: 100, startedAt: '2026-11-24T00:00:00.000Z', hwnd: '0x100', uri: 'https://a.local/s1?tok=secret', isForeground: true, window: { visible: true, cloaked: 0, minimized: false } },
            { pid: 200, startedAt: '2026-11-24T00:00:00.000Z', hwnd: '0x200', uri: 'https://a.local/s2', isForeground: false, window: { visible: true, cloaked: 0, minimized: false } },
          ],
        }
      }
      throw new Error(`should not probe when ambiguous: ${req.action}`)
    },
  }
  const channel = new DesktopChannel({
    bridge: {},
    config: { stateFile, desktop: { enabled: true, driver: fakeDriver } },
    logger: { warn: () => {} },
  })
  const res = await channel.pin()
  assert.equal(res.ok, false)
  assert.equal(res.code, 'desktop_target_ambiguous')
  assert.equal(res.candidates.length, 2)
  assert.equal(res.candidates[0].redactedUri, 'https://a.local/s1')
  assert.equal(existsSync(join(dir, 'desktop-target.json')), false)
})

test('t18-3 & t18-7: runtime pin overrides static config.desktop.target and clearPin falls back to static', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-t18-prio-'))
  const stateFile = join(dir, 'state.json')
  const staticTarget = { pid: 111, startedAt: '2026-11-24T00:00:00.000Z', hwnd: '0x111', uri: 'https://static.local/s' }
  const { DesktopChannel, driftFields } = await import('../lib/desktop.js')
  const fakeDriver = {
    async run(req) {
      if (req.action === 'inspect') {
        return { ok: true, candidates: [{ pid: 222, startedAt: '2026-11-24T00:00:00.000Z', hwnd: '0x222', window: { visible: true, cloaked: 0, minimized: false } }] }
      }
      return {
        ok: true,
        targetKey: 'aguia1:222',
        target: { pid: 222, startedAt: '2026-11-24T00:00:00.000Z', hwnd: '0x222', uri: 'https://pinned.local/s' },
        verified: { process: true, startTime: true, executable: true, window: true, documentUri: true, sessionLink: 'unique', linkEvidence: 'sidebar' },
        diagnostics: { documentUriCount: 1, elapsedMs: 5, foreground: { before: '0x1', after: '0x1', changed: false } },
      }
    },
  }
  const channel = new DesktopChannel({
    bridge: {},
    config: { stateFile, desktop: { enabled: true, target: staticTarget, driver: fakeDriver } },
    logger: { warn: () => {} },
  })
  assert.equal(channel.effectiveTarget().pid, 111)
  await channel.pin()
  assert.equal(channel.effectiveTarget().pid, 222)
  assert.deepEqual(driftFields(staticTarget, channel.effectiveTarget()), ['pid', 'hwnd', 'uri'])
  const cleared = channel.clearPin()
  assert.equal(cleared, true)
  assert.equal(channel.effectiveTarget().pid, 111)
})

test('t18-4: corrupted desktop-target.json is treated as unconfigured without crashing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-t18-corrupt-'))
  const stateFile = join(dir, 'state.json')
  const pinFile = join(dir, 'desktop-target.json')
  writeFileSync(pinFile, '{not valid json', 'utf8')
  const warnings = []
  const { DesktopChannel } = await import('../lib/desktop.js')
  const channel = new DesktopChannel({
    bridge: {},
    config: { stateFile, desktop: { enabled: true } },
    logger: { warn: (m) => warnings.push(m) },
  })
  assert.equal(channel.effectiveTarget(), null)
  assert.equal(warnings.length, 1)

  writeFileSync(pinFile, JSON.stringify({ version: 99, target: { pid: -1 } }), 'utf8')
  assert.equal(channel.effectiveTarget(), null)
  assert.equal(warnings.length, 2)
})

test('t18-5: probe_window in uia-driver.ps1 verifies identity and preserves foreground (changed=false)', async () => {
  const { spawnSync } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'ag-t18-pwsh-'))
  const scenarioFile = join(dir, 'scenario.json')
  const scenario = fakeScenario()
  writeFileSync(scenarioFile, JSON.stringify(scenario), 'utf8')
  const driverPath = join(process.cwd(), 'lib', 'uia-driver.ps1')
  const reqJson = JSON.stringify({ action: 'probe_window', target: { pid: TARGET.pid, startedAt: TARGET.startedAt, hwnd: TARGET.hwnd } })
  const run = spawnSync('pwsh', ['-NoProfile', '-File', driverPath], {
    input: reqJson,
    encoding: 'utf8',
    env: { ...process.env, AGUIA_FAKE_SCENARIO: scenarioFile },
  })
  assert.equal(run.status, 0, run.stderr)
  const parsed = JSON.parse(run.stdout.trim())
  assert.equal(parsed.ok, true, JSON.stringify(parsed))
  assert.equal(parsed.action, 'probe_window')
  assert.equal(parsed.target.uri, TARGET.uri)
  assert.equal(parsed.verified.sessionLink, 'unique')
  assert.equal(parsed.diagnostics.documentUriCount, 1)
  assert.equal(parsed.diagnostics.foreground.changed, false)
  assert.equal(parsed.diagnostics.foreground.before, parsed.diagnostics.foreground.after)
})

test('t18-6: missing driver throws desktop_driver_missing', async () => {
  const { DesktopChannel } = await import('../lib/desktop.js')
  const channel = new DesktopChannel({
    bridge: {},
    config: { desktop: { enabled: true, driverPath: join(tmpdir(), 'nonexistent-uia-driver-999.ps1') } },
    logger: { warn: () => {} },
  })
  assert.throws(() => channel.driver(), (err) => err?.code === 'desktop_driver_missing')
})

test('t18-r2-1: antigravity_desktop_pin tool handles ambiguous, unique pin, and clear fallback even when enabled=false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-t18-r2-pin-'))
  const stateFile = join(dir, 'state.json')
  const staticTarget = { pid: 101, startedAt: '2026-11-24T00:00:00.000Z', hwnd: '0x101', uri: 'https://static.local/s' }
  let candidates = [
    { pid: 100, startedAt: '2026-11-24T00:00:00.000Z', hwnd: '0x100', uri: 'https://a.local/s1?secret=1', isForeground: true, window: { visible: true, cloaked: 0, minimized: false } },
    { pid: 200, startedAt: '2026-11-24T00:00:00.000Z', hwnd: '0x200', uri: 'https://a.local/s2', isForeground: false, window: { visible: true, cloaked: 0, minimized: false } },
  ]
  const fakeDriver = {
    async run(req) {
      if (req.action === 'inspect') return { ok: true, candidates }
      if (req.action === 'probe_window') {
        return {
          ok: true,
          action: 'probe_window',
          driverVersion: '1.0.0',
          targetKey: 'aguia1:100',
          target: { pid: 100, startedAt: '2026-11-24T00:00:00.000Z', hwnd: '0x100', uri: 'https://a.local/s1' },
          verified: { process: true, startTime: true, executable: true, window: true, documentUri: true, sessionLink: 'unique', linkEvidence: 'sidebar' },
          diagnostics: { documentUriCount: 1, elapsedMs: 4, foreground: { before: '0x1', after: '0x1', changed: false } },
        }
      }
      throw new Error(`unexpected action ${req.action}`)
    },
  }
  const tools = new Map()
  const cleanups = []
  const { apply } = await import('../lib/index.js')
  apply(
    {
      tools: { register: (def) => { tools.set(def.name, def); return () => {} } },
      effect: (fn) => { const d = fn(); if (typeof d === 'function') cleanups.push(d); return () => {} },
      get: () => undefined,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, trace: () => {} },
      on: () => () => {},
      reflect: { provide: () => {}, get: () => undefined },
      root: {},
    },
    { stateFile, modelProvider: false, desktop: { enabled: false, target: staticTarget, driver: fakeDriver } },
  )
  try {
    const pinTool = tools.get('antigravity_desktop_pin')
    assert.ok(pinTool, 'antigravity_desktop_pin registered')
    const exec = { agent: { id: 'agent-r2-1' } }

    const ambig = await pinTool.execute({ action: 'pin' }, exec)
    assert.equal(ambig.pinned, false)
    assert.equal(ambig.code, 'desktop_target_ambiguous')
    assert.equal(ambig.candidates.length, 2)
    assert.equal(ambig.candidates[0].redactedUri, 'https://a.local/s1')

    candidates = [candidates[0]]
    const okPin = await pinTool.execute({ action: 'pin' }, exec)
    assert.equal(okPin.pinned, true)
    assert.equal(okPin.target.pid, 100)
    assert.ok(okPin.evidence?.verified)

    const statusRes = await pinTool.execute({ action: 'status', include_candidates: true }, exec)
    assert.equal(statusRes.pinned, true)
    assert.equal(statusRes.verified, true)
    assert.equal(statusRes.candidates.length, 1)

    const cleared = await pinTool.execute({ action: 'clear' }, exec)
    assert.equal(cleared.pinned, false)
    assert.equal(cleared.fallbackTarget.pid, 101)
  } finally {
    for (const fn of cleanups.reverse()) fn()
  }
})

test('t18-r2-2: error code normalization across web-remote desktopStatus, drift, and session ambiguity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-t18-r2-norm-'))
  const stateFile = join(dir, 'state.json')
  const target = { pid: 300, startedAt: '2026-11-24T00:00:00.000Z', hwnd: '0x300', uri: 'https://a.local/s1' }
  let probeResponse = { ok: false, code: 'uri_mismatch', message: 'uri changed', detail: { field: 'uri' } }
  const fakeDriver = {
    async run(req) {
      if (req.action === 'probe_window') return probeResponse
      if (req.action === 'inspect') return { ok: false, code: 'session_link_ambiguous', message: 'ambig' }
      throw new Error(`unexpected action ${req.action}`)
    },
  }
  let providedService = null
  const cleanups = []
  const { apply } = await import('../lib/index.js')
  apply(
    {
      tools: { register: () => () => {} },
      effect: (fn) => { const d = fn(); if (typeof d === 'function') cleanups.push(d); return () => {} },
      get: () => undefined,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, trace: () => {} },
      on: () => () => {},
      reflect: { provide: (_k, svc) => { providedService = svc; return () => {} }, get: () => undefined },
      root: {},
    },
    { stateFile, modelProvider: false, desktop: { enabled: false, target, driver: fakeDriver } },
  )
  try {
    const agent = { id: 'agent-r2-2' }
    const disabledRes = await providedService.desktopStatus(agent, {})
    assert.equal(disabledRes.ok, false)
    assert.equal(disabledRes.code, 'desktop_disabled')

    providedService.bridge.desktop.desktop.enabled = true
    const driftRes = await providedService.desktopStatus(agent, {})
    assert.equal(driftRes.verified, false)
    assert.equal(driftRes.code, 'desktop_target_changed')
    assert.equal(driftRes.detail?.driftField, 'uri')

    probeResponse = { ok: false, code: 'session_link_ambiguous', message: 'two links' }
    const ambigLinkRes = await providedService.desktopStatus(agent, {})
    assert.equal(ambigLinkRes.verified, false)
    assert.equal(ambigLinkRes.code, 'desktop_target_unverified')
  } finally {
    for (const fn of cleanups.reverse()) fn()
  }
})

test('t18-r2-3 & t18-r2-4: desktop receipt has effective.source=desktop_window_current and capability boundaries reject before inspect/dispatch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-t18-r2-cap-'))
  const stateFile = join(dir, 'state.json')
  const target = { pid: 400, startedAt: '2026-11-24T00:00:00.000Z', hwnd: '0x400', uri: 'https://a.local/s1' }
  let inspectCalls = 0
  let dispatchCalls = 0
  const fakeDriver = {
    async run(req) {
      if (req.action === 'inspect') {
        inspectCalls += 1
        return {
          ok: true,
          targetKey: 'aguia1:400',
          verified: { process: true, startTime: true, executable: true, window: true, documentUri: true, sessionLink: 'unique' },
          snapshot: {
            observedAt: new Date().toISOString(),
            phase: 'idle',
            evidence: { stopControl: false, permissionCard: false },
            history: { complete: true, turns: [] },
            unreadable: [],
          },
        }
      }
      if (req.action === 'dispatch') {
        dispatchCalls += 1
        return { ok: true, status: 'invoked' }
      }
      throw new Error(`unexpected action ${req.action}`)
    },
  }
  const tools = new Map()
  const cleanups = []
  const { apply } = await import('../lib/index.js')
  apply(
    {
      tools: { register: (def) => { tools.set(def.name, def); return () => {} } },
      effect: (fn) => { const d = fn(); if (typeof d === 'function') cleanups.push(d); return () => {} },
      get: () => undefined,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, trace: () => {} },
      on: () => () => {},
      reflect: { provide: () => {}, get: () => undefined },
      root: {},
    },
    { stateFile, modelProvider: false, desktop: { enabled: true, target, driver: fakeDriver, pollMs: 100 } },
  )
  try {
    const sendTool = tools.get('antigravity_send')
    const exec = { agent: { id: 'agent-r2-3' } }

    await assert.rejects(
      () => sendTool.execute({ message: 'hi', transport: 'desktop', model: 'GPT-6' }, exec),
      (err) => err?.code === 'unsupported_capability',
    )
    assert.equal(inspectCalls, 0)

    await assert.rejects(
      () => sendTool.execute({ message: 'hi', transport: 'desktop', attachments: ['/tmp/a.png'] }, exec),
      (err) => err?.code === 'unsupported_capability',
    )
    assert.equal(dispatchCalls, 0)

    const receipt = await sendTool.execute({ message: 'hello desktop', transport: 'desktop', wait: false }, exec)
    assert.equal(receipt.effective.source, 'desktop_window_current')
    assert.equal(receipt.effective.model, null)
    assert.equal(receipt.effective.effort, null)
    assert.equal(receipt.effective.summary, '实际：使用窗口当前设置（桌面通道不切换模型与思考强度）')
  } finally {
    for (const fn of cleanups.reverse()) fn()
  }
})

test('t21-f4: desktop transport with path_refs appends [path_reference] block and sends no native attachments', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-t21-f4-'))
  const stateFile = join(dir, 'state.json')
  const refFile = join(dir, 'spec.md')
  writeFileSync(refFile, '# spec\n', 'utf8')
  const target = { pid: 401, startedAt: '2026-11-24T00:00:00.000Z', hwnd: '0x401', uri: 'https://a.local/s1' }
  let capturedDispatch = null
  const fakeDriver = {
    async run(req) {
      if (req.action === 'inspect') {
        return {
          ok: true,
          targetKey: 'aguia1:401',
          verified: { process: true, startTime: true, executable: true, window: true, documentUri: true, sessionLink: 'unique' },
          snapshot: {
            observedAt: new Date().toISOString(),
            phase: 'idle',
            evidence: { stopControl: false, permissionCard: false },
            history: { complete: true, turns: [] },
            unreadable: [],
          },
        }
      }
      if (req.action === 'dispatch') {
        capturedDispatch = req
        return { ok: true, status: 'invoked' }
      }
      throw new Error(`unexpected action ${req.action}`)
    },
  }
  const tools = new Map()
  const cleanups = []
  const { apply } = await import('../lib/index.js')
  apply(
    {
      tools: { register: (def) => { tools.set(def.name, def); return () => {} } },
      effect: (fn) => { const d = fn(); if (typeof d === 'function') cleanups.push(d); return () => {} },
      get: () => undefined,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, trace: () => {} },
      on: () => () => {},
      reflect: { provide: () => {}, get: () => undefined },
      root: {},
    },
    { stateFile, cwd: dir, modelProvider: false, desktop: { enabled: true, target, driver: fakeDriver, pollMs: 100 } },
  )
  try {
    const sendTool = tools.get('antigravity_send')
    const exec = { agent: { id: 'agent-t21-f4' } }
    const receipt = await sendTool.execute(
      { message: 'read spec', transport: 'desktop', path_refs: [refFile], wait: false },
      exec,
    )
    assert.ok(capturedDispatch, 'driver dispatch must be called')
    assert.ok(capturedDispatch.message.includes('[path_reference]'), 'dispatch message must include [path_reference]')
    assert.ok(capturedDispatch.message.includes(refFile), 'dispatch message must include refFile path')
    assert.equal(capturedDispatch.attachments === undefined || capturedDispatch.attachments.length === 0, true)
    assert.equal(receipt.requested.attachments, 0)
    assert.deepEqual(receipt.requested.pathRefs, [refFile])
  } finally {
    for (const fn of cleanups.reverse()) fn()
  }
})

test('t23-1: probe_window matches session link ignoring query/fragment while keeping full query in target.uri', async () => {
  const { spawnSync } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'ag-t23-query-'))
  const scenarioFile = join(dir, 'scenario.json')
  const docWithQuery = 'https://127.0.0.1:44207/c/S1?project=outside-of-project'
  const linkNoQuery = 'https://127.0.0.1:44207/c/S1'
  const scenario = fakeScenario()
  scenario.tree.children[1].value = docWithQuery
  scenario.tree.children[0].children[0].value = linkNoQuery
  writeFileSync(scenarioFile, JSON.stringify(scenario), 'utf8')
  const driverPath = join(process.cwd(), 'lib', 'uia-driver.ps1')
  const reqJson = JSON.stringify({ action: 'probe_window', target: { pid: TARGET.pid, startedAt: TARGET.startedAt, hwnd: TARGET.hwnd } })
  const run = spawnSync('pwsh', ['-NoProfile', '-File', driverPath], {
    input: reqJson,
    encoding: 'utf8',
    env: { ...process.env, AGUIA_FAKE_SCENARIO: scenarioFile },
  })
  assert.equal(run.status, 0, run.stderr)
  const parsed = JSON.parse(run.stdout.trim())
  assert.equal(parsed.ok, true, JSON.stringify(parsed))
  assert.equal(parsed.verified.sessionLink, 'unique')
  assert.equal(parsed.target.uri, docWithQuery)
})

test('t23-2: probe_window rejects different session path (S1 vs S2) and DesktopChannel.pin normalizes to desktop_target_unverified', async () => {
  const { spawnSync } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'ag-t23-mismatch-'))
  const stateFile = join(dir, 'state.json')
  const scenarioFile = join(dir, 'scenario.json')
  const docWithQuery = 'https://127.0.0.1:44207/c/S1?project=outside-of-project'
  const wrongLink = 'https://127.0.0.1:44207/c/S2'
  const scenario = fakeScenario()
  scenario.tree.children[1].value = docWithQuery
  scenario.tree.children[0].children[0].value = wrongLink
  scenario.windows = [
    {
      hwnd: TARGET.hwnd,
      window: scenario.window,
      tree: scenario.tree,
    },
  ]
  writeFileSync(scenarioFile, JSON.stringify(scenario), 'utf8')
  const driverPath = join(process.cwd(), 'lib', 'uia-driver.ps1')
  const reqJson = JSON.stringify({ action: 'probe_window', target: { pid: TARGET.pid, startedAt: TARGET.startedAt, hwnd: TARGET.hwnd } })
  const run = spawnSync('pwsh', ['-NoProfile', '-File', driverPath], {
    input: reqJson,
    encoding: 'utf8',
    env: { ...process.env, AGUIA_FAKE_SCENARIO: scenarioFile },
  })
  assert.equal(run.status, 0, run.stderr)
  const parsed = JSON.parse(run.stdout.trim())
  assert.equal(parsed.ok, false)
  assert.equal(parsed.code, 'session_link_not_found')

  const { DesktopChannel } = await import('../lib/desktop.js')
  const channel = new DesktopChannel({
    bridge: {},
    config: { stateFile, desktop: { enabled: true, driverPath, env: { AGUIA_FAKE_SCENARIO: scenarioFile } } },
    logger: { warn: () => {} },
  })
  const pinned = await channel.pin({ pid: TARGET.pid })
  assert.equal(pinned.ok, false)
  assert.equal(pinned.code, 'desktop_target_unverified')
  assert.equal(existsSync(join(dir, 'desktop-target.json')), false)
})

test('t23-3: pid-only discovery filters out windows without http Document and picks the unique eligible window (or reports ambiguous when 2 eligible)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-t23-pidonly-'))
  const stateFile = join(dir, 'state.json')
  const scenarioFile = join(dir, 'scenario.json')
  const driverPath = join(process.cwd(), 'lib', 'uia-driver.ps1')
  const base = fakeScenario()
  const docUri = 'https://127.0.0.1:44207/c/S1?project=outside-of-project'
  base.tree.children[1].value = docUri
  base.tree.children[0].children[0].value = 'https://127.0.0.1:44207/c/S1'

  const noDocTree = { type: 'Window', name: 'Auxiliary', children: [{ type: 'Pane', name: 'Empty' }] }
  const scenario = {
    process: base.process,
    window: base.window,
    tree: base.tree,
    windows: [
      {
        hwnd: '0x1111',
        window: { ...base.window, visible: true, minimized: false, cloaked: 0, foreground: false },
        tree: noDocTree,
      },
      {
        hwnd: '0x2222',
        window: { ...base.window, visible: true, minimized: false, cloaked: 0, foreground: true },
        tree: base.tree,
      },
    ],
  }
  writeFileSync(scenarioFile, JSON.stringify(scenario), 'utf8')

  const { DesktopChannel } = await import('../lib/desktop.js')
  const channel = new DesktopChannel({
    bridge: {},
    config: { stateFile, desktop: { enabled: true, driverPath, env: { AGUIA_FAKE_SCENARIO: scenarioFile } } },
    logger: { warn: () => {} },
  })
  const pinned = await channel.pin({ pid: TARGET.pid })
  assert.equal(pinned.ok, true, JSON.stringify(pinned))
  assert.equal(pinned.target.hwnd, 0x2222)
  assert.equal(pinned.target.uri, docUri)

  // When both windows are eligible (each has 1 http Document), pid-only refuses with desktop_target_ambiguous.
  const secondTree = JSON.parse(JSON.stringify(base.tree))
  secondTree.children[1].value = 'https://127.0.0.1:44207/c/S2'
  secondTree.children[0].children[0].value = 'https://127.0.0.1:44207/c/S2'
  scenario.windows[0].tree = secondTree
  writeFileSync(scenarioFile, JSON.stringify(scenario), 'utf8')
  const ambig = await channel.discover({ pid: TARGET.pid })
  assert.equal(ambig.ok, false)
  assert.equal(ambig.code, 'desktop_target_ambiguous')
  assert.equal(ambig.candidates.length, 2)
})

test('t25-1: dispatch succeeds via keyboard injection when ValuePattern.SetValue is a no-op', async () => {
  const { spawnSync } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'ag-t25-kbd-'))
  const scenarioFile = join(dir, 'scenario.json')
  const scenario = fakeScenario()
  scenario.setValueNoop = true
  scenario.keyboard = 'ok'
  scenario.foregroundMode = 'match'
  scenario.emptyBaseline = '\n'
  // Empty Electron baseline '\n'
  scenario.tree.children[1] = scenario.tree.children[1]
  const composerNode = scenario.tree.children[2].children[0]
  composerNode.value = '\n'
  writeFileSync(scenarioFile, JSON.stringify(scenario), 'utf8')
  const driverPath = join(process.cwd(), 'lib', 'uia-driver.ps1')
  const reqJson = JSON.stringify({ action: 'dispatch', target: TARGET, message: 'probe-abc' })
  const run = spawnSync('pwsh', ['-NoProfile', '-File', driverPath], {
    input: reqJson,
    encoding: 'utf8',
    env: { ...process.env, AGUIA_FAKE_SCENARIO: scenarioFile },
  })
  assert.equal(run.status, 0, run.stderr)
  const parsed = JSON.parse(run.stdout.trim())
  assert.equal(parsed.ok, true, JSON.stringify(parsed))
  assert.equal(parsed.status, 'invoked', JSON.stringify({ status: parsed.status, reason: parsed.reason, code: parsed.code, detail: parsed.detail, diagnostics: parsed.diagnostics }))
  assert.equal(parsed.invokeCount, 1)
  assert.equal(parsed.diagnostics.fakeInvokes, 1)
  assert.equal(parsed.diagnostics.fakeWrites.length, 1)
  assert.equal(parsed.diagnostics.fakeWrites[0].applied, 'probe-abc')
  assert.equal(parsed.diagnostics.fakeWrites[0].mode, 'keyboard')
})

test('t25-2: truncated keyboard injection fails with readback_mismatch, 0 invokes, and restores composer', async () => {
  const { spawnSync } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'ag-t25-trunc-'))
  const scenarioFile = join(dir, 'scenario.json')
  const scenario = fakeScenario()
  scenario.setValueNoop = true
  scenario.keyboard = 'truncate'
  scenario.foregroundMode = 'match'
  scenario.emptyBaseline = '\n'
  writeFileSync(scenarioFile, JSON.stringify(scenario), 'utf8')
  const driverPath = join(process.cwd(), 'lib', 'uia-driver.ps1')
  const reqJson = JSON.stringify({ action: 'dispatch', target: TARGET, message: 'long-message-123' })
  const run = spawnSync('pwsh', ['-NoProfile', '-File', driverPath], {
    input: reqJson,
    encoding: 'utf8',
    env: { ...process.env, AGUIA_FAKE_SCENARIO: scenarioFile },
  })
  assert.equal(run.status, 0, run.stderr)
  const parsed = JSON.parse(run.stdout.trim())
  assert.equal(parsed.status, 'not_sent')
  assert.equal(parsed.code, 'readback_mismatch')
  assert.equal(parsed.invokeCount, 0)
  assert.equal(parsed.diagnostics.fakeInvokes, 0)
  assert.equal(parsed.detail.composerRestored, true)
})

test('t25-3: foreground mismatch twice refuses with foreground_unavailable and zero characters written', async () => {
  const { spawnSync } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'ag-t25-fg-'))
  const scenarioFile = join(dir, 'scenario.json')
  const scenario = fakeScenario()
  scenario.foregroundMode = 'mismatch'
  scenario.keyboard = 'ok'
  writeFileSync(scenarioFile, JSON.stringify(scenario), 'utf8')
  const driverPath = join(process.cwd(), 'lib', 'uia-driver.ps1')
  const reqJson = JSON.stringify({ action: 'dispatch', target: TARGET, message: 'hello' })
  const run = spawnSync('pwsh', ['-NoProfile', '-File', driverPath], {
    input: reqJson,
    encoding: 'utf8',
    env: { ...process.env, AGUIA_FAKE_SCENARIO: scenarioFile },
  })
  assert.equal(run.status, 0, run.stderr)
  const parsed = JSON.parse(run.stdout.trim())
  assert.equal(parsed.status, 'not_sent')
  assert.equal(parsed.code, 'foreground_unavailable')
  assert.equal(parsed.invokeCount, 0)
  assert.equal(parsed.diagnostics.fakeKeyCalls, 0)
  assert.equal(parsed.diagnostics.fakeWrites.length, 0)
})

test('t25-4: multiline message is rejected with bad_request before any write or invoke', async () => {
  const { spawnSync } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'ag-t25-multiline-'))
  const scenarioFile = join(dir, 'scenario.json')
  const scenario = fakeScenario()
  scenario.foregroundMode = 'match'
  scenario.keyboard = 'ok'
  writeFileSync(scenarioFile, JSON.stringify(scenario), 'utf8')
  const driverPath = join(process.cwd(), 'lib', 'uia-driver.ps1')
  const reqJson = JSON.stringify({ action: 'dispatch', target: TARGET, message: 'line1\nline2' })
  const run = spawnSync('pwsh', ['-NoProfile', '-File', driverPath], {
    input: reqJson,
    encoding: 'utf8',
    env: { ...process.env, AGUIA_FAKE_SCENARIO: scenarioFile },
  })
  assert.equal(run.status, 0, run.stderr)
  const parsed = JSON.parse(run.stdout.trim())
  assert.equal(parsed.ok, false)
  assert.equal(parsed.code, 'bad_request')
  assert.equal(parsed.status, 'not_sent')
  assert.equal(parsed.invokeCount, 0)
})

test('t25-5: foreground mismatchOnce retries restore+setForeground once and succeeds', async () => {
  const { spawnSync } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'ag-t25-fgonce-'))
  const scenarioFile = join(dir, 'scenario.json')
  const scenario = fakeScenario()
  scenario.foregroundMode = 'mismatchOnce'
  scenario.keyboard = 'ok'
  writeFileSync(scenarioFile, JSON.stringify(scenario), 'utf8')
  const driverPath = join(process.cwd(), 'lib', 'uia-driver.ps1')
  const reqJson = JSON.stringify({ action: 'dispatch', target: TARGET, message: 'retry-fg-ok' })
  const run = spawnSync('pwsh', ['-NoProfile', '-File', driverPath], {
    input: reqJson,
    encoding: 'utf8',
    env: { ...process.env, AGUIA_FAKE_SCENARIO: scenarioFile },
  })
  assert.equal(run.status, 0, run.stderr)
  const parsed = JSON.parse(run.stdout.trim())
  assert.equal(parsed.ok, true, JSON.stringify(parsed))
  assert.equal(parsed.status, 'invoked', JSON.stringify({ status: parsed.status, reason: parsed.reason, code: parsed.code, detail: parsed.detail, diagnostics: parsed.diagnostics }))
  assert.equal(parsed.invokeCount, 1)
  assert.equal(parsed.diagnostics.fakeWrites.length, 1)
  assert.equal(parsed.diagnostics.fakeWrites[0].applied, 'retry-fg-ok')
})

test('t26-1: post-write polling retries until readback matches (readbackDelayReads=2 -> polls>=3, invoked)', async () => {
  const { spawnSync } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'ag-t26-poll-'))
  const scenarioFile = join(dir, 'scenario.json')
  const scenario = fakeScenario()
  scenario.foregroundMode = 'match'
  scenario.keyboard = 'ok'
  scenario.readbackDelayReads = 2
  writeFileSync(scenarioFile, JSON.stringify(scenario), 'utf8')
  const driverPath = join(process.cwd(), 'lib', 'uia-driver.ps1')
  const reqJson = JSON.stringify({ action: 'dispatch', target: TARGET, message: 'poll-ok' })
  const run = spawnSync('pwsh', ['-NoProfile', '-File', driverPath], {
    input: reqJson,
    encoding: 'utf8',
    env: { ...process.env, AGUIA_FAKE_SCENARIO: scenarioFile },
  })
  assert.equal(run.status, 0, run.stderr)
  const parsed = JSON.parse(run.stdout.trim())
  assert.equal(parsed.ok, true, JSON.stringify(parsed))
  assert.equal(parsed.status, 'invoked', JSON.stringify({ status: parsed.status, reason: parsed.reason, code: parsed.code, detail: parsed.detail, diagnostics: parsed.diagnostics }))
  assert.equal(parsed.invokeCount, 1)
  assert.ok(parsed.diagnostics.readbackPolls >= 3, `expected >=3 polls, got ${parsed.diagnostics.readbackPolls}`)
})

test('t26-2: fresh scan retries once when first fresh scan sees stale composer value (freshStaleOnce=true)', async () => {
  const { spawnSync } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'ag-t26-fresh-'))
  const scenarioFile = join(dir, 'scenario.json')
  const scenario = fakeScenario()
  scenario.foregroundMode = 'match'
  scenario.keyboard = 'ok'
  scenario.freshStaleOnce = true
  writeFileSync(scenarioFile, JSON.stringify(scenario), 'utf8')
  const driverPath = join(process.cwd(), 'lib', 'uia-driver.ps1')
  const reqJson = JSON.stringify({ action: 'dispatch', target: TARGET, message: 'fresh-retry-ok' })
  const run = spawnSync('pwsh', ['-NoProfile', '-File', driverPath], {
    input: reqJson,
    encoding: 'utf8',
    env: { ...process.env, AGUIA_FAKE_SCENARIO: scenarioFile },
  })
  assert.equal(run.status, 0, run.stderr)
  const parsed = JSON.parse(run.stdout.trim())
  assert.equal(parsed.ok, true, JSON.stringify(parsed))
  assert.equal(parsed.status, 'invoked', JSON.stringify({ status: parsed.status, reason: parsed.reason, code: parsed.code, detail: parsed.detail, diagnostics: parsed.diagnostics }))
  assert.equal(parsed.invokeCount, 1)
  assert.equal(parsed.diagnostics.freshScanRetries, 1)
  assert.equal(parsed.diagnostics.fakeFreshScans, 2)
})

test('t26-3: readbackNever=true fails with readback_mismatch, 0 invokes, and restores composer empty', async () => {
  const { spawnSync } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'ag-t26-restore-'))
  const scenarioFile = join(dir, 'scenario.json')
  const scenario = fakeScenario()
  scenario.foregroundMode = 'match'
  scenario.readbackNever = true
  scenario.emptyBaseline = '\n'
  scenario.tree.children[2].children[0].value = '\n'
  writeFileSync(scenarioFile, JSON.stringify(scenario), 'utf8')
  const driverPath = join(process.cwd(), 'lib', 'uia-driver.ps1')
  const reqJson = JSON.stringify({ action: 'dispatch', target: TARGET, message: 'never-readback' })
  const run = spawnSync('pwsh', ['-NoProfile', '-File', driverPath], {
    input: reqJson,
    encoding: 'utf8',
    env: { ...process.env, AGUIA_FAKE_SCENARIO: scenarioFile },
  })
  assert.equal(run.status, 0, run.stderr)
  const parsed = JSON.parse(run.stdout.trim())
  assert.equal(parsed.status, 'not_sent')
  assert.equal(parsed.code, 'readback_mismatch')
  assert.equal(parsed.invokeCount, 0)
  assert.equal(parsed.diagnostics.fakeInvokes, 0)
  assert.equal(parsed.detail.composerRestored, true)
})

test('t26-4: focusMode=clickWorks falls back to clickFocus and succeeds; focusMode=noFocus refuses with foreground_unavailable and 0 writes', async () => {
  const { spawnSync } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'ag-t26-focus-'))
  const scenarioFile = join(dir, 'scenario.json')
  const driverPath = join(process.cwd(), 'lib', 'uia-driver.ps1')

  const scenarioClick = fakeScenario()
  scenarioClick.foregroundMode = 'match'
  scenarioClick.focusMode = 'clickWorks'
  scenarioClick.keyboard = 'ok'
  writeFileSync(scenarioFile, JSON.stringify(scenarioClick), 'utf8')
  const runClick = spawnSync('pwsh', ['-NoProfile', '-File', driverPath], {
    input: JSON.stringify({ action: 'dispatch', target: TARGET, message: 'click-focus-ok' }),
    encoding: 'utf8',
    env: { ...process.env, AGUIA_FAKE_SCENARIO: scenarioFile },
  })
  assert.equal(runClick.status, 0, runClick.stderr)
  const parsedClick = JSON.parse(runClick.stdout.trim())
  assert.equal(parsedClick.ok, true, JSON.stringify(parsedClick))
  assert.equal(parsedClick.status, 'invoked')
  assert.equal(parsedClick.diagnostics.fakeClickFocusCalls, 1)

  const scenarioNoFocus = fakeScenario()
  scenarioNoFocus.foregroundMode = 'match'
  scenarioNoFocus.focusMode = 'noFocus'
  scenarioNoFocus.keyboard = 'ok'
  writeFileSync(scenarioFile, JSON.stringify(scenarioNoFocus), 'utf8')
  const runNoFocus = spawnSync('pwsh', ['-NoProfile', '-File', driverPath], {
    input: JSON.stringify({ action: 'dispatch', target: TARGET, message: 'no-focus' }),
    encoding: 'utf8',
    env: { ...process.env, AGUIA_FAKE_SCENARIO: scenarioFile },
  })
  assert.equal(runNoFocus.status, 0, runNoFocus.stderr)
  const parsedNoFocus = JSON.parse(runNoFocus.stdout.trim())
  assert.equal(parsedNoFocus.status, 'not_sent')
  assert.equal(parsedNoFocus.code, 'foreground_unavailable')
  assert.equal(parsedNoFocus.invokeCount, 0)
  assert.equal(parsedNoFocus.diagnostics.fakeKeyCalls, 0)
  assert.equal(parsedNoFocus.diagnostics.fakeWrites.length, 0)
})

test('t27-1: attribution delivers reply after two consistent idle+complete frames even without observing busy', async () => {
  const { createBaseline, createTracker } = await import('../lib/desktop-attribution.js')
  const mapFrame = (turns, phase = 'idle', complete = true) => ({
    ...snapshot({ turns, phase }).snapshot,
    targetKey: 'tk-t27',
    complete,
  })
  const baseline = createBaseline(mapFrame(BASE_TURNS))
  const tracker = createTracker({ dispatchText: '请回复收到', baseline, jobId: 'job-t27-1' })
  const turnsWithReply = [...BASE_TURNS, { role: 'user', text: '请回复收到' }, { role: 'assistant', text: '收到' }]

  const first = tracker.observe(mapFrame(turnsWithReply))
  assert.equal(first.state, 'running')
  assert.equal(first.code, 'awaiting_final_state')

  const second = tracker.observe(mapFrame(turnsWithReply))
  assert.equal(second.state, 'replied')
  assert.equal(second.code, 'completed')
  assert.equal(second.reply, '收到')
  assert.equal(second.round.activity.observedRunning, false)
})

test('t27-2: baseline assistant text is never borrowed when no new assistant turn appears after matched user anchor', async () => {
  const { createBaseline, createTracker } = await import('../lib/desktop-attribution.js')
  const mapFrame = (turns, phase = 'idle', complete = true) => ({
    ...snapshot({ turns, phase }).snapshot,
    targetKey: 'tk-t27',
    complete,
  })
  const baseWithReply = [...BASE_TURNS, { role: 'user', text: 'old q' }, { role: 'assistant', text: '收到' }]
  const baseline = createBaseline(mapFrame(baseWithReply))
  const tracker = createTracker({ dispatchText: 'new q', baseline, jobId: 'job-t27-2' })
  const onlyUserAdded = [...baseWithReply, { role: 'user', text: 'new q' }]

  const first = tracker.observe(mapFrame(onlyUserAdded))
  assert.notEqual(first.state, 'replied')
  assert.equal(first.reply, null)

  const second = tracker.observe(mapFrame(onlyUserAdded))
  assert.equal(second.state, 'indeterminate')
  assert.equal(second.code, 'round_ended_without_reply')
  assert.equal(second.reply, null)
})

test('t27-3: added assistant turn without matching new user anchor is never delivered as replied', async () => {
  const { createBaseline, createTracker } = await import('../lib/desktop-attribution.js')
  const mapFrame = (turns, phase = 'idle', complete = true) => ({
    ...snapshot({ turns, phase }).snapshot,
    targetKey: 'tk-t27',
    complete,
  })
  const baseline = createBaseline(mapFrame(BASE_TURNS))
  const tracker = createTracker({ dispatchText: 'expected user prompt', baseline, jobId: 'job-t27-3' })
  const strayAssistant = [...BASE_TURNS, { role: 'assistant', text: '收到' }]

  const first = tracker.observe(mapFrame(strayAssistant))
  assert.notEqual(first.state, 'replied')
  assert.equal(first.code, 'awaiting_new_user_turn')
  assert.equal(first.reply, null)

  const noDelta = tracker.observe(mapFrame(BASE_TURNS))
  assert.notEqual(noDelta.state, 'replied')
  assert.equal(noDelta.code, 'awaiting_new_user_turn')
  assert.equal(noDelta.reply, null)
})

test('t27-4: without busy, two inconsistent idle+complete frames do not deliver until two consecutive frames match', async () => {
  const { createBaseline, createTracker } = await import('../lib/desktop-attribution.js')
  const mapFrame = (turns, phase = 'idle', complete = true) => ({
    ...snapshot({ turns, phase }).snapshot,
    targetKey: 'tk-t27',
    complete,
  })
  const baseline = createBaseline(mapFrame(BASE_TURNS))
  const tracker = createTracker({ dispatchText: 'q', baseline, jobId: 'job-t27-4' })

  const f1 = tracker.observe(mapFrame([...BASE_TURNS, { role: 'user', text: 'q' }, { role: 'assistant', text: 'partial' }]))
  assert.equal(f1.state, 'running')

  const f2 = tracker.observe(mapFrame([...BASE_TURNS, { role: 'user', text: 'q' }, { role: 'assistant', text: 'final' }]))
  assert.equal(f2.state, 'running')
  assert.equal(f2.round.idleConfirmations, 1)

  const f3 = tracker.observe(mapFrame([...BASE_TURNS, { role: 'user', text: 'q' }, { role: 'assistant', text: 'final' }]))
  assert.equal(f3.state, 'replied')
  assert.equal(f3.reply, 'final')
})

test('t28-1: cancelJob releases desktop lock on acceptance_unknown job and allows subsequent send on same window', async () => {
  const driver = scriptedDriver({
    inspects: [snapshot({ turns: BASE_TURNS }), snapshot({ turns: BASE_TURNS }), snapshot({ turns: BASE_TURNS })],
    dispatchResult: { ok: true, status: 'acceptance_unknown', reason: 'composer_not_cleared', code: 'composer_not_cleared' },
  })
  const { bridge, agent, dir, send } = makeBridge({ desktop: { target: TARGET, driver } })
  const job = send()
  await bridge.dispatch(job, { message: job.message, requested: job.requested })
  assert.equal(job.status, 'acceptance_unknown')
  assert.equal(bridge.state.locks[job.desktopLockKey], job.jobId)

  // While locked, another send on the same window is refused as busy.
  const blocked = bridge.beginSend({ agentId: agent.id, transport: 'desktop', message: 'next', requested: { pathRefs: [] } })
  assert.equal(blocked.error?.code, 'busy')

  const outcome = await bridge.cancelJob(job)
  assert.equal(outcome.released, true)
  assert.equal(outcome.cancelSent, false)
  assert.equal(job.status, 'cancelled')
  assert.equal(job.code, 'desktop_released_by_user')
  assert.equal(bridge.state.locks[job.desktopLockKey], undefined)

  // Same window can send again immediately after release.
  const nextBegun = bridge.beginSend({ agentId: agent.id, transport: 'desktop', message: 'next', requested: { pathRefs: [] } })
  assert.equal(nextBegun.error, undefined)
  assert.ok(nextBegun.job?.jobId)
  bridge.dispose()
})

test('t28-2: active desktop job still stops observation via cancel without taking offline release path', async () => {
  const gate = deferred()
  const driver = scriptedDriver({
    inspects: [snapshot({ turns: BASE_TURNS }), snapshot({ turns: BASE_TURNS }), () => gate.promise],
  })
  const { bridge, send } = makeBridge({ desktop: { target: TARGET, driver, replyTimeoutMs: 5000 } })
  const job = send()
  await bridge.dispatch(job, { message: job.message, requested: job.requested })
  assert.ok(bridge.activePrompts.has(job.jobId))

  const outcome = await bridge.cancelJob(job, { timeoutMs: 200 })
  assert.equal(outcome.released, undefined)
  assert.equal(outcome.stopControl, 'unavailable')
  gate.resolve(snapshot({ turns: BASE_TURNS }))
  await bridge.activePrompts.get(job.jobId)?.promise.catch(() => {})
  bridge.dispose()
})

test('t28-3: ACP cancelJob behavior and error codes remain completely unchanged', async () => {
  let cancelCalls = 0
  const backend = fakeAcpBackend()
  backend.cancelSession = () => { cancelCalls += 1 }
  const { bridge, agent, dir } = makeBridge({ backend, desktop: { enabled: false, target: TARGET } })

  const begun = bridge.beginSend({ agentId: agent.id, transport: 'acp', workspaceRoot: dir, message: 'hi', requested: {} })
  const job = begun.job
  // No active ACP prompt -> still not_cancellable
  const noPrompt = await bridge.cancelJob(job)
  assert.equal(noPrompt.error?.code, 'not_cancellable')
  assert.equal(noPrompt.released, undefined)

  // Active ACP prompt -> sends session/cancel
  const gate = deferred()
  bridge.activePrompts.set(job.jobId, { promise: gate.promise, sessionId: 'acp-1', transport: 'acp' })
  job.conversationId = 'acp-1'
  const activeCancel = await bridge.cancelJob(job, { timeoutMs: 120 })
  assert.equal(activeCancel.cancelSent, true)
  assert.equal(cancelCalls, 1)
  gate.resolve()
  bridge.dispose()
})

test('t28-4: antigravity_cancel tool receipt includes release risk copy and job.detail.releaseNote', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-t28-tool-'))
  const stateFile = join(dir, 'state.json')
  const target = { pid: 500, startedAt: '2026-11-24T00:00:00.000Z', hwnd: '0x500', uri: 'https://a.local/s1' }
  const fakeDriver = {
    async run(req) {
      if (req.action === 'inspect') {
        return {
          ok: true,
          targetKey: 'aguia1:500',
          verified: { process: true, startTime: true, executable: true, window: true, documentUri: true, sessionLink: 'unique' },
          snapshot: {
            observedAt: new Date().toISOString(),
            phase: 'idle',
            evidence: { stopControl: false, permissionCard: false },
            history: { complete: true, turns: [] },
            unreadable: [],
          },
        }
      }
      if (req.action === 'dispatch') {
        return { ok: true, status: 'acceptance_unknown', reason: 'composer_not_cleared', code: 'composer_not_cleared' }
      }
      throw new Error(`unexpected action ${req.action}`)
    },
  }
  const tools = new Map()
  const cleanups = []
  const { apply } = await import('../lib/index.js')
  apply(
    {
      tools: { register: (def) => { tools.set(def.name, def); return () => {} } },
      effect: (fn) => { const d = fn(); if (typeof d === 'function') cleanups.push(d); return () => {} },
      get: () => undefined,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, trace: () => {} },
      on: () => () => {},
      reflect: { provide: () => {}, get: () => undefined },
      root: {},
    },
    { stateFile, cwd: dir, modelProvider: false, desktop: { enabled: true, target, driver: fakeDriver, pollMs: 100 } },
  )
  try {
    const sendTool = tools.get('antigravity_send')
    const cancelTool = tools.get('antigravity_cancel')
    const exec = { agent: { id: 'agent-t28-4' } }
    const sent = await sendTool.execute({ message: 'hi', transport: 'desktop', wait: false }, exec)
    assert.equal(sent.status, 'acceptance_unknown')
    const cancelled = await cancelTool.execute({ job_id: sent.jobId }, exec)
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(cancelled.code, 'desktop_released_by_user')
    assert.ok(cancelled.markdown.includes('只解除桥侧占用，不代表应用侧没收到该轮，请人工确认'))
  } finally {
    for (const fn of cleanups.reverse()) fn()
  }
})
