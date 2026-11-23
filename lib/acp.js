/**
 * Minimal Agent Client Protocol (ACP) v1 client over a local child process.
 *
 * The bridge speaks JSON-RPC 2.0 to `agy acp` (newline-delimited JSON on
 * stdio). It never proxies Google's model endpoint, never reads credentials,
 * and never talks to the desktop app's private RPC. The only files it reads
 * are the explicit attachment paths the caller supplied.
 */

import { spawn } from 'node:child_process'

export class AcpError extends Error {
  constructor(code, message, phase = 'before_write', data = undefined) {
    super(message)
    this.name = 'AcpError'
    this.code = code
    this.phase = phase
    this.data = data
  }
}

const PROTOCOL_VERSION = 1
const MAX_FRAME_BYTES = 32 * 1024 * 1024
const STDERR_KEEP = 8192
const MAX_THOUGHTS_PER_PROMPT = 20
const MAX_THOUGHT_CHARS = 200

function normalizeThought(update) {
  const content = asObject(update?.content)
  if (content.type !== 'text' || typeof content.text !== 'string') return null
  const trimmed = content.text.trim()
  if (trimmed === '') return null
  return { text: trimmed.slice(0, MAX_THOUGHT_CHARS) }
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

// ACP 原生工具事件的 kind 归一。未知值落到 `other` 而不是丢弃：agent 新版本
// 新增的 kind 仍然要可见、可诊断，只是不假装成已知类别。
const TOOL_KINDS = new Set(['execute', 'edit', 'read', 'other'])

export function normalizeToolKind(value) {
  const kind = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return TOOL_KINDS.has(kind) ? kind : 'other'
}

/**
 * 把 `tool_call` / `tool_call_update` 通知归一成结构化事件。
 *
 * 只做投影，不做执行：这里产出的对象只进诊断/UI 通道，
 * 绝不能被翻译成 DSH 的 `tool-call` / `tool-call-delta`（那会让 DSH 二次执行
 * 一个已经被 agy 自己执行过的动作）。见 docs/DETAIL.md「工具事件语义」。
 *
 * kind 的三种情况必须区分开（review t21 F-2）：
 * - update **带非空 kind**：归一化后使用（已知值原样，未知值 → `other`）；
 * - update **不带 kind**：不伪造 `other`，先按同一条通知里的 `content.kind` /
 *   `content.type` 兜底，再用 `kindOf(toolCallId)` 继承该工具调用此前出现过的
 *   类别；都拿不到时保持 `unknown`。否则「先 execute、后一条只有 status 的
 *   update」会把这次调用降级成 `other`，让按事件流判断「发生过 execute」的
 *   消费方读到假信号。
 *
 * @param {string} sessionUpdate - 原始 sessionUpdate 名称。
 * @param {object} update - 通知里的 update 对象。
 * @param {(toolCallId: string) => string} [kindOf] - 查询同一 toolCallId 此前的归一化 kind。
 * @returns {{toolCallId: string, kind: string, title: string, status: string,
 *   sessionUpdate: string} | null} 结构化事件；完全无信息时返回 null。
 *   `kind` 为 `execute|edit|read|other` 之一，或 `unknown`（确实没有依据）。
 */
export function normalizeToolEvent(sessionUpdate, update, kindOf) {
  const source = asObject(update)
  const toolCallId = typeof source.toolCallId === 'string' ? source.toolCallId : ''
  const title = typeof source.title === 'string' ? source.title : ''
  const rawKind = typeof source.kind === 'string' ? source.kind.trim() : ''
  const status = typeof source.status === 'string' ? source.status : ''
  if (!toolCallId && !title && !rawKind) return null
  let kind
  if (rawKind !== '') {
    kind = normalizeToolKind(rawKind)
  } else {
    const content = asObject(source.content)
    const fallbackKind = typeof content.kind === 'string' && content.kind.trim() !== ''
      ? content.kind
      : (typeof content.type === 'string' && TOOL_KINDS.has(content.type.trim().toLowerCase()) ? content.type : '')
    const inherited = fallbackKind !== '' ? '' : (typeof kindOf === 'function' && toolCallId !== '' ? kindOf(toolCallId) : '')
    kind = fallbackKind !== '' ? normalizeToolKind(fallbackKind) : (inherited || 'unknown')
  }
  return {
    toolCallId,
    kind,
    title,
    status,
    sessionUpdate: typeof sessionUpdate === 'string' ? sessionUpdate : '',
  }
}

function isMethodNotFound(error) {
  // Modern ACP carries the JSON-RPC code in error.data.rpcCode. Keep the old
  // direct code/message checks for callers that still surface a plain error.
  const rpcCode = error?.data?.rpcCode
  if (rpcCode === -32601) return true
  if (rpcCode != null) return false
  return error?.code === -32601 || /method not found/i.test(String(error?.message ?? ''))
}

/**
 * Classify a failed session/resume or session/load so the caller can tell three
 * different situations apart instead of reporting all of them as "unknown":
 *
 * - `restore_unsupported`: the agent does not implement this restore method;
 * - `unknown_session`: the agent says this ACP session does not exist;
 * - `restore_failed`: anything else (rejected, transport loss, …).
 *
 * @param {string} method - `session/resume` or `session/load`.
 * @param {string} sessionId - Old ACP session id.
 * @param {unknown} error - Original failure.
 * @returns {Error} AcpError with a reason-specific code.
 */
function restoreError(method, sessionId, error) {
  if (isMethodNotFound(error)) {
    return new AcpError(
      'restore_unsupported',
      `${method} 没有被 Antigravity 实现（method not found），无法恢复 ACP 会话 ${sessionId}；没有派发。`,
      'before_write',
      { method, rpcCode: -32601, reason: 'restore_unsupported' },
    )
  }
  const rpcCode = error?.data?.rpcCode
  const message = String(error?.message ?? '')
  const missing = rpcCode === -32602 && /unknown session|not found|no such session/i.test(message)
    || /unknown session|session.*not found|no such session|session does not exist/i.test(message)
  if (missing) {
    return new AcpError(
      'unknown_session',
      `${method} 报告 ACP 会话 ${sessionId} 不存在；没有派发。`,
      'before_write',
      { method, rpcCode, reason: 'unknown_session', detail: message },
    )
  }
  return new AcpError(
    'restore_failed',
    `${method} 恢复 ACP 会话 ${sessionId} 失败（${rpcCode === undefined ? error?.code ?? 'unknown' : `rpc ${rpcCode}`}：${message}）；没有派发。`,
    'before_write',
    { method, rpcCode, reason: 'restore_failed', detail: message },
  )
}

function flattenSelectOptions(list) {
  const flattened = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    if (item.value == null && Array.isArray(item.options)) {
      const groupName = typeof item.name === 'string' ? item.name : String(item.group ?? '')
      for (const child of item.options) {
        if (!child || typeof child !== 'object' || child.value == null) continue
        const childName = typeof child.name === 'string' ? child.name : String(child.value)
        flattened.push({
          ...child,
          name: groupName ? `${groupName} / ${childName}` : childName,
        })
      }
      continue
    }
    if (item.value != null) flattened.push(item)
  }
  return flattened
}

function summarizeConfigOptions(list) {
  if (!Array.isArray(list)) return []
  return list
    .filter((option) => option && typeof option.id === 'string')
    .map((option) => ({
      id: String(option.id),
      name: typeof option.name === 'string' ? option.name : String(option.id),
      description: typeof option.description === 'string' ? option.description : '',
      category: typeof option.category === 'string' ? option.category : '',
      type: typeof option.type === 'string' ? option.type : '',
      currentValue: option.currentValue == null ? '' : String(option.currentValue),
      options: Array.isArray(option.options)
        ? flattenSelectOptions(option.options).map((item) => ({
            value: String(item.value),
            name: typeof item.name === 'string' ? item.name : String(item.value),
            description: typeof item.description === 'string' ? item.description : '',
          }))
        : [],
    }))
}

function findOption(configOptions, category, fallbackPattern) {
  const normalized = summarizeConfigOptions(configOptions)
  const byCategory = normalized.find(
    (option) => option.category.toLowerCase() === category.toLowerCase(),
  )
  if (byCategory) return byCategory
  return (
    normalized.find((option) => fallbackPattern.test(`${option.id} ${option.name}`)) ?? null
  )
}

function resolveOptionValue(option, requested) {
  const value = String(requested)
  const byValue = option.options.find((item) => item.value === value)
  if (byValue) return byValue.value
  const lower = value.toLowerCase()
  const byName = option.options.filter(
    (item) =>
      item.name.toLowerCase() === lower ||
      item.name.split(' / ').pop().toLowerCase() === lower,
  )
  if (byName.length === 1) return byName[0].value
  if (byName.length > 1) {
    throw new AcpError(
      'ambiguous_config_value',
      `配置项 ${option.id} 有多个同名选项：${byName.map((item) => item.value).join('、')}；请用 value 指定。`,
      'before_write',
    )
  }
  const choices = option.options.map((item) => `${item.value}（${item.name}）`).join('、')
  throw new AcpError(
    'unsupported_capability',
    `Antigravity 的配置项 ${option.id} 不接受“${value}”。可选值：${choices || '（无）'}。`,
    'before_write',
    { configId: option.id, value, options: option.options },
  )
}

/**
 * ACP client. One child process can host several sessions; prompts are
 * serialized per session by the bridge and, defensively, by this class.
 */
export class AcpClient {
  constructor(config, logger) {
    this.config = config
    this.logger = logger
    this.child = null
    this.startPromise = null
    this.startError = null
    this.initialized = false
    this.closed = false
    this.nextId = 1
    this.pending = new Map()
    this.sessions = new Map()
    this.capabilities = {
      protocolVersion: 0,
      loadSession: false,
      promptCapabilities: {},
      authMethods: [],
    }
    this.stderrBytes = 0
    this.stderr = ''
    this.buffer = ''
  }

  async ready() {
    if (this.initialized) return this.capabilities
    if (!this.startPromise) {
      this.startPromise = this.start().catch((error) => {
        this.startPromise = null
        this.close()
        throw error
      })
    }
    return this.startPromise
  }

  async start() {
    this.closed = false
    this.startError = null
    let child
    try {
      child = spawn(this.config.agyExecutable, this.config.agyArgs, {
        cwd: this.config.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: process.env,
      })
    } catch (error) {
      throw new AcpError(
        'acp_spawn_failed',
        `无法启动 ACP 子进程 ${this.config.agyExecutable}：${error?.message ?? error}`,
        'before_write',
      )
    }
    this.child = child
    child.on('error', (error) => {
      this.startError = new AcpError(
        'acp_spawn_failed',
        `ACP 子进程错误：${error?.message ?? error}`,
        'before_write',
      )
      this.failPending(this.startError)
    })
    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      const detail = signal ? `signal=${signal}` : `code=${code}`
      const wasInitialized = this.initialized
      if (!wasInitialized) {
        this.startError = new AcpError(
          'acp_exited',
          `ACP 子进程在初始化前退出（${detail}）。`,
          'before_write',
        )
      }
      this.failPending(
        new AcpError(
          'acp_exited',
          `ACP 子进程已退出（${detail}）；没有可靠的回放对账，不自动重发。`,
          wasInitialized ? 'after_write' : 'before_write',
        ),
      )
      // Allow the next send to spawn a fresh child. Session ids are not kept:
      // a continuation must go through session/resume (or session/load) and
      // prove that the agent still knows the session.
      this.sessions.clear()
      this.child = null
      this.initialized = false
      this.startPromise = null
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.onStdout(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      this.stderrBytes += Buffer.byteLength(chunk)
      this.stderr = (this.stderr + chunk).slice(-STDERR_KEEP)
    })
    child.stdin.on('error', (error) => this.onStdinError(error, child))

    const result = await this.request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: Boolean(this.config.fsProbeHandler), writeTextFile: Boolean(this.config.fsProbeHandler) },
          terminal: false,
        },
        clientInfo: { name: 'dsh-agy-bridge', version: '0.2.0' },
      },
      { timeoutMs: 30000, phase: 'before_write' },
    )
    const response = asObject(result)
    const agentCapabilities = asObject(response.agentCapabilities)
    const fromAgent = asObject(agentCapabilities.promptCapabilities)
    const promptCapabilities =
      Object.keys(fromAgent).length > 0 ? fromAgent : asObject(response.promptCapabilities)
    if (Number(response.protocolVersion) !== PROTOCOL_VERSION) {
      throw new AcpError(
        'unsupported_protocol',
        `Antigravity 返回 ACP 协议版本 ${response.protocolVersion ?? '未知'}；桥只支持 v1。`,
        'before_write',
      )
    }
    this.capabilities = {
      protocolVersion: Number(response.protocolVersion),
      loadSession: agentCapabilities.loadSession === true,
      resume: Boolean(agentCapabilities.sessionCapabilities?.resume),
      promptCapabilities: {
        image: promptCapabilities.image === true,
        audio: promptCapabilities.audio === true,
        embeddedContext: promptCapabilities.embeddedContext === true,
      },
      authMethods: Array.isArray(response.authMethods)
        ? response.authMethods.map((item) => ({
            id: typeof item?.id === 'string' ? item.id : '',
            name: typeof item?.name === 'string' ? item.name : '',
            description: typeof item?.description === 'string' ? item.description : '',
          }))
        : [],
    }
    this.initialized = true
    return this.capabilities
  }

  onStdout(chunk) {
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES) {
      this.buffer = ''
      this.failPending(
        new AcpError('acp_frame_too_large', 'ACP 子进程输出帧过大，已中断。', 'after_write'),
      )
      return
    }
    let index
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '').trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line === '') continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        // A CLI that writes a banner to stdout is not speaking ACP. Ignore the
        // line rather than treating it as a protocol response.
        this.logger?.warn?.('antigravity-bridge: ignored a non-JSON ACP stdout line')
        continue
      }
      this.onMessage(message)
    }
  }

  onMessage(message) {
    if (!message || typeof message !== 'object') return
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      pending.clearTimer()
      if (message.error) {
        // A prompt request was already sent to the child. Even a JSON-RPC error
        // cannot prove the agent performed no work, so keep it acceptance-unknown.
        const phase = pending.method === 'session/prompt' ? 'after_write' : 'before_write'
        pending.reject(
          new AcpError(
            'acp_rejected',
            String(message.error.message ?? 'ACP 请求被拒绝'),
            phase,
            { rpcCode: message.error.code, data: message.error.data, method: pending.method },
          ),
        )
      } else {
        pending.resolve(message.result)
      }
      return
    }
    if (typeof message.method !== 'string') return
    if (message.id !== undefined) {
      this.onAgentRequest(message)
    } else {
      this.onNotification(message)
    }
  }

  onNotification(message) {
    const params = asObject(message.params)
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
    if (!sessionId) return
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (message.method === 'session/update') {
      const update = asObject(params.update)
      const kind = String(update.sessionUpdate ?? '')
      if (kind === 'config_option_update') {
        const options = update.configOptions ?? params.configOptions
        if (Array.isArray(options)) {
          session.configOptions = options
          try {
            session.activePrompt?.onConfigUpdate?.(options)
          } catch {
            // A reporting callback must never break protocol processing.
          }
        }
        return
      }
      if (kind === 'agent_message_chunk') {
        if (session.loading) return
        const content = asObject(update.content)
        // 正文白名单：只有纯文本 content 可以进入回复正文。工具标题、thought、
        // 未知 content 类型一律不追加，只计入诊断计数，避免污染多轮账本的
        // assistantHash（见 results/round3a-impl.md）。
        if (content.type === 'text') {
          if (typeof content.text === 'string' && session.activePrompt) session.activePrompt.text += content.text
        } else if (session.activePrompt) {
          session.activePrompt.diagnostics.nonTextMessageChunks += 1
        }
        return
      }
      if (kind === 'tool_call' || kind === 'tool_call_update') {
        if (session.loading) return
        const toolKind = typeof update.kind === 'string' ? update.kind : ''
        if (session.activePrompt) session.activePrompt.diagnostics.toolEvents += 1
        // 旧的 `[kind:title]` 字符串字段：面板/日志/任务桥回复摘要按它展示，
        // 保持原样双写，避免既有消费方回归。
        const title = typeof update.title === 'string' ? update.title : ''
        if ((title || toolKind) && session.activePrompt) {
          const label = [toolKind, title].filter(Boolean).join(':')
          if (!session.activePrompt.tools.includes(label)) session.activePrompt.tools.push(label)
        }
        // 缺 kind 的 update 按同一 toolCallId 已知的 kind 继承（review t21 F-2）：
        // 只认已归一化的类别，‘unknown’ 不参与继承。
        const knownToolKinds = session.activePrompt?.toolKinds
        const kindOf = knownToolKinds === undefined
          ? undefined
          : (id) => {
            const seen = knownToolKinds.get(id)
            return seen === undefined || seen === 'unknown' ? '' : seen
          }
        const event = normalizeToolEvent(kind, update, kindOf)
        if (event && session.activePrompt) {
          // 老形状的 activePrompt（没有 toolKinds / 缺诊断字段）也要能收事件，
          // 不因为新增字段而抛错。
          const prompt = session.activePrompt
          if (!(prompt.toolKinds instanceof Map)) prompt.toolKinds = new Map()
          if (event.toolCallId !== '' && event.kind !== 'unknown') {
            prompt.toolKinds.set(event.toolCallId, event.kind)
          }
          prompt.toolEvents.push(event)
          try {
            prompt.onToolEvent?.(event)
          } catch (error) {
            // 诊断回调失败不得中断协议处理，但也不许静默丢弃（review t21 F-4）：
            // 计入 diagnostics 并留给调用方读取，不向外抛。
            prompt.diagnostics.toolCallbackErrors = (prompt.diagnostics.toolCallbackErrors ?? 0) + 1
            prompt.diagnostics.lastToolCallbackError = String(error?.message ?? error)
          }
        }
        return
      }
      if (kind === 'agent_thought_chunk') {
        if (session.activePrompt) {
          const prompt = session.activePrompt
          prompt.diagnostics.thoughtChunks += 1
          const thought = normalizeThought(update)
          if (thought) {
            if (!Array.isArray(prompt.thoughts)) prompt.thoughts = []
            prompt.thoughts.push(thought)
            if (prompt.thoughts.length > MAX_THOUGHTS_PER_PROMPT) {
              prompt.thoughts = prompt.thoughts.slice(-MAX_THOUGHTS_PER_PROMPT)
            }
            try {
              prompt.onThought?.(thought)
            } catch (error) {
              prompt.diagnostics.thoughtCallbackErrors = (prompt.diagnostics.thoughtCallbackErrors ?? 0) + 1
              prompt.diagnostics.lastThoughtCallbackError = String(error?.message ?? error)
            }
          }
        }
        return
      }
      // plans, user replay and mode updates are not final text.
      if (session.activePrompt) session.activePrompt.diagnostics.otherUpdates += 1
      return
    }
  }

  onAgentRequest(message) {
    const params = asObject(message.params)
    if (message.method === 'session/request_permission') {
      this.respondPermission(message.id, params)
      return
    }
    if (message.method === 'fs/read_text_file' || message.method === 'fs/write_text_file') {
      const event = { method: message.method, sessionId: params.sessionId ?? '', path: params.path ?? '' }
      this.logger?.info?.(`acp-fs-request ${JSON.stringify(event)}`)
      this.config.onFsRequest?.(event)
      if (this.config.fsProbeHandler) {
        Promise.resolve().then(() => this.config.fsProbeHandler(message.method, params, this.sessions.get(params.sessionId)))
          .then((result) => this.write({ jsonrpc: '2.0', id: message.id, result }),
            (error) => this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error.message, data: { code: error.code } } }))
        return
      }
    }
    // agy 1.5.x (tested 1.5.14) did not call client fs even with fs=true and
    // a safe handler: see results/round1-live-probe.json. Keep normal fs=false;
    // the explicit probe switch is for testing future versions. Native tool
    // events are not evidence of client fs requests.
    this.write({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: `Bridge does not provide ${message.method}.` },
    })
  }

  respondPermission(requestId, params) {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
    const session = this.sessions.get(sessionId)
    const prompt = session?.activePrompt ?? null
    const options = Array.isArray(params.options) ? params.options : []
    const reject =
      options.find((item) => item?.kind === 'reject_once') ??
      options.find((item) => item?.kind === 'reject_always') ??
      options.find((item) => String(item?.kind ?? '').startsWith('reject')) ??
      null
    const allow = this.config.permissionPolicy === 'allow_once' && prompt
      ? options.find((item) => item?.kind === 'allow_once' && typeof item.optionId === 'string' && item.optionId.length > 0) : null
    const selected = allow ?? reject
    const toolCall = asObject(params.toolCall)
    const event = {
      requestId: String(requestId),
      policy: this.config.permissionPolicy ?? 'reject',
      toolCallId: typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : '',
      title: typeof toolCall.title === 'string' ? toolCall.title : '',
      kind: typeof toolCall.kind === 'string' ? toolCall.kind : '',
      decision: allow ? 'approved' : reject ? 'rejected' : 'cancelled',
      optionId: selected && typeof selected.optionId === 'string' ? selected.optionId : '',
    }
    prompt?.permissions.push(event)
    try {
      prompt?.onPermission?.(event)
    } catch {
      // The decision itself must still be sent even if a listener fails.
    }
    this.logger?.info?.(`acp-permission ${JSON.stringify(event)}`)
    if (selected && typeof selected.optionId === 'string') {
      this.write({
        jsonrpc: '2.0',
        id: requestId,
        result: { outcome: { outcome: 'selected', optionId: selected.optionId } },
      })
    } else {
      this.write({
        jsonrpc: '2.0',
        id: requestId,
        result: { outcome: { outcome: 'cancelled' } },
      })
    }
  }

  onStdinError(error, child) {
    if (this.child !== child) return
    // A prompt that was already written to the pipe cannot be proven absent:
    // report it as acceptance-unknown and keep its bridge lock. Other pending
    // requests (initialize/session/config) failed before the prompt write.
    this.failPending(
      (pending) =>
        new AcpError(
          'acp_write_failed',
          `写入 ACP 子进程失败：${error?.message ?? error}`,
          pending.sent && pending.method === 'session/prompt' ? 'after_write' : 'before_write',
        ),
    )
    // The stdio pipe is no longer usable. Keep session ids only in the bridge
    // job records; a retry must resume and prove the session again.
    this.sessions.clear()
    this.child = null
    this.initialized = false
    this.startPromise = null
    try {
      child.kill()
    } catch {
      // The child may have exited already.
    }
  }

  write(message) {
    if (!this.child || this.closed || !this.child.stdin || this.child.stdin.destroyed) {
      throw new AcpError('acp_not_started', 'ACP 子进程没有在运行。', 'before_write')
    }
    const child = this.child
    child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) this.onStdinError(error, child)
    })
  }

  request(method, params, { timeoutMs = 30000, phase = 'before_write', onSent } = {}) {
    if (this.startError) return Promise.reject(this.startError)
    if (!this.child || this.closed) {
      return Promise.reject(new AcpError('acp_not_started', 'ACP 子进程没有在运行。', 'before_write'))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      let timer = null
      const entry = {
        method,
        sent: false,
        resolve,
        reject,
        clearTimer() {
          if (timer) clearTimeout(timer)
          timer = null
        },
      }
      this.pending.set(id, entry)
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id)
          reject(
            new AcpError(
              'acp_timeout',
              `ACP 请求 ${method} 在 ${Math.round(timeoutMs / 1000)}s 内没有响应。`,
              method === 'session/prompt' ? 'after_write' : 'before_write',
            ),
          )
        }, timeoutMs)
        timer.unref?.()
      }
      try {
        this.write({ jsonrpc: '2.0', id, method, params })
        entry.sent = true
        onSent?.(id)
      } catch (error) {
        this.pending.delete(id)
        entry.clearTimer()
        reject(
          error instanceof AcpError
            ? error
            : new AcpError('acp_write_failed', `写入 ACP 请求失败：${error?.message ?? error}`, 'before_write'),
        )
      }
    })
  }

  failPending(error) {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      pending.clearTimer()
      pending.reject(typeof error === 'function' ? error(pending) : error)
    }
  }

  async authenticate(methodId, { timeoutMs = 120000 } = {}) {
    if (typeof methodId !== 'string' || methodId.trim() === '') {
      throw new AcpError('invalid_request', 'ACP authenticate 需要有效的 methodId。', 'before_write')
    }
    await this.ready()
    return asObject(
      await this.request('authenticate', { methodId: methodId.trim() }, { timeoutMs, phase: 'before_write' }),
    )
  }

  async createSession({ cwd } = {}) {
    // session/new needs an explicit, already-resolved workspace. Silently
    // falling back to the plugin's own cwd would bypass the Host workspace
    // resolution that the bridge performs for every other call.
    if (typeof cwd !== 'string' || cwd.trim() === '') {
      throw new AcpError(
        'workspace_unconfigured',
        'ACP session/new 需要显式 cwd；调用方必须先解析 Host 工作区，不使用桥自身 cwd 兜底。',
        'before_write',
      )
    }
    await this.ready()
    const result = asObject(
      await this.request('session/new', { cwd, mcpServers: [] }, { timeoutMs: 30000 }),
    )
    const sessionId = typeof result.sessionId === 'string' ? result.sessionId : ''
    if (!sessionId) {
      throw new AcpError('session_create_failed', 'ACP session/new 没有返回 sessionId。', 'before_write')
    }
    const session = {
      id: sessionId,
      cwd,
      configOptions: Array.isArray(result.configOptions) ? result.configOptions : [],
      activePrompt: null,
      loading: false,
      resuming: false,
    }
    this.sessions.set(sessionId, session)
    return { sessionId, configOptions: session.configOptions }
  }

  /**
   * Resume an ACP session. `session/resume` is tried first; when the agent
   * does not implement it, `session/load` (when advertised) is used. The
   * desktop app's conversation UUID is a different namespace and is not
   * accepted as a substitute.
   */
  async resumeSession({ sessionId, cwd }) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new AcpError('invalid_session', '续聊需要 ACP sessionId。', 'before_write')
    }
    let session = this.sessions.get(sessionId)
    if (session?.activePrompt) {
      // session/load would replace this collector object. Never do that while
      // a prompt for the same ACP session is still running.
      throw new AcpError(
        'busy',
        `ACP 会话 ${sessionId} 已有在途 prompt；拒绝恢复，避免替换活动回复收集器。`,
        'before_write',
      )
    }
    if (session?.resuming) {
      throw new AcpError('busy', `ACP 会话 ${sessionId} 正在恢复；不并发替换。`, 'before_write')
    }

    // Reserve the session object synchronously, before the first await. A
    // prompt that arrives while session/resume or session/load is in flight
    // must fail instead of starting a collector this response could replace.
    const placeholder = !session
    if (!session) {
      session = {
        id: sessionId,
        cwd,
        configOptions: [],
        activePrompt: null,
        loading: false,
        resuming: false,
      }
      this.sessions.set(sessionId, session)
    }
    session.resuming = true
    let ok = false
    try {
      await this.ready()
      let result = null
      try {
        if (!this.capabilities.resume) throw new AcpError('method_not_found', 'session/resume not advertised', 'before_write', { rpcCode: -32601 })
        result = await this.request(
          'session/resume',
          { sessionId, cwd, mcpServers: [] },
          { timeoutMs: 30000 },
        )
      } catch (error) {
        if (!isMethodNotFound(error)) {
          if (error.code === 'acp_rejected') throw restoreError('session/resume', sessionId, error)
          throw error
        }
        if (!this.capabilities.loadSession) {
          throw new AcpError(
            'unsupported_capability',
            'Antigravity 没有声明 session/resume 或 session/load，无法恢复已存在的 ACP 会话；没有派发。',
            'before_write',
          )
        }
        // Revalidate after the first await. A prompt that somehow started in
        // the meantime must not have its collector replaced by this load.
        if (session.activePrompt) {
          throw new AcpError(
            'busy',
            `ACP 会话 ${sessionId} 已有在途 prompt；拒绝加载，避免替换活动回复收集器。`,
            'before_write',
          )
        }
        session.loading = true
        try {
          result = await this.request(
            'session/load',
            { sessionId, cwd, mcpServers: [] },
            { timeoutMs: 60000 },
          )
        } catch (loadError) {
          throw restoreError('session/load', sessionId, loadError)
        } finally {
          session.loading = false
        }
      }

      const response = asObject(result)
      const current = this.sessions.get(sessionId)
      if (current && current !== session && current.activePrompt) {
        throw new AcpError(
          'busy',
          `ACP 会话 ${sessionId} 已有在途 prompt；拒绝替换活动回复收集器。`,
          'before_write',
        )
      }
      if (session.activePrompt) {
        throw new AcpError(
          'busy',
          `ACP 会话 ${sessionId} 已有在途 prompt；拒绝替换活动回复收集器。`,
          'before_write',
        )
      }
      if (cwd) session.cwd = cwd
      if (Array.isArray(response.configOptions)) session.configOptions = response.configOptions
      session.loading = false
      // Keep the same object identity: the active prompt (if any) belongs to it.
      this.sessions.set(sessionId, session)
      ok = true
      return { sessionId, configOptions: session.configOptions }
    } finally {
      session.resuming = false
      if (!ok && placeholder && !session.activePrompt && this.sessions.get(sessionId) === session) {
        this.sessions.delete(sessionId)
      }
    }
  }

  async setConfigOption(sessionId, configId, value) {
    const session = this.sessions.get(sessionId)
    if (!session) throw new AcpError('unknown_session', `未知 ACP 会话 ${sessionId}。`, 'before_write')
    const result = asObject(
      await this.request(
        'session/set_config_option',
        { sessionId, configId, value },
        { timeoutMs: 30000 },
      ),
    )
    if (!Array.isArray(result.configOptions) || result.configOptions.length === 0) {
      throw new AcpError(
        'config_incomplete',
        `ACP 的 set_config_option 没有返回完整的 configOptions，不能确认 ${configId}=${value}；已停止派发。`,
        'before_write',
        { configOptions: summarizeConfigOptions(session.configOptions) },
      )
    }
    // The response is the complete current state. Cache it before validating so
    // a mismatch reports the service's actual value, not the old snapshot.
    session.configOptions = result.configOptions
    const current =
      summarizeConfigOptions(session.configOptions).find((option) => option.id === configId) ??
      findOption(session.configOptions, configId, new RegExp(configId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    if (!current || current.currentValue !== value) {
      throw new AcpError(
        'config_not_applied',
        `ACP 没有确认配置 ${configId}=${value}；当前值为 ${current?.currentValue ?? '未知'}。已停止派发。`,
        'before_write',
        { configOptions: summarizeConfigOptions(session.configOptions) },
      )
    }
    return { configOptions: session.configOptions }
  }

  /**
   * Send exactly one ACP prompt. The returned promise settles when the
   * matching `session/prompt` response arrives. Text is collected only from
   * agent_message_chunk notifications for this session and this prompt.
   */
  promptSession({ sessionId, prompt, onPermission, onConfigUpdate, onToolEvent, onThought }) {
    const session = this.sessions.get(sessionId)
    if (!session) throw new AcpError('unknown_session', `未知 ACP 会话 ${sessionId}。`, 'before_write')
    if (session.activePrompt) {
      throw new AcpError('busy', `ACP 会话 ${sessionId} 已有在途 prompt。`, 'before_write')
    }
    if (session.resuming) {
      throw new AcpError('busy', `ACP 会话 ${sessionId} 正在恢复；暂不接受 prompt。`, 'before_write')
    }
    const state = {
      requestId: null,
      text: '',
      tools: [],
      toolEvents: [],
      thoughts: [],
      // toolCallId → 已归一化的 kind：缺 kind 的增量 update 靠它继承类别，
      // 避免同一次调用被降级成 other（review t21 F-2）。
      toolKinds: new Map(),
      permissions: [],
      diagnostics: {
        toolEvents: 0,
        thoughtChunks: 0,
        nonTextMessageChunks: 0,
        otherUpdates: 0,
        toolCallbackErrors: 0,
        lastToolCallbackError: '',
        thoughtCallbackErrors: 0,
        lastThoughtCallbackError: '',
      },
      onPermission,
      onConfigUpdate,
      onToolEvent,
      onThought,
    }
    session.activePrompt = state
    let promise
    try {
      promise = this.request(
        'session/prompt',
        { sessionId, prompt },
        {
          timeoutMs: 0,
          phase: 'after_write',
          onSent: (id) => {
            state.requestId = id
          },
        },
      )
    } catch (error) {
      session.activePrompt = null
      throw error
    }
    return promise
      .then((result) => {
        if (session.activePrompt === state) session.activePrompt = null
        const response = asObject(result)
        return {
          stopReason: typeof response.stopReason === 'string' ? response.stopReason : '',
          text: state.text,
          tools: state.tools.slice(),
          toolEvents: state.toolEvents.slice(),
          thoughts: state.thoughts.slice(),
          diagnostics: { ...state.diagnostics },
          permissions: state.permissions.slice(),
          requestId: state.requestId,
          configOptions: session.configOptions,
        }
      })
      .catch((error) => {
        if (session.activePrompt === state) session.activePrompt = null
        if (!Array.isArray(error?.configOptions)) {
          error.configOptions = summarizeConfigOptions(session.configOptions)
        }
        throw error
      })
  }

  cancelSession(sessionId) {
    const session = this.sessions.get(sessionId)
    if (!session) return
    try {
      this.write({
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId },
      })
    } catch {
      // Cancellation is best effort; the process may already be gone.
    }
  }

  close() {
    this.closed = true
    this.initialized = false
    this.startPromise = null
    this.failPending(new AcpError('acp_closed', 'ACP 客户端已关闭。', 'after_write'))
    this.sessions.clear()
    const child = this.child
    this.child = null
    if (child) {
      try {
        child.stdin?.end()
      } catch {
        // Ignore a pipe that is already closed.
      }
      try {
        child.kill()
      } catch {
        // Ignore a process that already exited.
      }
    }
  }
}

export function summarizeOptions(configOptions) {
  return summarizeConfigOptions(configOptions)
}

export function pickModelOption(configOptions) {
  return findOption(configOptions, 'model', /model/i)
}

export function pickThoughtOption(configOptions) {
  const normalized = summarizeConfigOptions(configOptions)
  // Real agy ACP builds advertise this category as "thought_level"; accept the
  // older "thought" spelling and the obvious synonyms as well.
  const categories = new Set(['thought', 'thought_level', 'reasoning', 'effort'])
  const byCategory = normalized.find((option) => categories.has(option.category.toLowerCase()))
  if (byCategory) return byCategory
  return (
    normalized.find((option) => /thought|thinking|reasoning|effort/i.test(`${option.id} ${option.name}`)) ??
    null
  )
}

export function resolveConfigValue(option, requested) {
  return resolveOptionValue(option, requested)
}

/** Thin adapter used by Bridge; keeps process details out of the state machine. */
export function acpBackend(config, logger) {
  const client = new AcpClient(config, logger)
  return {
    kind: 'acp',
    ready: () => client.ready(),
    capabilities: () => client.capabilities,
    authenticate: (methodId, options) => client.authenticate(methodId, options),
    createSession: ({ cwd }) => client.createSession({ cwd }),
    resumeSession: ({ sessionId, cwd }) => client.resumeSession({ sessionId, cwd }),
    setConfigOption: (sessionId, configId, value) =>
      client.setConfigOption(sessionId, configId, value),
    promptSession: (options) => client.promptSession(options),
    cancelSession: (sessionId) => client.cancelSession(sessionId),
    close: () => client.close(),
  }
}