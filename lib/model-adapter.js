/**
 * 官方 agy ACP（stdio）作为 DSH 主模型的适配器。
 *
 * 传输契约（与 `antigravity-bridge/plugin` 里已核实的实现一致）：
 * JSON-RPC 2.0，**每行一个 JSON** 的 stdio 通道；方法依次为
 * `initialize` → `session/new` → `session/set_config_option`（先 model，后 thought）
 * → `session/prompt`，流式文本来自 `session/update` 的 `agent_message_chunk`，
 * 结束以 `session/prompt` 的 `stopReason` 为准。
 *
 * 使用范围：绑定工作区的纯文本多轮；每轮只发新增 user。
 * 目录来自 ACP 完整 configOptions；持久 pending 阻止歧义后重复派发。
 * 工具目录按会话分流（非承重丢弃+声明，承重硬拒绝零 prompt），图片/文件附件与无法对齐的历史仍在派发前明确失败、零 prompt，
 * 不静默丢上下文、不偷偷重放、不自动批准权限请求、不做 Google 上游反代。
 *
 * @module @lnu-seat/dsh-agy-acp-model/adapter
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { canonicalWorkspace } from './workspace.js'
import { normalizeToolEvent, normalizeToolKind } from './acp.js'
import { createCatalogStore, choices } from './model-catalog.js'

import {
  PROVIDER_DESCRIPTION,
  PROVIDER_NAME,
  effortIds,
  modelEntry,
  modelInfo as catalogModelInfo,
  listModelInfos,
} from './model-catalog.js'

/** ACP 协议版本（与 bridge 使用的值一致）。 */
export const PROTOCOL_VERSION = 1

/**
 * 适配器会抛出的失败码。DSH 读取 error.code 保留原值，不伪装成成功。
 *
 * @type {Readonly<Record<string, string>>}
 */
export const ERROR_CODES = Object.freeze({
  INVALID_REQUEST: 'AGY_ACP_INVALID_REQUEST',
  UNSUPPORTED_TOOLS: 'AGY_ACP_UNSUPPORTED_TOOLS',
  UNSUPPORTED_HISTORY: 'AGY_ACP_UNSUPPORTED_HISTORY',
  HISTORY_REPLAYED: 'AGY_ACP_HISTORY_REPLAYED',
  HISTORY_MULTI_ASSISTANT: 'AGY_ACP_HISTORY_MULTI_ASSISTANT',
  HISTORY_TOOL_ORDER: 'AGY_ACP_HISTORY_TOOL_ORDER',
  HISTORY_HASH_MISMATCH: 'AGY_ACP_HISTORY_HASH_MISMATCH',
  HISTORY_SHAPE: 'AGY_ACP_HISTORY_SHAPE',
  REBASELINE_LIMIT_EXCEEDED: 'AGY_ACP_REBASELINE_LIMIT_EXCEEDED',
  MESSAGE_ID_REQUIRED: 'AGY_ACP_MESSAGE_ID_REQUIRED',
  RESET_BUSY: 'AGY_ACP_RESET_BUSY',
  UNSUPPORTED_CONTENT: 'AGY_ACP_UNSUPPORTED_CONTENT',
  UNSUPPORTED_DEVELOPER: 'AGY_ACP_UNSUPPORTED_DEVELOPER',
  UNSUPPORTED_MESSAGE: 'AGY_ACP_UNSUPPORTED_MESSAGE',
  EMPTY_PROMPT: 'AGY_ACP_EMPTY_PROMPT',
  PROMPT_TOO_LARGE: 'AGY_ACP_PROMPT_TOO_LARGE',
  MODEL_UNSUPPORTED: 'AGY_ACP_MODEL_UNSUPPORTED',
  EFFORT_UNSUPPORTED: 'AGY_ACP_EFFORT_UNSUPPORTED',
  CONFIG_INCOMPLETE: 'AGY_ACP_CONFIG_INCOMPLETE',
  CONFIG_NOT_APPLIED: 'AGY_ACP_CONFIG_NOT_APPLIED',
  SPAWN_FAILED: 'AGY_ACP_SPAWN_FAILED',
  TRANSPORT_CLOSED: 'AGY_ACP_TRANSPORT_CLOSED',
  TIMEOUT: 'AGY_ACP_TIMEOUT',
  EXITED: 'AGY_ACP_EXITED',
  SESSION_FAILED: 'AGY_ACP_SESSION_FAILED',
  PROMPT_FAILED: 'AGY_ACP_PROMPT_FAILED',
  PERMISSION_REQUIRED: 'AGY_ACP_PERMISSION_REQUIRED',
  REFUSAL: 'AGY_ACP_REFUSAL',
  MAX_TURN_REQUESTS: 'AGY_ACP_MAX_TURN_REQUESTS',
  UNKNOWN_STOP_REASON: 'AGY_ACP_UNKNOWN_STOP_REASON',
  INVALID_CALL: 'AGY_ACP_INVALID_CALL',
  /** JSON-RPC -32601：对端没有实现该方法（resume 能力门与实际不符）。 */
  UNKNOWN_METHOD: 'AGY_ACP_UNKNOWN_METHOD',
})

export const MAX_CONSECUTIVE_REBASELINES = 3

export const HISTORY_ERROR_CODES = Object.freeze({
  REPLAYED: ERROR_CODES.HISTORY_REPLAYED,
  MULTI_ASSISTANT: ERROR_CODES.HISTORY_MULTI_ASSISTANT,
  TOOL_ORDER: ERROR_CODES.HISTORY_TOOL_ORDER,
  HASH_MISMATCH: ERROR_CODES.HISTORY_HASH_MISMATCH,
  SHAPE: ERROR_CODES.HISTORY_SHAPE,
})

function hashPrefix(hash) {
  return typeof hash === 'string' && hash !== '' ? hash.slice(0, 12) : 'none'
}

function historyErrorDetail(reason, committedLen, deltaCount, expectedHash) {
  return `${reason}（committed=${committedLen}，增量=${deltaCount}，期望hash=${hashPrefix(expectedHash)}）；没有派发 prompt。`
}

/**
 * 一个带稳定 `code` 的适配器失败。`code` 必须是自有数据属性，DSH 的
 * `normalizeLlmFailure` 才会把它保留成终态 `finish.failure.code`。
 */
export class AgyAcpError extends Error {
  /**
   * @param {string} code - 稳定失败码。
   * @param {string} message - 面向用户的中文说明。
   * @param {{cause?: unknown}} [options] - 原始原因。
   */
  constructor(code, message, options) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AgyAcpError'
    /** @type {string} */
    this.code = code
    // DSH 只用 HarnessError 的 code 做归一化；外部错误只有自带同码的 `failure`
    // 快照时，它的 code 才会在 model 失败与助手消息里原样保留，否则会变成 UNKNOWN。
    this.failure = Object.freeze({ code, message })
  }
}

/** 单次 prompt 的文本上限（字符数）；超出即失败而不是截断。 */
export const MAX_PROMPT_CHARS = 200_000

const INVALID = ERROR_CODES.INVALID_REQUEST

/** 承重（协作/任务）工具：丢掉它们会让成员领不到任务、回报不了，必须硬拒绝。 */
export const LOAD_BEARING_TOOLS = Object.freeze(['claim_task', 'update_task', 'send_message', 'create_task', 'reassign_task'])

/**
 * 承重（协作/任务）工具前缀规则：覆盖 AgentTeams 插件家族（`agent_teams_*`）与 DSH 内置
 * `@deepseek-ai/dsh-tool-agent-team` 家族（`team_task_*`：`team_task_create`/`get`/`list`/`update`）。
 * 漏掉任意一族会导致承重工具被静默丢弃（成员领不到任务/回报不了）。
 */
export const LOAD_BEARING_TOOL_PREFIXES = Object.freeze(['agent_teams_', 'team_task_'])

/**
 * 判定一个工具名是否承重；非字符串一律按非承重处理（不猜）。
 *
 * @param {unknown} name - 工具名。
 * @returns {boolean} 是否为承重工具。
 */
export function isLoadBearingTool(name) {
  if (typeof name !== 'string' || name === '') return false
  return LOAD_BEARING_TOOLS.includes(name) || LOAD_BEARING_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/**
 * 普通会话仅含非承重工具、丢弃工具目录后追加到 systemText 末尾的逐字稳定声明（零动态内容）。
 */
export const NO_TOOLS_NOTICE = Object.freeze(
  '[DSH / Antigravity ACP 纯文本通道声明]\n' +
    '本会话走纯文本 ACP 通道，DSH 已丢弃工具目录。本次无任何工具可用（不能读/写文件、不能执行命令、不能领取或回报任务），你只能输出文本。如确需使用工具，请改用 antigravity_send 任务桥。\n\n' +
    '[DSH / Antigravity ACP Text-Only Channel Notice]\n' +
    'This session runs on a text-only ACP channel and DSH has dropped the tool catalog. No tools are available in this turn (you cannot read/write files, execute commands, or claim/report tasks); you may only output text. If tools are required, use the antigravity_send task bridge instead.',
)

/**
 * 档四最小版（acpToolBridge）：允许通过文本围栏桥接给 DSH 原生执行的团队工具白名单。
 */
export const TOOL_BRIDGE_ALLOWLIST = Object.freeze(['claim_task', 'update_task'])

export const TOOL_BRIDGE_TOOL_PREFIX = 'agent_teams_'

/**
 * 返回 'claim_task' | 'update_task' | null（只看白名单语义，不看调用是否发生）。
 *
 * @param {unknown} name - 工具名。
 * @returns {'claim_task' | 'update_task' | null} 规范化工具种类。
 */
function bridgeToolKind(name) {
  if (typeof name !== 'string' || name === '') return null
  const bare = name.startsWith(TOOL_BRIDGE_TOOL_PREFIX) ? name.slice(TOOL_BRIDGE_TOOL_PREFIX.length) : name
  return TOOL_BRIDGE_ALLOWLIST.includes(bare) ? bare : null
}

/**
 * 桥接工具调用的独立围栏标记。
 */
export const TOOL_CALL_FENCE = '```tool_call'

/**
 * 桥接工具调用解析失败时追加到回复末尾的纠偏提示。
 */
export const TOOL_BRIDGE_CORRECTION = Object.freeze(
  '[DSH 工具调用格式纠偏] 检测到无效的 tool_call 输出，本轮未向宿主派发工具调用。如需调用工具，请仅输出一个独立围栏块（独占起止行 ```tool_call 与 ```），内部为合法 JSON 对象 {"name":"claim_task"|"update_task","arguments":{...}}，且不要在围栏外出现裸 tool_call 字样。',
)

/**
 * 确定性 JSON 序列化（按对象键字典序排列），保证相同语义产生相同字符串与 callId。
 *
 * @param {unknown} value - 任意可序列化值。
 * @returns {string} 规范化 JSON 字符串。
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`
  }
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

/**
 * 为启用 `acpToolBridge` 的请求生成确定性的系统工具桥接说明。
 *
 * @param {ReadonlyArray<{name: string, description?: string, inputSchema?: unknown, parameters?: unknown}>} tools - 允许的工具列表。
 * @returns {string} 确定性系统说明文本。
 */
export function renderToolBridgeNotice(tools) {
  const normalized = [...(tools ?? [])]
    .filter((tool) => tool && typeof tool.name === 'string')
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const lines = [
    '[DSH / Antigravity ACP 团队工具桥接说明]',
    '本轮仅开放以下团队协作工具供宿主原生执行（每轮最多调用 1 个）：',
  ]
  for (const tool of normalized) {
    const schema = tool.inputSchema ?? tool.parameters
    const desc = typeof tool.description === 'string' && tool.description.trim() !== '' ? ` - ${tool.description.trim()}` : ''
    const schemaText = schema !== undefined ? ` 参数Schema: ${canonicalJson(schema)}` : ''
    lines.push(`- ${tool.name}${desc}${schemaText}`)
  }
  lines.push(
    '调用格式：必须使用独占起止行的 ```tool_call 与 ``` 围栏包裹一个 JSON 对象：{"name":"<toolName>","arguments":{...}}。',
    '禁止在围栏外提及裸 tool_call，禁止一次输出多个围栏，否则本轮工具调用会被拒绝。',
  )
  return lines.join('\n')
}

/**
 * 为启用 `acpToolBridge` 且存在被丢弃工具的请求生成确定性的工具目录提示。
 *
 * @param {ReadonlyArray<{name: string}>} bridgedTools - 保留的可桥接工具列表。
 * @param {ReadonlyArray<string>} droppedNames - 被丢弃的工具名列表。
 * @returns {string} 确定性丢弃声明文本。
 */
export function renderDroppedToolsNotice(bridgedTools, droppedNames) {
  const available = [...(bridgedTools ?? [])]
    .filter((tool) => tool && typeof tool.name === 'string')
    .map((tool) => tool.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const dropped = [...new Set((droppedNames ?? []).filter((name) => typeof name === 'string' && name !== ''))]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const lines = ['[DSH / Antigravity ACP 工具目录提示]']
  lines.push(
    available.length > 0
      ? `本次可用工具仅：${available.join('、')}（必须使用上面列出的完整工具名）。`
      : '本次没有可用的团队工具。',
  )
  lines.push(`以下工具本次不可用（已丢弃，宿主不会执行）：${dropped.join('、')}。`)
  lines.push('不要尝试调用它们：若输出这些工具的 tool_call 围栏，本轮会被直接拒绝且不产生任何调用。')
  lines.push('需要通报进度或交付结果时，请把内容写进 update_task 的 arguments.output（或 claim_task 的说明字段）。')
  return lines.join('\n')
}

/**
 * Fail-closed 解析模型输出中的独立 `tool_call` 围栏块。
 *
 * @param {string} text - 模型本轮完整输出文本。
 * @param {readonly string[]} [allowedNames] - 本轮允许的工具名列表（默认 {@link TOOL_BRIDGE_ALLOWLIST}）。
 * @returns {{prose: string, calls: Array<{id: string, name: string, arguments: string}>, problem: null | 'inline_mention' | 'count' | 'json' | 'unknown_fields' | 'unknown_tool' | 'arguments'}} 解析结果。
 */
export function parseToolCalls(text, allowedNames = TOOL_BRIDGE_ALLOWLIST) {
  if (typeof text !== 'string' || text === '') {
    return { prose: typeof text === 'string' ? text : '', calls: [], problem: null }
  }
  const allowlist = Array.isArray(allowedNames) ? allowedNames : TOOL_BRIDGE_ALLOWLIST
  const lines = text.split(/\r?\n/)
  const keptLines = []
  const fences = []
  let inFence = false
  let currentFence = []
  let fenceCount = 0
  let sawInlineMention = false

  for (const line of lines) {
    if (!inFence) {
      if (/^\s*```tool_call\s*$/.test(line)) {
        inFence = true
        fenceCount += 1
        currentFence = []
        continue
      }
      if (/\btool_call\b/.test(line)) {
        sawInlineMention = true
      }
      keptLines.push(line)
      continue
    }
    if (/^\s*```\s*$/.test(line)) {
      inFence = false
      fences.push(currentFence.join('\n'))
      currentFence = []
      continue
    }
    currentFence.push(line)
  }

  if (inFence) {
    return { prose: text, calls: [], problem: 'count' }
  }
  if (fenceCount === 0) {
    return { prose: text, calls: [], problem: sawInlineMention ? 'inline_mention' : null }
  }
  if (fenceCount !== 1 || fences.length !== 1) {
    return { prose: text, calls: [], problem: 'count' }
  }
  if (sawInlineMention) {
    return { prose: text, calls: [], problem: 'inline_mention' }
  }

  let parsed
  try {
    parsed = JSON.parse(fences[0])
  } catch {
    return { prose: text, calls: [], problem: 'json' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { prose: text, calls: [], problem: 'unknown_tool' }
  }
  if (!Object.keys(parsed).every((k) => k === 'name' || k === 'arguments')) {
    return { prose: text, calls: [], problem: 'unknown_fields' }
  }
  if (typeof parsed.name !== 'string' || !allowlist.includes(parsed.name)) {
    return { prose: text, calls: [], problem: 'unknown_tool' }
  }
  if (
    parsed.arguments === null ||
    typeof parsed.arguments !== 'object' ||
    Array.isArray(parsed.arguments)
  ) {
    return { prose: text, calls: [], problem: 'arguments' }
  }

  const argsJson = canonicalJson(parsed.arguments)
  const callId = `call-${createHash('sha256').update(`${parsed.name}|${argsJson}`).digest('hex').slice(0, 20)}`
  const prose = keptLines.join('\n').trim()
  return {
    prose,
    calls: [{ id: callId, name: parsed.name, arguments: argsJson }],
    problem: null,
  }
}
const STDERR_KEEP = 8192

/**
 * 显式“不重试”策略（resolved 形状）。
 *
 * DSH 的 `providerRetryPolicy` 返回 `undefined` 时会套用默认策略（最多 5 次重试）；
 * 本通道一次调用就是一次 `session/prompt`，重发会重复派发，因此必须显式给出 0 次。
 */
export const NO_RETRY_POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 0,
  retryableCodes: Object.freeze([]),
  initialDelayMs: 0,
  maxDelayMs: 0,
  jitterRatio: 0,
})

/**
 * 归一化插件配置；只保留适配器真正用到的字段。
 *
 * @param {Record<string, unknown>} [config] - 插件行 config。
 * @returns {{agyExecutable: string, agyArgs: string[], cwd: string, model: string | undefined, initializeTimeoutMs: number, sessionTimeoutMs: number, configTimeoutMs: number, promptTimeoutMs: number, transport: undefined | (() => object), onStderr: undefined | ((chunk: string) => void)}}
 *   归一化配置。
 */
export function resolveConfig(config = {}) {
  const source = config ?? {}
  const agyExecutable = typeof source.agyExecutable === 'string' && source.agyExecutable !== '' ? source.agyExecutable : 'agy'
  const agyArgs = source.agyArgs === undefined ? ['acp'] : source.agyArgs
  if (!Array.isArray(agyArgs) || agyArgs.some((arg) => typeof arg !== 'string')) {
    throw new AgyAcpError(INVALID, 'agyArgs 必须是字符串数组。')
  }
  const cwd = typeof source.cwd === 'string' && source.cwd !== '' ? source.cwd : process.cwd()
  const model = source.model === undefined ? undefined : source.model
  if (model !== undefined && (typeof model !== 'string' || model === '')) {
    throw new AgyAcpError(INVALID, 'model 必须是非空字符串（ACP 的 model 选项值）。')
  }
  if (source.transport !== undefined && typeof source.transport !== 'function') {
    throw new AgyAcpError(INVALID, 'transport 必须是返回 ACP 传输对象的工厂函数（测试/嵌入用）。')
  }
  if (source.acpToolBridge !== undefined && typeof source.acpToolBridge !== 'boolean') {
    throw new AgyAcpError(INVALID, 'acpToolBridge 必须是布尔值。')
  }
  if (
    source.acpPermissionPolicy !== undefined &&
    source.acpPermissionPolicy !== 'reject' &&
    source.acpPermissionPolicy !== 'allow_once'
  ) {
    throw new AgyAcpError(INVALID, "acpPermissionPolicy 只能是 'reject' 或 'allow_once'。")
  }
  return {
    agyExecutable,
    agyArgs: [...agyArgs],
    cwd,
    model,
    acpToolBridge: source.acpToolBridge ?? false,
    acpPermissionPolicy: source.acpPermissionPolicy ?? 'reject',
    // 仅供展示，绝不回流上下文（否则会重现官方 bundle 的「思考死循环」）。
    inlineThought: source.inlineThought !== false,
    nativeActivityEnabled: source.nativeActivityEnabled !== false && process.env.AGY_NATIVE_ACTIVITY !== '0',
    resolveWorkspace: source.resolveWorkspace,
    nativeStateFile: source.nativeStateFile,
    initializeTimeoutMs: positive(source.initializeTimeoutMs, 30_000),
    sessionTimeoutMs: positive(source.sessionTimeoutMs, 30_000),
    configTimeoutMs: positive(source.configTimeoutMs, 30_000),
    promptTimeoutMs: nonNegative(source.promptTimeoutMs, 0),
    transport: source.transport,
    onStderr: typeof source.onStderr === 'function' ? source.onStderr : undefined,
    onCleanupError: typeof source.onCleanupError === 'function' ? source.onCleanupError : undefined,
    onToolEvents: typeof source.onToolEvents === 'function' ? source.onToolEvents : undefined,
  }
}

/**
 * @param {unknown} value - 候选值。
 * @param {number} fallback - 缺省值。
 * @returns {number} 正数或 fallback。
 */
function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * @param {unknown} value - 候选值。
 * @param {number} fallback - 缺省值。
 * @returns {number} 非负数或 fallback。
 */
function nonNegative(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * 把一条请求映射成一次 ACP 文本 prompt；不支持的输入在这里失败（零 I/O、零 prompt）。
 *
 * @param {object} options - DSH `GenerateOptions`。
 * @param {object} [settings] - 适配器归一化配置（可选）。
 * @returns {{promptText: string, systemText: string, userText: string, history: Array<object>, systemChars: number, userChars: number, droppedTools: number, loadBearingTools: string[], bridgedTools: Array<object>, toolResults: Array<{toolCallId: string, isError: boolean, text: string}>}} 派发计划。
 */
export function planRequest(options, settings = {}) {
  if (options === null || typeof options !== 'object') {
    throw new AgyAcpError(INVALID, '模型请求为空。')
  }
  const acpToolBridge = settings?.acpToolBridge === true
  const tools = options.tools
  let droppedTools = 0
  let droppedToolNames = []
  let bridgedTools = []
  if (Array.isArray(tools) && tools.length > 0) {
    if (acpToolBridge) {
      const kept = []
      const seen = new Set()
      const droppedNames = []
      for (const tool of tools) {
        const name = typeof tool?.name === 'string' ? tool.name : ''
        if (name !== '' && bridgeToolKind(name) !== null && !seen.has(name)) {
          seen.add(name)
          kept.push(tool)
        } else if (name !== '') {
          droppedNames.push(name)
        }
      }
      bridgedTools = kept
      droppedToolNames = droppedNames.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      droppedTools = droppedToolNames.length
    } else {
      const loadBearing = tools.filter((tool) => isLoadBearingTool(tool?.name))
      if (loadBearing.length > 0) {
        const names = loadBearing.map((tool) => tool.name).join(', ')
        throw new AgyAcpError(
          ERROR_CODES.UNSUPPORTED_TOOLS,
          `本适配器是纯文本多轮，不能交付协作/任务工具（${names}）；请：①切到零工具预设 antigravity-acp-text（Agent 预设「Antigravity ACP 纯文本多轮」），或 ②改用 antigravity_send 任务桥把任务派给 Gemini；没有派发 prompt。`,
        )
      }
      droppedTools = tools.length
    }
  }
  const toolHistory = options.toolHistory
  const historyTools = toolHistory?.tools?.length ?? 0
  const historyUpdates = toolHistory?.updates?.length ?? 0
  // toolHistory 是「当前生效的工具声明台账」（@deepseek-ai/dsh-llm types.d.ts ToolHistory），
  // 不是工具调用记录；ACP 文本通道无处可用，bridge 模式下干净忽略（不渲染、不进 systemText/promptText）。
  if (!acpToolBridge && (historyTools > 0 || historyUpdates > 0)) {
    throw new AgyAcpError(
      ERROR_CODES.UNSUPPORTED_TOOLS,
      `本适配器不接工具历史（${historyTools} 个声明、${historyUpdates} 个更新）；没有派发 prompt。`,
    )
  }

  const messages = Array.isArray(options.messages) ? options.messages : []
  const systemParts = []
  const userParts = []
  const trailingUserParts = []
  const history = []
  const toolResults = []
  const orphanToolParts = []
  let sawTrailingTool = false
  for (const message of messages) {
    const role = message?.role
    if (role === 'system') {
      systemParts.push(blockText(message.content, 'system'))
      continue
    }
    if (role === 'user' || role === 'assistant') {
      const text = blockText(message.content, role, acpToolBridge && role === 'assistant')
      history.push({ role, text, ...(typeof message.id === 'string' ? { id: message.id } : {}) })
      if (role === 'user' && toolResults.length > 0) {
        // 紧邻这条 user 之前的工具结果，才可能是本轮孤立结果
        orphanToolParts.length = 0
        orphanToolParts.push(formatToolResults(toolResults))
      } else {
        // assistant 已消费过工具结果；孤立结果绝不跨轮累积
        orphanToolParts.length = 0
      }
      toolResults.length = 0
      if (role === 'user') {
        userParts.push(text)
        trailingUserParts.push(text)
      } else {
        trailingUserParts.length = 0
      }
      sawTrailingTool = false
      continue
    }
    if (role === 'tool') {
      if (!acpToolBridge) {
        throw new AgyAcpError(ERROR_CODES.UNSUPPORTED_TOOLS, '工具历史尚未支持；没有派发 prompt。')
      }
      const toolCallId =
        typeof message.toolCallId === 'string'
          ? message.toolCallId
          : typeof message.source?.callId === 'string'
            ? message.source.callId
            : ''
      const mappedEntry = toolCallId ? settings?.toolNames?.get?.(toolCallId) : undefined
      const mappedName =
        typeof mappedEntry === 'string'
          ? mappedEntry
          : typeof mappedEntry?.name === 'string'
            ? mappedEntry.name
            : ''
      const toolName =
        typeof message.toolName === 'string' && message.toolName !== '' ? message.toolName : mappedName
      const isError = message.isError === true
      const text = blockText(message.content, 'tool')
      toolResults.push({ toolCallId, toolName, isError, text })
      sawTrailingTool = true
      continue
    }
    if (role === 'developer') {
      throw new AgyAcpError(
        ERROR_CODES.UNSUPPORTED_DEVELOPER,
        '本适配器不接 developer 消息（工具增删/更新走 developer 角色）；没有派发 prompt。',
      )
    }
    throw new AgyAcpError(ERROR_CODES.UNSUPPORTED_MESSAGE, `未知消息角色 ${JSON.stringify(role)}；没有派发 prompt。`)
  }

  if (acpToolBridge && sawTrailingTool && toolResults.length > 0) {
    if (history.at(-1)?.role !== 'assistant') {
      throw new AgyAcpError(ERROR_CODES.UNSUPPORTED_HISTORY, '工具结果消息前必须紧邻 assistant 工具调用；没有派发 prompt。')
    }
  } else {
    if (userParts.length === 0) {
      throw new AgyAcpError(ERROR_CODES.EMPTY_PROMPT, '请求里没有用户文本可发送；没有派发 prompt。')
    }
    if (history.at(-1)?.role !== 'user') throw new AgyAcpError(ERROR_CODES.UNSUPPORTED_HISTORY, '历史必须以新增用户输入结束；没有派发 prompt。')
  }

  const systemText = [
    typeof options.system === 'string' ? options.system : '',
    ...systemParts,
    ...(bridgedTools.length > 0 ? [renderToolBridgeNotice(bridgedTools)] : []),
    ...(droppedToolNames.length > 0 ? [renderDroppedToolsNotice(bridgedTools, droppedToolNames)] : []),
    ...(droppedTools > 0 && !acpToolBridge ? [NO_TOOLS_NOTICE] : []),
  ]
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join('\n\n')
  const orphanToolText = orphanToolParts.join('\n\n')
  const toolResultText = formatToolResults(toolResults)
  const joinedUserText = trailingUserParts.join('\n\n')
  const userText =
    acpToolBridge && sawTrailingTool && toolResults.length > 0
      ? toolResultText
      : acpToolBridge && !sawTrailingTool && toolResults.length === 0 && orphanToolText !== '' && history.at(-1)?.role === 'user'
        ? `${orphanToolText}\n\n${joinedUserText}`
        : joinedUserText
  if (userText.trim() === '') {
    throw new AgyAcpError(ERROR_CODES.EMPTY_PROMPT, '用户文本为空；没有派发 prompt。')
  }
  // 明确映射：system 段在前、用户文本在后，合成一次 ACP prompt（不丢、不重排）。
  const promptText = systemText === '' ? userText : `${systemText}\n\n${userText}`
  if (promptText.length > MAX_PROMPT_CHARS) {
    throw new AgyAcpError(
      ERROR_CODES.PROMPT_TOO_LARGE,
      `合成了 ${promptText.length} 字符的 prompt，超过上限 ${MAX_PROMPT_CHARS}；不截断、没有派发 prompt。`,
    )
  }
  return {
    promptText,
    systemText,
    userText,
    history,
    systemChars: systemText.length,
    userChars: userText.length,
    droppedTools,
    loadBearingTools: [],
    bridgedTools,
    toolResults,
  }
}

/**
 * 把一组 `toolResults` 渲染为发送给 ACP 模型的文本块。
 *
 * @param {Array<{toolName?: string, isError: boolean, text: string}>} items - 工具结果列表。
 * @returns {string} 渲染文本。
 */
function formatToolResults(items) {
  return items
    .map((item) => `[DSH 工具结果 / tool result] tool=${item.toolName || 'unknown'} status=${item.isError ? 'failed' : 'completed'}\n${item.text}`)
    .join('\n\n')
}

/**
 * 读一条消息的内容块文本；非文本块直接失败（不读入、不派发）。仅 assistant 侧跳过自身产出的展示块。
 *
 * @param {unknown} content - 消息内容（字符串或内容块数组）。
 * @param {string} role - 该消息的角色，用于失败说明。
 * @param {boolean} [allowToolCall] - 是否允许 assistant 消息中的 `tool-call` 块（桥接模式下跳过该块以保持纯文本历史指纹一致）。
 * @returns {string} 文本。
 */
function blockText(content, role, allowToolCall = false) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    throw new AgyAcpError(ERROR_CODES.UNSUPPORTED_CONTENT, `${role} 消息内容不是文本块数组；没有派发 prompt。`)
  }
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
      continue
    }
    if (allowToolCall && block !== null && typeof block === 'object' && block.type === 'tool-call') {
      continue
    }
    // 仅 assistant 侧跳过自身内联产出的 reasoning 展示块（已知但不可发送）；user/system/tool 仍 fail-closed。
    if (role === 'assistant' && block !== null && typeof block === 'object' && block.type === 'reasoning') {
      continue
    }
    const kind = block !== null && typeof block === 'object' ? block.type : typeof block
    throw new AgyAcpError(
      ERROR_CODES.UNSUPPORTED_CONTENT,
      `内容块类型 ${JSON.stringify(kind)} 不支持（本适配器只接纯文本，不接图片/文件/工具块）；没有派发 prompt。`,
    )
  }
  return parts.join('\n\n')
}

/**
 * 在 `configOptions` 里找一个选项：先按 category，再按 id 兜底。
 *
 * @param {unknown} configOptions - ACP 返回的完整选项数组。
 * @param {string} category - 期望的 category（model / thought_level）。
 * @param {string} fallbackId - 期望的选项 id。
 * @returns {any | undefined} 选项。
 */
export function findConfigOption(configOptions, category, fallbackId) {
  if (!Array.isArray(configOptions)) return undefined
  const byCategory = configOptions.find((option) => option?.category === category)
  if (byCategory !== undefined) return byCategory
  return configOptions.find((option) => option?.id === fallbackId)
}

/**
 * 一个 ACP 选项声明的取值列表。
 *
 * @param {any} option - 选项。
 * @returns {string[]} 取值；未声明时为空数组。
 */
export function optionValues(option) {
  return choices(option).map((item) => item.id)
}

/**
 * 把 ACP `stopReason` 映射成 DSH `FinishReason`；未知值不当完成。
 *
 * @param {unknown} stopReason - ACP 返回值。
 * @param {string} [context] - 失败说明用的附加信息。
 * @returns {{reason: object, failure?: {code: string, message: string}}} 终态。
 */
export function mapStopReason(stopReason, context = '') {
  switch (stopReason) {
    case 'end_turn':
      return { reason: { kind: 'stop' } }
    case 'max_tokens':
      return { reason: { kind: 'max-tokens' } }
    case 'cancelled':
      return {
        reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'ACP 会话被取消（stopReason=cancelled）。' } },
      }
    case 'refusal':
      return {
        reason: {
          kind: 'error',
          failure: { code: ERROR_CODES.REFUSAL, message: `模型拒绝回答（stopReason=refusal）${context}。` },
        },
      }
    case 'max_turn_requests':
      return {
        reason: {
          kind: 'error',
          failure: {
            code: ERROR_CODES.MAX_TURN_REQUESTS,
            message: `ACP 达到本回合请求上限（stopReason=max_turn_requests）${context}；不自动重发。`,
          },
        },
      }
    default:
      return {
        reason: {
          kind: 'error',
          failure: {
            code: ERROR_CODES.UNKNOWN_STOP_REASON,
            message: `session/prompt 返回未知 stopReason ${JSON.stringify(stopReason ?? null)}${context}；不当作完成。`,
          },
        },
      }
  }
}

/**
 * ACP stdio 传输：换行分隔的 JSON-RPC 2.0。
 *
 * 测试与嵌入可以注入自己的实现（同样的 `start/request/notify/onNotification/onRequest/respond/close`）。
 */
export class AcpStdioTransport {
  #child = null
  #pending = new Map()
  #nextId = 0
  #buffer = ''
  #notifications = []
  #requests = []
  #closed = false
  #stderr = ''
  #onStderr

  /**
   * @param {{agyExecutable: string, agyArgs: string[], cwd: string, onStderr?: (chunk: string) => void, env?: Record<string, string>}} options - 启动参数。
   */
  constructor(options) {
    this.executable = options.agyExecutable
    this.args = options.agyArgs
    this.cwd = options.cwd
    this.env = options.env
    this.#onStderr = options.onStderr
  }

  /** 最近 8192 字节的 stderr（诊断用）。 */
  get stderr() {
    return this.#stderr
  }

  /** 启动子进程（幂等）。 */
  start() {
    if (this.#child !== null) return
    const child = spawn(this.executable, this.args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...(this.env === undefined ? {} : { env: { ...process.env, ...this.env } }),
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#onStdout(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      this.#stderr = (this.#stderr + chunk).slice(-STDERR_KEEP)
      this.#onStderr?.(chunk)
    })
    child.on('error', (error) => {
      this.#closed = true
      this.#failPending(
        new AgyAcpError(ERROR_CODES.SPAWN_FAILED, `无法启动 ${this.executable} ${this.args.join(' ')}：${error?.message ?? error}`, {
          cause: error,
        }),
      )
    })
    child.on('exit', (code, signal) => {
      this.#closed = true
      this.#failPending(
        new AgyAcpError(
          ERROR_CODES.EXITED,
          `agy ACP 子进程已退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）；失败不自动重发。${this.#stderr === '' ? '' : ` stderr尾：${this.#stderr.slice(-500)}`}`,
        ),
      )
    })
    this.#child = child
  }

  /**
   * 注册通知处理器。
   *
   * 返回成对的注销函数：每轮 `stream()` 都会注册一个，因此必须能在轮末移除，
   * 否则一个长寿传输上的处理器只增不减。
   *
   * @param {(message: {method: string, params?: any}) => void} handler - 处理函数。
   * @returns {() => void} 注销函数（幂等）。
   */
  onNotification(handler) {
    this.#notifications.push(handler)
    return () => {
      const index = this.#notifications.indexOf(handler)
      if (index >= 0) this.#notifications.splice(index, 1)
    }
  }

  /**
   * 注册 agent→client 请求处理器（如 session/request_permission）。
   *
   * @param {(message: {id: number, method: string, params?: any}) => boolean} handler - 返回 true 表示已自行应答。
   * @returns {() => void} 注销函数（幂等）。
   */
  onRequest(handler) {
    this.#requests.push(handler)
    return () => {
      const index = this.#requests.indexOf(handler)
      if (index >= 0) this.#requests.splice(index, 1)
    }
  }

  /**
   * 当前已注册的处理器数量（诊断/回归：轮末必须回到 0）。
   *
   * @returns {{notifications: number, requests: number}} 处理器计数。
   */
  listenerCounts() {
    return { notifications: this.#notifications.length, requests: this.#requests.length }
  }

  /** 通道是否可用（子进程在且未关闭）。 */
  get isClosed() {
    return this.#child === null || this.#closed
  }

  /**
   * 发一条 JSON-RPC 请求并等待回执。
   *
   * @param {string} method - 方法名。
   * @param {unknown} params - 参数。
   * @param {{timeoutMs?: number}} [options] - 超时（0 表示不设超时）。
   * @returns {Promise<any>} 结果。
   */
  request(method, params, options = {}) {
    const timeoutMs = options.timeoutMs ?? 0
    const id = ++this.#nextId
    return new Promise((resolve, reject) => {
      if (this.#child === null || this.#closed) {
        reject(new AgyAcpError(ERROR_CODES.TRANSPORT_CLOSED, `ACP 通道已关闭，无法发送 ${method}；没有重发。`))
        return
      }
      let timer
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.#pending.delete(id)
          reject(new AgyAcpError(ERROR_CODES.TIMEOUT, `ACP ${method} 在 ${timeoutMs}ms 内没有回执；不自动重发。`))
        }, timeoutMs)
        timer.unref?.()
      }
      this.#pending.set(id, {
        method,
        resolve,
        reject,
        timer,
        // Called synchronously while the matching response line is being
        // dispatched, before the microtask that resolves `request()`. This is
        // what lets a prompt collector stop accepting notifications from the
        // same stdout batch that carried the response.
        onResponse: typeof options.onResponse === 'function' ? options.onResponse : undefined,
      })
      try {
        this.#write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
      } catch (error) {
        this.#pending.delete(id)
        if (timer !== undefined) clearTimeout(timer)
        reject(error)
      }
    })
  }

  /**
   * 发一条通知（无回执）。
   *
   * @param {string} method - 方法名。
   * @param {unknown} params - 参数。
   */
  notify(method, params) {
    this.#write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  }

  /**
   * 回复一条 agent→client 请求。
   *
   * @param {number} id - 请求 id。
   * @param {unknown} result - 结果。
   */
  respond(id, result) {
    this.#write({ jsonrpc: '2.0', id, result })
  }

  /**
   * 回复一条 agent→client 请求为错误。
   *
   * @param {number} id - 请求 id。
   * @param {number} code - JSON-RPC 错误码。
   * @param {string} message - 说明。
   */
  respondError(id, code, message) {
    this.#write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  /** 关闭通道：杀掉子进程并让所有在途请求失败。 */
  close() {
    const child = this.#child
    this.#child = null
    this.#closed = true
    this.#failPending(new AgyAcpError(ERROR_CODES.TRANSPORT_CLOSED, 'ACP 通道已关闭。'))
    if (child !== null) {
      try {
        child.stdin?.end()
      } catch {
        // 已经结束的管道无需再处理。
      }
      try {
        child.kill()
      } catch {
        // 子进程可能已经退出。
      }
    }
  }

  /**
   * @param {object} message - JSON-RPC 消息。
   */
  #write(message) {
    const child = this.#child
    if (child === null || this.#closed || child.stdin === null || child.stdin.destroyed) {
      throw new AgyAcpError(ERROR_CODES.TRANSPORT_CLOSED, 'ACP 通道不可写（子进程已退出）；没有重发。')
    }
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  /**
   * @param {string} chunk - stdout 片段。
   */
  #onStdout(chunk) {
    this.#buffer += chunk
    while (true) {
      const newline = this.#buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.#buffer.slice(0, newline).trim()
      this.#buffer = this.#buffer.slice(newline + 1)
      if (line === '') continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        // agy 可能在 stdout 上打横幅；按 bridge 的既有做法忽略非 JSON 行。
        continue
      }
      this.#dispatch(message)
    }
  }

  /**
   * @param {any} message - 解析后的消息。
   */
  #dispatch(message) {
    if (message === null || typeof message !== 'object') return
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.#pending.get(message.id)
      if (pending === undefined) return
      this.#pending.delete(message.id)
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      // Synchronous boundary: the collector closes before the next JSONL line
      // in this data chunk is parsed, not merely before the promise resumes.
      try {
        pending.onResponse?.({ result: message.result, error: message.error })
      } catch {
        // A collector callback must not break JSON-RPC dispatch.
      }
      if (message.error !== undefined) {
        // RPC 错误码保留下来：resume 的「方法不存在」与「会话不存在」是两种
        // 完全不同的处置，不能在适配器层被压成同一个错误。
        const rpcCode = typeof message.error?.code === 'number' ? message.error.code : undefined
        const mapped = rpcCode === -32601 ? ERROR_CODES.UNKNOWN_METHOD : ERROR_CODES.PROMPT_FAILED
        pending.reject(
          new AgyAcpError(
            mapped,
            `ACP ${pending.method} 被拒绝：${String(message.error?.message ?? '未知错误')}；不自动重发。`,
            rpcCode === undefined ? undefined : { cause: Object.assign(new Error(`rpc ${rpcCode}`), { rpcCode }) },
          ),
        )
        return
      }
      pending.resolve(message.result)
      return
    }
    if (typeof message.method !== 'string') return
    if (message.id !== undefined) {
      for (const handler of this.#requests) {
        try {
          if (handler({ id: message.id, method: message.method, params: message.params }) === true) return
        } catch {
          // 处理器异常不能破坏协议处理。
        }
      }
      this.respondError(message.id, -32601, `unhandled client request ${message.method}`)
      return
    }
    for (const handler of this.#notifications) {
      try {
        handler({ method: message.method, params: message.params })
      } catch {
        // 同上：通知处理异常不影响通道。
      }
    }
  }

  /**
   * @param {Error} error - 让所有在途请求失败的原因。
   */
  #failPending(error) {
    const pending = [...this.#pending.values()]
    this.#pending.clear()
    for (const entry of pending) {
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      entry.reject(error)
    }
  }
}

/**
 * 极简异步通道：把 ACP 通知里的文本增量转成可 `for await` 的序列。
 */
class ChunkChannel {
  #items = []
  #waiters = []
  #closed = false

  /**
   * @param {unknown} item - 入队项。
   */
  push(item) {
    if (this.#closed) return
    this.#items.push(item)
    this.#wake()
  }

  close() {
    this.#closed = true
    this.#wake()
  }

  #wake() {
    const waiters = this.#waiters
    this.#waiters = []
    for (const resolve of waiters) resolve()
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.#items.length > 0) {
        yield this.#items.shift()
        continue
      }
      if (this.#closed) return
      await new Promise((resolve) => this.#waiters.push(resolve))
    }
  }
}

const NATIVE_ACTIVITY_CAP = 40
const NATIVE_THOUGHT_CAP = 20
const NATIVE_THOUGHT_CHARS = 200
const NATIVE_ACTIVITY_SOURCE = 'acp-native'
const activeNativeAdapters = new Set()

function normalizeThought(update) {
  const content = update?.content && typeof update.content === 'object' && !Array.isArray(update.content) ? update.content : null
  if (!content || content.type !== 'text' || typeof content.text !== 'string') return null
  const trimmed = content.text.trim()
  if (trimmed === '') return null
  return { text: trimmed.slice(0, NATIVE_THOUGHT_CHARS) }
}

export function getNativeActivity(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return { events: [], thoughts: [], truncated: false }
  const adapters = [...activeNativeAdapters]
  for (let i = adapters.length - 1; i >= 0; i -= 1) {
    const adapter = adapters[i]
    if (!adapter.disposed && adapter.nativeActivity?.has(sessionId)) {
      return adapter.getNativeActivity(sessionId)
    }
  }
  return { events: [], thoughts: [], truncated: false }
}

/**
 * 官方 agy ACP 的 DSH 主模型适配器。
 *
 * 只实现 DSH `LlmAdapter` 实际会用到的面：`providerInfo`、`listModels`、
 * `resolveModel`、`prepareCall`、`stream`。鸭子类型即可注册，不需要继承。
 */
export class AgyAcpAdapter {
  /**
   * @param {Record<string, unknown>} [config] - 插件行 config（见 {@link resolveConfig}）。
   */
  constructor(config = {}) {
    this.config = resolveConfig(config)
    this.configError = undefined
    this.catalog = null
    this.catalogPending = null
    this.nativeSessions = {}
    this.nativeActivity = new Map()
    this.nativeActivityListeners = new Set()
    this.diagnostics = new Map()
    this.activeSessions = new Set()
    this.liveSessions = new Map()
    this.bridgeCalls = new Map()
    this.disposed = false
    activeNativeAdapters.add(this)
    if (this.config.nativeStateFile && existsSync(this.config.nativeStateFile)) {
      try {
        const state = JSON.parse(readFileSync(this.config.nativeStateFile, 'utf8'))
        if (state.version !== 1 || !state.sessions || typeof state.sessions !== 'object') throw new Error('invalid version')
        this.nativeSessions = state.sessions
      } catch (error) { throw new AgyAcpError('AGY_ACP_STATE_INVALID', `原生会话账本不可读：${error.message}`) }
    }
    /** @type {() => object} */
    this.transportFactory =
      this.config.transport ??
      (() =>
        new AcpStdioTransport({
          agyExecutable: this.config.agyExecutable,
          agyArgs: this.config.agyArgs,
          cwd: this.config.cwd,
          onStderr: this.config.onStderr,
        }))
    const catalogCacheFile = this.config.catalogCacheFile ?? (this.config.nativeStateFile ? `${this.config.nativeStateFile}.catalog.json` : '')
    this.catalogStore = createCatalogStore({
      transportFactory: () => this.transportFactory(),
      cwd: canonicalWorkspace(this.config.cwd),
      cacheFile: catalogCacheFile,
      timeoutMs: this.config.configTimeoutMs,
      perModelTimeoutMs: this.config.perModelTimeoutMs,
      logger: this.config.logger,
    })
  }

  /**
   * @param {string} provider - 注册路由。
   * @returns {{id: string, name: string, description: string}} provider 信息（id 必须等于路由）。
   */
  providerInfo(provider) {
    return { id: provider, name: PROVIDER_NAME, description: PROVIDER_DESCRIPTION }
  }

  /**
   * 显式关闭 DSH provider 自动重试：本通道一次请求只发一次 `session/prompt`。
   *
   * 返回 resolved 形状（`mode: 'normal'` + `maxRetries: 0` + 空 `retryableCodes`），
   * 因此任何失败（含传输断开、超时、受理不明）都不会被自动重发；
   * `undefined` 会被 DSH 换成默认策略（最多 5 次重试），那对本通道是错的。
   *
   * @param {string} _provider - 注册路由。
   * @returns {{mode: 'normal', maxRetries: number, retryableCodes: readonly string[], initialDelayMs: number, maxDelayMs: number, jitterRatio: number}} 不重试策略。
   */
  providerRetryPolicy(_provider) {
    return NO_RETRY_POLICY
  }

  /**
   * 不声明按图计费的改写规则，保持 DSH 的默认识别。
   *
   * @param {unknown} target - 目标标识。
   * @returns {unknown} 原样返回。
   */
  imageRequestTarget(target) {
    return target
  }

  /**
   * 菜单里可选的模型。
   *
   * @returns {Promise<ReadonlyArray<object>>} 模型信息。
   */
  async getCatalog(options = {}) {
    const snapshot = await this.catalogStore.getCatalog(options)
    this.catalog = snapshot
    return snapshot
  }

  async listModels() {
    return listModelInfos((await this.getCatalog()).entries)
  }

  dispose() {
    this.disposed = true
    activeNativeAdapters.delete(this)
    for (const live of this.liveSessions.values()) live.transport.close?.()
    this.liveSessions.clear()
    this.bridgeCalls.clear()
    this.nativeActivity.clear()
    this.nativeActivityListeners.clear()
    this.diagnostics.clear()
  }

  getDiagnostics(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return []
    const entries = this.diagnostics.get(sessionId)
    return Array.isArray(entries) ? entries.map((item) => ({ ...item })) : []
  }

  /**
   * 重置指定 DSH 会话的原生 ACP 绑定并写入重基线墓碑（只清绑定与内存状态）。
   *
   * @param {string} sessionId - DSH 会话 id。
   * @returns {{sessionId: string, hadBinding: boolean, hadTombstone: boolean, clearedCount: number}} 重置结果。
   */
  resetSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new AgyAcpError(ERROR_CODES.INVALID_REQUEST, '重置原生会话需要非空 sessionId。')
    }
    const existing = this.nativeSessions[sessionId]
    if (this.activeSessions.has(sessionId) || existing?.inFlight) {
      throw new AgyAcpError(
        ERROR_CODES.RESET_BUSY,
        '当前会话仍在处理或上轮受理未确认（inFlight）；本轮禁止重发同一 prompt，请等待当前轮结束再重置。',
      )
    }
    const hadBinding = Boolean(existing && existing.rebaseline !== true)
    const hadTombstone = Boolean(existing && existing.rebaseline === true)
    const oldAcpSessionId = typeof existing?.acpSessionId === 'string'
      ? existing.acpSessionId
      : typeof existing?.previousAcpSessionId === 'string'
        ? existing.previousAcpSessionId
        : ''
    let clearedCount = 0
    const live = this.liveSessions.get(sessionId)
    if (live) {
      this.#logCleanup(safeClose(live.transport), 'resetSession 关闭旧 ACP 连接')
      this.liveSessions.delete(sessionId)
      clearedCount += 1
    }
    if (this.nativeActivity.has(sessionId)) {
      this.nativeActivity.delete(sessionId)
      clearedCount += 1
    }
    if (this.bridgeCalls.size > 0) {
      clearedCount += this.bridgeCalls.size
      this.bridgeCalls.clear()
    }
    const lastCommittedUserId = typeof existing?.lastUserId === 'string'
      ? existing.lastUserId
      : typeof existing?.lastCommittedUserId === 'string'
        ? existing.lastCommittedUserId
        : ''
    const existingCwd = typeof existing?.cwd === 'string' ? existing.cwd : ''
    this.nativeSessions[sessionId] = {
      rebaseline: true,
      resetAt: Date.now(),
      reasonCode: 'manual_reset',
      previousAcpSessionId: oldAcpSessionId,
      cwd: existingCwd,
      lastCommittedUserId,
      consecutiveRebaselines: 0,
    }
    if (hadBinding || hadTombstone) clearedCount += 1
    this.saveNativeState()
    return { sessionId, hadBinding, hadTombstone, clearedCount }
  }

  getNativeActivity(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return { events: [], thoughts: [], rebaselines: [], truncated: false }
    const entry = this.nativeActivity.get(sessionId)
    if (!entry) return { events: [], thoughts: [], rebaselines: [], truncated: false }
    return {
      events: entry.events.map((e) => ({ ...e })),
      thoughts: entry.thoughts.map((t) => ({ ...t })),
      rebaselines: Array.isArray(entry.rebaselines) ? entry.rebaselines.map((r) => ({ ...r })) : [],
      truncated: Boolean(entry.truncated),
    }
  }

  #ensureNativeActivityEntry(sessionId) {
    let entry = this.nativeActivity.get(sessionId)
    if (!entry) {
      entry = { events: [], thoughts: [], rebaselines: [], truncated: false }
      this.nativeActivity.set(sessionId, entry)
    }
    return entry
  }

  #recordNativeToolEvent(sessionId, event) {
    if (!sessionId || !event) return
    const entry = this.#ensureNativeActivityEntry(sessionId)
    const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : ''
    const kind = event.kind && event.kind !== 'unknown' ? normalizeToolKind(event.kind) : 'unknown'
    const title = typeof event.title === 'string' ? event.title : ''
    const status = typeof event.status === 'string' ? event.status : ''
    const now = Date.now()
    const existing = toolCallId !== '' ? entry.events.find((item) => item.toolCallId === toolCallId) : undefined
    if (existing) {
      if (kind !== 'unknown') existing.kind = kind
      if (title !== '') existing.title = title
      if (status !== '') existing.status = status
      existing.updatedAt = now
      existing.source = NATIVE_ACTIVITY_SOURCE
      return
    }
    if (entry.events.length >= NATIVE_ACTIVITY_CAP) {
      entry.events.shift()
      entry.truncated = true
    }
    entry.events.push({
      toolCallId,
      kind,
      title,
      status,
      updatedAt: now,
      source: NATIVE_ACTIVITY_SOURCE,
    })
  }

  #recordNativeThought(sessionId, thought) {
    if (!sessionId || !thought || typeof thought.text !== 'string' || thought.text === '') return
    const entry = this.#ensureNativeActivityEntry(sessionId)
    if (entry.thoughts.length >= NATIVE_THOUGHT_CAP) {
      entry.thoughts.shift()
      entry.truncated = true
    }
    entry.thoughts.push({
      text: thought.text.slice(0, NATIVE_THOUGHT_CHARS),
      updatedAt: Date.now(),
      source: NATIVE_ACTIVITY_SOURCE,
    })
  }

  saveNativeState() {
    if (!this.config.nativeStateFile) return
    try {
      mkdirSync(dirname(this.config.nativeStateFile), { recursive: true })
      const tmp = `${this.config.nativeStateFile}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: 1, sessions: this.nativeSessions }, null, 2), 'utf8')
      renameSync(tmp, this.config.nativeStateFile)
    } catch (error) { throw new AgyAcpError('AGY_ACP_STATE_WRITE_FAILED', `原生账本无法持久化；不自动派发：${error.message}`) }
  }

  /**
   * 解析模型元数据；未声明的模型直接失败（不静默回退）。
   *
   * @param {string} provider - 注册路由。
   * @param {string} model - 模型 id。
   * @returns {Promise<object>} 模型信息。
   */
  async resolveModel(provider, model) {
    const { info, snapshot } = await this.catalogStore.resolveModel(provider, model)
    this.catalog = snapshot
    if (info === undefined) {
      const degradedSuffix = Array.isArray(snapshot.degraded) && snapshot.degraded.length > 0
        ? `；降级条目：${snapshot.degraded.map((d) => `${d.modelId}(${d.reason})`).join(', ')}`
        : ''
      throw new AgyAcpError(
        ERROR_CODES.MODEL_UNSUPPORTED,
        `本适配器未声明模型 ${JSON.stringify(model)}；可选模型：${snapshot.entries.map((entry) => entry.id).join(', ')}${degradedSuffix}。没有派发 prompt。`,
      )
    }
    return Promise.resolve(info)
  }

  /**
   * 绑定一次模型调用：模型元数据 + 只能派发一次的 stream。
   *
   * @param {string} provider - 注册路由。
   * @param {string} model - 模型 id。
   * @returns {Promise<{model: object, stream: (options: object) => AsyncIterable<object>}>} 准备好的调用。
   */
  async prepareCall(provider, model) {
    const info = await this.resolveModel(provider, model)
    let dispatched = false
    return {
      model: info,
      stream: (options) => {
        if (dispatched) {
          throw new AgyAcpError(ERROR_CODES.INVALID_CALL, '一次 prepareCall 只能派发一次 stream。')
        }
        dispatched = true
        return this.stream(options)
      },
    }
  }

  /**
   * 同一 DSH 会话复用 ACP 上下文；每次调用只派发一个新增 prompt，终态来自 stopReason。
   *
   * @param {object} options - DSH `GenerateOptions`。
   * @returns {AsyncGenerator<object>} `StreamChunk` 序列。
   */
  async *stream(options) {
    const plan = planRequest(options, { ...this.config, toolNames: this.bridgeCalls })
    const requestedModel = typeof options?.model === 'string' ? options.model : ''
    const effort = options?.reasoningEffort
    const key = typeof options?.sessionId === 'string' && options.sessionId ? options.sessionId : null
    const cwd = canonicalWorkspace(await this.config.resolveWorkspace?.(options) ?? this.config.cwd)
    const rawPrevious = key ? this.nativeSessions[key] : null
    if (key && this.activeSessions.has(key)) throw new AgyAcpError('AGY_ACP_SESSION_BUSY', '同一 DSH 会话已有原生请求；没有派发 prompt。')
    if (rawPrevious?.inFlight) throw new AgyAcpError('AGY_ACP_ACCEPTANCE_UNKNOWN', '上轮受理状态未确认；禁止自动重发，需新建会话。')
    const fingerprint = (item) => ({ role: item.role, hash: createHash('sha256').update(item.text).digest('hex'), ...(item.id ? { id: item.id } : {}) })
    const currentHistory = plan.history.map(fingerprint)
    const systemHash = createHash('sha256').update(plan.systemText).digest('hex')
    const isTombstone = rawPrevious?.rebaseline === true
    let previous = isTombstone ? null : rawPrevious
    let rebaselineInfo = isTombstone
      ? {
          reason: typeof rawPrevious.reasonCode === 'string' && rawPrevious.reasonCode !== ''
            ? rawPrevious.reasonCode
            : typeof rawPrevious.reason === 'string' && rawPrevious.reason !== ''
              ? rawPrevious.reason
              : 'TOMBSTONE',
          oldSessionId: typeof rawPrevious.previousAcpSessionId === 'string' ? rawPrevious.previousAcpSessionId : '',
          consecutiveRebaselines: Number.isFinite(rawPrevious.consecutiveRebaselines) ? rawPrevious.consecutiveRebaselines : 0,
        }
      : null
    let lastAssistantIdx = -1
    for (let i = currentHistory.length - 1; i >= 0; i -= 1) {
      if (currentHistory[i].role === 'assistant') {
        lastAssistantIdx = i
        break
      }
    }
    const trailingUsers = currentHistory.slice(lastAssistantIdx + 1).filter((item) => item.role === 'user')
    const isToolReplyTurn = this.config.acpToolBridge && plan.toolResults.length > 0 && currentHistory.at(-1)?.role === 'assistant'
    if (isTombstone) {
      if (rawPrevious.cwd && rawPrevious.cwd !== cwd) {
        throw new AgyAcpError('AGY_ACP_WORKSPACE_MISMATCH', '工作区已切换；请新建 DSH 会话，不沿用其他项目的 ACP 上下文。')
      }
      if (rebaselineInfo.consecutiveRebaselines > MAX_CONSECUTIVE_REBASELINES) {
        throw new AgyAcpError(
          ERROR_CODES.REBASELINE_LIMIT_EXCEEDED,
          `连续重基线次数已达上限（${MAX_CONSECUTIVE_REBASELINES}）；请新建 DSH 会话，没有派发 prompt。`,
        )
      }
      const lastTrailingUser = trailingUsers.at(-1)
      if (rawPrevious.lastCommittedUserId && lastTrailingUser?.id === rawPrevious.lastCommittedUserId) {
        throw new AgyAcpError(
          ERROR_CODES.HISTORY_REPLAYED,
          historyErrorDetail('检测到重复历史或已提交输入重放（无新增用户输入）', 0, currentHistory.length, ''),
        )
      }
      if (isToolReplyTurn || trailingUsers.length === 0) {
        throw new AgyAcpError(
          ERROR_CODES.HISTORY_TOOL_ORDER,
          historyErrorDetail('墓碑重基线轮次末尾缺少新增用户输入，禁止将工具结果塞入新会话', 0, currentHistory.length, ''),
        )
      }
    }
    if (previous) {
      if (previous.cwd !== cwd) throw new AgyAcpError('AGY_ACP_WORKSPACE_MISMATCH', '工作区已切换；请新建 DSH 会话，不沿用其他项目的 ACP 上下文。')
      if (previous.systemHash !== systemHash) throw new AgyAcpError('AGY_ACP_SYSTEM_CHANGED', 'system 已变化；需新建会话，没有派发 prompt。')
      if (key && currentHistory.some((item) => !item.id)) throw new AgyAcpError(ERROR_CODES.MESSAGE_ID_REQUIRED, '持久多轮要求每条历史消息有稳定 id；无 id 请使用隔离单轮。')
      const committed = previous.history
      const committedLen = Array.isArray(committed) ? committed.length : 0
      const deltaCount = currentHistory.length - committedLen
      const committedIds = new Set(
        Array.isArray(committed) ? committed.map((item) => item?.id).filter((id) => typeof id === 'string' && id !== '') : [],
      )
      const lastTrailingUser = trailingUsers.at(-1)
      if (
        (committedLen > 0 && currentHistory.length <= committedLen) ||
        (lastTrailingUser?.id && committedIds.has(lastTrailingUser.id))
      ) {
        throw new AgyAcpError(
          ERROR_CODES.HISTORY_REPLAYED,
          historyErrorDetail('检测到重复历史或已提交输入重放（无新增用户输入）', committedLen, deltaCount, previous.assistantHash),
        )
      }
      const needsRebaseline = previous.dirty === true || !Array.isArray(committed) || committedLen === 0
      let mismatchReason = null
      let mismatchMessage = ''
      if (needsRebaseline) {
        if (typeof previous.assistantHash === 'string' && !currentHistory.some((item) => item.role === 'assistant' && item.hash === previous.assistantHash)) {
          mismatchReason = ERROR_CODES.HISTORY_HASH_MISMATCH
          mismatchMessage = historyErrorDetail('上轮 assistant 与 ACP 已确认回复不一致', committedLen, deltaCount, previous.assistantHash)
        } else {
          mismatchReason = previous.dirty ? 'DIRTY_REBASELINE' : 'EMPTY_COMMITTED_REBASELINE'
        }
      } else {
        const prefixMatch = committed.every((cItem, idx) => {
          const curItem = currentHistory[idx]
          if (!curItem || curItem.role !== cItem.role) return false
          if (cItem.id) return curItem.id === cItem.id
          return curItem.hash === cItem.hash
        })
        if (!prefixMatch) {
          mismatchReason = ERROR_CODES.HISTORY_SHAPE
          mismatchMessage = historyErrorDetail('历史前缀与已提交记录不一致（role/id 不匹配）', committedLen, deltaCount, previous.assistantHash)
        } else {
          const suffix = currentHistory.slice(committedLen)
          const suffixAssistants = suffix.filter((item) => item.role === 'assistant')
          const hasSuffixTool = !isToolReplyTurn && hasToolInSuffix(options?.messages, committedLen)
          if (suffix[0]?.role !== 'assistant') {
            mismatchReason = ERROR_CODES.HISTORY_SHAPE
            mismatchMessage = historyErrorDetail('增量历史必须以 assistant 回复开头', committedLen, suffix.length, previous.assistantHash)
          } else if (suffixAssistants.length !== 1) {
            mismatchReason = ERROR_CODES.HISTORY_MULTI_ASSISTANT
            mismatchMessage = historyErrorDetail(`增量历史包含 ${suffixAssistants.length} 条 assistant（仅允许 1 条）`, committedLen, suffix.length, previous.assistantHash)
          } else {
            const assistant = suffixAssistants[0]
            const afterAssistant = suffix.slice(suffix.indexOf(assistant) + 1)
            if (hasSuffixTool) {
              mismatchReason = ERROR_CODES.HISTORY_TOOL_ORDER
              mismatchMessage = historyErrorDetail('非工具回复轮的增量历史中出现 tool 消息', committedLen, suffix.length, previous.assistantHash)
            } else if (afterAssistant.some((item) => item.role !== 'user') || (!isToolReplyTurn && afterAssistant.length === 0)) {
              mismatchReason = ERROR_CODES.HISTORY_SHAPE
              mismatchMessage = historyErrorDetail('增量历史末尾包含非 user 消息或缺少新增 user', committedLen, suffix.length, previous.assistantHash)
            } else {
              const idMatched = typeof previous.assistantId === 'string' && previous.assistantId !== '' && assistant.id === previous.assistantId
              if (!idMatched && assistant.hash !== previous.assistantHash) {
                mismatchReason = ERROR_CODES.HISTORY_HASH_MISMATCH
                mismatchMessage = historyErrorDetail('上轮 assistant 与 ACP 已确认回复不一致', committedLen, suffix.length, previous.assistantHash)
              }
            }
          }
        }
      }
      if (mismatchReason !== null) {
        if (isToolReplyTurn || trailingUsers.length === 0) {
          throw new AgyAcpError(
            mismatchReason === 'DIRTY_REBASELINE' || mismatchReason === 'EMPTY_COMMITTED_REBASELINE' ? ERROR_CODES.HISTORY_TOOL_ORDER : mismatchReason,
            mismatchMessage || historyErrorDetail('工具回复轮无法在历史失配时自动重基线（末尾无 user 输入）', committedLen, deltaCount, previous.assistantHash),
          )
        }
        const nextConsecutive = (Number.isFinite(previous.consecutiveRebaselines) ? previous.consecutiveRebaselines : 0) + 1
        if (nextConsecutive > MAX_CONSECUTIVE_REBASELINES) {
          throw new AgyAcpError(
            ERROR_CODES.REBASELINE_LIMIT_EXCEEDED,
            `连续重基线次数已达上限（${MAX_CONSECUTIVE_REBASELINES}，原因=${mismatchReason}）；请新建 DSH 会话，没有派发 prompt。`,
          )
        }
        // 原子重基线（取 transport 之前完成，顺序固定）：
        // 1) close 并 delete liveSessions.get(key)
        const oldLive = key ? this.liveSessions.get(key) : null
        if (oldLive) {
          this.#logCleanup(safeClose(oldLive.transport), '重基线前关闭旧 ACP 连接')
          this.liveSessions.delete(key)
        }
        // 2) 绑定 previous=null（写墓碑替代裸 delete）
        const oldAcpSessionId = typeof previous.acpSessionId === 'string' ? previous.acpSessionId : ''
        const lastCommittedUserId = typeof previous.lastUserId === 'string'
          ? previous.lastUserId
          : [...(Array.isArray(committed) ? committed : [])].reverse().find((item) => item?.role === 'user' && item?.id)?.id ?? ''
        rebaselineInfo = { reason: mismatchReason, oldSessionId: oldAcpSessionId, consecutiveRebaselines: nextConsecutive }
        if (key) {
          this.nativeSessions[key] = {
            rebaseline: true,
            resetAt: Date.now(),
            reasonCode: mismatchReason,
            previousAcpSessionId: oldAcpSessionId,
            cwd: previous.cwd ?? cwd,
            lastCommittedUserId,
            consecutiveRebaselines: nextConsecutive,
          }
          this.saveNativeState()
        }
        previous = null
        // 3) 重读 baselineEffort（previous=null 后在下方 session/new 自然重读）
        // 4) 清 bridgeCalls / nativeActivity
        this.bridgeCalls.clear()
        if (key) this.nativeActivity.delete(key)
      }
    } else if (!isTombstone && currentHistory.some((item) => item.role === 'assistant')) {
      throw new AgyAcpError('AGY_ACP_BINDING_UNKNOWN', '多轮历史没有原生 ACP 绑定；不重放历史，请新建会话。')
    }
    if (this.disposed) throw new AgyAcpError('AGY_ACP_DISPOSED', '原生适配器已卸载。')
    if (key && currentHistory.some((item) => !item.id)) throw new AgyAcpError('AGY_ACP_MESSAGE_ID_REQUIRED', '持久多轮要求每条历史消息有稳定 id；无 id 请使用隔离单轮。')
    if (key) this.activeSessions.add(key)
    // A cached entry is only reusable while its connection is demonstrably
    // alive. A transport that has closed (or lost its child process, or reports
    // itself closed through isClosed) can never answer again, so the entry is
    // evicted here instead of blocking this key forever with AGY_ACP_EXITED.
    const cached = key ? this.liveSessions.get(key) : null
    const live = cached && !isDeadTransport(cached.transport) ? cached : null
    if (cached && !live) this.liveSessions.delete(key)
    let transport
    try { transport = live?.transport ?? this.transportFactory() }
    catch (error) { if (key) this.activeSessions.delete(key); throw error }
    let record = previous
    let promptIssued = false
    const channel = new ChunkChannel()
    let permissionRequested = false
    let settled
    let text = ''
    let boundSessionId = ''
    let promptStarted = false
    let collecting = false
    let handlerActive = true
    let latestConfigOptions = null
    // Set only when this turn ended because its signal aborted: the caller is
    // then told exactly what happened instead of a generic transport close.
    let abortedBeforePrompt = false
    let abortedDuringPrompt = false
    let turnSettled = false
    let cancelSent = false
    let onAbort
    // 本轮 ACP 原生工具事件（结构化）与正文白名单诊断计数。只进诊断通道，
    // 不会被 yield 成任何 chunk（见 docs/DETAIL.md「工具事件语义」）。
    const toolEvents = []
    const toolDiagnostics = { toolEvents: 0, thoughtChunks: 0, nonTextMessageChunks: 0, otherUpdates: 0 }
    // 仅供展示，绝不回流上下文（否则会重现官方 bundle 的「思考死循环」）。
    const inlineThoughtEnabled = this.config.inlineThought !== false && options?.inlineThought !== false
    let inlineReasoningOpen = false
    const activityEnabled = this.config.nativeActivityEnabled !== false && options?.nativeActivityEnabled !== false
    let activityCallbacks = null
    if (key && activityEnabled) {
      activityCallbacks = {
        sessionId: key,
        onToolEvent: (event) => this.#recordNativeToolEvent(key, event),
        onThought: (thought) => this.#recordNativeThought(key, thought),
      }
      this.nativeActivityListeners.add(activityCallbacks)
      options?.onRegisterActivityCallbacks?.(activityCallbacks)
    }

    const closeCollector = () => {
      collecting = false
      channel.close()
    }
    // Paired with the registrations below: a transport shared across turns must
    // not accumulate dead per-turn handlers (previously they were pushed and
    // never removed, so handler count grew with every turn on one connection).
    let offNotification
    let offRequest
    const detachHandlers = () => {
      handlerActive = false
      if (activityCallbacks) {
        this.nativeActivityListeners.delete(activityCallbacks)
        activityCallbacks = null
      }
      try { offNotification?.() } catch { /* 注销本身不应抛错 */ }
      try { offRequest?.() } catch { /* 同上 */ }
      offNotification = undefined
      offRequest = undefined
    }

    offNotification = transport.onNotification?.(({ method, params }) => {
      if (!handlerActive || method !== 'session/update') return
      if (params?.sessionId === boundSessionId && params?.update?.sessionUpdate === 'config_option_update') {
        latestConfigOptions = params.update.configOptions
        const cached = key ? this.liveSessions.get(key) : null
        if (cached) cached.configOptions = latestConfigOptions
      }
      // Only this session's assistant text after this request's prompt started
      // and before its response line. Foreign sessions, pre-prompt preludes and
      // post-response replays are not part of this turn.
      if (boundSessionId === '' || params?.sessionId !== boundSessionId) return
      if (!promptStarted || !collecting || settled) return
      const update = params?.update
      const kind = update?.sessionUpdate
      if (kind === 'agent_message_chunk') {
        const content = update?.content
        // 正文白名单：只有纯文本 content 进入正文，其它类型只计诊断。
        if (content?.type === 'text' && typeof content.text === 'string' && content.text !== '') {
          inlineReasoningOpen = false
          channel.push({ kind: 'text', text: content.text })
        } else {
          toolDiagnostics.nonTextMessageChunks += 1
        }
        return
      }
      if (kind === 'tool_call' || kind === 'tool_call_update') {
        // 只做结构化投影，供诊断/日志使用。绝不 yield tool-call chunk：
        // agy 已经自己执行过这个工具，再交给 DSH 会二次执行。
        const kindOf = (id) => {
          const prev = toolEvents.findLast?.((item) => item.toolCallId === id) ?? [...toolEvents].reverse().find((item) => item.toolCallId === id)
          return prev && prev.kind !== 'unknown' ? prev.kind : ''
        }
        const event = normalizeToolEvent(kind, update, kindOf)
        if (event) {
          toolEvents.push(event)
          activityCallbacks?.onToolEvent(event)
        }
        return
      }
      if (kind === 'agent_thought_chunk') {
        toolDiagnostics.thoughtChunks += 1
        if (activityCallbacks) {
          const thought = normalizeThought(update)
          if (thought) activityCallbacks.onThought(thought)
        }
        if (inlineThoughtEnabled) {
          const content = update?.content
          if (content?.type === 'text' && typeof content.text === 'string' && content.text !== '' && (inlineReasoningOpen || content.text.trim() !== '')) {
            inlineReasoningOpen = true
            channel.push({ kind: 'reasoning', text: content.text })
          }
        }
        return
      }
      // plan / user_message 回放 / mode 更新等都不是最终正文：忽略。
      if (typeof kind === 'string' && kind !== '') toolDiagnostics.otherUpdates += 1
    })
    offRequest = transport.onRequest?.(({ id, method, params }) => {
      if (!handlerActive || method !== 'session/request_permission' || params?.sessionId !== boundSessionId) return false
      if (this.config.acpPermissionPolicy === 'allow_once') {
        const options = Array.isArray(params?.options) ? params.options : []
        const allow = options.find((item) => item?.kind === 'allow_once' && typeof item.optionId === 'string' && item.optionId.length > 0)
        if (allow) {
          transport.respond?.(id, { outcome: { outcome: 'selected', optionId: allow.optionId } })
          return true
        }
      }
      permissionRequested = true
      // 不自动批准：以 cancelled 结束该权限请求，并把这一轮判定为需要用户处理。
      transport.respond?.(id, { outcome: { outcome: 'cancelled' } })
      void params
      return true
    })

    try {
      if (!live) transport.start()
      const initialized = live?.initialized ?? await transport.request(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'dsh-agy-bridge-model', version: '0.3.0' },
        },
        { timeoutMs: this.config.initializeTimeoutMs },
      )
      const systemTransport = previous?.systemTransport ?? (initialized?.agentCapabilities?.sessionCapabilities?.systemPrompt ? 'append' : 'user-prefix')
      if (systemTransport === 'append' && plan.systemText && !initialized?.agentCapabilities?.sessionCapabilities?.systemPrompt) throw new AgyAcpError('AGY_ACP_SYSTEM_UNSUPPORTED', '恢复后的 CLI 不再声明 systemPrompt；没有派发 prompt。')
      const systemParams = systemTransport === 'append' && plan.systemText ? { systemPrompt: { mode: 'append', content: [{ type: 'text', text: plan.systemText }] } } : {}
      let created
      if (live) {
        // Reuse is gated on the very connection that will carry the prompt.
        if (isDeadTransport(live.transport)) {
          this.liveSessions.delete(key)
          throw new AgyAcpError(ERROR_CODES.TRANSPORT_CLOSED, 'ACP 连接在复用前已失效；本轮没有派发 prompt，绑定保留，可直接重试。')
        }
        created = { sessionId: previous.acpSessionId, configOptions: live.configOptions }
      }
      else if (previous) {
        const capabilities = initialized?.agentCapabilities ?? {}
        const method = capabilities.sessionCapabilities?.resume ? 'session/resume' : capabilities.loadSession ? 'session/load' : null
        if (!method) throw new AgyAcpError('AGY_ACP_SESSION_RESTORE_UNSUPPORTED', 'CLI 未声明 resume/load；不新建或重放旧历史。')
        try {
          created = await transport.request(method, { sessionId: previous.acpSessionId, cwd, mcpServers: [], ...systemParams }, { timeoutMs: this.config.sessionTimeoutMs })
        } catch (error) { throw restoreFailure(method, previous.acpSessionId, error) }
        created = { ...created, sessionId: previous.acpSessionId }
      } else created = await transport.request('session/new', { cwd, mcpServers: [], ...systemParams }, { timeoutMs: this.config.sessionTimeoutMs })
      const sessionId = created?.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw new AgyAcpError(ERROR_CODES.SESSION_FAILED, 'ACP session/new 没有返回 sessionId；没有派发 prompt。')
      }
      boundSessionId = sessionId
      let rebaselineRecord = null
      if (rebaselineInfo) {
        rebaselineRecord = {
          type: 'rebaseline',
          reason: rebaselineInfo.reason,
          oldAcpSessionId: rebaselineInfo.oldSessionId,
          newAcpSessionId: sessionId,
          promptChars: plan.userText.length,
          at: new Date().toISOString(),
        }
        if (key) {
          const entry = this.#ensureNativeActivityEntry(key)
          entry.rebaselines.push(rebaselineRecord)
          this.diagnostics.set(key, [...(this.diagnostics.get(key) ?? []), rebaselineRecord])
        }
        toolDiagnostics.rebaseline = { ...rebaselineRecord }
      }
      let configOptions = Array.isArray(created?.configOptions) ? created.configOptions : []
      const acpModelValue = requestedModel
      if (!acpModelValue) throw new AgyAcpError(ERROR_CODES.MODEL_UNSUPPORTED, 'GenerateOptions.model 必须显式指定 ACP model id；仅 effort 支持省略。没有派发 prompt。')
      if (previous && previous.model !== acpModelValue) throw new AgyAcpError('AGY_ACP_MODEL_CHANGED', '同一原生会话不能切换模型；请新建会话。')
      configOptions = await this.#applyOption(transport, sessionId, configOptions, 'model', 'model', acpModelValue, ERROR_CODES.MODEL_UNSUPPORTED)
      latestConfigOptions = null // Complete setter response supersedes earlier notifications.
      const available = optionValues(findConfigOption(configOptions, 'thought_level', 'thought'))
      if (effort !== undefined && !available.includes(String(effort))) throw new AgyAcpError(ERROR_CODES.EFFORT_UNSUPPORTED,
        `provider=${options.provider ?? 'antigravity-agy-acp'} model=${acpModelValue} requested effort=${String(effort)} available efforts=[${available.join(', ')}]；没有派发 prompt。`)
      const baselineEffort = previous ? previous.baselineEffort : findConfigOption(configOptions, 'thought_level', 'thought')?.currentValue
      const thoughtValue = effort === undefined ? baselineEffort : String(effort)
      if (effort === undefined && thoughtValue !== undefined && !available.includes(thoughtValue)) throw new AgyAcpError('AGY_ACP_DEFAULT_UNAVAILABLE', `CLI 基线 ${thoughtValue} 已不可用；没有派发 prompt。`)
      if (thoughtValue !== undefined) {
        configOptions = await this.#applyOption(transport, sessionId, configOptions, 'thought_level', 'thought', thoughtValue, ERROR_CODES.EFFORT_UNSUPPORTED)
        latestConfigOptions = null
      }
      // 最终一次完整回执必须同时确认「模型」与「显式档位」：
      // 后一次设置可能把先前的模型改回去，所以逐次回读不足以证明最终状态。
      this.#assertFinalConfig(configOptions, {
        modelValue: acpModelValue,
        thoughtValue,
      })
      if (options?.signal?.aborted === true) {
        abortedBeforePrompt = true
        throw new AgyAcpError('ABORTED', '调用在派发前被取消；没有派发 prompt。')
      }

      // Declared outside the try so the finally block can always detach it,
      // even on paths that fail before this turn ever registers it.
      onAbort = () => {
        if (cancelSent) return
        cancelSent = true
        try {
          transport.notify?.('session/cancel', { sessionId })
        } catch {
          // 取消通知失败不改变终态判定。
        }
      }
      // 先挂监听再发 prompt：取消可能发生在派发之后的任意时刻。
      options?.signal?.addEventListener?.('abort', onAbort, { once: true })
      const turnKey = createHash('sha256').update(JSON.stringify([key, acpModelValue, currentHistory])).digest('hex')
      record = { ...(previous ?? {}), acpSessionId: sessionId, cwd, model: acpModelValue, systemHash, systemTransport, baselineEffort,
        history: previous?.history ?? [], inFlight: { turnKey, user: currentHistory.at(-1), status: 'pending', startedAt: new Date().toISOString() },
        ...(rebaselineRecord ? { lastRebaseline: rebaselineRecord } : {}) }
      if (key) this.liveSessions.set(key, { transport, initialized, configOptions })
      if (key) {
        this.nativeSessions[key] = record
        try { this.saveNativeState() }
        catch (error) { if (previous) this.nativeSessions[key] = previous; else delete this.nativeSessions[key]; this.liveSessions.delete(key); this.#logCleanup(safeClose(transport), '保存账本失败后关闭连接'); throw error }
      }
      promptStarted = true
      collecting = true
      promptIssued = true
      const promptPromise = transport.request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: previous || systemTransport === 'append' ? plan.userText : plan.promptText }] },
        {
          timeoutMs: this.config.promptTimeoutMs,
          // AcpStdioTransport calls this synchronously when it parses the
          // matching response. Closing here prevents a later line in the same
          // stdout chunk from being appended to this turn's text.
          onResponse: () => closeCollector(),
        },
      )
      promptPromise.then(
        (result) => {
          settled = { ok: true, result }
          closeCollector()
        },
        (error) => {
          settled = { ok: false, error }
          closeCollector()
        },
      )
      if (options?.signal?.aborted === true) onAbort()

      const bridgeActive = this.config.acpToolBridge && plan.bridgedTools.length > 0
      let nextBlockIndex = 0
      if (!bridgeActive) {
        let activeBlock = null
        for await (const item of channel) {
          if (item.kind === 'reasoning') {
            if (activeBlock?.type === 'text') {
              yield { type: 'block-end', index: activeBlock.index, block: { type: 'text', text: activeBlock.text } }
              activeBlock = null
            }
            if (!activeBlock) {
              activeBlock = { type: 'reasoning', index: nextBlockIndex++, text: '' }
              yield { type: 'block-start', index: activeBlock.index, blockType: 'reasoning' }
            }
            activeBlock.text += item.text
            yield { type: 'reasoning-delta', index: activeBlock.index, text: item.text }
          } else {
            if (activeBlock?.type === 'reasoning') {
              yield { type: 'block-end', index: activeBlock.index, block: { type: 'reasoning', text: activeBlock.text } }
              activeBlock = null
            }
            if (!activeBlock) {
              activeBlock = { type: 'text', index: nextBlockIndex++, text: '' }
              yield { type: 'block-start', index: activeBlock.index, blockType: 'text' }
            }
            activeBlock.text += item.text
            text += item.text
            yield { type: 'text-delta', index: activeBlock.index, text: item.text }
          }
        }
        options?.signal?.removeEventListener?.('abort', onAbort)
        if (options?.signal?.aborted === true) onAbort()

        if (activeBlock) {
          yield { type: 'block-end', index: activeBlock.index, block: { type: activeBlock.type, text: activeBlock.text } }
        } else if (nextBlockIndex === 0) {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: '' } }
        }
      } else {
        let activeReasoning = null
        for await (const item of channel) {
          if (item.kind === 'reasoning') {
            if (!activeReasoning) {
              activeReasoning = { index: nextBlockIndex++, text: '' }
              yield { type: 'block-start', index: activeReasoning.index, blockType: 'reasoning' }
            }
            activeReasoning.text += item.text
            yield { type: 'reasoning-delta', index: activeReasoning.index, text: item.text }
          } else {
            if (activeReasoning) {
              yield { type: 'block-end', index: activeReasoning.index, block: { type: 'reasoning', text: activeReasoning.text } }
              activeReasoning = null
            }
            text += item.text
          }
        }
        if (activeReasoning) {
          yield { type: 'block-end', index: activeReasoning.index, block: { type: 'reasoning', text: activeReasoning.text } }
        }
        options?.signal?.removeEventListener?.('abort', onAbort)
        if (options?.signal?.aborted === true) onAbort()
      }

      const outcome = settled ?? {
        ok: false,
        error: new AgyAcpError(ERROR_CODES.PROMPT_FAILED, 'session/prompt 结束却没有回执；不标记完成。'),
      }
      if (!outcome.ok) {
        if (bridgeActive && text !== '') {
          const errIndex = nextBlockIndex++
          yield { type: 'block-start', index: errIndex, blockType: 'text' }
          yield { type: 'text-delta', index: errIndex, text }
          yield { type: 'block-end', index: errIndex, block: { type: 'text', text } }
        }
        const code = typeof outcome.error?.code === 'string' && outcome.error.code !== '' ? outcome.error.code : ERROR_CODES.PROMPT_FAILED
        const message = typeof outcome.error?.message === 'string' && outcome.error.message !== '' ? outcome.error.message : String(outcome.error)
        const aborted = code === 'ABORTED' || options?.signal?.aborted === true
        if (aborted) abortedDuringPrompt = true
        turnSettled = true
        yield { type: 'finish', reason: aborted ? { kind: 'aborted', failure: { code: 'ABORTED', message } } : { kind: 'error', failure: { code, message } } }
        return
      }
      if (permissionRequested) {
        if (bridgeActive && text !== '') {
          const permIndex = nextBlockIndex++
          yield { type: 'block-start', index: permIndex, blockType: 'text' }
          yield { type: 'text-delta', index: permIndex, text }
          yield { type: 'block-end', index: permIndex, block: { type: 'text', text } }
        }
        turnSettled = true
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              code: ERROR_CODES.PERMISSION_REQUIRED,
              message: 'ACP 会话请求了权限确认；本适配器不自动批准，本轮视为未完成，请用户在 Antigravity 侧处理后重试。',
            },
          },
        }
        return
      }
      const mapped = mapStopReason(outcome.result?.stopReason, text === '' ? '（本轮没有正文）' : '')
      // 工具事件只进诊断通道：agy 已经执行过这些工具，DSH 不需要也不能再执行一次。
      toolDiagnostics.toolEvents = toolEvents.length
      if (toolEvents.length > 0 || toolDiagnostics.thoughtChunks > 0 || toolDiagnostics.otherUpdates > 0 || toolDiagnostics.rebaseline) {
        try {
          this.config.onToolEvents?.({
            sessionId: record.acpSessionId,
            events: toolEvents.map((event) => ({ ...event })),
            diagnostics: { ...toolDiagnostics },
          })
        } catch {
          // 诊断回调不能影响 turn 结果。
        }
      }
      let finalText = text
      let finalReason = mapped.reason
      let isCorrectionTurn = false
      if (bridgeActive) {
        const parsed = parseToolCalls(text, plan.bridgedTools.map((tool) => tool.name))
        if (parsed.calls.length === 1) {
          const call = parsed.calls[0]
          let blockIndex = nextBlockIndex
          if (parsed.prose !== '') {
            yield { type: 'block-start', index: blockIndex, blockType: 'text' }
            yield { type: 'text-delta', index: blockIndex, text: parsed.prose }
            yield { type: 'block-end', index: blockIndex, block: { type: 'text', text: parsed.prose } }
            blockIndex += 1
          }
          yield { type: 'block-start', index: blockIndex, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: blockIndex, id: call.id, name: call.name, argumentsDelta: call.arguments }
          yield { type: 'block-end', index: blockIndex, block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments } }
          this.bridgeCalls.set(call.id, { name: call.name, arguments: call.arguments })
          finalText = parsed.prose
          finalReason = { kind: 'tool-calls' }
        } else {
          if (parsed.problem !== null) {
            isCorrectionTurn = true
            finalText = text === '' ? TOOL_BRIDGE_CORRECTION : `${text}\n\n${TOOL_BRIDGE_CORRECTION}`
          }
          const textIndex = nextBlockIndex
          yield { type: 'block-start', index: textIndex, blockType: 'text' }
          yield { type: 'text-delta', index: textIndex, text: finalText }
          yield { type: 'block-end', index: textIndex, block: { type: 'text', text: finalText } }
        }
      }
      if (typeof outcome.result?.stopReason === 'string') {
        const pending = record.inFlight
        const isCancelled = /cancel/i.test(outcome.result.stopReason)
        if (isCancelled) {
          record.history = previous?.history ?? []
          record.assistantHash = previous?.assistantHash
          record.dirty = true
        } else if (isCorrectionTurn) {
          // 纠偏轮不计入已确认回复，也不置全局 dirty（避免强杀 agy 子进程）。
          record.history = previous?.history ?? []
          record.assistantHash = previous?.assistantHash
          record.dirty = false
          record.lastCorrectionAt = new Date().toISOString()
        } else {
          const lastUser = currentHistory.at(-1)?.role === 'user' ? currentHistory.at(-1) : null
          record.history = currentHistory
          record.turnSeq = (previous?.turnSeq ?? 0) + 1
          record.consecutiveRebaselines = rebaselineInfo ? rebaselineInfo.consecutiveRebaselines : 0
          if (lastUser?.id) {
            record.lastUserId = lastUser.id
          } else if (key) {
            const diag = { type: 'missing_user_id', turnSeq: record.turnSeq, at: new Date().toISOString() }
            this.diagnostics.set(key, [...(this.diagnostics.get(key) ?? []), diag])
          }
          if (typeof options?.assistantMessageId === 'string' && options.assistantMessageId !== '') {
            record.assistantId = options.assistantMessageId
          } else {
            delete record.assistantId
          }
          record.assistantHash = createHash('sha256').update(finalText).digest('hex')
          record.dirty = false
        }
        record.lastResult = { turnKey: pending.turnKey, text: finalText, stopReason: outcome.result.stopReason }
        record.inFlight = null
        if (key) {
          try { this.saveNativeState() }
          catch (error) { record.inFlight = { ...pending, status: 'acceptance_unknown' }; throw error }
        }
      }
      turnSettled = true
      yield { type: 'finish', reason: finalReason }
    } finally {
      // Every step is isolated: a throwing cleanup step must not skip the
      // later ones. Previously an unguarded saveNativeState() here skipped
      // activeSessions.delete(key), so the same DSH session answered
      // AGY_ACP_SESSION_BUSY forever (the ledger was already acceptance_unknown,
      // so even a fresh attempt could not pass).
      detachHandlers()
      collecting = false
      try { options?.signal?.removeEventListener?.('abort', onAbort) } catch { /* 已 aborted 的信令对象不应阻止解锁 */ }
      try { channel.close() } catch { /* 收集器已结束 */ }
      if (record?.inFlight && promptIssued) {
        if ((abortedDuringPrompt || !turnSettled) && record.inFlight.status !== 'acceptance_unknown') {
          record.history = previous?.history ?? []
          record.assistantHash = previous?.assistantHash
          record.dirty = true
          record.inFlight = null
          if (key) this.#logCleanup(safeSave(this, key), '中断后标记会话为 dirty')
        } else {
          record.inFlight.status = 'acceptance_unknown'
          if (abortedBeforePrompt === true) record.inFlight.aborted = true
          if (key) this.#logCleanup(safeSave(this, key), '受理状态标记为 acceptance_unknown')
        }
      }
      if (key) this.activeSessions.delete(key)
      if (!key || !this.liveSessions.has(key) || record?.inFlight || record?.dirty) {
        this.#logCleanup(safeClose(transport), '关闭 ACP 连接')
        if (key) this.liveSessions.delete(key)
      }
    }
  }

  /**
   * 清理步骤的失败只记录，不再事后抛出：finally 里的异常会把已经结束的
   * turn 变成 rejection，并跳过后续解锁步骤。
   *
   * @param {unknown} error - 清理失败原因（undefined 表示无失败）。
   * @param {string} step - 失败步骤说明。
   * @returns {void}
   */
  #logCleanup(error, step) {
    if (error === undefined || error === null) return
    try {
      this.config.onCleanupError?.({ step, error })
    } catch {
      // 日志回调本身不能破坏清理。
    }
    if (this.config.onCleanupError === undefined) {
      // 没有注入日志时不吞掉事实，但也不阻塞后续清理。
      process.emitWarning?.(`antigravity-bridge model adapter 清理失败（${step}）：${error?.message ?? error}`)
    }
  }

  /**
   * 设置一个 ACP 会话选项并回读校验；不匹配则零 prompt 失败。
   *
   * @param {object} transport - ACP 传输。
   * @param {string} sessionId - 会话 id。
   * @param {any[]} configOptions - 当前完整选项。
   * @param {string} category - 期望 category。
   * @param {string} fallbackId - 期望选项 id。
   * @param {string} value - 目标值。
   * @param {string} missingCode - 选项缺失时的失败码。
   * @returns {Promise<any[]>} 服务端返回的完整选项。
   */
  async #applyOption(transport, sessionId, configOptions, category, fallbackId, value, missingCode) {
    const option = findConfigOption(configOptions, category, fallbackId)
    if (option === undefined) {
      throw new AgyAcpError(
        missingCode,
        `ACP 会话没有提供 ${category} 选项（现有：${summarizeOptions(configOptions)}）；没有派发 prompt。`,
      )
    }
    const offered = optionValues(option)
    if (offered.length > 0 && !offered.includes(value)) {
      throw new AgyAcpError(
        missingCode,
        `ACP 声明的 ${category} 取值不含 ${JSON.stringify(value)}（可选：${offered.join(', ')}）；没有派发 prompt。`,
      )
    }
    const result = await transport.request(
      'session/set_config_option',
      { sessionId, configId: option.id, value },
      { timeoutMs: this.config.configTimeoutMs },
    )
    const returned = Array.isArray(result?.configOptions) ? result.configOptions : []
    if (returned.length === 0) {
      throw new AgyAcpError(
        ERROR_CODES.CONFIG_INCOMPLETE,
        `ACP 的 session/set_config_option 没有回传完整 configOptions，无法确认 ${option.id}=${value}；没有派发 prompt。`,
      )
    }
    const current = findConfigOption(returned, category, fallbackId)
    const readback = current?.currentValue
    if (readback !== value) {
      throw new AgyAcpError(
        ERROR_CODES.CONFIG_NOT_APPLIED,
        `ACP 没有确认 ${option.id}=${value}（回读为 ${JSON.stringify(readback ?? null)}）；没有派发 prompt。`,
      )
    }
    return returned
  }

  /**
   * 用最终一次完整 `configOptions` 回执同时校验模型与（显式给出的）思考档位。
   *
   * 逐次 `#applyOption` 只证明“那一刻”生效；最后一次回执才是派发前的真实状态，
   * 因此模型漂移、缺项、回读冲突都在这里再判一次，且仍在 `session/prompt` 之前。
   *
   * @param {any[]} configOptions - 最终回执里的完整选项。
   * @param {{modelValue: string, thoughtValue?: string}} expected - 期望值。
   * @returns {void}
   */
  #assertFinalConfig(configOptions, expected) {
    if (!Array.isArray(configOptions) || configOptions.length === 0) {
      throw new AgyAcpError(
        ERROR_CODES.CONFIG_INCOMPLETE,
        'ACP 最终回执没有完整 configOptions，无法确认本轮模型与档位；没有派发 prompt。',
      )
    }
    const modelOption = findConfigOption(configOptions, 'model', 'model')
    if (modelOption === undefined) {
      throw new AgyAcpError(
        ERROR_CODES.CONFIG_INCOMPLETE,
        `ACP 最终回执缺少模型选项（现有：${summarizeOptions(configOptions)}）；没有派发 prompt。`,
      )
    }
    if (modelOption.currentValue !== expected.modelValue) {
      throw new AgyAcpError(
        ERROR_CODES.CONFIG_NOT_APPLIED,
        `ACP 最终回执里的模型是 ${JSON.stringify(modelOption.currentValue ?? null)}，不是请求的 ${JSON.stringify(expected.modelValue)}（回读冲突）；没有派发 prompt。`,
      )
    }
    if (expected.thoughtValue === undefined) return
    const thoughtOption = findConfigOption(configOptions, 'thought_level', 'thought')
    if (thoughtOption === undefined) {
      throw new AgyAcpError(
        ERROR_CODES.CONFIG_INCOMPLETE,
        `ACP 最终回执缺少思考档位选项（现有：${summarizeOptions(configOptions)}）；没有派发 prompt。`,
      )
    }
    if (thoughtOption.currentValue !== expected.thoughtValue) {
      throw new AgyAcpError(
        ERROR_CODES.CONFIG_NOT_APPLIED,
        `ACP 最终回执里的思考档位是 ${JSON.stringify(thoughtOption.currentValue ?? null)}，不是请求的 ${JSON.stringify(expected.thoughtValue)}（回读冲突）；没有派发 prompt。`,
      )
    }
  }
}

/**
 * 选项摘要，仅用于失败说明（不输出无关字段）。
 *
 * @param {unknown} configOptions - 选项数组。
 * @returns {string} 摘要。
 */
export function summarizeOptions(configOptions) {
  if (!Array.isArray(configOptions) || configOptions.length === 0) return '无'
  return configOptions
    .map((option) => {
      const values = optionValues(option)
      return `${option?.category ?? option?.id ?? '?'}=${JSON.stringify(option?.currentValue ?? null)}${values.length === 0 ? '' : `[${values.join('|')}]`}`
    })
    .join(', ')
}

/**
 * 构造适配器（供插件入口与测试共用）。
 *
 * @param {Record<string, unknown>} [config] - 插件行 config。
 * @returns {AgyAcpAdapter} 适配器。
 */
export function createAdapter(config = {}) {
  return new AgyAcpAdapter(config)
}

/**
 * 连接是否已明确失效（可判定，不靠猜测）。
 *
 * 三个独立信号任一成立即失效：传输自己报告的 `isClosed`（子进程在且未关闭）、
 * `closed` 标志（本仓库 close() 与测试替身都设置它），或子进程已 exit/error
 * 留下的 `exitCode`/`signalCode`。仍在运行但暂时无响应的连接不算失效。
 *
 * @param {object} transport - ACP 传输。
 * @returns {boolean} 是否已失效。
 */
export function isDeadTransport(transport) {
  if (transport === null || typeof transport !== 'object') return true
  try {
    // 只有明确的 true 才算失效：旧式替身可能把字段留成 undefined。
    if (transport.isClosed === true) return true
    if (transport.closed === true) return true
    const child = transport.child ?? null
    if (child !== null && typeof child === 'object' && (child.exitCode !== null && child.exitCode !== undefined || child.signalCode !== null && child.signalCode !== undefined)) return true
  } catch {
    // 读取诊断字段失败本身也不构成可用证据；按仍可用处理。
    return false
  }
  return false
}

/**
 * 只结束传输，失败时把原因交回调用方（不抛出）。
 *
 * finally 里直接 `transport.close()` 一旦抛错，后续的 activeSessions 解锁与
 * liveSessions 淘汰都会被跳过，同一 DSH 会话就永久得到 SESSION_BUSY。
 *
 * @param {object} transport - ACP 传输。
 * @returns {unknown} 失败原因；成功返回 undefined。
 */
function safeClose(transport) {
  try {
    transport.close?.()
    return undefined
  } catch (error) {
    return error
  }
}

/**
 * 持久化账本，失败时把原因交回调用方（不抛出）。
 *
 * @param {AgyAcpAdapter} adapter - 适配器。
 * @param {string} key - 绑定的 DSH 会话。
 * @returns {unknown} 失败原因；成功返回 undefined。
 */
function safeSave(adapter, key) {
  try {
    adapter.saveNativeState()
    return undefined
  } catch (error) {
    // 内存账本保持 acceptance_unknown；这是可重试/可诊断状态，不再阻塞解锁。
    const record = adapter.nativeSessions[key]
    if (record) record.statePersistError = { message: String(error?.message ?? error), at: new Date().toISOString() }
    return error
  }
}

function hasToolInSuffix(messages, committedCount) {
  if (!Array.isArray(messages)) return false
  let historyIndex = 0
  for (const message of messages) {
    const role = message?.role
    if (role === 'user' || role === 'assistant') {
      historyIndex += 1
      continue
    }
    if (role === 'tool' && historyIndex > committedCount) return true
  }
  return false
}

/**
 * 把一次 resume/load 失败映射成能指向真实原因的错误。
 *
 * 旧实现把所有失败都改写成 AGY_ACP_SESSION_NOT_FOUND，于是「CLI 不再支持恢复」
 * 「恢复被服务拒绝」「会话真的不存在」在日志里长得一模一样。
 *
 * @param {string} method - `session/resume` 或 `session/load`。
 * @param {string} sessionId - 旧 ACP 会话 id。
 * @param {unknown} error - 原始失败。
 * @returns {AgyAcpError} 带原因区分的失败。
 */
function restoreFailure(method, sessionId, error) {
  const code = typeof error?.code === 'string' ? error.code : ''
  const message = String(error?.message ?? error)
  const unsupported = code === ERROR_CODES.UNKNOWN_METHOD || /method not found|not supported|unsupported|not implemented/i.test(message)
  if (unsupported) {
    return new AgyAcpError(
      'AGY_ACP_SESSION_RESTORE_UNSUPPORTED',
      `CLI 不支持 ${method} 恢复旧 ACP 会话 ${sessionId}（${code || 'method_not_found'}：${message}）；没有派发 prompt。`,
      { cause: error },
    )
  }
  const missing = /unknown session|not found|no such session|session does not exist/i.test(message)
  if (!missing) {
    return new AgyAcpError(
      'AGY_ACP_SESSION_RESTORE_FAILED',
      `${method} 恢复旧 ACP 会话 ${sessionId} 失败（${code || 'restore_failed'}：${message}）；没有派发 prompt。`,
      { cause: error },
    )
  }
  return new AgyAcpError(
    'AGY_ACP_SESSION_NOT_FOUND',
    `旧 ACP 会话 ${sessionId} 在 CLI 侧已不存在（${code || 'not_found'}：${message}）；没有派发 prompt。`,
    { cause: error },
  )
}