/**
 * DSH ↔ Antigravity bridge, official ACP route.
 *
 * Tools drive a local `agy acp` child process over ACP v1 JSON-RPC. Each send
 * is a persisted job with a fixed DSH owner and an ACP session id; the job is
 * completed only by the matching `session/prompt` response and a deliverable
 * assistant reply. No desktop RPC, no Google endpoint proxy, no credential
 * read.
 */

import { statSync } from 'node:fs'
import { isAbsolute, normalize, dirname, join } from 'node:path'
import { resolveHostWorkspace } from './workspace.js'
import { Bridge, defaultConfig } from './bridge.js'
import { attachmentInfo, inspectAttachments } from './attachments.js'
import { createAdapter, ERROR_CODES } from './model-adapter.js'
import { EFFORT_LOW_ID, MODEL_ID, PROVIDER_ID } from './model-catalog.js'
import { registerWebService } from './web-remote.js'

export const name = 'dsh-agy-bridge'

export const inject = ['tools', 'agents', 'workingDirectory']

const MAX_TIMEOUT_SEC = 600
const MAX_PATH_REFS = 20

const RELAY_ROLE_TABLE = Object.freeze({
  implement: Object.freeze({ model: 'gemini-4-hydrogen', effort: 'medium' }),
  review: Object.freeze({ model: 'gemini-4-neon', effort: 'medium' }),
})

const RELAY_WATCH_CODES = Object.freeze([
  Object.freeze({
    code: ERROR_CODES.UNSUPPORTED_TOOLS,
    explanation: '纯文本 ACP 通道不允许携带协作/任务工具，请改用纯文本预设或移除不兼容工具后再派发。',
  }),
  Object.freeze({
    code: 'AGY_ACP_ACCEPTANCE_UNKNOWN',
    explanation: '上轮受理状态未确认（inFlight 未落盘确认），禁止自动重发，需先排查或新建会话。',
  }),
  Object.freeze({
    code: 'AGY_ACP_BINDING_UNKNOWN',
    explanation: '多轮历史没有原生 ACP 会话绑定，不重放历史，请新建会话。',
  }),
  Object.freeze({
    code: 'AGY_ACP_SYSTEM_CHANGED',
    explanation: 'system 提示词相对已绑定会话发生变化，需新建会话，不要继续派发。',
  }),
])

function buildRelayBrief(role) {
  if (role !== 'implement' && role !== 'review') {
    throw fail('invalid_role', `不支持的 role ${JSON.stringify(role)}；仅支持 'implement' 或 'review'。`)
  }
  const spec = RELAY_ROLE_TABLE[role]
  const send = {
    pathRefsRule: '必须传绝对路径数组 path_refs（只传路径引用，不在正文贴大段文件内容）。',
    wait: true,
    timeoutSecHint: 'timeout_sec 给足（建议 300~600，最大 600）。',
    onTimeout: '超时后先调用 antigravity_read 查状态，绝不重发同一 prompt。',
    neverResendSamePrompt: true,
  }
  const promptTemplate =
    role === 'implement'
      ? '你是实现执行体。请基于以下路径完成实现与自测，并在结尾原样给出实测输出与退出码（标注为执行体自报）：\n任务：{{TASK}}\n路径：{{PATHS}}'
      : '你是独立审查体。请只读审查以下路径的改动与测试证据，列出明确的 findings（含文件与行号）与最终结论（标注为执行体自报）：\n任务：{{TASK}}\n路径：{{PATHS}}'
  const mustNot = [
    '不许代跑测试或替执行体补跑命令',
    '不许替执行体下结论或自行判定通过/失败',
    '不许替审查体补充或改写 findings',
    '不许把工具结果正文或文件内容写进活动条目（只保留元数据）',
    '超时后绝不重发同一 prompt（先 antigravity_read 查状态）',
    '回传结果时必须原文搬运并标注「执行体自报」',
  ]
  const watchCodes = RELAY_WATCH_CODES.map((entry) => ({ code: entry.code, explanation: entry.explanation }))
  const markdown = [
    `# Antigravity 中继简要口径（role=${role}）`,
    `- model: \`${spec.model}\` / effort: \`${spec.effort}\``,
    `- send: wait=${send.wait}，${send.timeoutSecHint} ${send.pathRefsRule} ${send.onTimeout}`,
    `- mustNot: ${mustNot.join('；')}`,
    `- watchCodes: ${watchCodes.map((w) => `${w.code}（${w.explanation}）`).join('；')}`,
  ].join('\n')
  return {
    markdown,
    role,
    model: spec.model,
    effort: spec.effort,
    send,
    promptTemplate,
    mustNot,
    watchCodes,
  }
}

const STATUS_LABELS = {
  not_sent: '未发送',
  accepted: '已受理，ACP 运行中',
  acceptance_unknown: '受理未知',
  replied: '已回复',
  failed: '失败',
}

export function waitTimeoutMessage(timeoutSec, statusLabel) {
  return `等待 ${timeoutSec}s 超时；请求状态保持“${statusLabel}”。回复不会被消费。不要重发同一 prompt（重发会产生重复 job 与重复计费）；请先用 antigravity_read 查状态，再决定是否继续 wait。 / Timed out after ${timeoutSec}s; status is unchanged and the reply is not consumed. Do not resend the same prompt (it would create a duplicate job and duplicate charges); use antigravity_read to check the job status first.`
}

function fail(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

function limitText(text, config) {
  if (text.length <= config.maxReplyChars) return text
  return `${text.slice(0, config.maxReplyChars)}\n…（已截断，共 ${text.length} 字符）`
}

function replyBlock(reply, config) {
  const text = limitText(reply.text ?? '', config)
  const tools = reply.tools?.length ? `\n\n工具：${reply.tools.join('、')}` : ''
  return `${text}${tools}`
}

function isDevicePath(value) {
  return /^[\\/]{2}[.?][\\/]/.test(value)
}

function isUncPath(value) {
  return /^[\\/]{2}[^\\/]/.test(value)
}

function normalizePathRefs(input) {
  if (input === undefined) return []
  if (!Array.isArray(input)) throw fail('invalid_request', 'path_refs 必须是绝对路径数组。')
  if (input.length > MAX_PATH_REFS) {
    throw fail('invalid_request', `path_refs 最多 ${MAX_PATH_REFS} 个。`)
  }
  const seen = new Set()
  const paths = []
  for (const raw of input) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw fail('invalid_path', 'path_refs 的每一项都必须是非空字符串。')
    }
    const value = raw.trim()
    if (isDevicePath(value)) throw fail('invalid_path', `不接受设备路径：${value}`)
    if (isUncPath(value)) throw fail('invalid_path', `不接受 UNC 路径：${value}`)
    if (!isAbsolute(value)) throw fail('invalid_path', `必须是绝对路径：${value}`)
    let stat
    try {
      stat = statSync(value)
    } catch {
      throw fail('invalid_path', `路径不存在或无法访问：${value}`)
    }
    if (!stat.isFile()) throw fail('invalid_path', `不是普通文件：${value}`)
    const normalized = normalize(value)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    paths.push(normalized)
  }
  return paths
}

function pathReferenceBlock(paths) {
  if (paths.length === 0) return ''
  return `\n\n[path_reference]\n${paths.map((path) => `- ${path}`).join('\n')}`
}

function requestSummary(view) {
  const parts = []
  if (view.requested.model) parts.push(`模型 ${view.requested.model}`)
  if (view.requested.effort) parts.push(`强度 ${view.requested.effort}`)
  if (view.requested.profile) parts.push(`profile ${view.requested.profile}`)
  if (view.requested.pathRefs.length > 0) parts.push(`路径引用 ${view.requested.pathRefs.length} 个`)
  if (view.requested.attachments > 0) parts.push(`附件 ${view.requested.attachments} 个`)
  return parts.join(' · ')
}

function describeEffective(value) {
  const parts = []
  if (value?.model) parts.push(`模型 ${value.model}`)
  if (value?.effort) parts.push(`强度 ${value.effort}`)
  return parts.join(' · ')
}

function sameEffective(a, b) {
  return (
    String(a?.model ?? '') === String(b?.model ?? '') &&
    String(a?.effort ?? '') === String(b?.effort ?? '')
  )
}

function effectiveSummary(view) {
  if (view.effective?.source === 'desktop_window_current') {
    return '使用窗口当前设置（桌面通道不切换模型与思考强度）'
  }
  const confirmed = describeEffective(view.confirmed)
  const actual = describeEffective(view.effective)
  if (confirmed && actual && !sameEffective(view.confirmed, view.effective)) {
    return `派发前确认：${confirmed}；当前实际：${actual}（无确认标记）`
  }
  if (!actual) return confirmed ? `派发前确认：${confirmed}` : ''
  return `${actual}${view.effective.verified ? '（ACP 已确认）' : ''}`
}

function buildMarkdown(view, { config, waitTimedOutSec = 0, progress = null }) {
  const status = STATUS_LABELS[view.status] ?? view.status
  const isDesktop = view.transport === 'desktop'
  const target = isDesktop
    ? `桌面会话 ${view.desktopConversationId || '（固定窗口）'}`
    : view.conversationId
      ? `ACP 会话 ${view.conversationId}`
      : '新 ACP 会话尚未建立'
  const title = view.title ? `「${view.title}」` : ''
  const lines = [`job ${view.jobId} · ${target}${title} · ${status}`]
  if (progress) {
    lines.push(
      `进度快照：已运行 ${progress.elapsedSec}s（自 ${progress.since}）；最近活动 ${progress.activityCount} 条（显示 ${progress.recentActivity.length} 条）`,
    )
    for (const item of progress.recentActivity.slice(0, 10)) {
      lines.push(`- ${item.kind} · ${item.title} · ${item.status}`)
    }
    lines.push(progress.hint)
    if (progress.terminal) lines.push('已达到终态，progress 不会再变化。')
  }
  lines.push(
    isDesktop
      ? '目标类型：经 pid / 启动时间 / HWND / 文档 URI / 唯一会话链接校验的 Antigravity 桌面窗口（UIA 驱动）；该通道的模型、强度切换与原生附件未验证。'
      : '目标类型：ACP sessionId（不是 Antigravity 桌面 UUID，两者未验证可互换）',
  )
  if (view.workspaceRoot) lines.push(`工作区：${view.workspaceRoot}`)
  const requested = requestSummary(view)
  if (requested) lines.push(`请求：${requested}`)
  const effective = effectiveSummary(view)
  if (effective) lines.push(`实际：${effective}`)
  if (view.code) lines.push(`代码：${view.code}`)
  if (view.message) lines.push(`说明：${view.message}`)
  if (view.fileMode === 'path_reference') {
    lines.push('文件：仅将绝对路径以 path_reference 引用块随文本发送；桥没有读取文件内容，能否访问由 Antigravity 进程权限决定。')
  } else if (view.fileMode === 'attachment') {
    lines.push('文件：按 ACP initialize 协商的 image/embeddedContext 能力发送实际字节；桥只读取调用者显式列出的路径。')
  } else if (view.fileMode === 'attachment+path_reference') {
    lines.push('文件：同时发送实际附件字节和 path_reference 路径引用。')
  }
  if (view.permissionPending) {
    lines.push('权限提示：桌面会话正在等待你在 Antigravity 窗口中处理；桥不会自动批准，也不会重复发送。')
  }
  if (view.permissions?.length > 0) {
    lines.push(
      `权限请求：${view.permissions.length} 次；按配置策略决定（${view.permissions
        .map((item) => item.decision)
        .join('、')}）。`,
    )
  }
  if (view.status === 'replied') {
    lines.push('', replyBlock({ text: view.reply, tools: view.tools }, config))
  } else if (waitTimedOutSec > 0) {
    lines.push(
      '',
      `等待超时（${waitTimedOutSec}s），请求状态保持“${status}”。回复不会被消费：不要重发同一 prompt，请先用 antigravity_read 查看或稍后用 antigravity_wait（job_id ${view.jobId}）再等。 / Do not resend the same prompt; use antigravity_read to check status first.`,
    )
  } else if (view.status === 'accepted') {
    if (view.permissionPending) {
      lines.push('桌面会话正在等待权限确认；处理后再用 antigravity_wait 或 antigravity_read 继续观察。')
    } else if (view.wakeState === 'pending') {
      lines.push('回复已到达，但本会话当前不可达；会话恢复后会投递，也可用 antigravity_read 读取。')
    } else if (view.wakeState === 'delivered') {
      lines.push('回复已通过唤醒消息送达本会话。')
    } else {
      lines.push(
        isDesktop
          ? '桌面回合正在观察中；只有本轮被观察到运行过、且两次完整空闲快照一致时才交付回复并唤醒。'
          : 'ACP prompt 正在运行；完成后会用一条回复唤醒本会话，或用 antigravity_wait/antigravity_read 主动收取。',
      )
    }
  } else if (view.status === 'acceptance_unknown') {
    lines.push('没有可证明“已受理/已完成”的证据；为避免重复发送，桥不会自动重发。请先在 Antigravity 中确认这次请求是否出现。')
  } else if (view.status === 'not_sent') {
    lines.push('请求没有发送出去，可以安全地重试。')
  } else if (view.status === 'failed') {
    lines.push('这一轮没有可交付的最终回复；桥不会唤醒，也不会把半截内容当成答复。')
  }
  return lines.join('\n')
}

const CONFIG_OPTION_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    category: { type: 'string' },
    type: { type: 'string' },
    currentValue: { type: 'string' },
    options: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          value: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['value', 'name', 'description'],
        additionalProperties: false,
      },
    },
  },
  required: ['id', 'name', 'description', 'category', 'type', 'currentValue', 'options'],
  additionalProperties: false,
}

const EFFECTIVE_SCHEMA = {
  type: 'object',
  properties: {
    model: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    effort: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    profile: { type: 'string' },
    source: { type: 'string' },
    verified: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['model', 'effort', 'profile', 'source', 'verified'],
  additionalProperties: false,
}

const PERMISSION_SCHEMA = {
  type: 'object',
  properties: {
    requestId: { type: 'string' },
    policy: { type: 'string' },
    toolCallId: { type: 'string' },
    title: { type: 'string' },
    kind: { type: 'string' },
    decision: { type: 'string' },
    optionId: { type: 'string' },
  },
  required: ['toolCallId', 'title', 'kind', 'decision', 'optionId'],
  additionalProperties: false,
}

function markdownToolOutput() {
  return {
    type: 'object',
    properties: {
      markdown: { type: 'string' },
      jobId: { type: 'string' },
      workspaceRoot: { type: 'string' },
      transport: { type: 'string' },
      conversationId: { type: 'string' },
      sessionId: { type: 'string' },
      desktopConversationId: { type: 'string' },
      targetKind: { type: 'string' },
      status: { type: 'string' },
      code: { type: 'string' },
      message: { type: 'string' },
      reply: { type: 'string' },
      tools: { type: 'array', items: { type: 'string' } },
      permissions: { type: 'array', items: PERMISSION_SCHEMA },
      wakeState: { type: 'string' },
      stopReason: { type: 'string' },
      cancelRequested: { type: 'boolean' },
      runStatus: { type: 'string' },
      fileMode: { type: 'string' },
      requested: {
        type: 'object',
        properties: {
          model: { type: 'string' },
          effort: { type: 'string' },
          profile: { type: 'string' },
          title: { type: 'string' },
          pathRefs: { type: 'array', items: { type: 'string' } },
          attachments: { type: 'number' },
          attachmentInfo: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                kind: { type: 'string' },
                mimeType: { type: 'string' },
                bytes: { type: 'number' },
              },
              required: ['name', 'kind', 'mimeType', 'bytes'],
              additionalProperties: false,
            },
          },
        },
        required: ['model', 'effort', 'profile', 'title', 'pathRefs', 'attachments', 'attachmentInfo'],
        additionalProperties: false,
      },
      effective: EFFECTIVE_SCHEMA,
      confirmed: EFFECTIVE_SCHEMA,
      configOptions: { type: 'array', items: CONFIG_OPTION_SCHEMA },
      title: { type: 'string' },
      ack: { type: 'string' },
      createdAt: { type: 'string' },
      updatedAt: { type: 'string' },
      progress: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['progress'] },
          elapsedMs: { type: 'number' },
          elapsedSec: { type: 'number' },
          since: { type: 'string' },
          terminal: { type: 'boolean' },
          activityCount: { type: 'number' },
          recentActivity: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                toolCallId: { type: 'string' },
                kind: { type: 'string' },
                title: { type: 'string' },
                status: { type: 'string' },
              },
              required: ['toolCallId', 'kind', 'title', 'status'],
              additionalProperties: false,
            },
          },
          hint: { type: 'string' },
        },
        required: ['mode', 'elapsedMs', 'elapsedSec', 'since', 'terminal', 'activityCount', 'recentActivity', 'hint'],
        additionalProperties: false,
      },
    },
    required: [
      'markdown',
      'jobId',
      'workspaceRoot',
      'transport',
      'conversationId',
      'sessionId',
      'desktopConversationId',
      'targetKind',
      'status',
      'code',
      'message',
      'reply',
      'tools',
      'permissions',
      'wakeState',
      'stopReason',
      'cancelRequested',
      'runStatus',
      'fileMode',
      'requested',
      'effective',
      'confirmed',
      'configOptions',
      'title',
      'ack',
      'createdAt',
      'updatedAt',
    ],
    additionalProperties: false,
  }
}

function toolOutput(label) {
  return {
    schema: markdownToolOutput(),
    render(_args, value) {
      return [{ type: 'text', text: String(value?.markdown ?? label) }]
    },
  }
}

function publicView(job, bridge) {
  const view = bridge.view(job)
  const effective =
    view.transport === 'desktop'
      ? {
          model: null,
          effort: null,
          profile: '',
          source: 'desktop_window_current',
          verified: false,
          summary: '实际：使用窗口当前设置（桌面通道不切换模型与思考强度）',
        }
      : view.effective
  return {
    markdown: '',
    jobId: view.jobId,
    workspaceRoot: view.workspaceRoot,
    transport: view.transport === 'desktop' ? 'desktop' : 'acp',
    conversationId: view.conversationId,
    sessionId: view.sessionId,
    desktopConversationId: view.desktopConversationId,
    targetKind: view.targetKind,
    status: view.status,
    code: view.code,
    message: view.message,
    reply: view.reply,
    tools: view.tools,
    permissions: view.permissions,
    wakeState: view.wakeState,
    stopReason: view.stopReason,
    cancelRequested: view.cancelRequested,
    runStatus: view.runStatus,
    fileMode: view.fileMode,
    title: view.title,
    ack: view.ack,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    requested: view.requested,
    effective,
    confirmed: view.confirmed,
    configOptions: view.configOptions,
  }
}

function configMarkdown(sessionId, configOptions, capabilities, created) {
  const lines = [
    `${created ? '已建立新 ACP 会话' : '已恢复 ACP 会话'} ${sessionId}`,
    '目标类型：ACP sessionId；与 Antigravity 桌面 UUID 未验证可互换。',
  ]
  const promptCaps = capabilities?.promptCapabilities ?? {}
  lines.push(
    `prompt 能力：image=${promptCaps.image === true} · embeddedContext=${
      promptCaps.embeddedContext === true
    }`,
  )
  for (const option of configOptions) {
    const choices = option.options.map((item) => `${item.value}（${item.name}）`).join('、')
    lines.push(
      `- ${option.category || 'config'} / ${option.id}：当前 ${option.currentValue || '（空）'}；可选 ${
        choices || '（无）'
      }`,
    )
  }
  if (configOptions.length === 0) lines.push('服务没有返回 configOptions；无法在此会话选择模型或思考强度。')
  return lines.join('\n')
}

function desktopMarkdown(desktop) {
  const lines = [`桌面备用通道：${desktop.enabled ? '已启用（仅在 antigravity_send 显式传 transport="desktop" 时使用）' : '未启用'}`, 'ACP 仍是默认通道；桌面通道不会自动接管失败的 ACP 任务。']
  if (desktop.target) {
    lines.push(
      `目标：pid ${desktop.target.pid} · startedAt ${desktop.target.startedAt} · hwnd ${desktop.target.hwnd} · 文档 ${desktop.target.uri}`,
    )
    lines.push('身份校验：进程启动时间、exe 路径、顶层窗口类、cloaked/可见性、当前 Document 完整 URI，以及唯一匹配的侧栏会话链接；任一不符即不派发。')
  } else if (desktop.enabled) {
    lines.push('目标：配置里还没有 desktop.target；未配置时 dispatch 会以 desktop_target_not_configured 拒绝。')
  }
  lines.push(
    `模型：${desktop.models.length === 0 ? '未提供（桌面通道未验证模型切换；桌面 CLI 证据仅覆盖新建会话的 --model）' : desktop.models.join('、')}`,
  )
  lines.push(
    `强度：${desktop.efforts.length === 0 ? '未提供（桌面通道没有经过验证的思考强度入口）' : desktop.efforts.join('、')}`,
  )
  lines.push(
    `附件：path_refs=${desktop.attachments.pathRefs === true} · 原生附件=${
      desktop.attachments.native === true
    }（桌面未验证原生附件；只把绝对路径作为引用块随文本发送）`,
  )
  lines.push(`证据：${desktop.evidence}`)
  return lines.join('\n')
}

export function apply(ctx, rawConfig) {
  const config = defaultConfig(rawConfig)
  const bridge = new Bridge(ctx, config, ctx.logger)

  ctx.effect(() => {
    bridge.start()
    return () => bridge.dispose()
  })

  let nativeAdapter = null
  if (config.modelProvider !== false) {
    const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
    if (llm && typeof llm.registerAdapter === 'function') {
      // The native route is fixed: the adapter's catalog and resolveModel() are
      // keyed by exactly this provider id. A caller-supplied alias would make
      // listModels() and resolveModel() disagree, so it is not configurable.
      const route = PROVIDER_ID
      // defaultConfig 已校验并归一化 acpToolBridge（仅 true 启用），这里不再重复判断
      const acpToolBridge = config.acpToolBridge === true
      // defaultConfig 已校验并归一化 acpPermissionPolicy，这里只做安全收窄
      const acpPermissionPolicy = config.acpPermissionPolicy === 'allow_once' ? 'allow_once' : 'reject'
      const adapter = createAdapter({
        agyExecutable: config.agyExecutable,
        agyArgs: config.agyArgs,
        cwd: config.cwd,
        acpToolBridge,
        acpPermissionPolicy,
        nativeActivityEnabled: config.nativeActivityEnabled,
        inlineThought: config.inlineThought,
        nativeStateFile: join(dirname(config.stateFile), 'native-sessions.json'),
        resolveWorkspace: (options) => {
          if (!options.sessionId) return resolveHostWorkspace(ctx, null, config)
          const handle = ctx.agents.get(options.sessionId)
          const agent = handle?.agent ?? handle
          // A stable `failure` snapshot keeps this code visible through DSH's
          // normalizer; a bare Error here degraded to UNKNOWN in the model path.
          if (!agent?.session) {
            const message = `Host session ${options.sessionId} 未找到，无法解析原生工作区。`
            throw Object.assign(new Error(message), {
              code: 'workspace_session_unknown',
              failure: Object.freeze({ code: 'workspace_session_unknown', message }),
            })
          }
          return resolveHostWorkspace(ctx, agent, config)
        },
        ...(config.transport === undefined ? {} : { transport: config.transport }),
      })
      nativeAdapter = adapter
      ctx.effect(() => {
        const dispose = llm.registerAdapter([route], adapter)
        return () => { if (typeof dispose === 'function') dispose(); adapter.dispose() }
      })
    }
  }

  const web = registerWebService({
    ctx,
    bridge,
    adapter: nativeAdapter,
    config: {
      ...config,
      models:
        Array.isArray(config.models) && config.models.length > 0 ? config.models : [],
      efforts:
        Array.isArray(config.efforts) && config.efforts.length > 0
          ? config.efforts
          : [EFFORT_LOW_ID],
    },
  })
  if (web.registered && typeof web.dispose === 'function') {
    ctx.effect(() => web.dispose)
  }

  ctx.effect(() => {
    const offCreated = ctx.on('agent/created', (payload) => {
      const agent = payload?.agent
      if (agent) bridge.remember(agent)
    })
    const offDisposed = ctx.on('agent/disposed', (payload) => {
      const agent = payload?.agent
      if (agent) bridge.forget(agent.id)
    })
    return () => {
      offCreated?.()
      offDisposed?.()
    }
  })

  ctx.effect(() => {
    const disposers = []

    disposers.push(
      ctx.tools.register({
        name: 'antigravity_send',
        description:
          'Send a task to the local Antigravity CLI over the official `agy acp` stdio channel and return a bridge job id. ' +
          'Antigravity runs the ACP prompt in the background; this DSH session is woken only when that exact prompt ends with a deliverable assistant reply. ' +
          'The job is persisted before the prompt is sent, so a possibly-delivered request is never resent automatically. ' +
          'A new ACP session is created when conversation_id is omitted; conversation_id continues an existing ACP session (an ACP sessionId, not a desktop UUID). ' +
          'model/effort are applied with session/set_config_option and verified against the returned configOptions; unsupported values fail before the prompt. ' +
          'attachments are absolute paths to explicit files and are sent as real image base64 or embedded text when ACP negotiated image/embeddedContext. ' +
          'path_refs only adds absolute paths as a reference block and never reads file content. ' +
          'transport="desktop" instead uses the explicitly configured Antigravity desktop window through the local UIA driver: ACP remains the default, ' +
          'desktop does not support model/effort/profile or native attachments, accepts only path_refs, and is delivered only after this round is attributed to the job. ' +
          'Permission requests follow the configured reject/allow_once policy and are recorded. Set wait=true to block for the reply.',
        parameters: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description:
                'The task to execute, in natural language. Include absolute paths and the exact expected result.',
            },
            conversation_id: {
              type: 'string',
              description:
                'Continue this ACP sessionId (returned by antigravity_send or antigravity_config). This is not an Antigravity desktop conversation UUID.',
            },
            transport: {
              type: 'string',
              enum: ['acp', 'desktop'],
              description:
                "Delivery channel. Default (and preferred) is 'acp'. 'desktop' is an explicit opt-in fallback that drives the configured Antigravity desktop window through UIA; it has no model/effort/profile and no native attachments.",
            },
            model: {
              type: 'string',
              description:
                'Model value or display name from antigravity_config. Applied via session/set_config_option; invalid or missing values fail before the prompt.',
            },
            effort: {
              type: 'string',
              description:
                'Thought/reasoning strength value or display name from antigravity_config (category "thought"). Applied and verified before the prompt.',
            },
            profile: {
              type: 'string',
              description:
                'Not supported by the ACP route. Supplying it fails with unsupported_capability before anything is sent.',
            },
            title: {
              type: 'string',
              description: 'Local label for this bridge job. ACP has no title field, so this is not sent to Antigravity.',
            },
            path_refs: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Absolute paths of existing regular files. Only the paths are sent in a path_reference block; no file content is read or attached.',
            },
            attachments: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Absolute paths of explicit files to transfer. Images (png/jpeg/gif/webp) require ACP image capability; text files require embeddedContext. The bridge reads only these paths, then sends actual bytes.',
            },
            wait: {
              type: 'boolean',
              description: 'Block until the reply for this request arrives. Default false.',
            },
            timeout_sec: {
              type: 'integer',
              description: 'Maximum seconds to wait when wait=true. Default 180.',
            },
            wake_agent: {
              type: 'string',
              description:
                'Optional AgentTeams member name (e.g. "relay-neon" or "lead"). When provided, replied output is delivered to that member (queued semantics, never rejected when busy). Omit to wake the owning session; blank is treated as omitted, falls back to the plugin config `wakeAgent`.',
            },
          },
          required: ['message'],
          additionalProperties: false,
        },
        output: toolOutput('Antigravity'),
        timeoutMs: (MAX_TIMEOUT_SEC + 120) * 1000,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const message = typeof args?.message === 'string' ? args.message.trim() : ''
          if (message === '') throw fail('invalid_request', 'message 不能为空。')
          const agentId = String(exec.agent.id)
          bridge.remember(exec.agent)

          const conversationId = typeof args?.conversation_id === 'string' ? args.conversation_id.trim() : ''
          const transport = typeof args?.transport === 'string' ? args.transport.trim() : 'acp'
          if (transport !== 'acp' && transport !== 'desktop') {
            throw fail('invalid_request', `transport 只能是 'acp' 或 'desktop'（收到 ${transport}）。`)
          }
          const windowed = transport === 'desktop'
          const explicitModel = typeof args?.model === 'string' ? args.model.trim() : ''
          const explicitEffort = typeof args?.effort === 'string' ? args.effort.trim() : ''
          const profile = typeof args?.profile === 'string' ? args.profile.trim() : ''
          const explicitTitle = typeof args?.title === 'string' ? args.title.trim() : ''
          const explicitWakeAgent = typeof args?.wake_agent === 'string' ? args.wake_agent.trim() : ''
          const wakeAgent = explicitWakeAgent || config.wakeAgent || ''
          const pathRefs = normalizePathRefs(args?.path_refs)
          const attachmentPaths = args?.attachments
          if (profile !== '') {
            throw fail(
              'unsupported_capability',
              windowed
                ? '桌面通道没有 profile 配置项；没有派发。'
                : 'ACP 通道没有 profile 配置项；没有派发。请去掉 profile，模型和强度用 model/effort。',
            )
          }
          if (windowed) {
            if (conversationId !== '') {
              throw fail(
                'unsupported_capability',
                '桌面通道只向配置里经唯一识别的那个窗口派发，不接受 conversation_id 续聊；没有派发。',
              )
            }
            if (explicitModel !== '' || explicitEffort !== '') {
              throw fail(
                'unsupported_capability',
                '桌面通道未验证模型/强度切换（桌面 CLI 证据只支持新建会话的 model，续聊没有）；没有派发。请去掉 model/effort，或改用 transport="acp"。',
              )
            }
            if (Array.isArray(attachmentPaths) && attachmentPaths.length > 0) {
              throw fail(
                'unsupported_capability',
                '桌面通道未验证原生附件；没有派发。桌面只支持 path_refs（仅把绝对路径作为引用块随文本发送）。',
              )
            }
          }

          // ACP must be ready before any file capability question is answered;
          // desktop never touches the ACP backend.
          const workspaceRoot = windowed ? '' : resolveHostWorkspace(ctx, exec.agent, config)
          const capabilities = windowed ? null : await bridge.backend.ready()
          const attachments = windowed
            ? []
            : inspectAttachments(attachmentPaths, capabilities.promptCapabilities, config)

          const model = windowed
            ? ''
            : conversationId === ''
              ? explicitModel || config.defaultModel
              : explicitModel
          const effort = windowed
            ? ''
            : conversationId === ''
              ? explicitEffort || config.defaultEffort
              : explicitEffort
          const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ')
          const title =
            explicitTitle ||
            (windowed
              ? `DSH → Antigravity 桌面 ${stamp}`
              : conversationId === ''
                ? `DSH → Antigravity ${stamp}`
                : '')
          const requested = {
            model,
            effort,
            profile,
            title,
            pathRefs,
            attachments: attachments.length,
            attachmentInfo: attachmentInfo(attachments),
          }

          const { job, error } = bridge.beginSend({
            agentId,
            workspaceRoot,
            conversationId,
            transport,
            message: `${message}${pathReferenceBlock(pathRefs)}`,
            requested,
            title,
            wakeAgent,
          })
          if (error) throw fail(error.code, error.message)

          const wait = args?.wait === true
          const timeoutSec = Math.min(
            MAX_TIMEOUT_SEC,
            Math.max(10, Number(args?.timeout_sec ?? 180)),
          )
          let timedOut = false
          // Hold the wake slot before the prompt is written, so an immediate
          // ACP reply cannot wake the session that is already blocking in wait.
          if (wait) bridge.beginWaiter(job.jobId)
          try {
            await bridge.dispatch(job, {
              message: `${message}${pathReferenceBlock(pathRefs)}`,
              requested,
              attachments,
              cwd: workspaceRoot,
            })
            if (wait) {
              const outcome = await bridge.waitFor(job, {
                timeoutMs: timeoutSec * 1000,
                signal: exec.signal,
              })
              timedOut = outcome.timedOut === true
            }
          } finally {
            if (wait) bridge.endWaiter(job.jobId)
          }

          const result = publicView(job, bridge)
          if (timedOut) {
            result.code = 'wait_timeout'
            result.message = waitTimeoutMessage(timeoutSec, STATUS_LABELS[job.status] ?? job.status)
          }
          result.markdown = buildMarkdown(result, {
            config,
            waitTimedOutSec: timedOut ? timeoutSec : 0,
          })
          if (wakeAgent !== '' && result.wakeState === 'delivered') {
            const via = bridge.view(job).wakeDeliveredVia === 'subagents' ? 'subagents' : 'fallback followup'
            result.markdown = `${result.markdown}\n投递目标：AgentTeams 成员 ${wakeAgent}（via ${via}）`
          }
          return result
        },
      }),
    )

    disposers.push(
      ctx.tools.register({
        name: 'antigravity_cancel',
        description:
          'Cancel the active prompt for one of your bridge jobs. For ACP it sends the official `session/cancel` notification for that ACP session, ' +
          'waits briefly for the actual `session/prompt` stopReason, and updates the job from that result. For desktop it only stops local observation ' +
          '(the driver has no verified Stop control) and says so. A prompt that has not settled yet stays accepted ' +
          'and readable; this never resends a request and never treats cancellation as a completed reply.',
        parameters: {
          type: 'object',
          properties: {
            job_id: {
              type: 'string',
              description: 'Bridge job id returned by antigravity_send.',
            },
            timeout_sec: {
              type: 'number',
              description: 'How long to wait for the real stopReason after session/cancel. Default 10 seconds.',
            },
          },
          required: ['job_id'],
          additionalProperties: false,
        },
        output: toolOutput('Antigravity cancel'),
        async execute(args, exec) {
          try {
            const agentId = String(exec.agent.id)
            bridge.remember(exec.agent)
            const jobId = String(args?.job_id ?? '').trim()
            if (jobId === '') throw fail('invalid_request', '必须提供 antigravity_send 返回的 job_id。')
            const timeoutSec = Math.min(30, Math.max(1, Number(args?.timeout_sec ?? 10)))
            const { job, error } = bridge.resolveJob({ jobId, agentId })
            if (error) throw fail(error.code, error.message)
            const outcome = await bridge.cancelJob(job, { timeoutMs: timeoutSec * 1000 })
            if (outcome.error) throw fail(outcome.error.code, outcome.error.message)
            // Let the prompt completion handler apply the actual stopReason.
            await new Promise((resolve) => setTimeout(resolve, 0))
            const result = publicView(job, bridge)
            if (job.transport === 'desktop') {
              result.markdown = outcome.released === true
                ? `已解除 job ${job.jobId} 的桥侧桌面窗口锁（status=${result.status}, code=${result.code}）：${outcome.message}。`
                : outcome.stopControl === 'unavailable'
                  ? `已停止对 job ${job.jobId} 的本地观察；桌面驱动没有经过验证的 Stop 控件，Antigravity 里的生成可能仍在继续。状态 ${STATUS_LABELS[result.status] ?? result.status}，可用 antigravity_read 查看。`
                  : `job ${job.jobId} 不在观察中（状态 ${STATUS_LABELS[result.status] ?? result.status}）；桌面通道没有 Stop 控件。`
            } else {
              result.markdown = outcome.cancelSent
                ? outcome.settled
                  ? `已取消 job ${job.jobId}：ACP 返回 stopReason=${result.stopReason || '（空）'}，状态 ${STATUS_LABELS[result.status] ?? result.status}。`
                  : `已向 job ${job.jobId} 的 ACP 会话发送 session/cancel，但 ${timeoutSec}s 内没有收到 stopReason；状态保持 ${STATUS_LABELS[result.status] ?? result.status}，稍后用 antigravity_read 查看。`
                : `job ${job.jobId} 当前没有可取消的在途 prompt（状态 ${STATUS_LABELS[result.status] ?? result.status}）。`
            }
            return result
          } catch (cause) {
            throw cause
          }
        },
      }),
    )

    disposers.push(
      ctx.tools.register({
        name: 'antigravity_config',
        description:
          'Inspect ACP configOptions (model and thought/reasoning choices) and prompt capabilities. ' +
          'With conversation_id, resumes that ACP session; without it, creates a new ACP session and returns its sessionId for a later antigravity_send. ' +
          'transport="desktop" instead reports the configured desktop fallback target and its (limited) evidence without touching ACP. ' +
          'This never sends a prompt. Use the exact value or display name from here in antigravity_send model/effort.',
        parameters: {
          type: 'object',
          properties: {
            conversation_id: {
              type: 'string',
              description: 'Existing ACP sessionId to resume. Omit to create a session and list its options.',
            },
            transport: {
              type: 'string',
              enum: ['acp', 'desktop'],
              description: "Report for 'acp' (default) or the explicit 'desktop' fallback.",
            },
          },
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              markdown: { type: 'string' },
              sessionId: { type: 'string' },
              workspaceRoot: { type: 'string' },
              created: { type: 'boolean' },
              configOptions: { type: 'array', items: CONFIG_OPTION_SCHEMA },
              capabilities: {
                type: 'object',
                properties: {
                  image: { type: 'boolean' },
                  audio: { type: 'boolean' },
                  embeddedContext: { type: 'boolean' },
                  loadSession: { type: 'boolean' },
                },
                required: ['image', 'audio', 'embeddedContext', 'loadSession'],
                additionalProperties: false,
              },
              desktop: {
                type: 'object',
                properties: {
                  enabled: { type: 'boolean' },
                  target: {
                    oneOf: [
                      {
                        type: 'object',
                        properties: {
                          pid: { type: 'number' },
                          startedAt: { type: 'string' },
                          hwnd: { type: 'number' },
                          uri: { type: 'string' },
                        },
                        required: ['pid', 'startedAt', 'hwnd', 'uri'],
                        additionalProperties: false,
                      },
                      { type: 'null' },
                    ],
                  },
                  models: { type: 'array', items: { type: 'string' } },
                  efforts: { type: 'array', items: { type: 'string' } },
                  attachments: {
                    type: 'object',
                    properties: {
                      pathRefs: { type: 'boolean' },
                      native: { type: 'boolean' },
                    },
                    required: ['pathRefs', 'native'],
                    additionalProperties: false,
                  },
                  evidence: { type: 'string' },
                },
                required: ['enabled', 'target', 'models', 'efforts', 'attachments', 'evidence'],
                additionalProperties: false,
              },
            },
            required: ['markdown', 'sessionId', 'workspaceRoot', 'created', 'configOptions', 'capabilities', 'desktop'],
            additionalProperties: false,
          },
          render(_args, value) {
            return [{ type: 'text', text: String(value?.markdown ?? '') }]
          },
        },
        timeoutMs: 60_000,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
          const agentId = String(exec.agent.id)
          bridge.remember(exec.agent)
          const requested = typeof args?.conversation_id === 'string' ? args.conversation_id.trim() : ''
          const desktopCaps = bridge.desktop.capabilities()
          const desktopInfo = {
            enabled: desktopCaps.desktop === true,
            target: desktopCaps.target
              ? {
                  pid: desktopCaps.target.pid,
                  startedAt: desktopCaps.target.startedAt,
                  hwnd: desktopCaps.target.hwnd,
                  uri: desktopCaps.target.uri,
                }
              : null,
            models: desktopCaps.models,
            efforts: desktopCaps.efforts,
            attachments: {
              pathRefs: desktopCaps.attachments.pathRefs === true,
              native: desktopCaps.attachments.native === true,
            },
            evidence: desktopCaps.evidence,
          }
          if (requested === '' && args?.transport === 'desktop') {
            return {
              markdown: desktopMarkdown(desktopInfo),
              sessionId: '',
              workspaceRoot: '',
              created: false,
              configOptions: [],
              capabilities: { image: false, audio: false, embeddedContext: false, loadSession: false },
              desktop: desktopInfo,
            }
          }
          if (requested !== '' && args?.transport === 'desktop') {
            throw fail(
              'unsupported_capability',
              '桌面通道只向配置里经唯一识别的那个窗口派发，不接受 conversation_id；读取 ACP 选项请去掉 transport。',
            )
          }
          const session = await bridge.configSession({
            agentId,
            conversationId: requested,
            cwd: resolveHostWorkspace(ctx, exec.agent, config),
          })
          if (session.error) throw fail(session.error.code, session.error.message)
          const capabilities = session.capabilities
          const configOptions = session.configOptions
          return {
            markdown: `${configMarkdown(session.sessionId, configOptions, capabilities, session.created)}\n\n${desktopMarkdown(desktopInfo)}`,
            sessionId: session.sessionId,
            workspaceRoot: session.workspaceRoot,
            created: session.created,
            configOptions,
            capabilities: {
              image: capabilities.promptCapabilities.image === true,
              audio: capabilities.promptCapabilities.audio === true,
              embeddedContext: capabilities.promptCapabilities.embeddedContext === true,
              loadSession: capabilities.loadSession === true,
            },
            desktop: desktopInfo,
          }
        },
      }),
    )

    disposers.push(
      ctx.tools.register({
        name: 'antigravity_wait',
        description:
          'Block until the ACP prompt for one bridge job finishes with a deliverable reply, then return its text. Prefer job_id. ' +
          'conversation_id only works when this session owns exactly one job for that ACP session. ' +
          'A timeout returns code=wait_timeout with the job id and leaves the job status unchanged; the reply is not consumed and remains queryable.',
        parameters: {
          type: 'object',
          properties: {
            job_id: {
              type: 'string',
              description: 'Bridge job id returned by antigravity_send.',
            },
            conversation_id: {
              type: 'string',
              description: 'Legacy selector: only when this session owns exactly one job for that ACP session.',
            },
            timeout_sec: {
              type: 'integer',
              description: 'Maximum seconds to wait. Default 180.',
            },
            mode: {
              type: 'string',
              enum: ['wait', 'progress'],
              description: 'wait（默认）=阻塞到回复或超时；progress=立即返回当前状态/已等待时长/最近活动，不阻塞。',
            },
            activity_limit: {
              type: 'integer',
              description: 'progress 模式返回的最近活动条数，默认 3，代码里夹在 1..10。',
            },
          },
          additionalProperties: false,
        },
        output: toolOutput('Antigravity wait'),
        timeoutMs: (MAX_TIMEOUT_SEC + 120) * 1000,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
          bridge.remember(exec.agent)
          const resolved = bridge.resolveJob({
            jobId: typeof args?.job_id === 'string' ? args.job_id.trim() : '',
            conversationId:
              typeof args?.conversation_id === 'string' ? args.conversation_id.trim() : '',
            agentId: String(exec.agent.id),
          })
          if (resolved.error) throw fail(resolved.error.code, resolved.error.message)
          const job = resolved.job
          const mode = args?.mode === 'progress' ? 'progress' : 'wait'
          if (mode === 'progress') {
            const view = bridge.view(job)
            const activityLimit = Math.min(10, Math.max(1, Number(args?.activity_limit ?? 3)))
            const parsedCreated = Date.parse(view.createdAt)
            const elapsedMs = Number.isFinite(parsedCreated) ? Math.max(0, Date.now() - parsedCreated) : 0
            const elapsedSec = Math.round(elapsedMs / 100) / 10
            const allActivity = Array.isArray(view.activity) ? view.activity : []
            const recentActivity = allActivity.slice(-activityLimit).map((item) => ({
              toolCallId: String(item?.toolCallId ?? ''),
              kind: String(item?.kind ?? ''),
              title: String(item?.title ?? ''),
              status: String(item?.status ?? ''),
            }))
            const terminal = view.status === 'replied' || view.status === 'failed' || view.status === 'not_sent'
            const result = publicView(job, bridge)
            result.progress = {
              mode: 'progress',
              elapsedMs,
              elapsedSec,
              since: String(view.createdAt ?? ''),
              terminal,
              activityCount: allActivity.length,
              recentActivity,
              hint: '进度快照不消耗回复；不要在进度模式下重发 prompt，查状态用 antigravity_read；Do not resend the prompt; use antigravity_read for status.',
            }
            result.markdown = buildMarkdown(result, { config, progress: result.progress })
            return result
          }
          const timeoutSec = Math.min(
            MAX_TIMEOUT_SEC,
            Math.max(10, Number(args?.timeout_sec ?? 180)),
          )
          const outcome = await bridge.waitFor(job, {
            timeoutMs: timeoutSec * 1000,
            signal: exec.signal,
          })
          const result = publicView(job, bridge)
          if (outcome.timedOut) {
            result.code = 'wait_timeout'
            result.message = waitTimeoutMessage(timeoutSec, STATUS_LABELS[job.status] ?? job.status)
          }
          result.markdown = buildMarkdown(result, {
            config,
            waitTimedOutSec: outcome.timedOut ? timeoutSec : 0,
          })
          return result
        },
      }),
    )

    disposers.push(
      ctx.tools.register({
        name: 'antigravity_read',
        description:
          'Read one bridge job without waiting: request status, wake state and the cached reply. ' +
          'Prefer job_id; conversation_id works only when this session owns exactly one job for that ACP session. Reading does not consume the reply.',
        parameters: {
          type: 'object',
          properties: {
            job_id: { type: 'string', description: 'Bridge job id returned by antigravity_send.' },
            conversation_id: {
              type: 'string',
              description: 'Legacy selector: only when this session owns exactly one job for that ACP session.',
            },
          },
          additionalProperties: false,
        },
        output: toolOutput('Antigravity read'),
        timeoutMs: 30_000,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          bridge.remember(exec.agent)
          const resolved = bridge.resolveJob({
            jobId: typeof args?.job_id === 'string' ? args.job_id.trim() : '',
            conversationId:
              typeof args?.conversation_id === 'string' ? args.conversation_id.trim() : '',
            agentId: String(exec.agent.id),
          })
          if (resolved.error) throw fail(resolved.error.code, resolved.error.message)
          bridge.readJob(resolved.job)
          const result = publicView(resolved.job, bridge)
          result.markdown = buildMarkdown(result, { config })
          return result
        },
      }),
    )

    disposers.push(
      ctx.tools.register({
        name: 'antigravity_list',
        description:
          'List this DSH session’s own bridge jobs with status and wake state, newest first. ' +
          'It never lists private Antigravity history or reply bodies; use antigravity_list only for your own jobs.',
        parameters: {
          type: 'object',
          properties: {
            limit: {
              type: 'integer',
              description: 'How many jobs to list. Default 10.',
            },
          },
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              markdown: { type: 'string' },
              jobs: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    jobId: { type: 'string' },
                    clientRequestId: { type: 'string' },
                    transport: { type: 'string' },
                    conversationId: { type: 'string' },
                    sessionId: { type: 'string' },
                    desktopConversationId: { type: 'string' },
                    targetKind: { type: 'string' },
                    title: { type: 'string' },
                    status: { type: 'string' },
                    code: { type: 'string' },
                    wakeState: { type: 'string' },
                    createdAt: { type: 'string' },
                    updatedAt: { type: 'string' },
                  },
                  required: [
                    'jobId',
                    'clientRequestId',
                    'transport',
                    'conversationId',
                    'sessionId',
                    'desktopConversationId',
                    'targetKind',
                    'title',
                    'status',
                    'code',
                    'wakeState',
                    'createdAt',
                    'updatedAt',
                  ],
                  additionalProperties: false,
                },
              },
            },
            required: ['markdown', 'jobs'],
            additionalProperties: false,
          },
          render(_args, value) {
            return [{ type: 'text', text: String(value?.markdown ?? '') }]
          },
        },
        timeoutMs: 30_000,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          bridge.remember(exec.agent)
          const limit = Math.max(1, Math.min(50, Number(args?.limit ?? 10)))
          const jobs = bridge.listJobs(String(exec.agent.id), limit)
          const rows = jobs.map((job) => {
            const target =
              job.transport === 'desktop'
                ? `桌面 ${job.desktopConversationId || '（固定窗口）'}`
                : job.conversationId
                  ? `ACP ${job.conversationId}`
                  : '新 ACP 会话尚未建立'
            const title = job.title ? `「${job.title}」` : ''
            const code = job.code ? ` · ${job.code}` : ''
            return `- ${job.jobId} · ${target}${title} · ${STATUS_LABELS[job.status] ?? job.status}${code} · wake=${job.wakeState}`
          })
          return {
            markdown:
              rows.length > 0
                ? `本会话的 Antigravity job：\n${rows.join('\n')}`
                : '本会话还没有 Antigravity job。',
            jobs,
          }
        },
      }),
      ctx.tools.register({
        name: 'antigravity_relay_brief',
        description:
          '返回纯静态、确定性的 Antigravity 中继派单口径（模型、思考强度、发送要点、prompt 模板、禁止事项与重点错误码说明）。不读写 state.json、不发网络、不建 job。',
        parameters: {
          type: 'object',
          properties: {
            role: {
              type: 'string',
              enum: ['implement', 'review'],
              description: "目标角色：'implement'（实现执行体）或 'review'（独立审查体）。",
            },
          },
          required: ['role'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              markdown: { type: 'string' },
              role: { type: 'string', enum: ['implement', 'review'] },
              model: { type: 'string' },
              effort: { type: 'string' },
              send: {
                type: 'object',
                properties: {
                  pathRefsRule: { type: 'string' },
                  wait: { type: 'boolean' },
                  timeoutSecHint: { type: 'string' },
                  onTimeout: { type: 'string' },
                  neverResendSamePrompt: { type: 'boolean' },
                },
                required: ['pathRefsRule', 'wait', 'timeoutSecHint', 'onTimeout', 'neverResendSamePrompt'],
                additionalProperties: false,
              },
              promptTemplate: { type: 'string' },
              mustNot: { type: 'array', items: { type: 'string' } },
              watchCodes: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    code: { type: 'string' },
                    explanation: { type: 'string' },
                  },
                  required: ['code', 'explanation'],
                  additionalProperties: false,
                },
              },
            },
            required: ['markdown', 'role', 'model', 'effort', 'send', 'promptTemplate', 'mustNot', 'watchCodes'],
            additionalProperties: false,
          },
          render(_args, value) {
            return [{ type: 'text', text: String(value?.markdown ?? '') }]
          },
        },
        timeoutMs: 10_000,
        isConcurrencySafe: () => true,
        async execute(args) {
          return buildRelayBrief(args?.role)
        },
      }),
      ctx.tools.register({
        name: 'antigravity_reset_session',
        description:
          '重置调用方当前 DSH 会话的原生 ACP 绑定并写入重基线墓碑（只清绑定与内存状态，不删用户会话/不重启 agy/不动 job 列表）。下一轮将自动以末尾用户输入重建 ACP 会话。',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              markdown: { type: 'string' },
              sessionId: { type: 'string' },
              hadBinding: { type: 'boolean' },
              hadTombstone: { type: 'boolean' },
              clearedCount: { type: 'number' },
              nextTurnBehavior: { type: 'string', enum: ['rebaseline_new_session'] },
            },
            required: ['markdown', 'sessionId', 'hadBinding', 'hadTombstone', 'clearedCount', 'nextTurnBehavior'],
            additionalProperties: false,
          },
          render(_args, value) {
            return [{ type: 'text', text: String(value?.markdown ?? '') }]
          },
        },
        timeoutMs: 30_000,
        isConcurrencySafe: () => false,
        async execute(_args, exec) {
          bridge.remember(exec?.agent)
          const sessionId = String(exec?.agent?.session?.id ?? exec?.agent?.id ?? '')
          if (sessionId === '') {
            throw fail('invalid_request', '无法从调用上下文确定当前 DSH 会话 id。')
          }
          if (!nativeAdapter) {
            return {
              markdown: `当前未启用原生模型适配器，会话 ${sessionId} 无需清理；下一轮将自动重基线。`,
              sessionId,
              hadBinding: false,
              hadTombstone: false,
              clearedCount: 0,
              nextTurnBehavior: 'rebaseline_new_session',
            }
          }
          const result = nativeAdapter.resetSession(sessionId)
          return {
            markdown: `已重置会话 ${result.sessionId} 的原生 ACP 绑定（hadBinding=${result.hadBinding}，hadTombstone=${result.hadTombstone}，清理项=${result.clearedCount}）；下一轮将自动重基线；未删除用户会话、未重启 agy、未改动 job 列表。`,
            ...result,
            nextTurnBehavior: 'rebaseline_new_session',
          }
        },
      }),
    )

    const desktopTargetSchema = {
      type: 'object',
      properties: {
        pid: { type: 'number' },
        startedAt: { type: 'string' },
        hwnd: { type: 'number' },
        uri: { type: 'string' },
      },
      required: ['pid', 'startedAt', 'hwnd', 'uri'],
      additionalProperties: false,
    }
    const desktopCandidateSchema = {
      type: 'object',
      properties: {
        pid: { type: 'number' },
        startedAt: { type: 'string' },
        hwnd: { oneOf: [{ type: 'number' }, { type: 'string' }] },
        redactedUri: { type: 'string' },
        isForeground: { type: 'boolean' },
      },
      required: ['pid', 'startedAt', 'hwnd', 'redactedUri', 'isForeground'],
      additionalProperties: false,
    }

    disposers.push(
      ctx.tools.register({
        name: 'antigravity_desktop_pin',
        description:
          'Configure or inspect the runtime pinned Antigravity desktop window target (action: pin | clear | status). ' +
          'Read-only UIA probe only: never steals focus and never clicks controls; status never writes pin files. ' +
          'Available even when config.desktop.enabled is false (desktop dispatch remains opt-in, ACP stays default, and desktop never switches model/effort or accepts native attachments).',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['pin', 'clear', 'status'], description: 'pin=发现并固定目标窗口；clear=清除运行期固定并回退静态配置；status=只读查看当前固定目标与连通状态。' },
            hwnd: { oneOf: [{ type: 'number' }, { type: 'string' }], description: '可选窗口句柄（正整数或 0x 十六进制），多候选时用于消歧。' },
            pid: { type: 'number', description: '可选进程 pid 过滤条件。' },
            include_candidates: { type: 'boolean', description: 'action=status 时可选：是否同时列出当前可见的 Antigravity 候选窗口。' },
          },
          required: ['action'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              markdown: { type: 'string' },
              pinned: { type: 'boolean' },
              enabled: { type: 'boolean' },
              verified: { type: 'boolean' },
              target: { oneOf: [desktopTargetSchema, { type: 'null' }] },
              fallbackTarget: { oneOf: [desktopTargetSchema, { type: 'null' }] },
              targetKey: { type: 'string' },
              evidence: { type: 'object', additionalProperties: true },
              code: { type: 'string' },
              message: { type: 'string' },
              candidates: { type: 'array', items: desktopCandidateSchema },
            },
            required: ['markdown', 'pinned', 'enabled'],
            additionalProperties: false,
          },
          render(_args, value) {
            return [{ type: 'text', text: String(value?.markdown ?? '') }]
          },
        },
        timeoutMs: 30_000,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
          bridge.remember(exec?.agent)
          const action = String(args?.action ?? '')
          const optInNote = bridge.desktop.enabled
            ? ''
            : '（注意：当前 config.desktop.enabled=false，桌面备用通道仍为 opt-in，仅在启用后且显式传 transport="desktop" 才会使用。）'
          if (action === 'status') {
            const res = await bridge.desktop.statusSnapshot({
              includeCandidates: args?.include_candidates === true,
            })
            const summary = res.target
              ? `pid ${res.target.pid} · hwnd ${res.target.hwnd} · verified=${res.verified}`
              : '未配置目标'
            return {
              markdown: `桌面备用通道（${res.enabled ? '已启用' : '未启用'} · ACP 仍是默认）：pinned=${res.pinned} · ${summary}${res.code ? ` · ${res.code}` : ''}`,
              enabled: res.enabled,
              target: res.target,
              pinned: res.pinned,
              verified: res.verified,
              ...(res.code ? { code: res.code } : {}),
              ...(res.message ? { message: res.message } : {}),
              ...(Array.isArray(res.candidates) ? { candidates: res.candidates } : {}),
            }
          }
          const res = await bridge.desktop.pinAction({
            action,
            hwnd: args?.hwnd,
            pid: args?.pid,
          })
          if (action === 'clear') {
            const fallbackText = res.fallbackTarget
              ? `；已回退到静态目标 pid ${res.fallbackTarget.pid} hwnd ${res.fallbackTarget.hwnd}`
              : '；当前无静态目标'
            return {
              markdown: `已清除运行期桌面目标固定${fallbackText}。${optInNote}`,
              pinned: false,
              enabled: bridge.desktop.enabled,
              fallbackTarget: res.fallbackTarget ?? null,
              ...(res.code ? { code: res.code } : {}),
              ...(res.message ? { message: res.message } : {}),
            }
          }
          if (!res.ok) {
            return {
              markdown: `桌面目标固定失败（${res.code ?? 'desktop_target_unverified'}）：${res.message ?? ''}${optInNote}`,
              pinned: false,
              enabled: bridge.desktop.enabled,
              code: res.code ?? 'desktop_target_unverified',
              message: res.message ?? '',
              ...(Array.isArray(res.candidates) ? { candidates: res.candidates } : {}),
            }
          }
          return {
            markdown: `已固定桌面目标：pid ${res.target.pid} · hwnd ${res.target.hwnd} · key ${res.targetKey}。${optInNote}`,
            pinned: true,
            enabled: bridge.desktop.enabled,
            target: res.target,
            targetKey: res.targetKey,
            evidence: res.evidence,
          }
        },
      }),
    )

    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          // Disposal order never worth failing the unload over.
        }
      }
    }
  })
}
