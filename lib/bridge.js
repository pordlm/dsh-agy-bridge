/**
 * The bridge state machine for the official `agy acp` route and the explicit
 * desktop fallback.
 *
 * One `job` is one prompt from one DSH session into one ACP session or one
 * pinned Antigravity desktop window. The job is persisted before the request
 * is written, so a crash or an ambiguous transport outcome can never become a
 * second write. Replies are cached on the job and are readable even after a
 * wait timeout.
 *
 * ACP is the default and the only backend the model tools use unless the caller
 * asks for `transport: 'desktop'`. The desktop path goes through the bundled
 * UIA driver (`./desktop.js`); there is no desktop app RPC, no Google endpoint
 * proxy, no credential read, and no network client here.
 */

import { randomUUID } from 'node:crypto'
import { probeCli, loginArgs, launchLoginTerminal } from './cli-probe.js'
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { acpBackend, pickModelOption, pickThoughtOption, resolveConfigValue, summarizeOptions } from './acp.js'
import { attachmentInfo, inspectAttachments, readAttachmentBlocks } from './attachments.js'
import { canonicalWorkspace, assertWorkspaceBinding } from './workspace.js'
import { DESKTOP_TRANSPORT, DesktopChannel, defaultDesktopConfig } from './desktop.js'

const STATE_VERSION = 3
const TERMINAL_STATUSES = new Set(['not_sent', 'replied', 'failed'])
const WAKE_FALLBACK_CODES = new Set([
  'AGENT_NAME_NOT_FOUND',
  'CONTINUATION_UNAVAILABLE',
  'ACTIVATION_CLOSING',
  'INPUT_CLOSED',
  'DRAINING',
])
const MAX_ACTIVITY_PER_JOB = 20
const ACTIVITY_KINDS = new Set(['execute', 'edit', 'read', 'other'])

function normalizeActivityEvent(event) {
  if (!event || typeof event !== 'object') return null
  const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : String(event.toolCallId ?? '')
  const rawKind = typeof event.kind === 'string' ? event.kind : String(event.kind ?? '')
  const kind = ACTIVITY_KINDS.has(rawKind) ? rawKind : 'unknown'
  const title = (typeof event.title === 'string' ? event.title : String(event.title ?? '')).slice(0, 200)
  const status = (typeof event.status === 'string' ? event.status : String(event.status ?? '')).slice(0, 200)
  if (toolCallId === '' && title === '' && status === '' && kind === 'unknown') return null
  return { toolCallId, kind, title, status }
}

function activityOf(job) {
  return Array.isArray(job?.activity) ? job.activity : []
}

const MAX_THOUGHTS_PER_JOB = 20
const MAX_THOUGHT_CHARS = 200

function thoughtOf(job) {
  return Array.isArray(job?.thoughts) ? job.thoughts : []
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

function clampText(text, limit) {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n…（已截断，共 ${text.length} 字符）`
}

function nowIso() {
  return new Date().toISOString()
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function defaultStatePath() {
  const home = process.env.DSH_HOME || join(process.env.LOCALAPPDATA || process.cwd(), 'dsh')
  return join(home, 'antigravity-bridge', 'state.json')
}

export function defaultConfig(raw = {}) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const config = {
    agyExecutable: 'agy',
    agyArgs: ['acp'],
    cwd: process.cwd(),
    pollMs: 4000,
    waitPollMs: 900,
    defaultModel: '',
    defaultEffort: '',
    autoWake: true,
    maxReplyChars: 20000,
    maxAttachments: 10,
    maxAttachmentBytes: 10 * 1024 * 1024,
    maxTotalAttachmentBytes: 20 * 1024 * 1024,
    permissionPolicy: 'reject',
    thoughtSummary: input.thoughtSummary !== false,
    inlineThought: input.inlineThought !== false,
    nativeActivityEnabled: input.nativeActivityEnabled !== false,
    acpToolBridge: input.acpToolBridge === true,
    acpPermissionPolicy: input.acpPermissionPolicy ?? 'reject',
    wakeAgent: '',
    workspaceConfigured: typeof input.cwd === 'string' && input.cwd.trim() !== '',
    stateFile: '',
    ...input,
  }
  if (input.acpToolBridge !== undefined && typeof input.acpToolBridge !== 'boolean') {
    throw new Error('antigravity-bridge: acpToolBridge must be a boolean when set')
  }
  config.acpToolBridge = input.acpToolBridge === true
  if (input.nativeActivityEnabled !== undefined && typeof input.nativeActivityEnabled !== 'boolean') {
    throw new Error('antigravity-bridge: nativeActivityEnabled must be a boolean')
  }
  config.nativeActivityEnabled = input.nativeActivityEnabled !== false
  if (input.inlineThought !== undefined && typeof input.inlineThought !== 'boolean') {
    throw new Error('antigravity-bridge: inlineThought must be a boolean')
  }
  config.inlineThought = input.inlineThought !== false
  if (
    input.acpPermissionPolicy !== undefined &&
    input.acpPermissionPolicy !== 'reject' &&
    input.acpPermissionPolicy !== 'allow_once'
  ) {
    throw new Error('antigravity-bridge: acpPermissionPolicy must be "reject" or "allow_once" when set')
  }
  config.acpPermissionPolicy = input.acpPermissionPolicy ?? 'reject'
  if (typeof config.agyExecutable !== 'string' || config.agyExecutable.trim() === '') {
    throw new Error('antigravity-bridge: agyExecutable must be a non-empty path')
  }
  if (
    !Array.isArray(config.agyArgs) ||
    config.agyArgs.length === 0 ||
    config.agyArgs.some((arg) => typeof arg !== 'string')
  ) {
    throw new Error('antigravity-bridge: agyArgs must be a non-empty string array')
  }
  if (typeof config.cwd !== 'string' || config.cwd.trim() === '') {
    throw new Error('antigravity-bridge: cwd must be a non-empty path')
  }
  if (!Number.isSafeInteger(config.pollMs) || config.pollMs < 1000 || config.pollMs > 120000) {
    throw new Error('antigravity-bridge: pollMs must be an integer from 1000 to 120000')
  }
  if (
    !Number.isSafeInteger(config.waitPollMs) ||
    config.waitPollMs < 50 ||
    config.waitPollMs > 10000
  ) {
    throw new Error('antigravity-bridge: waitPollMs must be an integer from 50 to 10000')
  }
  if (typeof config.defaultModel !== 'string') {
    throw new Error('antigravity-bridge: defaultModel must be a string')
  }
  if (typeof config.defaultEffort !== 'string') {
    throw new Error('antigravity-bridge: defaultEffort must be a string')
  }
  if (typeof config.autoWake !== 'boolean') {
    throw new Error('antigravity-bridge: autoWake must be a boolean')
  }
  if (
    !Number.isSafeInteger(config.maxReplyChars) ||
    config.maxReplyChars < 500 ||
    config.maxReplyChars > 200000
  ) {
    throw new Error('antigravity-bridge: maxReplyChars must be an integer from 500 to 200000')
  }
  if (
    !Number.isSafeInteger(config.maxAttachments) ||
    config.maxAttachments < 0 ||
    config.maxAttachments > 50
  ) {
    throw new Error('antigravity-bridge: maxAttachments must be an integer from 0 to 50')
  }
  if (
    !Number.isSafeInteger(config.maxAttachmentBytes) ||
    config.maxAttachmentBytes < 1024 ||
    config.maxAttachmentBytes > 100 * 1024 * 1024
  ) {
    throw new Error('antigravity-bridge: maxAttachmentBytes must be 1024..104857600')
  }
  if (
    !Number.isSafeInteger(config.maxTotalAttachmentBytes) ||
    config.maxTotalAttachmentBytes < config.maxAttachmentBytes ||
    config.maxTotalAttachmentBytes > 200 * 1024 * 1024
  ) {
    throw new Error('antigravity-bridge: maxTotalAttachmentBytes must be >= maxAttachmentBytes')
  }
  if (!['reject', 'allow_once'].includes(config.permissionPolicy)) {
    throw new Error('antigravity-bridge: permissionPolicy must be "reject" or "allow_once"')
  }
  if (typeof config.thoughtSummary !== 'boolean') {
    throw new Error('antigravity-bridge: thoughtSummary must be a boolean')
  }
  if (typeof config.wakeAgent !== 'string' || (input.wakeAgent !== undefined && config.wakeAgent.trim() === '')) {
    throw new Error('antigravity-bridge: wakeAgent must be a non-empty string when provided')
  }
  config.wakeAgent = config.wakeAgent.trim()
  if (config.backend !== undefined && (config.backend === null || typeof config.backend !== 'object')) {
    throw new Error('antigravity-bridge: backend must be an object when provided')
  }
  if (config.messageFactory !== undefined && typeof config.messageFactory !== 'function') {
    throw new Error('antigravity-bridge: messageFactory must be a function when provided')
  }
  if (config.cliLoginLauncher !== undefined && typeof config.cliLoginLauncher !== 'function') {
    throw new Error('antigravity-bridge: cliLoginLauncher must be a function when provided')
  }
  if (config.desktop === undefined) {
    config.desktop = defaultDesktopConfig()
  } else if (config.desktop === null || typeof config.desktop !== 'object' || Array.isArray(config.desktop)) {
    throw new Error('antigravity-bridge: desktop must be an object when provided')
  } else {
    config.desktop = { ...defaultDesktopConfig(), ...config.desktop }
  }
  if (typeof config.desktop.enabled !== 'boolean') {
    throw new Error('antigravity-bridge: desktop.enabled must be a boolean')
  }
  for (const key of ['driverPath', 'powershell']) {
    if (typeof config.desktop[key] !== 'string') {
      throw new Error(`antigravity-bridge: desktop.${key} must be a string`)
    }
  }
  if (
    !Number.isSafeInteger(config.desktop.timeoutMs) ||
    config.desktop.timeoutMs < 1000 ||
    config.desktop.timeoutMs > 120000
  ) {
    throw new Error('antigravity-bridge: desktop.timeoutMs must be an integer from 1000 to 120000')
  }
  if (!Number.isSafeInteger(config.desktop.pollMs) || config.desktop.pollMs < 100 || config.desktop.pollMs > 120000) {
    throw new Error('antigravity-bridge: desktop.pollMs must be an integer from 100 to 120000')
  }
  if (
    !Number.isSafeInteger(config.desktop.replyTimeoutMs) ||
    config.desktop.replyTimeoutMs < 1000 ||
    config.desktop.replyTimeoutMs > 3600000
  ) {
    throw new Error('antigravity-bridge: desktop.replyTimeoutMs must be an integer from 1000 to 3600000')
  }
  if (config.desktop.target !== null && config.desktop.target !== undefined) {
    if (typeof config.desktop.target !== 'object' || Array.isArray(config.desktop.target)) {
      throw new Error('antigravity-bridge: desktop.target must be an object when provided')
    }
  }
  if (config.desktop.driver !== undefined && (config.desktop.driver === null || typeof config.desktop.driver.run !== 'function')) {
    throw new Error('antigravity-bridge: desktop.driver must expose run(request) when provided')
  }
  if (
    config.desktop.env !== null &&
    config.desktop.env !== undefined &&
    (typeof config.desktop.env !== 'object' || Array.isArray(config.desktop.env))
  ) {
    throw new Error('antigravity-bridge: desktop.env must be an object of environment overrides when provided')
  }
  config.stateFile =
    typeof config.stateFile === 'string' && config.stateFile !== ''
      ? config.stateFile
      : defaultStatePath()
  return config
}

function emptyState() {
  return { version: STATE_VERSION, jobs: {}, owners: {}, locks: {}, workspaces: {}, legacy: {} }
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function loadState(file, logger) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logger?.warn?.(`antigravity-bridge: state file unreadable, starting empty: ${error?.message ?? error}`)
    }
    return emptyState()
  }
  if (!parsed || typeof parsed !== 'object') return emptyState()
  return {
    version: STATE_VERSION,
    jobs: objectOrEmpty(parsed.jobs),
    owners: objectOrEmpty(parsed.owners),
    workspaces: objectOrEmpty(parsed.workspaces),
    locks: objectOrEmpty(parsed.locks),
    legacy:
      Number(parsed.version) === STATE_VERSION
        ? objectOrEmpty(parsed.legacy)
        : objectOrEmpty(parsed.conversations),
    loadedVersion: Number(parsed.version) || 0,
  }
}

function saveState(file, state, logger) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    const writable = { ...state }
    delete writable.loadedVersion
    writeFileSync(tmp, JSON.stringify(writable, null, 2), 'utf8')
    renameSync(tmp, file)
    return true
  } catch (error) {
    logger?.warn?.(`antigravity-bridge: could not write state file: ${error?.message ?? error}`)
    return false
  }
}

function defaultRequested() {
  return {
    model: '',
    effort: '',
    profile: '',
    title: '',
    pathRefs: [],
    attachments: 0,
    attachmentInfo: [],
  }
}

function defaultEffective() {
  return { model: '', effort: '', profile: '', source: '', verified: false }
}

function requestedOf(job) {
  const value = job?.requested && typeof job.requested === 'object' ? job.requested : {}
  return {
    ...defaultRequested(),
    ...value,
    pathRefs: Array.isArray(value.pathRefs) ? value.pathRefs : [],
    attachmentInfo: Array.isArray(value.attachmentInfo) ? value.attachmentInfo : [],
  }
}

function effectiveFromOptions(options, verified = false) {
  const model = pickModelOption(options)
  const thought = pickThoughtOption(options)
  return {
    model: model?.currentValue ?? '',
    effort: thought?.currentValue ?? '',
    profile: '',
    source: model || thought ? 'acp_current' : 'acp_default',
    verified: verified && Boolean(model || thought),
  }
}

/**
 * Read the service's actual complete config snapshot from an ACP error. The
 * current AcpError carries it in `data.configOptions`; older shapes put it on
 * `error.configOptions` or under the raw JSON-RPC `error.data`.
 */
function errorConfigSnapshot(error) {
  if (Array.isArray(error?.data?.configOptions)) return error.data.configOptions
  if (Array.isArray(error?.data?.data?.configOptions)) return error.data.data.configOptions
  if (Array.isArray(error?.configOptions)) return error.configOptions
  return null
}

function fileModeOf(requested) {
  const refs = Array.isArray(requested.pathRefs) && requested.pathRefs.length > 0
  const files = Array.isArray(requested.attachments)
    ? requested.attachments.length > 0
    : Number(requested.attachments ?? 0) > 0
  if (refs && files) return 'attachment+path_reference'
  if (files) return 'attachment'
  if (refs) return 'path_reference'
  return ''
}

export class Bridge {
  constructor(ctx, config, logger) {
    this.ctx = ctx
    this.config = config
    this.logger = logger
    this.state = loadState(config.stateFile, logger)
    this.backend = config.backend ?? acpBackend(config, logger)
    this.waiters = new Map()
    this.activePrompts = new Map()
    // Synchronous per-session reservation for config/create-resume. It is set
    // before the first backend await so a send cannot slip through the gap.
    this.reservations = new Map()
    this.waking = new Set()
    this.agents = new Map()
    this.timer = null
    this.ticking = false
    // Set by dispose(); a closed Bridge must never write, wake or adopt a late
    // observation from a channel that outlived it.
    this.closed = false
    this.wakeAbort = new AbortController()
    this._messageFactory = null
    this.desktop = new DesktopChannel({ bridge: this, config: this.config, logger })
    this.recover()
  }

  /** Keep the live Agent around so a wake does not depend on the registry. */
  remember(agent) {
    if (agent && typeof agent.followup === 'function' && agent.id) this.agents.set(String(agent.id), agent)
    return agent
  }

  /** Drop a disposed Agent so a stale handle is never used for a wake. */
  forget(agentId) {
    if (agentId) this.agents.delete(String(agentId))
  }

  agentOf(agentId) {
    if (!agentId) return undefined
    const held = this.agents.get(String(agentId))
    if (held) return held
    try {
      const found = this.ctx.agents.get(agentId)
      if (found) {
        this.remember(found)
        return this.agents.get(String(agentId)) || found
      }
      this.trace(`lookup-miss agent=${agentId} reason=registry-empty`)
    } catch (error) {
      this.trace(`lookup-error agent=${agentId} error=${error?.message ?? error}`)
    }
    return undefined
  }

  save() {
    // A disposed instance must not rewrite a state file another Bridge may
    // already own (reload/restart races).
    if (this.closed) return false
    return saveState(this.config.stateFile, this.state, this.logger)
  }

  /** Append one diagnostic line; never include reply text or file contents. */
  trace(line) {
    try {
      const file = `${this.config.stateFile}.log`
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, `${nowIso()} ${line}\n`, 'utf8')
    } catch {
      // Diagnostics must never break a wake attempt.
    }
  }

  /** After a reload, no request that might have reached ACP is ever retried. */
  recover() {
    let dirty = false
    const oldState = Number(this.state.loadedVersion) > 0 && Number(this.state.loadedVersion) < STATE_VERSION
    for (const job of Object.values(this.state.jobs)) {
      if (!job || typeof job !== 'object') continue
      // A persisted "delivering" may already have entered followup before the
      // process stopped. Never replay it, including for an already-replied job.
      if (job.wakeState === 'delivering') {
        job.wakeState = 'delivery_unknown'
        job.updatedAt = nowIso()
        dirty = true
      }
      if (oldState && !TERMINAL_STATUSES.has(job.status)) {
        job.legacy = true
        job.status = 'failed'
        job.phase = 'terminal'
        job.code = 'legacy_state'
        job.message = '这是旧版桌面通道留下的任务；当前通道不重放，也不会自动重发。'
        job.updatedAt = nowIso()
        this.releaseLock(job)
        dirty = true
        continue
      }
      if (TERMINAL_STATUSES.has(job.status)) {
        this.releaseLock(job)
        continue
      }
      const desktop = job.transport === DESKTOP_TRANSPORT
      if (['creating', 'resuming', 'configuring', 'reserving'].includes(job.phase)) {
        job.status = 'not_sent'
        job.phase = 'terminal'
        job.code = 'dispatch_interrupted_before_prompt'
        job.message = desktop
          ? '插件在桌面 Send 之前重启；请求没有发出，可安全重试。'
          : '插件在 ACP prompt 发出前重启；请求没有发送，可安全重试。'
        job.updatedAt = nowIso()
        this.releaseLock(job)
        dirty = true
        continue
      }
      if (['prompting', 'dispatching'].includes(job.phase) || job.status === 'accepted') {
        job.status = 'acceptance_unknown'
        job.phase = 'idle'
        job.code = 'dispatch_interrupted'
        job.message = desktop
          ? '插件在桌面观察进行中重启；无法证明本轮是否完成，也不会自动重发。可按 job_id 查询，或在 Antigravity 窗口中人工核对。'
          : '插件在 ACP prompt 进行中重启；无法证明请求是否完成，也不会自动重发。请人工核对，或按 job_id 读取。'
        job.updatedAt = nowIso()
        dirty = true
      }
    }
    for (const [conversationId, jobId] of Object.entries(this.state.locks)) {
      const job = this.state.jobs[jobId]
      if (!job || TERMINAL_STATUSES.has(job.status)) {
        delete this.state.locks[conversationId]
        dirty = true
      }
    }
    if (dirty) this.save()
  }

  job(jobId) {
    return this.state.jobs[jobId] ?? null
  }

  /**
   * A wake may only go out while this Bridge is still the live owner of the
   * exact job object it started with. After an await the instance may have
   * been disposed, or a reload may have replaced the state file with another
   * instance's records; in both cases the persisted "delivering" checkpoint
   * must stay as it is (a restart maps it to delivery_unknown) instead of
   * being turned back into a retryable "pending" by the stale instance.
   */
  stillOwns(job) {
    if (!job || this.closed) return false
    return this.job(job.jobId) === job
  }

  jobs(agentId) {
    const id = String(agentId)
    return Object.values(this.state.jobs)
      .filter((job) => String(job.ownerAgentId) === id)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  }

  /** Jobs are invisible to every DSH session except their fixed owner. */
  resolveJob({ jobId = '', conversationId = '', agentId = '' } = {}) {
    if (jobId) {
      const job = this.job(jobId)
      if (!job) return { error: { code: 'job_not_found', message: `没有这个 job：${jobId}` } }
      if (String(job.ownerAgentId) !== String(agentId)) {
        return { error: { code: 'forbidden', message: '这个 job 属于另一个 DSH 会话，不能读取或等待。' } }
      }
      return { job }
    }
    const id = String(conversationId ?? '').trim()
    if (id === '') {
      return { error: { code: 'invalid_request', message: '需要 job_id 或 conversation_id。' } }
    }
    const owned = this.jobs(agentId).filter(
      (job) =>
        job.conversationId === id ||
        job.desktopConversationId === id ||
        job.desktopLockKey === id ||
        (typeof job.targetKey === 'string' && job.targetKey === id),
    )
    if (owned.length === 0) {
      return {
        error: {
          code: 'job_not_found',
          message: `当前会话没有与 ${id} 关联的 job（ACP 会话或桌面会话）。请用 job_id。`,
        },
      }
    }
    if (owned.length > 1) {
      return {
        error: {
          code: 'ambiguous_job',
          message: `会话 ${id} 有 ${owned.length} 个 job，请用 job_id 指定：${owned
            .map((job) => job.jobId)
            .join('、')}`,
        },
      }
    }
    return { job: owned[0] }
  }

  /** True if this ACP session already has a live prompt in this process. */
  promptActive(sessionId) {
    for (const value of this.activePrompts.values()) {
      if (value?.sessionId === sessionId) return true
    }
    return false
  }

  /**
   * Inspect one ACP session without sending a prompt. A new session becomes
   * owned by the caller. Resuming a session owned by another DSH session, or one
   * with a live prompt/lock, is refused before any ACP request.
   */
  async configSession({ agentId, conversationId = '', cwd }) {
    cwd = canonicalWorkspace(cwd)
    const id = String(conversationId ?? '').trim()
    if (id && this.state.owners[id] && String(this.state.owners[id]) !== String(agentId)) return { error: { code: 'forbidden', message: 'Session belongs to another owner.' } }
    if (id) assertWorkspaceBinding(this.state.workspaces[id], cwd)
    let reservation = null
    let claimedOwner = false
    let claimedId = ''
    if (id !== '') {
      if (this.reservations.has(id)) {
        return {
          error: {
            code: 'busy',
            message: `ACP 会话 ${id} 正在被另一个操作恢复或配置；不并发替换。`,
          },
        }
      }
      const activeJobId = this.state.locks[id]
      const active = activeJobId ? this.job(activeJobId) : null
      if (
        (activeJobId && active && !TERMINAL_STATUSES.has(active.status)) ||
        this.promptActive(id)
      ) {
        return {
          error: {
            code: 'busy',
            message: `ACP 会话 ${id} 还有未结束的 prompt；拒绝恢复或替换活动回复收集器。`,
          },
        }
      }
      const owner = this.state.owners[id]
      if (owner && String(owner) !== String(agentId)) {
        return {
          error: {
            code: 'forbidden',
            message: `ACP 会话 ${id} 已属于另一个 DSH 会话；不能读取或修改它的配置。`,
          },
        }
      }
      // Claim both the reservation and (for an unowned session) the owner
      // before the first await. beginSend checks the same reservation.
      reservation = { token: `cfg-${randomUUID()}`, agentId: String(agentId) }
      this.reservations.set(id, reservation)
      if (!owner) {
        this.state.owners[id] = String(agentId)
        claimedOwner = true
        claimedId = id
      }
      if (!this.save()) {
        this.releaseReservation(id, reservation.token)
        if (claimedOwner && !this.state.locks[id]) delete this.state.owners[id]
        throw Object.assign(new Error(`状态文件无法写入，无法登记会话归属：${this.config.stateFile}`), {
          code: 'state_write_failed',
          phase: 'before_write',
        })
      }
    }

    let session = null
    try {
      const capabilities = await this.backend.ready()
      session =
        id === ''
          ? await this.backend.createSession({ cwd })
          : await this.backend.resumeSession({ sessionId: id, cwd })
      const sessionId = String(session?.sessionId ?? '')
      if (sessionId === '') {
        throw Object.assign(new Error(id === '' ? 'ACP 没有返回 sessionId。' : `无法恢复 ACP 会话 ${id}（后端没有返回 sessionId）。`), {
          code: id === '' ? 'session_create_failed' : 'restore_failed',
          phase: 'before_write',
        })
      }
      if (id !== '' && sessionId !== id) {
        throw Object.assign(new Error(`ACP 恢复了不同的会话 ${sessionId}，不是 ${id}；没有继续。`), {
          code: 'session_mismatch',
          phase: 'before_write',
        })
      }
      this.state.workspaces[sessionId] = cwd
      if (!this.state.owners[sessionId]) {
        this.state.owners[sessionId] = String(agentId)
        claimedOwner = true
        claimedId = sessionId
      }
      if (!this.save()) {
        throw Object.assign(new Error(`状态文件无法写入，无法登记会话归属：${this.config.stateFile}`), {
          code: 'state_write_failed',
          phase: 'before_write',
        })
      }
      return {
        sessionId,
        workspaceRoot: cwd,
        configOptions: summarizeOptions(session.configOptions ?? []),
        capabilities,
        created: id === '',
      }
    } catch (error) {
      if (
        claimedOwner &&
        claimedId &&
        !this.state.locks[claimedId] &&
        String(this.state.owners[claimedId]) === String(agentId)
      ) {
        delete this.state.owners[claimedId]
        this.save()
      }
      throw error
    } finally {
      if (reservation) this.releaseReservation(id, reservation.token)
    }
  }

  releaseReservation(sessionId, token) {
    const held = this.reservations.get(sessionId)
    if (!held || held.token !== token) return false
    this.reservations.delete(sessionId)
    return true
  }

  /**
   * Reserve the target and persist the job before any backend await. For ACP a
   * new conversation gets its lock after `session/new`; a desktop job is pinned
   * to one verified window, so its lock exists from the first byte.
   */
  beginSend({
    agentId,
    conversationId = '',
    message,
    requested,
    title = '',
    clientRequestId = '',
    transport = 'acp',
    workspaceRoot = '',
    wakeAgent = '',
  }) {
    const wanted = transport === DESKTOP_TRANSPORT ? DESKTOP_TRANSPORT : 'acp'
    const id = wanted === DESKTOP_TRANSPORT ? '' : String(conversationId ?? '').trim()
    if (wanted === DESKTOP_TRANSPORT && String(conversationId ?? '').trim() !== '') {
      return {
        error: {
          code: 'invalid_request',
          message: '桌面通道不接受 conversation_id：它始终写入已固定的桌面会话。',
        },
      }
    }
    let desktop = null
    if (wanted === DESKTOP_TRANSPORT) {
      try {
        desktop = this.desktop.jobFields()
      } catch (error) {
        return { error: { code: error?.code ?? 'desktop_unavailable', message: error?.message ?? String(error) } }
      }
    }
    const lockKey = wanted === DESKTOP_TRANSPORT ? desktop.desktopLockKey : id
    if (lockKey !== '') {
      if (this.reservations.has(lockKey)) {
        return {
          error: {
            code: 'busy',
            message:
              wanted === DESKTOP_TRANSPORT
                ? '这个桌面会话正在被另一个操作确认；不并发写入。'
                : `ACP 会话 ${lockKey} 正在被另一个操作恢复或配置；不并发写入。`,
          },
        }
      }
      const activeJobId = this.state.locks[lockKey]
      if (activeJobId) {
        const active = this.job(activeJobId)
        if (active && !TERMINAL_STATUSES.has(active.status)) {
          return {
            error: {
              code: 'busy',
              message:
                wanted === DESKTOP_TRANSPORT
                  ? `这个桌面会话还有未结束的任务 ${activeJobId}（${active.status}）。先等待或读取它，不并发写入。`
                  : `ACP 会话 ${lockKey} 还有未结束的 prompt ${activeJobId}（${active.status}）。先等待或读取它，不并发写入。`,
            },
          }
        }
        delete this.state.locks[lockKey]
      }
      const owner = this.state.owners[lockKey]
      if (owner && String(owner) !== String(agentId)) {
        return {
          error: {
            code: 'forbidden',
            message:
              wanted === DESKTOP_TRANSPORT
                ? '这个桌面会话已属于另一个 DSH 会话；不接管陌生会话。'
                : `ACP 会话 ${lockKey} 已属于另一个 DSH 会话；不接管陌生会话。`,
          },
        }
      }
    }

    const jobId = `agj-${randomUUID()}`
    const job = {
      jobId,
      ownerAgentId: String(agentId),
      clientRequestId: String(clientRequestId ?? ''),
      transport: wanted,
      workspaceRoot,
      conversationId: id,
      desktopConversationId: '',
      desktopLockKey: wanted === DESKTOP_TRANSPORT ? desktop.desktopLockKey : '',
      targetKey: '',
      target: wanted === DESKTOP_TRANSPORT ? desktop.target : null,
      targetKind: wanted === DESKTOP_TRANSPORT ? 'desktop_window' : 'acp_session',
      kind: wanted === DESKTOP_TRANSPORT ? DESKTOP_TRANSPORT : id === '' ? 'create' : 'continue',
      status: 'acceptance_unknown',
      phase: wanted === DESKTOP_TRANSPORT ? 'dispatching' : id === '' ? 'creating' : 'resuming',
      code: 'dispatching',
      message:
        wanted === DESKTOP_TRANSPORT
          ? '请求正在核对固定的桌面窗口并派发；在收到 UIA Send 结果前状态保持未知。'
          : '请求正在建立 ACP 会话并派发；在收到 prompt 受理证据前状态保持未知。',
      requested: { ...defaultRequested(), ...(requested ?? {}) },
      effective: defaultEffective(),
      confirmed: defaultEffective(),
      configOptions: [],
      permissions: [],
      permissionPending: false,
      title: String(title ?? ''),
      reply: null,
      wakeState: 'none',
      wakeTries: 0,
      wakeAgent: String(wakeAgent ?? '').trim(),
      wakeDeliveredVia: '',
      ack: '',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    this.state.jobs[jobId] = job
    if (lockKey !== '') {
      if (!this.state.owners[lockKey]) this.state.owners[lockKey] = String(agentId)
      this.state.locks[lockKey] = jobId
    }
    this.save()
    return { job }
  }

  attachConversation(job, conversationId) {
    if (!conversationId || job.conversationId === conversationId) return
    job.conversationId = conversationId
    job.targetKind = 'acp_session'
    if (!this.state.owners[conversationId]) this.state.owners[conversationId] = job.ownerAgentId
    const lock = this.state.locks[conversationId]
    if (!lock || lock === job.jobId) this.state.locks[conversationId] = job.jobId
  }

  releaseLock(job) {
    const key = job?.desktopLockKey || job?.conversationId
    if (!key) return
    if (this.state.locks[key] === job.jobId) delete this.state.locks[key]
  }

  /** The ACP prompt request was written to the child process. */
  markAccepted(job, result = {}) {
    if (!job || TERMINAL_STATUSES.has(job.status)) return job
    if (result.conversationId) this.attachConversation(job, result.conversationId)
    job.status = 'accepted'
    job.phase = 'prompting'
    job.code = String(result.code ?? '')
    job.message = String(result.message ?? 'ACP prompt 已发出，等待对应请求结束。')
    job.ack = String(result.ackEvidence ?? result.ack ?? '')
    job.updatedAt = nowIso()
    this.save()
    return job
  }

  /** The request may have been delivered; it is never retried automatically. */
  markAcceptanceUnknown(job, result = {}) {
    if (!job || TERMINAL_STATUSES.has(job.status)) return job
    if (result.conversationId) this.attachConversation(job, result.conversationId)
    job.status = 'acceptance_unknown'
    job.phase = 'idle'
    job.code = String(result.code ?? 'acceptance_unknown')
    job.message = String(
      result.message ??
        '无法证明 ACP prompt 已受理或已结束；为避免重复发送不会自动重试。请先确认 Antigravity 中是否出现该请求。',
    )
    if (result.effective?.model) job.effective = { ...job.effective, ...result.effective }
    if (Array.isArray(result.configOptions)) job.configOptions = result.configOptions
    job.updatedAt = nowIso()
    this.save()
    return job
  }

  markFailure(job, status, { code = 'failed', message = '', effective, configOptions } = {}) {
    if (!job) return job
    job.status = status
    job.phase = 'terminal'
    job.code = code
    job.message = message
    if (effective) job.effective = { ...job.effective, ...effective }
    if (Array.isArray(configOptions)) job.configOptions = configOptions
    job.updatedAt = nowIso()
    this.releaseLock(job)
    this.save()
    return job
  }

  finishReply(job, reply) {
    if (!job || TERMINAL_STATUSES.has(job.status)) return job
    job.status = 'replied'
    job.phase = 'terminal'
    job.code = ''
    job.message = ''
    job.reply = {
      text: reply.text,
      tools: Array.isArray(reply.tools) ? reply.tools.slice() : [],
      stopReason: reply.stopReason,
      permissions: Array.isArray(reply.permissions) ? reply.permissions.slice() : [],
      at: nowIso(),
    }
    job.permissions = job.reply.permissions
    if (!job.wakeState || job.wakeState === 'none') job.wakeState = 'pending'
    job.updatedAt = nowIso()
    this.releaseLock(job)
    this.save()
    return job
  }

  async messageFactory() {
    if (this._messageFactory) return this._messageFactory
    const injected = this.config.messageFactory
    if (typeof injected === 'function') {
      this._messageFactory = injected
      return injected
    }
    try {
      const module = await import('@deepseek-ai/dsh-llm')
      if (typeof module.createUserMessage === 'function') {
        this._messageFactory = module.createUserMessage
        return this._messageFactory
      }
    } catch {
      // The offline harness has no DSH node_modules. The local shape below is
      // the same frozen user message DSH accepts; production resolves the real
      // helper first.
    }
    this._messageFactory = ({ content, source }) =>
      Object.freeze({
        id: randomUUID(),
        role: 'user',
        content,
        source,
      })
    return this._messageFactory
  }

  recordPermission(job, event) {
    if (!job) return
    job.permissions = Array.isArray(job.permissions) ? job.permissions : []
    job.permissions.push(event)
    const label = event.title || event.kind || event.toolCallId || 'unknown tool'
    job.message = `Antigravity 请求权限：${label}；policy=${event.policy ?? 'reject'}，${event.decision}，optionId=${event.optionId ?? ''}。`
    this.trace(`permission job=${job.jobId} ${JSON.stringify(event)}`)
    job.updatedAt = nowIso()
    this.save()
  }

  /**
   * Record a complete config snapshot reported after dispatch (notification or
   * prompt result). This is the actual value and must not be overwritten by a
   * stale pre-dispatch cache.
   */
  applyActualConfig(job, options, source) {
    if (!job || !Array.isArray(options) || options.length === 0) return false
    job.configOptions = summarizeOptions(options)
    job.effective = {
      ...job.effective,
      ...effectiveFromOptions(options),
      source,
      verified: false,
    }
    job.updatedAt = nowIso()
    this.save()
    return true
  }

  async applyRequestedConfig(session, requested) {
    let options = Array.isArray(session.configOptions) ? session.configOptions : []
    try {
      if (requested.profile) {
        throw Object.assign(new Error('ACP 通道没有 profile 配置项；没有派发。'), {
          code: 'unsupported_capability',
          phase: 'before_write',
        })
      }
      const modelOption = pickModelOption(options)
      const thoughtOption = pickThoughtOption(options)
      if (requested.model && !modelOption) {
        throw Object.assign(
          new Error(`Antigravity 没有返回 model 配置项，不能选择模型“${requested.model}”；没有派发。`),
          { code: 'unsupported_capability', phase: 'before_write' },
        )
      }
      if (requested.effort && !thoughtOption) {
        throw Object.assign(
          new Error(`Antigravity 没有返回 thought 配置项，不能选择思考强度“${requested.effort}”；没有派发。`),
          { code: 'unsupported_capability', phase: 'before_write' },
        )
      }

      let effective = effectiveFromOptions(options)
      if (requested.model) {
        const value = resolveConfigValue(modelOption, requested.model)
        const result = await this.backend.setConfigOption(session.sessionId, modelOption.id, value)
        if (!Array.isArray(result?.configOptions) || result.configOptions.length === 0) {
          throw Object.assign(
            new Error(`ACP 的 set_config_option 没有返回完整 configOptions，不能确认模型 ${value}；已停止派发。`),
            {
              code: 'config_incomplete',
              phase: 'before_write',
              configOptions: summarizeOptions(options),
            },
          )
        }
        options = result.configOptions
        session.configOptions = options
        const after = pickModelOption(options)
        if (!after || after.currentValue !== value) {
          throw Object.assign(
            new Error(`ACP 没有确认模型 ${modelOption.id}=${value}；已停止派发。`),
            {
              code: 'config_not_applied',
              phase: 'before_write',
              configOptions: summarizeOptions(options),
            },
          )
        }
        effective = {
          ...effectiveFromOptions(options),
          source: 'acp_set_config_option',
          verified: true,
        }
      }
      if (requested.effort) {
        const currentThought = pickThoughtOption(options)
        if (!currentThought) {
          throw Object.assign(new Error('ACP 更新配置后不再返回 thought 选项；没有派发。'), {
            code: 'config_not_applied',
            phase: 'before_write',
            configOptions: summarizeOptions(options),
          })
        }
        const value = resolveConfigValue(currentThought, requested.effort)
        const result = await this.backend.setConfigOption(session.sessionId, currentThought.id, value)
        if (!Array.isArray(result?.configOptions) || result.configOptions.length === 0) {
          throw Object.assign(
            new Error(`ACP 的 set_config_option 没有返回完整 configOptions，不能确认思考强度 ${value}；已停止派发。`),
            {
              code: 'config_incomplete',
              phase: 'before_write',
              configOptions: summarizeOptions(options),
            },
          )
        }
        options = result.configOptions
        session.configOptions = options
        const after = pickThoughtOption(options)
        if (!after || after.currentValue !== value) {
          throw Object.assign(
            new Error(`ACP 没有确认思考强度 ${currentThought.id}=${value}；已停止派发。`),
            {
              code: 'config_not_applied',
              phase: 'before_write',
              configOptions: summarizeOptions(options),
            },
          )
        }
        effective = {
          ...effectiveFromOptions(options),
          source: 'acp_set_config_option',
          verified: true,
        }
      }
      return {
        effective,
        confirmed: { ...effective },
        configOptions: summarizeOptions(options),
      }
    } catch (error) {
      // A later option can fail after an earlier one was applied. Prefer the
      // service's complete snapshot on the error (AcpError.data.configOptions)
      // over the older pre-dispatch cache.
      const snapshot = errorConfigSnapshot(error) ?? summarizeOptions(options)
      session.configOptions = snapshot
      error.configOptions = snapshot
      throw error
    }
  }

  /**
   * Perform the one prompt this job stands for. `dispatch` returns once the
   * prompt request is on the wire; completion is handled by the ACP promise.
   */
  async dispatch(job, { message, requested, attachments = [], cwd }) {
    if (job?.transport === DESKTOP_TRANSPORT) {
      // The desktop channel owns its own pre-write checks, the single UIA Send
      // and the observation loop; results come back through the same helpers.
      try {
        return await this.desktop.dispatch(job, { message, requested })
      } catch (error) {
        const beforeWrite = error?.phase === 'before_write' || error?.phase === 'rejected'
        if (beforeWrite) {
          // Nothing reached the app: terminal not_sent, safe to retry explicitly.
          this.markFailure(job, 'not_sent', {
            code: error?.code ?? 'desktop_not_sent',
            message: error?.message ?? String(error),
          })
          throw error
        }
        // Something may have reached the app: keep it queryable, never resend.
        this.markAcceptanceUnknown(job, {
          code: error?.code ?? 'desktop_acceptance_unknown',
          message: error?.message ?? String(error),
        })
        return job
      }
    }
    let session = null
    try {
      cwd = canonicalWorkspace(job.workspaceRoot || cwd)
      if (job.workspaceRoot && cwd !== job.workspaceRoot) assertWorkspaceBinding(job.workspaceRoot, cwd)
      if (job.kind !== 'create') assertWorkspaceBinding(this.state.workspaces[job.conversationId], cwd)
      job.workspaceRoot = cwd
      if (job.kind === 'create') {
        job.phase = 'creating'
        this.save()
        session = await this.backend.createSession({ cwd })
        if (!session?.sessionId) {
          throw Object.assign(new Error('ACP session/new 没有返回 sessionId；没有派发。'), {
            code: 'session_create_failed',
            phase: 'before_write',
          })
        }
        this.attachConversation(job, session.sessionId)
        this.state.workspaces[session.sessionId] = cwd
      } else {
        job.phase = 'resuming'
        this.save()
        session = await this.backend.resumeSession({ sessionId: job.conversationId, cwd })
        if (!session?.sessionId) {
          // The backend already distinguishes restore_unsupported /
          // restore_failed / unknown_session when it throws; this only covers a
          // backend that returns an empty session instead of throwing.
          throw Object.assign(new Error(`无法恢复 ACP 会话 ${job.conversationId}（后端没有返回 sessionId）；没有派发。`), {
            code: 'restore_failed',
            phase: 'before_write',
          })
        }
      }

      job.phase = 'configuring'
      this.save()
      const applied = await this.applyRequestedConfig(session, requested)
      job.effective = applied.effective
      job.confirmed = applied.confirmed
      job.configOptions = applied.configOptions

      // Build the complete prompt (including attachments) before committing
      // the in-flight intent. A job that cannot persist its target and
      // "prompting" phase must not write session/prompt at all.
      const prompt = [{ type: 'text', text: message }]
      if (attachments.length > 0) {
        try {
          // Tool callers pass already-inspected descriptors. The Web Host passes
          // absolute host paths from DSH receipts; inspect those against the
          // negotiated prompt capabilities before reading any bytes.
          const descriptors =
            typeof attachments[0] === 'string'
              ? inspectAttachments(
                  attachments,
                  (await this.backend.capabilities())?.promptCapabilities ?? {},
                  this.config,
                )
              : attachments
          prompt.push(...readAttachmentBlocks(descriptors, this.config))
        } catch (error) {
          error.phase = error.phase ?? 'before_write'
          throw error
        }
      }
      job.phase = 'prompting'
      if (!this.save()) {
        throw Object.assign(
          new Error(`状态文件无法写入，ACP prompt 未发送：${this.config.stateFile}`),
          { code: 'state_write_failed', phase: 'before_write' },
        )
      }

      let promptPromise
      try {
        promptPromise = this.backend.promptSession({
          sessionId: job.conversationId,
          prompt,
          onPermission: (event) => this.recordPermission(job, event),
          onConfigUpdate: (options) =>
            this.applyActualConfig(job, options, 'acp_config_notification'),
          onToolEvent: (event) => this.recordActivity(job, event),
          ...(this.config.thoughtSummary === false ? {} : { onThought: (event) => this.recordThought(job, event) }),
        })
      } catch (error) {
        throw error
      }
      this.activePrompts.set(job.jobId, { promise: promptPromise, sessionId: job.conversationId })
      this.markAccepted(job, {
        ackEvidence: 'acp_session_prompt',
        message: 'ACP prompt 请求已写入本机 agy acp 子进程，等待对应的 session/prompt 结束。',
      })
      promptPromise.then(
        (result) => this.completeJob(job, result),
        (error) => this.failJob(job, error),
      )
      return job
    } catch (error) {
      const snapshot =
        errorConfigSnapshot(error) ??
        (session ? summarizeOptions(session.configOptions) : null)
      if (snapshot) {
        job.configOptions = snapshot
        job.effective = {
          ...job.effective,
          ...effectiveFromOptions(snapshot),
          source: 'acp_error_snapshot',
          verified: false,
        }
        error.configOptions = snapshot
      }
      this.failJob(job, error)
      return job
    }
  }

  completeJob(job, result) {
    this.activePrompts.delete(job?.jobId)
    if (!job || TERMINAL_STATUSES.has(job.status)) return job
    const permissions = Array.isArray(result?.permissions) ? result.permissions : job.permissions
    job.permissions = permissions
    const stopReason = String(result?.stopReason ?? '')
    job.stopReason = stopReason
    // The prompt result may carry the complete post-prompt configuration; it is
    // newer than the pre-dispatch confirmation and must be the reported actual.
    this.applyActualConfig(job, result?.configOptions, 'acp_prompt_result')
    const text = typeof result?.text === 'string' ? result.text : ''
    if (stopReason === 'end_turn' && text.trim() !== '') {
      this.finishReply(job, {
        text,
        tools: result.tools,
        stopReason,
        permissions,
      })
      void this.maybeWake(job).catch((error) => {
        this.logger?.warn?.(`antigravity-bridge: wake failed: ${error?.message ?? error}`)
      })
      return job
    }
    if (stopReason === 'end_turn') {
      return this.markFailure(job, 'failed', {
        code: 'empty_reply',
        message: 'ACP prompt 以 end_turn 结束，但没有可交付的 assistant 文本；没有唤醒。',
        configOptions: job.configOptions,
      })
    }
    if (stopReason === 'refusal') {
      const denied = permissions.length > 0
      return this.markFailure(job, 'failed', {
        code: denied ? 'permission_denied' : 'refusal',
        message: denied
          ? 'ACP prompt 因权限请求未获授权而拒绝；桥没有自动批准，也没有唤醒。'
          : 'ACP prompt 以 refusal 结束；没有唤醒。',
        configOptions: job.configOptions,
      })
    }
    if (stopReason === 'max_tokens') {
      return this.markFailure(job, 'failed', {
        code: 'truncated',
        message: 'ACP prompt 以 max_tokens 结束，内容可能被截断；不当作最终回复，也不唤醒。',
        configOptions: job.configOptions,
      })
    }
    if (stopReason === 'cancelled') {
      return this.markFailure(job, 'failed', {
        code: 'cancelled',
        message: 'ACP prompt 被取消；没有唤醒。',
        configOptions: job.configOptions,
      })
    }
    return this.markFailure(job, 'failed', {
      code: `stop_${stopReason || 'unknown'}`,
      message: `ACP prompt 以未支持的 stopReason“${stopReason || '空'}”结束；没有唤醒。`,
      configOptions: job.configOptions,
    })
  }

  failJob(job, error) {
    this.activePrompts.delete(job?.jobId)
    if (!job || TERMINAL_STATUSES.has(job.status)) return job
    const code = String(error?.code ?? 'acp_error')
    const message = String(error?.message ?? error)
    const snapshot = errorConfigSnapshot(error)
    if (snapshot) this.applyActualConfig(job, snapshot, 'acp_error_snapshot')
    if (error?.phase === 'before_write' || error?.phase === 'rejected') {
      return this.markFailure(job, 'not_sent', {
        code,
        message: `请求没有派发：${message}`,
        configOptions: snapshot ?? job.configOptions,
      })
    }
    return this.markAcceptanceUnknown(job, {
      code: 'acceptance_unknown',
      message: `ACP prompt 的结果不明，不会自动重发：${message}`,
      effective: job.effective,
      configOptions: snapshot ?? job.configOptions,
    })
  }

  // 仅保留最近 20 条，超限时最旧条目被挤出（在途项也可能被挤出）；面板 status 原样显示 ACP 英文值，本地化留待后续任务。
  recordActivity(job, event) {
    if (!job) return
    const normalized = normalizeActivityEvent(event)
    if (!normalized) return
    if (!Array.isArray(job.activity)) job.activity = []
    if (normalized.toolCallId !== '') {
      const index = job.activity.findIndex((e) => e.toolCallId === normalized.toolCallId)
      if (index >= 0) {
        const prev = job.activity[index]
        job.activity[index] = {
          toolCallId: normalized.toolCallId,
          kind: normalized.kind !== 'unknown' ? normalized.kind : prev.kind,
          title: normalized.title || prev.title,
          status: normalized.status || prev.status,
        }
      } else {
        job.activity.push(normalized)
        if (job.activity.length > MAX_ACTIVITY_PER_JOB) {
          job.activity = job.activity.slice(-MAX_ACTIVITY_PER_JOB)
        }
      }
    } else {
      job.activity.push(normalized)
      if (job.activity.length > MAX_ACTIVITY_PER_JOB) {
        job.activity = job.activity.slice(-MAX_ACTIVITY_PER_JOB)
      }
    }
    try {
      this.save()
    } catch {
      // Keep existing save tolerance; never throw from diagnostic activity hook.
    }
  }

  recordThought(job, event) {
    if (!job || this.config?.thoughtSummary === false) return
    const text = String(event?.text ?? event?.summary ?? '').trim().slice(0, MAX_THOUGHT_CHARS)
    if (text === '') return
    if (!Array.isArray(job.thoughts)) job.thoughts = []
    const last = job.thoughts[job.thoughts.length - 1]
    if (last && last.text === text) return
    job.thoughts.push({ text })
    if (job.thoughts.length > MAX_THOUGHTS_PER_JOB) {
      job.thoughts = job.thoughts.slice(-MAX_THOUGHTS_PER_JOB)
    }
    try {
      this.save()
    } catch {
      // Keep existing save tolerance; never throw from diagnostic thought hook.
    }
  }

  view(job) {
    const isDesktop = job.transport === DESKTOP_TRANSPORT
    const acpId = typeof job.conversationId === 'string' ? job.conversationId : ''
    const desktopId = typeof job.desktopConversationId === 'string' ? job.desktopConversationId : ''
    return {
      jobId: String(job.jobId ?? ''),
      workspaceRoot: String(job.workspaceRoot ?? ''),
      clientRequestId: String(job.clientRequestId ?? ''),
      transport: isDesktop ? DESKTOP_TRANSPORT : 'acp',
      conversationId: isDesktop ? '' : acpId,
      sessionId: isDesktop ? '' : acpId,
      desktopConversationId: desktopId,
      targetKind: isDesktop ? 'desktop_window' : 'acp_session',
      permissionPending: job.permissionPending === true,
      status: String(job.status ?? 'failed'),
      code: String(job.code ?? ''),
      message: String(job.message ?? ''),
      reply: typeof job.reply?.text === 'string' ? job.reply.text : '',
      tools: Array.isArray(job.reply?.tools) ? job.reply.tools : [],
      permissions: Array.isArray(job.permissions) ? job.permissions : [],
      activity: activityOf(job).map((e) => ({ ...e })),
      thoughts: thoughtOf(job).map((e) => ({ text: String(e?.text ?? '') })),
      wakeState: String(job.wakeState ?? 'none'),
      wakeAgent: String(job.wakeAgent ?? ''),
      wakeDeliveredVia: String(job.wakeDeliveredVia ?? ''),
      stopReason: String(job.stopReason ?? ''),
      cancelRequested: job.cancelRequested === true,
      runStatus: String(job.status ?? 'failed'),
      requested: requestedOf(job),
      effective: { ...defaultEffective(), ...(job.effective ?? {}) },
      confirmed: { ...defaultEffective(), ...(job.confirmed ?? {}) },
      configOptions: Array.isArray(job.configOptions) ? job.configOptions : [],
      fileMode: fileModeOf(requestedOf(job)),
      title: String(job.title ?? ''),
      ack: String(job.ack ?? ''),
      createdAt: String(job.createdAt ?? ''),
      updatedAt: String(job.updatedAt ?? ''),
    }
  }

  wakeText(job) {
    const tools = job.reply?.tools?.length ? `\n（本轮工具：${job.reply.tools.join('、')}）` : ''
    const label = job.title ? `「${job.title}」` : ''
    const target =
      job.transport === DESKTOP_TRANSPORT
        ? `桌面会话 ${job.desktopConversationId || job.desktopLockKey || job.targetKey || '（固定窗口）'}`
        : `ACP 会话 ${job.conversationId}`
    return (
      `[Antigravity 回复] job ${job.jobId} · ${target}${label} 已完成并回复：\n\n` +
      clampText(job.reply?.text ?? '', this.config.maxReplyChars) +
      tools
    )
  }

  wakeSignal() {
    return this.wakeAbort.signal
  }

  async resolveWakeAgent(job, live) {
    const targetName = String(job?.wakeAgent ?? '').trim()
    if (targetName === '') {
      return { agent: live, targetId: '', via: 'followup', subagents: null }
    }
    const signal = this.wakeSignal()
    const subagents = typeof this.ctx?.get === 'function' ? this.ctx.get('subagents') : this.ctx?.subagents
    if (subagents && typeof subagents.resolveName === 'function' && typeof subagents.sendMessage === 'function') {
      try {
        const targetId = await subagents.resolveName(live, targetName, signal)
        if (targetId) {
          return { agent: live, targetId: String(targetId), via: 'subagents', subagents }
        }
      } catch (error) {
        if (error?.name === 'AbortError' || signal.aborted) {
          return { agent: live, targetId: '', via: 'aborted', subagents: null }
        }
        this.trace(
          `wake-resolve-failed job=${job.jobId} wakeAgent=${targetName} error=${error?.code ?? error?.message ?? error}`,
        )
      }
    }
    const fallbackAgent = this.agentOf(targetName) || live
    return { agent: fallbackAgent, targetId: '', via: 'followup', subagents: null }
  }

  /**
   * Deliver one wake through the owning Agent or configured AgentTeams member.
   * A reply stays readable with the job id even when the session is gone.
   */
  async maybeWake(job) {
    if (this.closed) return false
    if (!this.config.autoWake) return false
    if (job.status !== 'replied') return false
    if (this.waiterCount(job.jobId) > 0) return false
    // Only a persisted pending wake may start. A concurrent caller therefore
    // sees "delivering" and leaves the single delivery to its owner.
    if (job.wakeState !== 'pending') {
      this.trace(`wake-rejected job=${job.jobId} state=${job.wakeState} reason=already_triggered`)
      return false
    }
    if (this.waking.has(job.jobId)) return false
    this.waking.add(job.jobId)
    try {
      job.wakeState = 'delivering'
      job.updatedAt = nowIso()
      // The delivery checkpoint must be durable before followup. Otherwise a
      // restart would read an older "pending" state and wake the same DSH
      // session twice after this process already delivered once.
      if (!this.save()) {
        job.wakeState = 'pending'
        job.updatedAt = nowIso()
        this.trace(`wake-checkpoint-failed job=${job.jobId} agent=${job.ownerAgentId}`)
        return false
      }
      const live = this.agentOf(job.ownerAgentId)
      if (!live) {
        job.wakeState = 'pending'
        job.wakeTries = Number(job.wakeTries ?? 0) + 1
        job.updatedAt = nowIso()
        this.save()
        if (job.wakeTries % 15 === 1) {
          this.trace(`wake-pending job=${job.jobId} agent=${job.ownerAgentId} tries=${job.wakeTries}`)
        }
        return false
      }
      const target = await this.resolveWakeAgent(job, live)
      if (target.via === 'aborted' || this.wakeSignal().aborted) {
        this.trace(`wake-abandoned job=${job.jobId} reason=signal_aborted`)
        return false
      }
      if (!this.stillOwns(job)) {
        this.trace(`wake-abandoned job=${job.jobId} reason=disposed_after_resolve`)
        return false
      }
      const text = this.wakeText(job)
      if (target.via === 'subagents') {
        try {
          await target.subagents.sendMessage(live, target.targetId, [{ type: 'text', text }], { signal: this.wakeSignal() })
          job.wakeDeliveredVia = 'subagents'
        } catch (error) {
          if (error?.name === 'AbortError' || this.wakeSignal().aborted) {
            this.trace(`wake-abandoned job=${job.jobId} reason=signal_aborted`)
            return false
          }
          // DSH sendMessage uses steer inbox acceptance semantics: errors outside the
          // pre-acceptance refusal allowlist may occur after queuing, so never retry/fallback.
          const errCode = typeof error?.code === 'string' ? error.code : ''
          let fallbackAgent = null
          if (errCode === 'UNAUTHORIZED') {
            if (String(live?.id ?? '') === String(target.targetId ?? '')) {
              fallbackAgent = live
            } else {
              job.wakeState = 'delivery_unknown'
              job.wakeTries = Number(job.wakeTries ?? 0) + 1
              job.updatedAt = nowIso()
              this.save()
              this.trace(`wake-forbidden job=${job.jobId} target=${target.targetId} reason=cross_tree_or_unknown_id`)
              return false
            }
          } else if (!WAKE_FALLBACK_CODES.has(errCode)) {
            job.wakeState = 'delivery_unknown'
            job.wakeTries = Number(job.wakeTries ?? 0) + 1
            job.updatedAt = nowIso()
            this.save()
            this.trace(`wake-unknown job=${job.jobId} target=${target.targetId} code=${errCode || 'unknown'}`)
            return false
          } else {
            fallbackAgent = this.agentOf(target.targetId) || this.agentOf(job.wakeAgent) || live
          }
          this.trace(
            `wake-subagents-failed job=${job.jobId} target=${target.targetId} error=${error?.code ?? error?.message ?? error}`,
          )
          let createUserMessage
          try {
            createUserMessage = await this.messageFactory()
          } catch (factoryErr) {
            if (!this.stillOwns(job)) {
              this.trace(`wake-abandoned job=${job.jobId} error=${factoryErr?.message ?? factoryErr}`)
              return false
            }
            job.wakeState = 'pending'
            job.wakeTries = Number(job.wakeTries ?? 0) + 1
            job.updatedAt = nowIso()
            this.save()
            this.trace(`wake-factory-failed job=${job.jobId} error=${factoryErr?.message ?? factoryErr}`)
            return false
          }
          if (!this.stillOwns(job)) {
            this.trace(`wake-abandoned job=${job.jobId} reason=disposed_before_fallback_followup`)
            return false
          }
          let fallbackMessage
          try {
            fallbackMessage = createUserMessage({
              content: [{ type: 'text', text }],
              source: { kind: 'user' },
            })
          } catch (msgErr) {
            if (!this.stillOwns(job)) {
              this.trace(`wake-abandoned job=${job.jobId} error=${msgErr?.message ?? msgErr}`)
              return false
            }
            job.wakeState = 'pending'
            job.wakeTries = Number(job.wakeTries ?? 0) + 1
            job.updatedAt = nowIso()
            this.save()
            this.trace(`wake-message-failed job=${job.jobId} error=${msgErr?.message ?? msgErr}`)
            return false
          }
          if (!this.stillOwns(job)) {
            this.trace(`wake-abandoned job=${job.jobId} reason=disposed_before_fallback_followup`)
            return false
          }
          try {
            fallbackAgent.followup(fallbackMessage)
            job.wakeDeliveredVia = 'followup'
          } catch (followupErr) {
            job.wakeState = 'delivery_unknown'
            job.wakeTries = Number(job.wakeTries ?? 0) + 1
            job.updatedAt = nowIso()
            this.save()
            this.trace(`wake-unknown job=${job.jobId} agent=${job.wakeAgent || job.ownerAgentId} error=${followupErr?.message ?? followupErr}`)
            return false
          }
        }
      } else {
        let createUserMessage
        try {
          createUserMessage = await this.messageFactory()
        } catch (error) {
          if (!this.stillOwns(job)) {
            // The instance went away while the factory was pending. Leave the
            // durable "delivering" checkpoint untouched: it must never become an
            // auto-retryable "pending" wake from a dead instance.
            this.trace(`wake-abandoned job=${job.jobId} error=${error?.message ?? error}`)
            return false
          }
          job.wakeState = 'pending'
          job.wakeTries = Number(job.wakeTries ?? 0) + 1
          job.updatedAt = nowIso()
          this.save()
          this.trace(`wake-factory-failed job=${job.jobId} error=${error?.message ?? error}`)
          return false
        }
        if (!this.stillOwns(job)) {
          // Re-checked after the await and before any message is built: a
          // disposed/replaced instance must not deliver, and must not rewrite a
          // "delivering" checkpoint into something a restart would retry.
          this.trace(`wake-abandoned job=${job.jobId} reason=disposed_after_factory`)
          return false
        }
        let message
        try {
          message = createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
          })
        } catch (error) {
          if (!this.stillOwns(job)) {
            this.trace(`wake-abandoned job=${job.jobId} error=${error?.message ?? error}`)
            return false
          }
          job.wakeState = 'pending'
          job.wakeTries = Number(job.wakeTries ?? 0) + 1
          job.updatedAt = nowIso()
          this.save()
          this.trace(`wake-message-failed job=${job.jobId} error=${error?.message ?? error}`)
          return false
        }
        if (!this.stillOwns(job)) {
          this.trace(`wake-abandoned job=${job.jobId} reason=disposed_before_followup`)
          return false
        }
        try {
          target.agent.followup(message)
          job.wakeDeliveredVia = 'followup'
        } catch (error) {
          // followup may have queued the message before throwing. Retrying could
          // wake the same session twice, so leave the outcome explicitly unknown.
          job.wakeState = 'delivery_unknown'
          job.wakeTries = Number(job.wakeTries ?? 0) + 1
          job.updatedAt = nowIso()
          this.save()
          this.trace(`wake-unknown job=${job.jobId} agent=${job.ownerAgentId} error=${error?.message ?? error}`)
          return false
        }
      }
      job.wakeState = 'delivered'
      job.updatedAt = nowIso()
      // followup has already happened. If the delivered marker cannot be
      // persisted, keep the durable "delivering" checkpoint as the recovery
      // signal and never retry: restart maps it to delivery_unknown.
      if (!this.save()) {
        job.wakeState = 'delivery_unknown'
        job.updatedAt = nowIso()
        this.trace(`wake-delivered-persist-failed job=${job.jobId} agent=${job.ownerAgentId}`)
      }
      return true
    } finally {
      this.waking.delete(job.jobId)
    }
  }

  /** Count waiters per job so one waiter leaving cannot suppress another. */
  beginWaiter(jobId) {
    const key = String(jobId)
    this.waiters.set(key, (this.waiters.get(key) ?? 0) + 1)
  }

  endWaiter(jobId) {
    const key = String(jobId)
    const count = this.waiters.get(key) ?? 0
    if (count <= 1) this.waiters.delete(key)
    else this.waiters.set(key, count - 1)
  }

  waiterCount(jobId) {
    return this.waiters.get(String(jobId)) ?? 0
  }

  /**
   * ACP sends session/cancel and waits for the actual stopReason. Desktop has no
   * verified Stop control, so cancel only stops local observation: the app may
   * still be generating and this is reported as such.
   */
  async cancelJob(job, { timeoutMs = 10000 } = {}) {
    if (!job) return { job, cancelSent: false, settled: false }
    if (TERMINAL_STATUSES.has(job.status)) return { job, cancelSent: false, settled: true }
    const active = this.activePrompts.get(job.jobId)
    if (!active) {
      if (
        job.transport === DESKTOP_TRANSPORT &&
        !this.desktop?.controllers?.has(job.jobId) &&
        (job.status === 'acceptance_unknown' || job.status === 'accepted' || job.status === 'prompting')
      ) {
        const releaseNote = '只解除桥侧占用，不代表应用侧没收到该轮，请人工确认'
        job.status = 'cancelled'
        job.phase = 'cancelled'
        job.code = 'desktop_released_by_user'
        job.message = releaseNote
        job.detail = {
          ...(job.detail && typeof job.detail === 'object' ? job.detail : {}),
          releaseNote,
        }
        job.updatedAt = nowIso()
        this.releaseLock(job)
        this.save()
        return {
          job,
          cancelSent: false,
          released: true,
          settled: true,
          stopControl: 'unavailable',
          message: releaseNote,
        }
      }
      return {
        job,
        cancelSent: false,
        settled: false,
        stopControl: job.transport === DESKTOP_TRANSPORT ? 'unavailable' : undefined,
        error: {
          code: 'not_cancellable',
          message:
            job.transport === DESKTOP_TRANSPORT
              ? '这个桌面 job 当前没有在途观察，无法停止本地轮询。'
              : '这个 job 当前没有在途 ACP prompt，无法发送 session/cancel。',
        },
      }
    }
    job.cancelRequested = true
    job.message =
      job.transport === DESKTOP_TRANSPORT
        ? '已停止本地观察；桌面驱动没有经过验证的 Stop 控件，应用端生成可能仍在继续。'
        : '已发送 session/cancel；等待 ACP 返回实际 stopReason。'
    job.updatedAt = nowIso()
    this.save()
    if (job.transport === DESKTOP_TRANSPORT) {
      this.desktop.cancel(job)
      const settledDesktop = await Promise.race([
        active.promise.then(
          () => true,
          () => true,
        ),
        sleep(Math.max(100, Number(timeoutMs) || 10000)).then(() => false),
      ])
      return { job, cancelSent: false, stopControl: 'unavailable', settled: settledDesktop }
    }
    try {
      this.backend.cancelSession(job.conversationId)
    } catch (error) {
      return {
        job,
        cancelSent: false,
        settled: false,
        error: {
          code: 'cancel_failed',
          message: `发送 session/cancel 失败：${error?.message ?? error}`,
        },
      }
    }
    const settled = await Promise.race([
      active.promise.then(
        () => true,
        () => true,
      ),
      sleep(Math.max(100, Number(timeoutMs) || 10000)).then(() => false),
    ])
    return { job, cancelSent: true, settled }
  }

  /** Blocking wait; a timeout leaves the job and its cached state untouched. */
  async waitFor(job, { timeoutMs = 180000, signal } = {}) {
    this.beginWaiter(job.jobId)
    const deadline = Date.now() + Math.max(100, Number(timeoutMs) || 1000)
    try {
      for (;;) {
        if (job.status === 'replied') {
          if (job.wakeState !== 'delivered') {
            job.wakeState = 'suppressed'
            job.updatedAt = nowIso()
            this.save()
          }
          return { timedOut: false, replied: true }
        }
        if (TERMINAL_STATUSES.has(job.status)) return { timedOut: false }
        if (Date.now() >= deadline) return { timedOut: true }
        try {
          await sleep(Math.min(this.config.waitPollMs, Math.max(50, deadline - Date.now())), signal)
        } catch {
          return { timedOut: false, interrupted: true }
        }
      }
    } finally {
      this.endWaiter(job.jobId)
    }
  }

  /** Non-blocking read. It never starts a backend call. */
  readJob(job) {
    return this.view(job)
  }

  listJobs(agentId, limit = 10) {
    return this.jobs(agentId)
      .slice(0, Math.max(1, Math.min(50, limit)))
      .map((job) => {
        const isDesktop = job.transport === DESKTOP_TRANSPORT
        return {
          jobId: String(job.jobId ?? ''),
          clientRequestId: String(job.clientRequestId ?? ''),
          transport: isDesktop ? DESKTOP_TRANSPORT : 'acp',
          conversationId: isDesktop ? '' : typeof job.conversationId === 'string' ? job.conversationId : '',
          sessionId: isDesktop ? '' : typeof job.conversationId === 'string' ? job.conversationId : '',
          desktopConversationId: isDesktop ? String(job.desktopConversationId ?? '') : '',
          targetKind: isDesktop ? 'desktop_window' : 'acp_session',
          title: String(job.title ?? ''),
          status: String(job.status ?? 'failed'),
          code: String(job.code ?? ''),
          wakeState: String(job.wakeState ?? 'none'),
          createdAt: String(job.createdAt ?? ''),
          updatedAt: String(job.updatedAt ?? ''),
        }
      })
  }

  /**
   * Wake pending replies. Desktop rounds own their observation loop, so this
   * pass only re-delivers completed replies (never polls the app itself).
   */
  async tick() {
    if (this.ticking) return
    this.ticking = true
    try {
      for (const job of Object.values(this.state.jobs)) {
        if (!job || typeof job !== 'object') continue
        if (job.status === 'replied') await this.maybeWake(job)
      }
    } catch (error) {
      this.logger?.warn?.(`antigravity-bridge: watcher pass failed: ${error?.message ?? error}`)
    } finally {
      this.ticking = false
    }
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), this.config.pollMs)
    this.timer.unref?.()
  }

  /**
   * Probe Antigravity CLI authentication status on-demand without reading any
   * credential files or starting persistent polling.
   */
  async cliAuthStatus() {
    if (this.closed) return { ok: false, status: 'unknown', code: 'bridge_closed', authMethods: [] }
    const installation = this.config.cliProbe ? await this.config.cliProbe(this.config) : await probeCli(this.config)
    if (installation.installation !== 'available') return { ...installation, ok: false, status: 'unknown', authMethods: [] }
    try { loginArgs(this.config) } catch (error) { return { ...installation, ok: false, status: 'unknown', code: error.code, message: `CLI 数据目录未配置或不可用，无法确认可写性；不会使用默认账户目录。${error.message}`, authMethods: [] } }
    const useInjected = this.config.backend !== undefined
    const client = useInjected ? this.backend : acpBackend(this.config, {})
    let authMethods = []
    try {
      const caps = await client.ready()
      authMethods = Array.isArray(caps?.authMethods) ? caps.authMethods : []
      // agy 1.5.14 advertises the SAME authentication menu AND accepts
      // session/new for both known-login and empty data. Neither proves auth.
      // A protocol backend may provide a separately verified status operation;
      // the official current backend does not, so remain honest and unknown.
      if (typeof client.authStatus === 'function') {
        const verified = await client.authStatus()
        if (verified?.status === 'loggedin' || verified?.status === 'unauthenticated') return { ...installation, ...verified, authMethods }
      }
      if (typeof client.createSession === 'function') await client.createSession({ cwd: this.config.cwd })
      return { ...installation, ok: true, status: 'unknown', code: 'auth_status_unknown', authMethods, message: 'CLI 可用；当前协议不能可靠区分已登录与未登录。请在登录终端完成授权后自行确认，静默检测不发送模型请求。' }
    } catch (error) {
      const required = error?.data?.rpcCode === -32000 && /authenticat(?:ion|e).*required|not authenticated|not logged in|unauthenticated/i.test(error.message || '')
      const denied = /access is denied|permission denied/i.test(error?.message || '')
      return { ...installation, installation: denied ? 'unusable' : installation.installation, ok: false, status: required ? 'unauthenticated' : 'unknown', code: denied ? 'cli_data_unavailable' : error?.code || 'auth_probe_failed', message: denied ? 'CLI 数据目录不可写（installation_id / Access is denied）；请检查桥配置的数据目录权限。' : required ? 'Antigravity CLI 需要登录。' : '无法通过 ACP session/new 确认登录状态。', authMethods }
    } finally {
      if (!useInjected) { try { client.close?.() } catch {} }
    }
  }

  async cliLogin() {
    if (this.closed) return { ok: false, status: 'unknown', flow: 'none', code: 'bridge_closed' }
    const probe = await this.cliAuthStatus()
    if (probe.installation !== 'available') return { ...probe, flow: 'none' }
    if (probe.status === 'loggedin') return { ...probe, flow: 'already_logged_in', message: 'Antigravity CLI 已登录。' }
    if (probe.status === 'unauthenticated' && probe.authMethods?.length) {
      const client = this.config.backend !== undefined ? this.backend : acpBackend(this.config, {})
      try {
        await client.ready()
        await client.authenticate(probe.authMethods[0].id)
        const recheck = await this.cliAuthStatus()
        if (recheck.status === 'loggedin') return { ...recheck, flow: 'acp_authenticate', message: '已通过官方 ACP 认证完成登录。' }
      } catch {} finally { if (this.config.backend === undefined) client.close?.() }
    }
    try {
      const args = loginArgs(this.config)
      const terminal = await (this.config.cliLoginLauncher || launchLoginTerminal)({ executable: this.config.agyExecutable, args, cwd: this.config.cwd })
      return { ok: true, installation: 'available', status: 'unknown', flow: 'terminal', terminalPid: terminal?.pid, message: '已打开可见终端运行 agy acp --login（沿用桥的数据目录）。请完成后点击“刷新登录状态”。' }
    } catch (error) {
      return { ok: false, status: 'unknown', flow: 'terminal', code: error?.code || 'cli_login_spawn_failed', message: error?.message || '无法打开登录终端。' }
    }
  }
  dispose() {
    // Invalidate this instance before anything else: a late observation from a
    // channel must not commit, release a lock or wake after dispose.
    this.closed = true
    try {
      this.wakeAbort?.abort()
    } catch {}
    try {
      this.desktop?.stop()
    } catch {
      // Stopping observation is best-effort; the closed flag is the guard.
    }
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    try {
      this.backend.close?.()
    } catch {
      // The child may already be gone.
    }
  }
}

export { attachmentInfo }