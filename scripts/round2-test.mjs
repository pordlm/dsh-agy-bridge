import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, statSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { AgyAcpAdapter, AcpStdioTransport, planRequest } from '../lib/model-adapter.js'
import { PROVIDER_ID } from '../lib/model-catalog.js'
import { apply } from '../lib/index.js'

const temp = mkdtempSync(path.join(tmpdir(), 'agy-native-tests-'))
const models = ['neon', 'argon', 'hydrogen', 'o-neon', 'o-argon', 'flash', 'opus', 'sonnet', 'oss']
class Transport {
  constructor({ restore = 'resume', system = true, fail = false, replay = false, closeError = null, resumeError = null, stopReason = 'end_turn', sessionIdStart = 1 } = {}) {
    Object.assign(this, { restore, system, fail, replay, closeError, resumeError, stopReason })
    this.requests = []; this.handlers = []; this.state = {}; this.nextSession = sessionIdStart
    // Like AcpStdioTransport: a fresh connection is not closed.
    this.closed = false
    // Peak listener counts observed since construction: the adapter must not
    // accumulate per-turn handlers on one shared connection.
    this.peak = { notifications: 0, requests: 0 }
  }
  start() {}
  close() {
    // Simulates a cleanup step that throws (transport already gone, EPIPE, …).
    if (this.closeError) throw this.closeError
    this.closed = true
  }
  onNotification(fn) {
    this.handlers.push(fn)
    this.peak.notifications = Math.max(this.peak.notifications, this.handlers.length)
    return () => { const i = this.handlers.indexOf(fn); if (i >= 0) this.handlers.splice(i, 1) }
  }
  onRequest(fn) {
    this.requestHandler = fn
    this.peak.requests = Math.max(this.peak.requests, 1)
    return () => { this.requestHandler = null }
  }
  listenerCounts() { return { notifications: this.handlers.length, requests: this.requestHandler ? 1 : 0 } }
  notify() {}
  emit(sessionId, text) { this.handlers.forEach((fn) => fn({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } })) }
  options(id) { const s = this.state[id]; return [{ id: 'choose-model', category: 'model', type: 'select', currentValue: s.model, options: [{ group: 'all', options: models.map((value) => ({ value, name: value })) }] }, { id: 'reason', category: 'thought_level', type: 'select', currentValue: s.effort, options: (s.model === 'oss' ? ['medium'] : ['low', 'high']).map((value) => ({ value, name: value })) }] }
  async request(method, params, options) {
    this.requests.push({ method, params })
    if (method === 'initialize') return { agentCapabilities: { ...(this.restore === 'load' ? { loadSession: true } : {}), sessionCapabilities: { ...(this.restore === 'resume' ? { resume: {} } : {}), ...(this.system ? { systemPrompt: {} } : {}) } } }
    if (method === 'session/new') { const sessionId = `session-${this.nextSession++}`; this.state[sessionId] = { model: 'neon', effort: 'high' }; return { sessionId, configOptions: this.options(sessionId) } }
    if (method === 'session/resume' || method === 'session/load') {
      if (this.resumeError) throw this.resumeError
      this.state[params.sessionId] ??= { model: 'neon', effort: 'high' }; if (this.replay) this.emit(params.sessionId, 'OLD REPLAY'); return { configOptions: this.options(params.sessionId) }
    }
    if (method === 'session/set_config_option') { const s = this.state[params.sessionId]; if (params.configId === 'choose-model') { s.model = params.value; if (s.model === 'oss') s.effort = 'medium' } else s.effort = params.value; return { configOptions: this.options(params.sessionId) } }
    if (method === 'session/prompt') { if (this.fail) throw Object.assign(Error('connection lost'), { code: 'ACP_CLOSED' }); this.emit(params.sessionId, 'answer'); options?.onResponse?.(); return { stopReason: this.stopReason } }
    throw Error(`unexpected ${method}`)
  }
}
const user = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }] })
const assistant = (id, text = 'answer') => ({ id, role: 'assistant', content: [{ type: 'text', text }] })
const request = (messages, extra = {}) => ({ provider: PROVIDER_ID, model: 'neon', sessionId: 'dsh-1', messages, ...extra })
async function collect(adapter, options) { const chunks = []; for await (const chunk of adapter.stream(options)) chunks.push(chunk); return chunks }
const prompts = (t) => t.requests.filter((r) => r.method === 'session/prompt')

if (!process.argv.includes('--live')) {
  test('dynamic grouped catalog, per-model efforts, no metadata prompt, single-flight', async () => {
    const t = new Transport(); const a = new AgyAcpAdapter({ cwd: temp, transport: () => t })
    const [list, again] = await Promise.all([a.listModels(), a.listModels()]); assert.equal(list.length, 9); assert.deepEqual(list, again)
    assert.equal(t.requests.filter((r) => r.method === 'initialize').length, 1); assert.equal(prompts(t).length, 0)
    assert.deepEqual((await a.resolveModel(PROVIDER_ID, 'oss')).reasoning.efforts.map((e) => e.id), ['medium'])
    assert.deepEqual((await a.resolveModel(PROVIDER_ID, 'neon')).reasoning.efforts.map((e) => e.id), ['low', 'high'])
    assert.equal((await a.resolveModel(PROVIDER_ID, 'neon')).reasoning.defaultEffort, undefined); a.dispose()
  })
  test('two incremental turns, stable ledger, exact system append, baseline restores after explicit low', async () => {
    const t = new Transport(); const file = path.join(temp, 'native.json'); const a = new AgyAcpAdapter({ cwd: temp, nativeStateFile: file, transport: () => t })
    const messages = [{ role: 'system', content: 'system rules' }, user('u1', 'first')]
    await collect(a, request(messages, { reasoningEffort: 'low' }))
    assert.equal(t.requests.find((r) => r.method === 'session/new').params.systemPrompt.content[0].text, 'system rules')
    const next = [...messages, assistant('a1'), user('u2', 'second')]; await collect(a, request(next))
    assert.equal(prompts(t).length, 2); assert.equal(prompts(t)[0].params.sessionId, prompts(t)[1].params.sessionId)
    assert.deepEqual(prompts(t).map((r) => r.params.prompt[0].text), ['first', 'second']); assert.equal(t.state['session-1'].effort, 'high')
    const ledger = JSON.parse(readFileSync(file)); assert.equal(ledger.sessions['dsh-1'].inFlight, null); assert.equal(ledger.sessions['dsh-1'].history.at(-1).id, 'u2')
    const beforeReplayPrompts = prompts(t).length
    await assert.rejects(() => collect(a, request(next)), { code: 'AGY_ACP_HISTORY_REPLAYED' })
    assert.equal(prompts(t).length, beforeReplayPrompts, 'replay of committed history must not dispatch a prompt')
    const rebaselined = await collect(a, request([...next, assistant('a2', 'edited'), user('u3', 'third')]))
    assert.equal(rebaselined.at(-1).reason.kind, 'stop')
    assert.equal(prompts(t).length, beforeReplayPrompts + 1, 'edited assistant with new trailing user must auto-rebaseline')
    assert.equal(prompts(t).at(-1).params.prompt[0].text, 'third', 'rebaseline must only send trailing user')
    assert.equal(a.getNativeActivity('dsh-1').rebaselines.length, 1)
    assert.equal(a.getNativeActivity('dsh-1').rebaselines[0].reason, 'AGY_ACP_HISTORY_HASH_MISMATCH')
    assert.equal(a.getDiagnostics('dsh-1').length, 1)
    a.dispose()
  })
  test('restart capability gates resume/load; load replay excluded; unknown restore never new/prompt', async () => {
    for (const restore of ['resume', 'load', 'none']) {
      const file = path.join(temp, `${restore}.json`); const first = new Transport(); const a = new AgyAcpAdapter({ cwd: temp, nativeStateFile: file, transport: () => first }); await collect(a, request([user('u1', 'first')])); a.dispose()
      const t = new Transport({ restore, replay: true }); const b = new AgyAcpAdapter({ cwd: temp, nativeStateFile: file, transport: () => t })
      if (restore === 'none') { await assert.rejects(() => collect(b, request([user('u1', 'first'), assistant('a1'), user('u2', 'next')])), { code: 'AGY_ACP_SESSION_RESTORE_UNSUPPORTED' }); assert.equal(prompts(t).length, 0); assert.equal(t.requests.some((r) => r.method === 'session/new'), false) }
      else { const result = await collect(b, request([user('u1', 'first'), assistant('a1'), user('u2', 'next')])); assert.equal(t.requests[1].method, `session/${restore}`); assert.equal(result.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'answer') }
      b.dispose()
    }
  })
  test('unavailable effort detailed zero-prompt; unsupported inputs, unknown prefix and workspace changes fail closed', async () => {
    const t = new Transport(); const a = new AgyAcpAdapter({ cwd: temp, transport: () => t })
    await assert.rejects(() => collect(a, request([user('u1', 'x')], { reasoningEffort: 'medium' })), (e) => /provider=.*model=neon requested effort=medium available efforts=\[low, high\]/.test(e.message)); assert.equal(prompts(t).length, 0)
    assert.throws(() => planRequest(request([user('u1', 'x')], { tools: [{ name: 'claim_task' }] })))
    assert.doesNotThrow(() => planRequest(request([user('u1', 'x')], { tools: [{ name: 'read' }] })))
    assert.throws(() => planRequest(request([{ role: 'user', content: [{ type: 'image', source: {} }] }])))
    assert.throws(() => planRequest(request([{ role: 'developer', content: 'x' }, user('u1', 'x')])))
    await assert.rejects(() => collect(a, request([user('u1', 'x'), assistant('a1'), user('u2', 'x')])), { code: 'AGY_ACP_BINDING_UNKNOWN' })
    await collect(a, request([user('u1', 'x')])); a.config.resolveWorkspace = () => process.cwd()
    await assert.rejects(() => collect(a, request([user('u1', 'x'), assistant('a1'), user('u2', 'x')])), { code: 'AGY_ACP_WORKSPACE_MISMATCH' }); a.dispose()
  })
  test('older config update before setter response cannot override final complete readback', async () => {
    const t = new Transport(); const original = t.request.bind(t)
    t.request = async (method, params, options) => {
      if (method === 'session/set_config_option' && params.configId === 'reason') {
        const old = t.options(params.sessionId)
        t.handlers.forEach((fn) => fn({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'config_option_update', configOptions: old } } }))
      }
      return original(method, params, options)
    }
    const a = new AgyAcpAdapter({ cwd: temp, transport: () => t }); const result = await collect(a, request([user('u1', 'x')], { reasoningEffort: 'low' }))
    assert.equal(prompts(t).length, 1); assert.equal(result.at(-1).reason.kind, 'stop'); assert.equal(t.state['session-1'].effort, 'low'); a.dispose()
  })
  // Renamed: the old title also claimed "system mutation guards", but nothing
  // here exercises AGY_ACP_SYSTEM_CHANGED (that guard lives in test 2's prefix
  // checks). The title now states exactly what this case asserts.
  test('durable pending precedes prompt; connection loss leaves acceptance_unknown, never resends, and stable ids are required', async () => {
    const file = path.join(temp, 'unknown.json'); const t = new Transport({ fail: true, system: false }); const original = t.request.bind(t)
    t.request = async (method, params, options) => { if (method === 'session/prompt') assert.equal(JSON.parse(readFileSync(file)).sessions['dsh-1'].inFlight.status, 'pending'); return original(method, params, options) }
    const a = new AgyAcpAdapter({ cwd: temp, nativeStateFile: file, transport: () => t }); await collect(a, request([user('u1', 'x')]))
    assert.equal(JSON.parse(readFileSync(file)).sessions['dsh-1'].inFlight.status, 'acceptance_unknown'); await assert.rejects(() => collect(a, request([user('u1', 'x')])), { code: 'AGY_ACP_ACCEPTANCE_UNKNOWN' }); assert.equal(prompts(t).length, 1); a.dispose()
    const clean = new AgyAcpAdapter({ cwd: temp, transport: () => new Transport() }); await assert.rejects(() => collect(clean, request([user('', 'x')])), { code: 'AGY_ACP_MESSAGE_ID_REQUIRED' }); clean.dispose()
  })

  // Finding 1 (Neon C3): a closed connection must be evicted, so the same DSH
  // key is served again on a *new* connection instead of answering
  // AGY_ACP_EXITED forever. The turn is re-established transparently: no prompt
  // goes to the dead transport, and the resent user message is exactly once.
  test('a dead connection is evicted: session A disconnects and the same key is re-established on a fresh connection', async () => {
    const transports = []
    const file = path.join(temp, 'dead.json')
    const adapter = new AgyAcpAdapter({ cwd: temp, nativeStateFile: file, transport: () => { const t = new Transport(); transports.push(t); return t } })
    await collect(adapter, request([user('u1', 'first')]))
    assert.equal(transports.length, 1); assert.equal(adapter.liveSessions.size, 1)
    // The CLI process died: the transport reports itself closed.
    transports[0].closed = true
    // Same history as the completed turn: the next user message is a new turn.
    const next = [user('u1', 'first'), assistant('a1'), user('u2', 'second')]
    const chunks = await collect(adapter, request(next))
    // The dead connection never carried the new prompt …
    assert.equal(prompts(transports[0]).length, 1, 'the dead transport must not receive a second prompt')
    // … and a brand-new connection restored the same ACP session and prompted.
    assert.equal(transports.length, 2)
    assert.deepEqual(transports[1].requests.map((r) => r.method), ['initialize', 'session/resume', 'session/set_config_option', 'session/set_config_option', 'session/prompt'])
    assert.equal(transports[1].requests[1].params.sessionId, 'session-1')
    assert.equal(prompts(transports[1]).length, 1)
    assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'answer')
    assert.equal(JSON.parse(readFileSync(file)).sessions['dsh-1'].inFlight, null)
    adapter.dispose()
  })

  // A transport that only exposes `isClosed` must be evicted the same way, and
  // isClosed is consulted before the dead connection receives anything.
  test('isClosed transports are evicted too, and repeated turns keep one pair of listeners', async () => {
    const transports = []
    let closed = false
    const adapter = new AgyAcpAdapter({ cwd: temp, transport: () => { const t = new Transport(); Object.defineProperty(t, 'isClosed', { get: () => closed }); transports.push(t); return t } })
    const history = [user('u1', 'first')]
    await collect(adapter, request(history))
    assert.deepEqual(transports[0].listenerCounts(), { notifications: 0, requests: 0 })
    history.push(assistant('a1'), user('u2', 'second'))
    await collect(adapter, request(history))
    assert.deepEqual(transports[0].listenerCounts(), { notifications: 0, requests: 0 }, 'per-turn handlers must not accumulate on a shared connection')
    assert.equal(adapter.liveSessions.size, 1, 'the live connection is reused, not recreated')
    assert.equal(transports.length, 1)
    closed = true
    history.push(assistant('a2'), user('u3', 'third'))
    const chunks = await collect(adapter, request(history))
    assert.equal(prompts(transports[0]).length, 2, 'the closed transport must not receive the third prompt')
    assert.equal(transports.length, 2)
    assert.equal(transports[1].requests[1].method, 'session/resume')
    assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'answer')
    adapter.dispose()
  })

  // Finding 2 (Neon C4): listeners registered per turn are removed when the
  // turn ends, both on success and on failure. Baseline = zero listeners while
  // no turn is running (every turn detaches its own pair in `finally`).
  test('listener counts return to the zero baseline after N turns and after a failed turn', async () => {
    const t = new Transport()
    const adapter = new AgyAcpAdapter({ cwd: temp, transport: () => t })
    assert.deepEqual(t.listenerCounts(), { notifications: 0, requests: 0 }, 'baseline before any turn')
    const history = [user('u1', 'turn-0')]
    await collect(adapter, request(history))
    assert.deepEqual(t.listenerCounts(), { notifications: 0, requests: 0 }, 'after turn 0')
    for (let i = 1; i <= 5; i += 1) {
      history.push(assistant(`a${i}`, 'answer'), user(`u${i + 1}`, `turn-${i}`))
      await collect(adapter, request(history))
      assert.deepEqual(t.listenerCounts(), { notifications: 0, requests: 0 }, `after turn ${i}`)
    }
    assert.equal(t.peak.notifications, 1, 'no turn ever stacked a second notification handler')
    adapter.dispose()

    const failing = new Transport({ fail: true })
    const broken = new AgyAcpAdapter({ cwd: temp, transport: () => failing })
    const result = await collect(broken, request([user('u1', 'x')]))
    assert.equal(result.at(-1).reason.kind, 'error')
    assert.deepEqual(failing.listenerCounts(), { notifications: 0, requests: 0 }, 'a failed turn must detach its handlers')
    broken.dispose()
  })

  // The same guarantee across *connections*: N create/dispose cycles must not
  // leave handlers behind on any of them.
  test('N create/dispose cycles leave every transport at the zero listener baseline', async () => {
    const transports = []
    for (let i = 0; i < 8; i += 1) {
      const t = new Transport()
      transports.push(t)
      const adapter = new AgyAcpAdapter({ cwd: temp, transport: () => t })
      await collect(adapter, request([user('u1', `cycle-${i}`)]))
      assert.deepEqual(t.listenerCounts(), { notifications: 0, requests: 0 }, `cycle ${i}`)
      adapter.dispose()
      assert.equal(t.closed, true, `cycle ${i} must close its transport`)
    }
    assert.equal(transports.length, 8)
    assert.equal(transports.reduce((sum, t) => sum + t.peak.notifications, 0), 8, 'exactly one handler per connection')
  })

  // Finding 3 (Neon C9): the cleanup path must never turn a finished turn into
  // a rejection nor leave the key busy. Double fault: prompt throws AND
  // transport.close() throws.
  test('prompt failure plus throwing cleanup still unlocks the key and stays retryable', async () => {
    const saved = []
    const t = new Transport({ fail: true, closeError: Object.assign(Error('close exploded'), { code: 'EPIPE' }) })
    const adapter = new AgyAcpAdapter({
      cwd: temp,
      nativeStateFile: path.join(temp, 'dbl.json'),
      transport: () => t,
      onCleanupError: (entry) => saved.push({ step: entry.step, message: String(entry.error?.message ?? entry.error) }),
    })
    const result = await collect(adapter, request([user('u1', 'x')]))
    assert.equal(result.at(-1).reason.kind, 'error')
    assert.equal(result.at(-1).reason.failure.code, 'ACP_CLOSED')
    // The cleanup failure is reported, not swallowed …
    assert.ok(saved.length >= 1, `cleanup failures must be reported: ${JSON.stringify(saved)}`)
    assert.ok(saved.some((entry) => entry.step === '关闭 ACP 连接'), JSON.stringify(saved))
    // … and the key is unlocked for the next turn (never a permanent BUSY).
    await assert.rejects(() => collect(adapter, request([user('u1', 'x')])), { code: 'AGY_ACP_ACCEPTANCE_UNKNOWN' })
    adapter.dispose()
  })

  test('a throwing ledger save during cleanup degrades to acceptance_unknown without blocking the unlock', async () => {
    const t = new Transport({ fail: true })
    const adapter = new AgyAcpAdapter({ cwd: temp, nativeStateFile: path.join(temp, 'nostate'), transport: () => t })
    const save = adapter.saveNativeState.bind(adapter)
    // The pre-prompt save must succeed; only the save issued from the cleanup
    // path (after the prompt failed) is made to throw.
    let armed = false
    adapter.saveNativeState = () => {
      if (armed) throw Object.assign(Error('state file is read-only'), { code: 'AGY_ACP_STATE_WRITE_FAILED' })
      return save()
    }
    const original = t.request.bind(t)
    t.request = async (method, params, options) => {
      if (method === 'session/prompt') {
        // The durable pending record must already be on disk before the prompt
        // is written, and this is the last successful save of the turn.
        assert.equal(JSON.parse(readFileSync(path.join(temp, 'nostate'))).sessions['dsh-1'].inFlight.status, 'pending')
        armed = true
      }
      return original(method, params, options)
    }
    const result = await collect(adapter, request([user('u1', 'x')]))
    assert.equal(result.at(-1).reason.kind, 'error')
    // The disk copy stays 'pending' because the cleanup save failed …
    assert.equal(JSON.parse(readFileSync(path.join(temp, 'nostate'))).sessions['dsh-1'].inFlight.status, 'pending')
    // … but the in-memory ledger is degraded to a retryable unknown state and
    // the turn is unlocked, so the next attempt is refused for the right reason
    // instead of a permanent AGY_ACP_SESSION_BUSY.
    assert.equal(adapter.nativeSessions['dsh-1'].inFlight.status, 'acceptance_unknown')
    assert.equal(adapter.activeSessions.size, 0, 'the key must be released even when the save failed')
    await assert.rejects(() => collect(adapter, request([user('u1', 'x')])), { code: 'AGY_ACP_ACCEPTANCE_UNKNOWN' })
    adapter.dispose()
  })

  // Finding 4 (Neon C7): restore failures keep their real reason.
  test('resume errors keep their reason: unsupported, restore_failed, unknown_session', async () => {
    const seed = async (name) => {
      const file = path.join(temp, `${name}.json`)
      const first = new Transport()
      const a = new AgyAcpAdapter({ cwd: temp, nativeStateFile: file, transport: () => first })
      await collect(a, request([user('u1', 'first')]))
      a.dispose()
      return file
    }
    const next = [user('u1', 'first'), assistant('a1'), user('u2', 'next')]

    const unsupportedFile = await seed('unsupported')
    const unsupported = new Transport({ resumeError: Object.assign(Error('rpc -32601: Method not found: session/resume'), { code: 'AGY_ACP_UNKNOWN_METHOD' }) })
    const a1 = new AgyAcpAdapter({ cwd: temp, nativeStateFile: unsupportedFile, transport: () => unsupported })
    await assert.rejects(() => collect(a1, request(next)), (error) => error.code === 'AGY_ACP_SESSION_RESTORE_UNSUPPORTED' && /不支持/.test(error.message))
    assert.equal(prompts(unsupported).length, 0)
    assert.equal(unsupported.requests.some((r) => r.method === 'session/new'), false)
    a1.dispose()

    const failedFile = await seed('failed')
    const failed = new Transport({ resumeError: Object.assign(Error('connection reset by peer'), { code: 'ACP_CLOSED' }) })
    const a2 = new AgyAcpAdapter({ cwd: temp, nativeStateFile: failedFile, transport: () => failed })
    await assert.rejects(() => collect(a2, request(next)), (error) => error.code === 'AGY_ACP_SESSION_RESTORE_FAILED' && /connection reset by peer/.test(error.message))
    assert.equal(prompts(failed).length, 0)
    a2.dispose()

    const missingFile = await seed('missing')
    const missing = new Transport({ resumeError: Object.assign(Error('Unknown session: session-1'), { rpcCode: -32602 }) })
    const a3 = new AgyAcpAdapter({ cwd: temp, nativeStateFile: missingFile, transport: () => missing })
    await assert.rejects(() => collect(a3, request(next)), (error) => error.code === 'AGY_ACP_SESSION_NOT_FOUND' && /已不存在/.test(error.message))
    assert.equal(prompts(missing).length, 0)
    a3.dispose()
  })

  // Finding 5 (Neon C2 / D2, "needs measurement"): an aborted turn must not
  // poison the binding. Expected behaviour with a real CLI is that the next
  // turn is refused before dispatch, because this adapter's ledger records the
  // assistant text it actually received and an aborted turn yields none. The
  // refusal must be a pre-prompt error (no resend, no replay), and the ledger
  // must not keep the turn pending — a fresh session is the recovery path.
  test('a cancelled turn marks dirty, closes transport, and allows next turn to re-baseline with only trailing user', async () => {
    const file = path.join(temp, 'cancelled.json')
    const t = new Transport({ stopReason: 'cancelled' })
    const adapter = new AgyAcpAdapter({ cwd: temp, nativeStateFile: file, transport: () => t })
    const first = await collect(adapter, request([user('u1', 'please stop')]))
    assert.equal(first.at(-1).reason.kind, 'aborted')
    const afterAbort = JSON.parse(readFileSync(file)).sessions['dsh-1']
    assert.equal(afterAbort.inFlight, null, 'an aborted turn must not stay pending')
    assert.equal(afterAbort.dirty, true, 'a cancelled turn must mark dirty=true')
    assert.equal(adapter.nativeSessions['dsh-1'].dirty, true)
    assert.equal(afterAbort.lastResult.stopReason, 'cancelled')
    assert.equal(adapter.activeSessions.size, 0, 'the key must be released after an aborted turn')
    assert.equal(t.closed, true, 'old transport must be closed after cancel')
    assert.equal(adapter.liveSessions.has('dsh-1'), false, 'old live transport must be evicted after cancel')

    // Next turn under dirty state: can dispatch and sends only trailing user segment (no replay of old user/assistant).
    t.stopReason = 'end_turn'
    t.closed = false
    const nextTurn = [user('u1', 'please stop'), assistant('a1', ''), user('u2', 'second')]
    const second = await collect(adapter, request(nextTurn))
    assert.equal(second.at(-1).reason.kind, 'stop')
    assert.equal(prompts(t).length, 2, 'dirty recovery turn must dispatch')
    assert.equal(prompts(t)[1].params.prompt[0].text, 'second', 'dirty turn must only send trailing user segment')
    assert.equal(prompts(t)[1].params.prompt[0].text.includes('please stop'), false)
    assert.equal(adapter.nativeSessions['dsh-1'].dirty, false, 'dirty must clear after successful turn')

    // A fresh DSH session is unaffected: the adapter is not globally poisoned.
    const fresh = await collect(adapter, request([user('u9', 'fresh start')], { sessionId: 'dsh-2' }))
    assert.equal(fresh.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'answer')
    adapter.dispose()
  })

  test('a cancelled turn whose ledger text matches DSH history lets the next turn run', async () => {
    // If the CLI had already streamed text before the cancel, the ledger keeps
    // that text and the binding stays usable for the next turn.
    const file = path.join(temp, 'cancelled-text.json')
    class TextThenCancel extends Transport {
      async request(method, params, options) {
        if (method !== 'session/prompt') return super.request(method, params, options)
        // First turn: the CLI streamed a partial answer and then the prompt was
        // cancelled. Later turns answer normally, so the binding can be proven
        // usable after the aborted one.
        this.requests.push({ method, params })
        if (this.cancelled) { this.emit(params.sessionId, 'answer'); options?.onResponse?.(); return { stopReason: 'end_turn' } }
        this.cancelled = true
        this.emit(params.sessionId, 'partial answer')
        options?.onResponse?.()
        return { stopReason: 'cancelled' }
      }
    }
    const t = new TextThenCancel()
    const adapter = new AgyAcpAdapter({ cwd: temp, nativeStateFile: file, transport: () => t })
    const first = await collect(adapter, request([user('u1', 'go')]))
    assert.equal(first.at(-1).reason.kind, 'aborted')
    assert.equal(first.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'partial answer')
    const history = [user('u1', 'go'), assistant('a1', 'partial answer'), user('u2', 'continue')]
    const second = await collect(adapter, request(history))
    assert.equal(second.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'answer')
    assert.equal(prompts(t).length, 2)
    const ledger = JSON.parse(readFileSync(file)).sessions['dsh-1']
    assert.equal(ledger.inFlight, null); assert.equal(ledger.lastResult.stopReason, 'end_turn')
    adapter.dispose()
  })
  test('concurrent stream on the same sessionId rejects with AGY_ACP_SESSION_BUSY', async () => {
    let releasePrompt
    let enteredPrompt
    const promptEntered = new Promise((resolve) => { enteredPrompt = resolve })
    class BlockingTransport extends Transport {
      async request(method, params, options) {
        if (method === 'session/prompt') {
          this.requests.push({ method, params })
          enteredPrompt()
          await new Promise((resolve) => { releasePrompt = resolve })
          this.emit(params.sessionId, 'first answer')
          options?.onResponse?.()
          return { stopReason: 'end_turn' }
        }
        return super.request(method, params, options)
      }
    }
    const t = new BlockingTransport()
    const adapter = new AgyAcpAdapter({ cwd: temp, transport: () => t })
    const firstTurn = collect(adapter, request([user('u1', 'first')]))
    await promptEntered
    await assert.rejects(
      () => collect(adapter, request([user('u2', 'second')])),
      (err) => err.code === 'AGY_ACP_SESSION_BUSY' && /同一 DSH 会话已有原生请求/.test(err.message),
    )
    releasePrompt()
    const firstChunks = await firstTurn
    assert.equal(firstChunks.at(-1).reason.kind, 'stop')
    adapter.dispose()
  })

  test('t31-a: AGY_ACP_SYSTEM_CHANGED with trailing user triggers atomic rebaseline and sends only trailing user', async () => {
    const transports = []
    const toolEventPayloads = []
    const stateFile = path.join(temp, 't31-a-sessions.json')
    let seq = 0
    const adapter = new AgyAcpAdapter({
      cwd: temp,
      nativeStateFile: stateFile,
      onToolEvents: (payload) => toolEventPayloads.push(payload),
      transport: () => {
        const t = new Transport({ sessionIdStart: ++seq })
        transports.push(t)
        return t
      },
    })
    const sys = (text) => ({ role: 'system', content: [{ type: 'text', text }] })
    const c1 = await collect(adapter, request([sys('sys-v1'), user('u1', 'earlier secret')]))
    assert.equal(c1.at(-1).reason.kind, 'stop')
    assert.equal(transports.length, 1)
    const oldAcpSessionId = adapter.nativeSessions['dsh-1'].acpSessionId

    const c2 = await collect(
      adapter,
      request([sys('sys-v2'), user('u1', 'earlier secret'), assistant('a1', 'answer'), user('u2', 'only-this-user')]),
    )
    assert.equal(c2.at(-1).reason.kind, 'stop')
    assert.equal(transports[0].closed, true, 'old transport must be closed on SYSTEM_CHANGED rebaseline')
    assert.equal(transports.length, 2, 'must open a fresh transport/session')
    const newPrompts = prompts(transports[1])
    assert.equal(newPrompts.length, 1)
    assert.equal(newPrompts[0].params.prompt[0].text, 'only-this-user')
    assert.ok(!newPrompts[0].params.prompt[0].text.includes('earlier secret'))
    const act = adapter.getNativeActivity('dsh-1')
    assert.ok(Array.isArray(act.rebaselines) && act.rebaselines.length === 1)
    assert.equal(act.rebaselines[0].reason, 'AGY_ACP_SYSTEM_CHANGED')
    assert.equal(act.rebaselines[0].oldAcpSessionId, oldAcpSessionId)
    assert.equal(act.rebaselines[0].newAcpSessionId, 'session-2')
    assert.notEqual(act.rebaselines[0].newAcpSessionId, oldAcpSessionId)
    assert.equal(adapter.liveSessions.get('dsh-1').transport, transports[1])
    assert.equal(act.rebaselines[0].promptChars, 'only-this-user'.length)
    assert.equal(toolEventPayloads.at(-1)?.diagnostics?.rebaseline?.reason, 'AGY_ACP_SYSTEM_CHANGED')
    adapter.dispose()
  })

  test('t31-b: AGY_ACP_SYSTEM_CHANGED with non-user tail (tool-reply) still hard-rejects with 0 session/new & 0 prompt and keeps binding', async () => {
    const transports = []
    const stateFile = path.join(temp, 't31-b-sessions.json')
    const adapter = new AgyAcpAdapter({
      cwd: temp,
      acpToolBridge: true,
      nativeStateFile: stateFile,
      transport: () => {
        const t = new Transport()
        transports.push(t)
        return t
      },
    })
    const sys = (text) => ({ role: 'system', content: [{ type: 'text', text }] })
    const claimTools = [{ name: 'claim_task', description: 'claim', parameters: { type: 'object', properties: {} } }]
    await collect(adapter, request([sys('sys-v1'), user('u1', 'hi')], { tools: claimTools }))
    const beforeSid = adapter.nativeSessions['dsh-1'].acpSessionId

    await assert.rejects(
      () =>
        collect(
          adapter,
          request(
            [
              sys('sys-v2'),
              user('u1', 'hi'),
              assistant('a1', 'calling'),
              {
                id: 't1',
                role: 'tool',
                toolCallId: 'tc-1',
                source: { kind: 'tool', callId: 'tc-1' },
                isError: false,
                content: [{ type: 'text', text: '{"ok":true}' }],
              },
            ],
            { tools: claimTools },
          ),
        ),
      (err) => err.code === 'AGY_ACP_SYSTEM_CHANGED' && /本次未重基线/.test(err.message) && !/自动重基线/.test(err.message),
    )
    assert.equal(transports.length, 1, 'no new transport/session/new on non-user tail')
    assert.equal(prompts(transports[0]).length, 1, 'no extra prompt sent')
    assert.equal(adapter.nativeSessions['dsh-1'].acpSessionId, beforeSid)
    adapter.dispose()
  })

  test('t31-c: exceeding MAX_CONSECUTIVE_REBASELINES=3 on SYSTEM_CHANGED throws AGY_ACP_REBASELINE_LIMIT_EXCEEDED with 0 prompt', async () => {
    const transports = []
    const stateFile = path.join(temp, 't31-c-sessions.json')
    const adapter = new AgyAcpAdapter({
      cwd: temp,
      nativeStateFile: stateFile,
      transport: () => {
        const t = new Transport()
        transports.push(t)
        return t
      },
    })
    const sys = (text) => ({ role: 'system', content: [{ type: 'text', text }] })
    await collect(adapter, request([sys('sys-0'), user('u0', 'turn0')]))
    // 3 consecutive system-changed rebaselines (allowed)
    for (let i = 1; i <= 3; i += 1) {
      const msgs = [sys(`sys-${i}`), user('u0', 'turn0')]
      for (let j = 1; j <= i; j += 1) {
        msgs.push(assistant(`a${j - 1}`, 'answer'), user(`u${j}`, `turn${j}`))
      }
      const c = await collect(adapter, request(msgs))
      assert.equal(c.at(-1).reason.kind, 'stop')
    }
    const promptsBefore = transports.reduce((acc, t) => acc + prompts(t).length, 0)
    const sidBefore = adapter.nativeSessions['dsh-1'].acpSessionId
    // 4th consecutive rebaseline must reject with AGY_ACP_REBASELINE_LIMIT_EXCEEDED
    const msgs4 = [
      sys('sys-4'),
      user('u0', 'turn0'),
      assistant('a0', 'answer'), user('u1', 'turn1'),
      assistant('a1', 'answer'), user('u2', 'turn2'),
      assistant('a2', 'answer'), user('u3', 'turn3'),
      assistant('a3', 'answer'), user('u4', 'turn4'),
    ]
    await assert.rejects(
      () => collect(adapter, request(msgs4)),
      (err) => err.code === 'AGY_ACP_REBASELINE_LIMIT_EXCEEDED',
    )
    const promptsAfter = transports.reduce((acc, t) => acc + prompts(t).length, 0)
    assert.equal(promptsAfter, promptsBefore)
    assert.equal(adapter.nativeSessions['dsh-1'].acpSessionId, sidBefore)
    adapter.dispose()
  })

  test('t31-d: unchanged system and matching history stay on normal incremental path with 0 rebaselines', async () => {
    const transports = []
    const adapter = new AgyAcpAdapter({
      cwd: temp,
      transport: () => {
        const t = new Transport()
        transports.push(t)
        return t
      },
    })
    const sys = { role: 'system', content: [{ type: 'text', text: 'stable-sys' }] }
    await collect(adapter, request([sys, user('u1', 'one')]))
    const c2 = await collect(adapter, request([sys, user('u1', 'one'), assistant('a1', 'answer'), user('u2', 'two')]))
    assert.equal(c2.at(-1).reason.kind, 'stop')
    assert.equal(transports.length, 1)
    assert.equal(prompts(transports[0]).length, 2)
    const act = adapter.getNativeActivity('dsh-1')
    assert.equal(act.rebaselines.length, 0)
    adapter.dispose()
  })

  test('t31-e: pure assistant tail is pre-blocked by planRequest with UNSUPPORTED_HISTORY', async () => {
    const transports = []
    const stateFile = path.join(temp, 't31-e-sessions.json')
    const adapter = new AgyAcpAdapter({
      cwd: temp,
      nativeStateFile: stateFile,
      transport: () => {
        const t = new Transport()
        transports.push(t)
        return t
      },
    })
    const sys = (text) => ({ role: 'system', content: [{ type: 'text', text }] })
    await collect(adapter, request([sys('sys-v1'), user('u1', 'hi')]))
    const beforeSid = adapter.nativeSessions['dsh-1'].acpSessionId

    await assert.rejects(
      () => collect(adapter, request([sys('sys-v2'), user('u1', 'hi'), assistant('a1', 'answer')])),
      (err) => err.code === 'AGY_ACP_UNSUPPORTED_HISTORY',
    )
    assert.equal(transports.length, 1)
    assert.equal(transports[0].requests.filter((r) => r.method === 'session/new').length, 1)
    assert.equal(prompts(transports[0]).length, 1)
    assert.equal(adapter.nativeSessions['dsh-1'].acpSessionId, beforeSid)
    adapter.dispose()
  })
  test.after(() => rmSync(temp, { recursive: true, force: true }))
} else {
  // Authorized live harness: login data copied read-only to TEMP; results contain evidence only.
  const root = path.resolve('D:/lnu-seat'); const out = path.join(root, 'antigravity-bridge/results/round2-verify.json')
  const shared = path.join(root, 'antigravity-bridge/desktop-staging/verification/agy-data')
  const snapshot = () => { const result = []; function walk(dir) { for (const e of readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isSymbolicLink()) throw Error('shared symlink'); if (e.isDirectory()) walk(f); else { const s = statSync(f); result.push({ path: path.relative(shared, f), size: s.size, mtimeMs: s.mtimeMs }) } } } walk(shared); return result.sort((a, b) => a.path.localeCompare(b.path)) }
  const evidence = { startedAt: new Date().toISOString(), sharedBefore: snapshot(), requests: [], responses: [], turns: [] }
  const auth = path.join(temp, 'login-copy'); cpSync(shared, auth, { recursive: true })
  const require = createRequire('D:/dsh-data/versions/0.2.2-rc.5/node_modules/@deepseek-ai/dsh/package.json')
  const load = async (name) => import(pathToFileURL(require.resolve(name)).href)
  let ctx, adapter
  try {
    const { Context } = await load('@deepseek-ai/cordis'); ctx = new Context(); const llm = await load('@deepseek-ai/dsh-llm'); ctx.plugin(llm.default ?? llm, {}); await ctx.lifecycle?.ready?.()
    // cordis materializes the llm service on its own async boundary: right after
    // ctx.plugin() `ctx.get('llm')` is still undefined, which would make apply()
    // skip the adapter entirely. Yield until the service is observable so this
    // harness really exercises the plugin's assembly layer.
    for (let i = 0; i < 50 && typeof ctx.get('llm')?.registerAdapter !== 'function'; i += 1) await new Promise((r) => setTimeout(r, 10))
    evidence.llmServiceReady = typeof ctx.get('llm')?.registerAdapter === 'function'
    // Go through the real plugin entry point so the assembly layer (apply ->
    // createAdapter -> resolveWorkspace -> registerAdapter) is what runs. A
    // hand-built adapter here would hide exactly the wiring Neon E2 flagged.
    const hostAgent = { id: 'round2-live-agent', session: { id: 'round2-real-ctx-llm' }, followup: () => {} }
    const hostAgents = { get: (id) => (String(id) === hostAgent.session.id ? hostAgent : undefined), list: () => [hostAgent] }
    ctx.provide?.('tools', { register: () => () => {} })
    ctx.provide?.('agents', hostAgents)
    ctx.provide?.('workingDirectory', { get: () => root })
    const stateDir = path.join(temp, 'plugin-state')
    apply(ctx, {
      agyExecutable: path.join(root, 'antigravity-bridge/desktop-staging/verification/official-cli/agy.exe'),
      agyArgs: ['acp', '--gemini-dir', auth],
      cwd: root,
      stateFile: path.join(stateDir, 'state.json'),
      modelProvider: true,
      transport: () => {
        const t = new AcpStdioTransport({ cwd: root, agyExecutable: path.join(root, 'antigravity-bridge/desktop-staging/verification/official-cli/agy.exe'), agyArgs: ['acp', '--gemini-dir', auth] }); const request = t.request.bind(t)
        t.request = async (method, params, options) => { evidence.requests.push({ method, params }); const result = await request(method, params, options); if (method !== 'session/prompt') evidence.responses.push({ method, result }); return result }; return t
      },
    })
    adapter = null
    evidence.assembledBy = 'apply(ctx)'
    evidence.nativeStateFile = path.join(stateDir, 'native-sessions.json')
    evidence.providers = (ctx.llm.listProviders?.() ?? []).map((p) => p.id)
    evidence.llmRegistered = evidence.providers.includes(PROVIDER_ID)
    evidence.catalog = await ctx.llm.listModels(PROVIDER_ID)
    evidence.resolved = await Promise.all(evidence.catalog.map((m) => ctx.llm.resolveModelInfo(PROVIDER_ID, m.id)))
    const opts = { provider: PROVIDER_ID, model: 'gemini-4-hydrogen', sessionId: 'round2-real-ctx-llm', reasoningEffort: 'medium', tools: [] }
    const first = user('live-u1', 'Remember the nonce CEDAR-7319. Reply exactly CEDAR-7319. Do not use any tools.')
    async function turn(messages) { const chunks = []; for await (const c of ctx.llm.stream({ ...opts, messages })) chunks.push(c); const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''); evidence.turns.push({ text, chunks }); return text }
    const answer = await turn([first]); assert.match(answer, /CEDAR-7319/); const second = user('live-u2', 'What nonce did I ask you to remember? Reply only that nonce. Do not use any tools.'); const answer2 = await turn([first, { ...assistant('live-a1', answer), source: { kind: 'model', provider: PROVIDER_ID, model: opts.model } }, second])
    const sent = evidence.requests.filter((r) => r.method === 'session/prompt'); assert.equal(sent.length, 2); assert.equal(sent[0].params.sessionId, sent[1].params.sessionId); assert.deepEqual(sent[1].params.prompt, [{ type: 'text', text: second.content[0].text }]); assert.match(answer2, /CEDAR-7319/)
    evidence.nativeSessionId = sent[0].params.sessionId; evidence.ledger = JSON.parse(readFileSync(evidence.nativeStateFile)); evidence.passed = true
  } catch (error) { evidence.error = { code: error.code, message: error.message, stack: error.stack }; process.exitCode = 1 }
  finally {
    adapter?.dispose(); await ctx?.dispose?.(); evidence.sharedAfter = snapshot(); const before = new Map(evidence.sharedBefore.map((i) => [i.path, i])); const after = new Map(evidence.sharedAfter.map((i) => [i.path, i])); evidence.sharedDiff = { added: evidence.sharedAfter.filter((i) => !before.has(i.path)), removed: evidence.sharedBefore.filter((i) => !after.has(i.path)), changed: evidence.sharedAfter.filter((i) => before.has(i.path) && (i.size !== before.get(i.path).size || i.mtimeMs !== before.get(i.path).mtimeMs)) }; evidence.finishedAt = new Date().toISOString(); evidence.tempDirectory = temp
    rmSync(temp, { recursive: true, force: true }); evidence.tempDeleted = !existsSync(temp)
    const prior = JSON.parse(readFileSync(out)); if (!Array.isArray(prior)) throw Error('Expected existing verification array'); prior.push({ kind: 'nativeRound2', evidence }); writeFileSync(out, JSON.stringify(prior, null, 2)); console.log(JSON.stringify({ passed: evidence.passed, error: evidence.error, assembledBy: evidence.assembledBy, providers: evidence.providers, llmRegistered: evidence.llmRegistered, models: evidence.catalog?.length, nativeSessionId: evidence.nativeSessionId, turns: evidence.turns, sharedCount: [evidence.sharedBefore.length, evidence.sharedAfter.length], sharedDiff: evidence.sharedDiff, tempDeleted: evidence.tempDeleted }, null, 2))
  }
}
