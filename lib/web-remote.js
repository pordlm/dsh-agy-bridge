/**
 * Web Host service + typed Remote contribution for the Antigravity panel.
 *
 * The panel calls one Host service. Every method receives the Agent resolved by
 * the session-scoped Gateway, so ownership always comes from the call context,
 * never from a browser-supplied session id. This file keeps the same Bridge
 * instance used by the model tools; it does not own a second job store.
 */

import { resolveHostWorkspace } from './workspace.js'
import { getNativeActivity } from './model-adapter.js'
import { PROVIDER_ID, listModelInfos } from './model-catalog.js'
import { normalizeDesktopError } from './desktop.js'
import { statSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'

const CLI_AMBIGUOUS_REASON = 'protocol_ambiguous'

function cliDataRoot(config) {
  const args = Array.isArray(config?.agyArgs) ? config.agyArgs : []
  let dataRoot = ''
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--gemini-dir' || arg === '--app-data-dir') dataRoot = args[i + 1] || ''
    else if (/^--(?:gemini-dir|app-data-dir)=/.test(arg)) dataRoot = arg.slice(arg.indexOf('=') + 1)
  }
  return dataRoot && isAbsolute(dataRoot) && !dataRoot.includes('\0') ? dataRoot : null
}

function probeDataRoot(dataDir) {
  if (!dataDir) {
    return { dataDir: null, writable: false, dataDirError: 'EUNCONFIGURED: config.agyArgs does not set --gemini-dir or --app-data-dir' }
  }
  const probeFile = join(dataDir, `.antigravity-bridge-write-probe-${process.pid}-${Date.now().toString(36)}.tmp`)
  let wrote = false
  try {
    const stat = statSync(dataDir)
    if (!stat.isDirectory()) {
      return { dataDir, writable: false, dataDirError: 'ENOTDIR: CLI data root is not a directory' }
    }
    writeFileSync(probeFile, '', 'utf8')
    wrote = true
    return { dataDir, writable: true, dataDirError: null }
  } catch (err) {
    const code = err && err.code ? String(err.code) : ''
    const message = String((err && (err.message || err)) || '')
    return {
      dataDir,
      writable: false,
      dataDirError: code && !message.startsWith(`${code}: `) ? `${code}: ${message}` : message,
    }
  } finally {
    if (wrote) {
      try { unlinkSync(probeFile) } catch {}
    }
  }
}

export const BRIDGE_SERVICE = 'antigravityBridge'
export const REMOTE_PACKAGE = 'dsh-agy-bridge'
export const REMOTE_LOOKUP = 'agent'
export const REMOTE_LOOKUP_WIRE = 'agentId'
export const REMOTE_METHODS = Object.freeze([
  'capabilities',
  'dispatch',
  'status',
  'reply',
  'cancel',
  'activity',
  'nativeActivity',
  'authStatus',
  'login',
  'refreshModels',
  'desktopStatus',
  'desktopPin',
  'desktopDetect',
])
export const REMOTE_DESCRIPTOR =
  '@deepseek-ai/dsh-typert-protocol/remote-methods'

const MAX_MESSAGE_CHARS = 100_000
const MAX_PATH_REFS = 20
const MAX_ATTACHMENTS = 10

function errorResult(code, message, extra = {}) {
  return { ok: false, code, message, ...extra }
}

function agentSessionId(agent) {
  const raw = agent?.session?.id ?? agent?.session?.sessionId ?? agent?.sessionId ?? agent?.id
  return typeof raw === 'string' ? raw : ''
}

function requireAgent(agent) {
  if (!agent || typeof agent !== 'object') throw new Error('session_unknown')
}

function mergeQuarantined(...lists) {
  const merged = []
  const seen = new Set()
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const item of list) {
      if (!item || typeof item !== 'object') continue
      const key = `${String(item.file ?? '')}\u0000${String(item.renamedTo ?? '')}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(item)
    }
  }
  return merged.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')))
}

function ownedJob(bridge, agent, jobId) {
  if (typeof jobId !== 'string' || jobId === '') return { error: errorResult('invalid_request', 'jobId is required') }
  const job = bridge.job(jobId)
  if (!job) return { error: errorResult('job_not_found', 'no such job') }
  if (job.ownerAgentId !== String(agent.id)) return { error: errorResult('forbidden', 'job belongs to another session') }
  return { job }
}

function normalizePathRefs(input) {
  if (input === undefined) return { paths: [] }
  if (!Array.isArray(input)) return { error: errorResult('invalid_request', 'pathRefs must be an array') }
  if (input.length > MAX_PATH_REFS) return { error: errorResult('invalid_request', `pathRefs max ${MAX_PATH_REFS}`) }
  const seen = new Set()
  const paths = []
  for (const raw of input) {
    if (typeof raw !== 'string' || raw.trim() === '') return { error: errorResult('invalid_path', 'pathRefs entries must be strings') }
    const value = raw.trim()
    if (/^[\\/]{2}[.?][\\/]/.test(value) || /^[\\/]{2}[^\\/]/.test(value)) {
      return { error: errorResult('invalid_path', `device/UNC path rejected: ${value}`) }
    }
    if (!isAbsolute(value)) return { error: errorResult('invalid_path', `absolute path required: ${value}`) }
    let stat
    try {
      stat = statSync(value)
    } catch {
      return { error: errorResult('invalid_path', `path not readable: ${value}`) }
    }
    if (!stat.isFile()) return { error: errorResult('invalid_path', `not a regular file: ${value}`) }
    const normalized = normalize(value)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    paths.push(normalized)
  }
  return { paths }
}

function resolveReceipts(ctx, agent, receipts) {
  if (receipts === undefined) return { paths: [], info: [] }
  if (!Array.isArray(receipts)) return { error: errorResult('invalid_request', 'attachments must be an array') }
  if (receipts.length > MAX_ATTACHMENTS) return { error: errorResult('invalid_request', `attachments max ${MAX_ATTACHMENTS}`) }
  const uploads = typeof ctx.get === 'function' ? ctx.get('fileUploads') : undefined
  const attachments = typeof ctx.get === 'function' ? ctx.get('attachments') : undefined
  if (!uploads || !attachments || typeof uploads.resolve !== 'function' || typeof attachments.fileHostPath !== 'function') {
    return { error: errorResult('unsupported_capability', 'DSH session upload/attachment service is unavailable') }
  }
  const paths = []
  const info = []
  for (const receiptId of receipts) {
    if (typeof receiptId !== 'string' || receiptId === '') return { error: errorResult('invalid_request', 'attachment receipt must be a string') }
    const staged = uploads.resolve(agent, receiptId)
    if (!staged) return { error: errorResult('attachment_receipt_invalid', 'receipt is unknown or belongs to another session') }
    if (staged.type !== 'file') return { error: errorResult('attachment_receipt_invalid', 'only verbatim file receipts are supported') }
    const hostPath = attachments.fileHostPath(staged.attachment)
    if (typeof hostPath !== 'string' || hostPath === '') {
      return { error: errorResult('attachment_unavailable', 'DSH attachment has no host path') }
    }
    paths.push(hostPath)
    info.push({
      name: staged.attachment.name ?? '',
      bytes: Number(staged.attachment.bytes ?? 0),
      receiptId,
    })
  }
  return { paths, info }
}

function pathReferenceBlock(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return ''
  return `\n\n[path_reference]\n${paths.map((path) => `- ${path}`).join('\n')}`
}

const TERMINAL_STATES = new Set(['replied', 'failed', 'cancelled'])

function publicView(job, bridge) {
  const view = bridge.view(job)
  const permission = Array.isArray(view.permissions) && view.permissions.length > 0
  const waitingPermission = (permission || view.permissionPending === true) && !TERMINAL_STATES.has(view.status)
  return {
    jobId: view.jobId,
    workspaceRoot: view.workspaceRoot,
    transport: view.transport === 'desktop' ? 'desktop' : 'acp',
    state: view.status,
    status: view.status,
    conversationId: view.conversationId,
    sessionId: view.sessionId,
    desktopConversationId: view.desktopConversationId ?? '',
    targetKind: view.targetKind,
    title: view.title,
    code: view.code,
    message: view.message,
    wakeState: view.wakeState,
    stopReason: view.stopReason,
    cancelRequested: view.cancelRequested,
    requested: view.requested,
    effective:
      view.transport === 'desktop'
        ? {
            model: null,
            effort: null,
            profile: '',
            source: 'desktop_window_current',
            verified: false,
            summary: '实际：使用窗口当前设置（桌面通道不切换模型与思考强度）',
          }
        : view.effective,
    confirmed: view.confirmed,
    reply: view.reply,
    permissions: view.permissions,
    configOptions: view.configOptions,
    fileMode: view.fileMode,
    permissionPending: view.permissionPending === true,
    detail: { phase: waitingPermission ? 'permission' : view.status },
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  }
}

export class AntigravityBridgeService {
  constructor({ ctx, bridge, config, adapter = null }) {
    this.ctx = ctx
    this.bridge = bridge
    this.config = config
    this.adapter = adapter
    this.name = BRIDGE_SERVICE
    /** Fast path for the current Host generation; the job store survives reloads. */
    this.clientRequests = new Map()
    this._refreshInFlight = null
    this._desktopStatusInFlight = null
    this._desktopPinInFlight = null
    this._desktopDetectInFlight = null
    this._lastRefreshAt = 0
    this._lastRefreshResult = null
    this.typertRemote = Object.freeze({ service: this, serviceKey: BRIDGE_SERVICE, namespace: BRIDGE_SERVICE })
  }

  /** One dispatch intent per (owner, clientRequestId), before and after a reload. */
  existingDispatch(agentId, clientRequestId) {
    if (clientRequestId === '') return null
    const key = `${agentId}\u0000${clientRequestId}`
    const remembered = this.clientRequests.get(key)
    if (remembered) {
      const job = this.bridge.job(remembered)
      if (job && String(job.ownerAgentId) === agentId) return job
      this.clientRequests.delete(key)
    }
    const job = this.bridge
      .jobs(agentId)
      .find((entry) => entry.clientRequestId === clientRequestId)
    if (job) this.clientRequests.set(key, job.jobId)
    return job ?? null
  }

  rememberDispatch(agentId, clientRequestId, jobId) {
    if (clientRequestId === '') return
    this.clientRequests.set(`${agentId}\u0000${clientRequestId}`, jobId)
  }

  async capabilities(agent) {
    requireAgent(agent)
    const uploads = typeof this.ctx.get === 'function' ? this.ctx.get('fileUploads') : undefined
    const attachments = typeof this.ctx.get === 'function' ? this.ctx.get('attachments') : undefined
    const desktop = this.bridge.desktop.capabilities()
    let models = Array.isArray(this.config.models) && this.config.models.length > 0 ? this.config.models : []
    if (models.length === 0 && this.adapter && typeof this.adapter.listModels === 'function') {
      try {
        models = (await this.adapter.listModels()).map((m) => m.id)
      } catch {
        models = []
      }
    }
    return {
      ok: true,
      capabilities: {
        transports: desktop.transports,
        models,
        efforts: Array.isArray(this.config.efforts) ? this.config.efforts : [],
        attachments: {
          pathRefs: true,
          uploadReceipt: Boolean(uploads && attachments && typeof uploads.resolve === 'function'),
        },
        profile: false,
        desktop: desktop.desktop === true,
        target: desktop.target,
        desktopCapabilities: {
          enabled: desktop.desktop === true,
          target: desktop.target,
          models: desktop.models,
          efforts: desktop.efforts,
          attachments: desktop.attachments,
          evidence: desktop.evidence,
        },
        machineId: this.bridge.machineId ?? null,
        quarantined: mergeQuarantined(
          this.bridge.quarantined,
          this.bridge.desktop?.quarantined,
          this.adapter?.quarantined,
        ),
      },
    }
  }

  /**
   * 只读刷新模型目录：强制重探、单飞、1s 频控，失败显式返回错误码+原因。
   */
  async refreshModels(agent) {
    requireAgent(agent)
    if (this._refreshInFlight) return this._refreshInFlight
    const nowMs = Date.now()
    if (this._lastRefreshResult && nowMs - this._lastRefreshAt < 1000) {
      return { ...this._lastRefreshResult, cached: true }
    }
    if (!this.adapter || typeof this.adapter.getCatalog !== 'function') {
      return errorResult('model_provider_disabled', '原生模型适配器未启用，无法刷新模型目录。')
    }
    this._refreshInFlight = (async () => {
      const startedAt = Date.now()
      try {
        const snapshot = await this.adapter.getCatalog({ force: true, allowFallback: false })
        const models = listModelInfos(snapshot.entries)
        const result = {
          ok: true,
          models,
          discoveredAt: snapshot.discoveredAt ?? new Date().toISOString(),
          elapsedMs: snapshot.elapsedMs ?? (Date.now() - startedAt),
          degraded: Array.isArray(snapshot.degraded) ? snapshot.degraded : [],
        }
        this._lastRefreshAt = Date.now()
        this._lastRefreshResult = result
        try { this.ctx?.emit?.('llm/models-updated', PROVIDER_ID) } catch {}
        return result
      } catch (error) {
        const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'catalog_refresh_failed'
        const message = String(error?.message ?? error)
        return errorResult(code, message)
      } finally {
        this._refreshInFlight = null
      }
    })()
    return this._refreshInFlight
  }

  async dispatch(agent, request) {
    requireAgent(agent)
    const payload = request ?? {}
    const agentId = String(agent.id)
    const clientRequestId =
      typeof payload.clientRequestId === 'string' ? payload.clientRequestId.trim() : ''
    if (clientRequestId.length > 200) {
      return errorResult('invalid_request', 'clientRequestId max 200')
    }
    // Reuse the first dispatch for this owner's intent. This is deliberately
    // checked before validation and before any await: a retry after an ambiguous
    // acceptance must only read the original job, never create a second prompt.
    const existing = this.existingDispatch(agentId, clientRequestId)
    if (existing) {
      return {
        ok: true,
        reused: true,
        jobId: existing.jobId,
        status: existing.status,
        view: publicView(existing, this.bridge),
      }
    }
    const message = typeof payload.message === 'string' ? payload.message.trim() : ''
    if (message === '') return errorResult('invalid_request', 'message is empty')
    if (message.length > MAX_MESSAGE_CHARS) return errorResult('message_too_long', `message max ${MAX_MESSAGE_CHARS}`)
    const transport = typeof payload.transport === 'string' && payload.transport !== '' ? payload.transport : 'acp'
    if (transport !== 'acp' && transport !== 'desktop') {
      return errorResult('invalid_request', `transport must be 'acp' or 'desktop' (got ${transport})`)
    }
    if (transport === 'desktop') {
      if (!this.bridge.desktop.enabled) {
        return errorResult('desktop_disabled', 'desktop transport is not enabled in this profile')
      }
      const conversationId = typeof payload.conversationId === 'string' ? payload.conversationId.trim() : ''
      if (conversationId !== '') {
        return errorResult('unsupported_capability', 'desktop only drives the one configured window; conversationId is not accepted')
      }
      const model = typeof payload.model === 'string' ? payload.model.trim() : ''
      const effort = typeof payload.effort === 'string' ? payload.effort.trim() : ''
      if (model !== '' || effort !== '') {
        return errorResult('unsupported_capability', 'desktop model/effort switching is unverified; use ACP')
      }
      if (Array.isArray(payload.attachments) && payload.attachments.length > 0) {
        return errorResult('unsupported_capability', 'desktop native attachments are unverified; use pathRefs')
      }
    }
    if (payload.profile !== undefined && payload.profile !== '') {
      return errorResult('unsupported_capability', 'profile is not supported on either transport')
    }
    const refs = normalizePathRefs(payload.pathRefs)
    if (refs.error) return refs.error
    const receipts = transport === 'desktop' ? { paths: [], info: [] } : resolveReceipts(this.ctx, agent, payload.attachments)
    if (receipts.error) return receipts.error
    const dispatchMessage = `${message}${pathReferenceBlock(refs.paths)}`

    let workspaceRoot = ''
    try { if (transport === 'acp') workspaceRoot = resolveHostWorkspace(this.ctx, agent, this.config) }
    catch (error) { return errorResult(error.code, error.message) }
    const begun = this.bridge.beginSend({
      workspaceRoot,
      agentId,
      conversationId: transport === 'desktop' ? '' : typeof payload.conversationId === 'string' ? payload.conversationId.trim() : '',
      transport,
      message: dispatchMessage,
      clientRequestId,
      title: '',
      requested: {
        model: transport === 'desktop' ? '' : typeof payload.model === 'string' ? payload.model.trim() : '',
        effort: transport === 'desktop' ? '' : typeof payload.effort === 'string' ? payload.effort.trim() : '',
        profile: '',
        pathRefs: refs.paths,
        attachments: receipts.paths,
        attachmentInfo: receipts.info,
      },
    })
    if (begun.error) return errorResult(begun.error.code, begun.error.message)
    const job = begun.job
    this.rememberDispatch(agentId, clientRequestId, job.jobId)
    try {
      await this.bridge.dispatch(job, {
        message: dispatchMessage,
        requested: job.requested,
        attachments: receipts.paths,
        cwd: workspaceRoot,
      })
    } catch (error) {
      return {
        ok: false,
        jobId: job.jobId,
        status: job.status,
        code: error?.code ?? 'dispatch_failed',
        message: error?.message ?? String(error),
        view: publicView(job, this.bridge),
      }
    }
    return { ok: true, jobId: job.jobId, status: job.status, view: publicView(job, this.bridge) }
  }

  async status(agent, request) {
    requireAgent(agent)
    const found = ownedJob(this.bridge, agent, request?.jobId)
    if (found.error) return found.error
    await this.bridge.tick()
    return { ok: true, view: publicView(found.job, this.bridge) }
  }

  async reply(agent, request) {
    requireAgent(agent)
    const found = ownedJob(this.bridge, agent, request?.jobId)
    if (found.error) return found.error
    await this.bridge.tick()
    const view = this.bridge.view(found.job)
    if (view.status !== 'replied') return { ok: true, available: false, state: view.status, jobId: view.jobId }
    return { ok: true, available: true, text: view.reply, cached: true, jobId: view.jobId, state: view.status }
  }

  async cancel(agent, request) {
    requireAgent(agent)
    const found = ownedJob(this.bridge, agent, request?.jobId)
    if (found.error) return found.error
    const result = await this.bridge.cancelJob(found.job)
    return {
      ok: !result.error,
      ...(result.error ? { code: result.error.code, message: result.error.message } : {}),
      jobId: found.job.jobId,
      state: found.job.status,
      cancelSent: typeof result.cancelSent === 'boolean' ? result.cancelSent : undefined,
      settled: typeof result.settled === 'boolean' ? result.settled : undefined,
      stopControl: typeof result.stopControl === 'string' ? result.stopControl : undefined,
      view: publicView(found.job, this.bridge),
    }
  }

  async activity(agent, request) {
    requireAgent(agent)
    const found = ownedJob(this.bridge, agent, request?.jobId)
    if (found.error) return found.error
    const view = this.bridge.view(found.job)
    const events = Array.isArray(view.activity)
      ? view.activity.map((e) => ({
          toolCallId: String(e?.toolCallId ?? ''),
          kind: ['execute', 'edit', 'read', 'other'].includes(e?.kind) ? e.kind : 'unknown',
          title: String(e?.title ?? ''),
          status: String(e?.status ?? ''),
        }))
      : []
    const thoughts = Array.isArray(view.thoughts)
      ? view.thoughts.map((e) => ({ text: String(e?.text ?? '').slice(0, 200) }))
      : []
    return {
      ok: true,
      jobId: found.job.jobId,
      state: found.job.status,
      events,
      thoughts,
      thoughtSummaryEnabled: this.config?.thoughtSummary !== false,
    }
  }

  async nativeActivity(agent, request) {
    requireAgent(agent)
    const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : ''
    if (sessionId === '') return errorResult('invalid_request', 'sessionId is required')
    const ownedSessionId = agentSessionId(agent)
    if (!ownedSessionId || ownedSessionId !== sessionId) {
      return errorResult('forbidden', 'sessionId belongs to another session')
    }
    if (request?.scope !== undefined && agent?.scope !== undefined && request.scope !== agent.scope) {
      return errorResult('forbidden', 'scope mismatch')
    }
    if (request?.agentId !== undefined && agent?.id !== undefined && String(request.agentId) !== String(agent.id)) {
      return errorResult('forbidden', 'agentId mismatch')
    }
    const raw = this.adapter?.getNativeActivity?.(sessionId) ?? getNativeActivity(sessionId)
    const events = Array.isArray(raw?.events)
      ? raw.events.map((e) => ({
          toolCallId: String(e?.toolCallId ?? ''),
          kind: ['execute', 'edit', 'read', 'other'].includes(e?.kind) ? e.kind : 'unknown',
          title: String(e?.title ?? ''),
          status: String(e?.status ?? ''),
          ...(typeof e?.updatedAt === 'number' ? { updatedAt: e.updatedAt } : {}),
          ...(typeof e?.source === 'string' ? { source: e.source } : {}),
        }))
      : []
    const thoughts = Array.isArray(raw?.thoughts)
      ? raw.thoughts.map((e) => ({
          text: String(e?.text ?? '').slice(0, 200),
          ...(typeof e?.updatedAt === 'number' ? { updatedAt: e.updatedAt } : {}),
          ...(typeof e?.source === 'string' ? { source: e.source } : {}),
        }))
      : []
    return {
      ok: true,
      events,
      thoughts,
      truncated: Boolean(raw?.truncated),
      thoughtSummaryEnabled: this.config?.thoughtSummary !== false,
    }
  }

  async authStatus() {
    const result = await this.bridge.cliAuthStatus()
    const dataProbe = probeDataRoot(cliDataRoot(this.config))
    const authMethods = Array.isArray(result.authMethods) ? result.authMethods : []
    const authStatus = typeof result.status === 'string' ? result.status : 'unknown'
    const sessionProbe =
      result.ok === true && result.code === 'auth_status_unknown'
        ? 'ok'
        : authStatus === 'unauthenticated' &&
            (result.code === 'auth_probe_failed' || /需要登录|authenticat|unauthenticated/i.test(result.message || ''))
          ? 'failed'
          : 'skipped'
    const reasonCode =
      result.ok === true && result.code === 'auth_status_unknown'
        ? CLI_AMBIGUOUS_REASON
        : authStatus === 'unknown'
          ? (result.code || 'unknown')
          : null
    return {
      ok: Boolean(result.ok),
      authStatus,
      authMethods,
      installation: result.installation || 'unknown',
      executable: result.executable || '',
      version: result.version || '',
      dataDir: dataProbe.dataDir,
      dataDirWritable: dataProbe.writable,
      dataDirError: dataProbe.dataDirError,
      reasonCode,
      probe: {
        authMethodCount: authMethods.length,
        sessionProbe,
        verifiedStatus: authStatus,
      },
      ...(result.code ? { code: result.code } : {}),
      ...(result.message ? { message: result.message } : {}),
    }
  }

  async login() {
    const result = await this.bridge.cliLogin()
    return {
      ok: Boolean(result.ok),
      authStatus: typeof result.status === 'string' ? result.status : 'unknown',
      flow: typeof result.flow === 'string' ? result.flow : 'unknown',
      ...(result.methodId ? { methodId: result.methodId } : {}),
      ...(result.command ? { command: result.command } : {}),
      ...(result.code ? { code: result.code } : {}),
      ...(result.message ? { message: result.message } : {}),
    }
  }

  async desktopStatus(agent, request) {
    requireAgent(agent)
    if (!this.bridge.desktop.enabled) {
      return errorResult('desktop_disabled', 'desktop transport is not enabled in this profile')
    }
    if (this._desktopStatusInFlight) return this._desktopStatusInFlight
    this._desktopStatusInFlight = (async () => {
      try {
        return await this.bridge.desktop.statusSnapshot({
          includeCandidates: request?.includeCandidates === true,
        })
      } finally {
        this._desktopStatusInFlight = null
      }
    })()
    return this._desktopStatusInFlight
  }

  async desktopPin(agent, request) {
    requireAgent(agent)
    if (this._desktopPinInFlight) return this._desktopPinInFlight
    this._desktopPinInFlight = (async () => {
      try {
        return await this.bridge.desktop.pinAction({
          action: request?.action ?? 'pin',
          hwnd: request?.hwnd,
          pid: request?.pid,
        })
      } finally {
        this._desktopPinInFlight = null
      }
    })()
    return this._desktopPinInFlight
  }

  /** 只读探测本地 Antigravity 桌面窗口候选；绝不写 desktop-target.json、不 pin、不聚焦。 */
  async desktopDetect(agent) {
    requireAgent(agent)
    if (!this.bridge.desktop.enabled) {
      return { ok: true, enabled: false, reason: 'desktop_disabled', candidates: [] }
    }
    if (this._desktopDetectInFlight) return this._desktopDetectInFlight
    this._desktopDetectInFlight = (async () => {
      try {
        const driver = this.bridge.desktop.driver()
        const res = await driver.run({ action: 'inspect' })
        if (!res || res.ok !== true) {
          const norm = normalizeDesktopError(res?.code, res?.detail, 'desktop_target_unverified')
          return errorResult(
            norm.code,
            res?.message || 'desktop inspect failed',
          )
        }
        const raw = Array.isArray(res.candidates) ? res.candidates : []
        const candidates = raw.map((c) => ({
          title: typeof c?.window?.title === 'string' ? c.window.title : (typeof c?.title === 'string' ? c.title : ''),
          pid: Number(c?.pid) || 0,
          hwnd: String(c?.hwnd ?? ''),
          documentUriCount: Number(c?.documentUriCount ?? (Array.isArray(c?.documentUris) ? c.documentUris.length : 0)),
          isForeground: Boolean(c?.isForeground),
        }))
        return { ok: true, enabled: true, candidates }
      } catch (error) {
        const norm = normalizeDesktopError(error?.code, error?.detail, 'desktop_target_unverified')
        return errorResult(
          norm.code,
          error?.message || 'failed to invoke desktop driver',
        )
      } finally {
        this._desktopDetectInFlight = null
      }
    })()
    return this._desktopDetectInFlight
  }
}

Object.defineProperty(AntigravityBridgeService.prototype, REMOTE_DESCRIPTOR, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze(REMOTE_METHODS.map((method) => Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) }))),
  }),
})

const stringSchema = (maxLength) => ({ type: 'string', ...(maxLength ? { maxLength } : {}) })
// DSH validates remote/tool schemas against a JSON-schema subset that rejects
// type arrays ("must be a single type string"), so nullable strings use oneOf.
const nullableStringSchema = () => ({ oneOf: [{ type: 'string' }, { type: 'null' }] })
const objectSchema = (properties, required) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  ...(required?.length ? { required } : {}),
})
const viewSchema = objectSchema(
  {
    jobId: stringSchema(),
    transport: stringSchema(),
    state: stringSchema(),
    status: stringSchema(),
    conversationId: stringSchema(),
    sessionId: stringSchema(),
    desktopConversationId: stringSchema(),
    targetKind: stringSchema(),
    title: stringSchema(),
    code: stringSchema(),
    message: stringSchema(),
    wakeState: stringSchema(),
    stopReason: stringSchema(),
    cancelRequested: { type: 'boolean' },
    permissionPending: { type: 'boolean' },
    reply: stringSchema(),
    fileMode: stringSchema(),
    detail: objectSchema({ phase: stringSchema() }, ['phase']),
    requested: { type: 'object', additionalProperties: true },
    effective: { type: 'object', additionalProperties: true },
    confirmed: { type: 'object', additionalProperties: true },
    permissions: { type: 'array', items: { type: 'object', additionalProperties: true } },
    configOptions: { type: 'array', items: { type: 'object', additionalProperties: true } },
    createdAt: { type: 'number' },
    updatedAt: { type: 'number' },
  },
  ['jobId', 'state'],
)
const resultSchema = objectSchema(
  {
    ok: { type: 'boolean' },
    reused: { type: 'boolean' },
    jobId: stringSchema(),
    status: stringSchema(),
    code: stringSchema(),
    message: stringSchema(),
    view: viewSchema,
    available: { type: 'boolean' },
    text: stringSchema(),
    state: stringSchema(),
    cached: { type: 'boolean' },
    cancelSent: { type: 'boolean' },
    settled: { type: 'boolean' },
    stopControl: stringSchema(),
    capabilities: { type: 'object', additionalProperties: true },
    authStatus: stringSchema(),
    authMethods: { type: 'array', items: { type: 'object', additionalProperties: true } },
    installation: stringSchema(),
    executable: stringSchema(),
    version: stringSchema(),
    dataDir: nullableStringSchema(),
    dataDirWritable: { type: 'boolean' },
    dataDirError: nullableStringSchema(),
    reasonCode: nullableStringSchema(),
    probe: objectSchema(
      {
        authMethodCount: { type: 'number' },
        sessionProbe: { type: 'string', enum: ['ok', 'failed', 'skipped'] },
        verifiedStatus: nullableStringSchema(),
      },
      ['authMethodCount', 'sessionProbe', 'verifiedStatus'],
    ),
    flow: stringSchema(),
    methodId: stringSchema(),
    command: stringSchema(),
    events: {
      type: 'array',
      items: objectSchema(
        {
          toolCallId: stringSchema(),
          kind: { type: 'string', enum: ['execute', 'edit', 'read', 'other', 'unknown'] },
          title: stringSchema(),
          status: stringSchema(),
          updatedAt: { type: 'number' },
          source: stringSchema(),
        },
        ['toolCallId', 'kind', 'title', 'status'],
      ),
    },
    thoughts: {
      type: 'array',
      items: objectSchema(
        {
          text: stringSchema(),
          updatedAt: { type: 'number' },
          source: stringSchema(),
        },
        ['text'],
      ),
    },
    truncated: { type: 'boolean' },
    thoughtSummaryEnabled: { type: 'boolean' },
    models: { type: 'array', items: { type: 'object', additionalProperties: true } },
    discoveredAt: stringSchema(),
    elapsedMs: { type: 'number' },
    degraded: { type: 'array', items: { type: 'object', additionalProperties: true } },
    enabled: { type: 'boolean' },
    pinned: { type: 'boolean' },
    verified: { type: 'boolean' },
    target: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
    fallbackTarget: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
    targetKey: stringSchema(),
    evidence: { type: 'object', additionalProperties: true },
    candidates: { type: 'array', items: { type: 'object', additionalProperties: true } },
    detail: { type: 'object', additionalProperties: true },
  },
  ['ok'],
)
const dispatchRequestSchema = objectSchema(
  {
    clientRequestId: stringSchema(200),
    message: stringSchema(MAX_MESSAGE_CHARS),
    transport: { type: 'string', enum: ['acp', 'desktop'] },
    conversationId: stringSchema(200),
    profile: nullableStringSchema(),
    model: nullableStringSchema(),
    effort: nullableStringSchema(),
    pathRefs: { type: 'array', items: stringSchema(), maxItems: MAX_PATH_REFS },
    attachments: { type: 'array', items: stringSchema(), maxItems: MAX_ATTACHMENTS },
  },
  ['message'],
)
const jobRequestSchema = objectSchema({ jobId: stringSchema(200) }, ['jobId'])
const nativeActivityRequestSchema = objectSchema(
  {
    sessionId: stringSchema(200),
    scope: stringSchema(200),
    agentId: stringSchema(200),
  },
  ['sessionId'],
)
const desktopStatusRequestSchema = objectSchema(
  {
    includeCandidates: { type: 'boolean' },
  },
  [],
)
const desktopPinRequestSchema = objectSchema(
  {
    action: { type: 'string', enum: ['pin', 'clear'] },
    hwnd: { oneOf: [{ type: 'number' }, { type: 'string' }] },
    pid: { type: 'number' },
  },
  ['action'],
)
const desktopDetectRequestSchema = objectSchema({}, [])

function strictCodec(typeSymbol, jsonSchema) {
  const create = () => ({
    parse: (value) => value,
    safeParse: (value) => ({ success: true, data: value }),
    toJSON: () => jsonSchema,
  })
  return { mode: 'strict', typeSymbol, create, jsonSchema }
}
const AGENT_CODEC = strictCodec('typert:agentId', stringSchema())
function agentParameter() {
  return {
    name: REMOTE_LOOKUP,
    wire: REMOTE_LOOKUP_WIRE,
    source: 'lookup',
    lookup: REMOTE_LOOKUP,
    description: 'caller Agent resolved by the Host from the connection',
    codec: AGENT_CODEC,
    strictCodec: AGENT_CODEC,
  }
}
function jsonParameter(name, typeSymbol, jsonSchema) {
  const codec = strictCodec(typeSymbol, jsonSchema)
  return { name, wire: name, source: 'json', codec, strictCodec: codec }
}
const DEFINITIONS = {
  capabilities: { parameters: [], result: 'bridge:CapabilitiesResult' },
  dispatch: { parameters: [jsonParameter('request', 'bridge:DispatchRequest', dispatchRequestSchema)], result: 'bridge:DispatchResult' },
  status: { parameters: [jsonParameter('request', 'bridge:JobRequest', jobRequestSchema)], result: 'bridge:StatusResult' },
  reply: { parameters: [jsonParameter('request', 'bridge:JobRequest', jobRequestSchema)], result: 'bridge:ReplyResult' },
  cancel: { parameters: [jsonParameter('request', 'bridge:JobRequest', jobRequestSchema)], result: 'bridge:CancelResult' },
  activity: { parameters: [jsonParameter('request', 'bridge:JobRequest', jobRequestSchema)], result: 'bridge:ActivityResult' },
  nativeActivity: { parameters: [jsonParameter('request', 'bridge:NativeActivityRequest', nativeActivityRequestSchema)], result: 'bridge:NativeActivityResult' },
  authStatus: { parameters: [], result: 'bridge:AuthStatusResult' },
  login: { parameters: [], result: 'bridge:LoginResult' },
  refreshModels: { parameters: [], result: 'bridge:RefreshModelsResult' },
  desktopStatus: { parameters: [jsonParameter('request', 'bridge:DesktopStatusRequest', desktopStatusRequestSchema)], result: 'bridge:DesktopStatusResult' },
  desktopPin: { parameters: [jsonParameter('request', 'bridge:DesktopPinRequest', desktopPinRequestSchema)], result: 'bridge:DesktopPinResult' },
  desktopDetect: { parameters: [jsonParameter('request', 'bridge:DesktopDetectRequest', desktopDetectRequestSchema)], result: 'bridge:DesktopDetectResult' },
}

const GLOBAL_METHODS = new Set(['authStatus', 'login'])

export function createRemoteInfo() {
  return {
    package: REMOTE_PACKAGE,
    descriptors: Object.entries(DEFINITIONS).map(([method, definition]) => {
      const isGlobal = GLOBAL_METHODS.has(method)
      return {
        id: `${REMOTE_PACKAGE}#${BRIDGE_SERVICE}/${method}`,
        package: REMOTE_PACKAGE,
        service: BRIDGE_SERVICE,
        namespace: BRIDGE_SERVICE,
        method,
        invocation: { kind: 'direct' },
        ...(isGlobal ? {} : { scope: { context: REMOTE_LOOKUP, wire: REMOTE_LOOKUP_WIRE } }),
        parameters: isGlobal ? [...definition.parameters] : [agentParameter(), ...definition.parameters],
        result: strictCodec(definition.result, resultSchema),
      }
    }),
  }
}

export const TYPERT_REMOTE = Object.freeze(createRemoteInfo())

export function registerWebService({ ctx, bridge, config, adapter = null }) {
  if (!ctx || !ctx.reflect || typeof ctx.reflect.provide !== 'function') {
    return { registered: false, reason: 'reflect_unavailable' }
  }
  const service = new AntigravityBridgeService({ ctx, bridge, config, adapter })
  const dispose = ctx.reflect.provide(BRIDGE_SERVICE, service)
  try {
    const root = ctx.root || ctx
    if (root && typeof root.accessor === 'function' && !Object.hasOwn(root.reflect.props, 'invocation')) {
      root.accessor('invocation', { get: () => undefined })
    }
  } catch {
    // Existing accessor or a host that forbids it.
  }
  return { registered: true, service, dispose }
}