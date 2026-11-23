/* GENERATED FILE - do not edit by hand.
 * Regenerate by embedding client/locale.js + client/panel.js and the Remote
 * descriptors from lib/web-remote.js.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.__ModuleLoader__) return;
  window.__ModuleLoader__.load({
    id: "dsh-agy-bridge",
    factory: function factory(require) {
      var React = require('react');
      var localeApi = (function () {
/**
 * Typed locale namespace for the Antigravity bridge panel (staging).
 *
 * DSH requires a client plugin to register its own namespace with both baseline
 * locales (`zh` and `en`) and to read copy through the bound translate seat, so the
 * panel never hard-codes user-visible text.
 */

const PANEL_NAMESPACE = 'antigravity-bridge';

const zh = {
  'title': 'Antigravity 任务',
  'panel.expand': '展开 Antigravity 面板',
  'panel.collapse': '收起 Antigravity 面板',
  'panel.collapsedHint': '已收起，输入框保持不变',
  'transport.label': '通道',
  'transport.acp': 'ACP（默认）',
  'transport.desktop': '桌面（备用，仅显式选择）',
  'transport.desktopUnavailable': '桌面备用当前不可用',
  'model.label': '模型',
  'model.auto': '跟随会话当前设置',
  'model.unsupported': '当前后端不能选择模型',
  'effort.label': '思考强度',
  'effort.auto': '跟随会话当前设置',
  'effort.unsupported': '当前后端不能选择思考强度',
  'attachments.label': 'Host 路径引用',
  'attachments.placeholder': '绝对路径，例如 D:\\work\\spec.md',
  'attachments.add': '添加路径',
  'attachments.remove': '移除',
  'attachments.pathOnly': '只发送路径引用，面板不读取文件内容',
  'attachments.unsupported': '当前后端不支持 Host 路径引用',
  'attachments.filesLabel': '文件附件（DSH 会话上传）',
  'attachments.choose': '选择文件',
  'attachments.uploading': '正在上传…',
  'attachments.uploadFailed': '文件上传失败，未派发',
  'attachments.fileUnsupported': '当前 DSH 会话没有可用的上传服务；请改用 Host 路径引用',
  'attachments.bytes': '{bytes} 字节',
  'message.label': '任务内容',
  'message.placeholder': '描述要交给 Antigravity 的任务',
  'actions.dispatch': '派发',
  'actions.newIntent': '新意图（不重发旧任务）',
  'actions.cancel': '取消任务',
  'actions.refresh': '刷新状态',
  'actions.readReply': '读取回复',
  'state.idle': '空闲',
  'state.pending': '派发中',
  'state.accepted': '已受理',
  'state.acceptanceUnknown': '送达状态未确认，不会自动重发。请查看状态后再决定。',
  'state.busy': '运行中',
  'state.replied': '已有最终回复',
  'state.failed': '失败',
  'state.cancelled': '已取消',
  'state.notSent': '未发送',
  'state.unknown': '状态未知',
  'banner.noSession': '未识别当前会话，面板已停用。请刷新或重新打开会话。',
  'banner.noRemote': '本地服务未连接，当前只读展示，无法发送任务。',
  'banner.capabilitiesFailed': '无法读取后端状态，功能暂不可用。请刷新重试。',
  'banner.crossSession': '该任务属于其他会话，已禁止读写。请切回对应会话查看。',
  'reply.label': '最终回复',
  'reply.empty': '暂无最终回复',
  'reply.truncated': '回复较长，已在面板中折叠显示',
  'permission.title': 'Antigravity 正在等待你的许可',
  'permission.hint': '请在 Antigravity 窗口中处理；本面板不会自动批准权限。',
  'error.label': '操作未能完成。请重试，如仍失败请查看日志。',
  'limits.message': '任务内容不能超过 {limit} 个字符',
  'limits.paths': 'Host 路径附件最多 {limit} 个',
  'auth.label': 'Antigravity CLI 登录',
  'auth.login': '登录 Antigravity CLI',
  'auth.loggingIn': '正在发起登录…',
  'auth.refresh': '刷新登录状态',
  'auth.statusLoggedin': '已登录',
  'auth.statusUnauthenticated': '未登录',
  'auth.statusUnknown': '状态未知',
  'auth.statusChecking': '检查中…',
  'auth.unauthenticatedHint': '尚未登录。请点“登录 Antigravity CLI”完成授权。',
  'auth.terminalHint': '登录后这里仍可能显示未知。请点登录按钮在终端授权，完成后刷新。',
  'auth.privacy': '本面板不读取、上传或保存凭据，也不发送模型请求。登录由官方 CLI 在终端完成。',
  'auth.installHint': '尚未安装 CLI。请从 https://antigravity.google/download 安装后刷新。',
  'auth.notesSummary': '说明',
  'cli.title': 'Antigravity CLI 状态',
  'cli.availability': 'CLI 可用性',
  'cli.available': '可用',
  'cli.missing': '未安装',
  'cli.unusable': '不可用',
  'cli.version': '版本',
  'cli.executable': '可执行文件',
  'cli.dataDir': '数据目录',
  'cli.dataDirMissing': '未配置',
  'cli.writable': '可写',
  'cli.notWritable': '不可写',
  'cli.dataDirError': '数据目录不可写（{detail}），请检查权限。',
  'cli.loginState': '登录状态',
  'cli.statusUnknown': '未知（查不到）',
  'cli.statusLoggedin': '已登录',
  'cli.statusUnauthenticated': '未登录',
  'cli.unknownReason': '这里查不到登录状态，请在终端确认。',
  'cli.unknownReasonProtocol': '这里看不出你有没有登录，得在终端确认。',
  'cli.refresh': '刷新状态',
  'cli.openLogin': '打开登录终端',
  'cli.probeFailed': '暂时无法检测 CLI 状态，请稍后点刷新重试。',
  'cli.remoteUnavailable': '无法连接本地服务，暂不能检测 CLI 状态。请稍后重试。',
  'cli.unknownValue': '未知',
  'cli.notProbed': '尚未探测',
  'cli.reasonMissing': '本机没有可用的 agy CLI。请先安装后再刷新。',
  'cli.reasonDataDir': '数据目录未配置或不可写，查不到登录状态。请检查目录权限。',
  'cli.reasonProbeFailed': '状态检测失败，查不到登录状态。请点刷新重试。',
  'cli.reasonBridgeClosed': '连接已关闭，暂不能检测 CLI 状态。请刷新页面或重启服务。',
  'cli.unknownReasonCode': '原因代码：{code}',
  'cli.flowTerminal': '已在终端打开官方登录。完成授权后请点“刷新状态”。',
  'cli.flowAlreadyLoggedIn': '当前已登录，无需重新授权。',
  'cli.flowNone': '当前无法启动登录。请先安装 CLI 并配置可写的数据目录。',
  'cli.bridgeMessage': 'CLI 还返回了：{detail}',
  'cli.detailsSummary': '说明',
  'activity.title': 'Antigravity 活动流',
  'activity.readonly': '来自 Antigravity 的只读活动',
  'activity.empty': '本轮没有工具活动',
  'activity.error': '活动流读取失败',
  'activity.kind.execute': '执行',
  'activity.kind.edit': '编辑',
  'activity.kind.read': '读取',
  'activity.kind.other': '其它',
  'activity.kind.unknown': '未知',
  'thought.summary': '思考概况',
  'session.label': '当前会话',
};

const en = {
  'title': 'Antigravity task',
  'panel.expand': 'Expand Antigravity panel',
  'panel.collapse': 'Collapse Antigravity panel',
  'panel.collapsedHint': 'Collapsed; the composer stays as it was',
  'transport.label': 'Channel',
  'transport.acp': 'ACP (default)',
  'transport.desktop': 'Desktop (fallback, explicit only)',
  'transport.desktopUnavailable': 'Desktop fallback is unavailable',
  'model.label': 'Model',
  'model.auto': 'Follow the session setting',
  'model.unsupported': 'This backend cannot select a model',
  'effort.label': 'Thinking effort',
  'effort.auto': 'Follow the session setting',
  'effort.unsupported': 'This backend cannot select a thinking effort',
  'attachments.label': 'Host path references',
  'attachments.placeholder': 'Absolute path, e.g. D:\\work\\spec.md',
  'attachments.add': 'Add path',
  'attachments.remove': 'Remove',
  'attachments.pathOnly': 'Only path references are sent; the panel never reads file contents',
  'attachments.unsupported': 'This backend does not accept host path references',
  'attachments.filesLabel': 'File attachments (DSH session upload)',
  'attachments.choose': 'Choose files',
  'attachments.uploading': 'Uploading…',
  'attachments.uploadFailed': 'Upload failed; nothing was dispatched',
  'attachments.fileUnsupported': 'No DSH upload service in this session; use host path references instead',
  'attachments.bytes': '{bytes} bytes',
  'message.label': 'Task',
  'message.placeholder': 'Describe the task for Antigravity',
  'actions.dispatch': 'Dispatch',
  'actions.newIntent': 'New intent (do not resend)',
  'actions.cancel': 'Cancel task',
  'actions.refresh': 'Refresh status',
  'actions.readReply': 'Read reply',
  'state.idle': 'Idle',
  'state.pending': 'Dispatching',
  'state.accepted': 'Accepted',
  'state.acceptanceUnknown': 'Delivery unconfirmed; won\'t resend automatically. Check status before retrying.',
  'state.busy': 'Running',
  'state.replied': 'Final reply available',
  'state.failed': 'Failed',
  'state.cancelled': 'Cancelled',
  'state.notSent': 'Not sent',
  'state.unknown': 'Unknown state',
  'banner.noSession': 'Current session couldn\'t be identified; panel disabled. Reload or reopen the session.',
  'banner.noRemote': 'Local service disconnected. Read-only view; tasks can\'t be sent.',
  'banner.capabilitiesFailed': 'Couldn\'t load backend status; features are temporarily unavailable. Refresh to retry.',
  'banner.crossSession': 'This task belongs to another session and is locked here. Switch to that session to view it.',
  'reply.label': 'Final reply',
  'reply.empty': 'No final reply yet',
  'reply.truncated': 'The reply is long and is collapsed in the panel',
  'permission.title': 'Antigravity is waiting for your permission',
  'permission.hint': 'Resolve it in the Antigravity window; this panel never auto-approves permissions.',
  'error.label': 'Something went wrong. Please retry, or check the logs if the issue persists.',
  'limits.message': 'The task must stay under {limit} characters',
  'limits.paths': 'At most {limit} host path attachments',
  'auth.label': 'Antigravity CLI sign-in',
  'auth.login': 'Sign in to Antigravity CLI',
  'auth.loggingIn': 'Starting sign-in…',
  'auth.refresh': 'Refresh sign-in status',
  'auth.statusLoggedin': 'Signed in',
  'auth.statusUnauthenticated': 'Not signed in',
  'auth.statusUnknown': 'Status unknown',
  'auth.statusChecking': 'Checking…',
  'auth.unauthenticatedHint': 'Not signed in. Click "Sign in to Antigravity CLI" to authorize.',
  'auth.terminalHint': 'Status may still show unknown after sign-in. Click Sign in to authorize in the terminal, then refresh.',
  'auth.privacy': 'This panel never reads, uploads, or stores credentials, and sends no model requests. Sign-in is handled by the official CLI in your terminal.',
  'auth.installHint': 'CLI not installed. Download it from https://antigravity.google/download, then refresh.',
  'auth.notesSummary': 'Notes',
  'cli.title': 'Antigravity CLI status',
  'cli.availability': 'CLI availability',
  'cli.available': 'Available',
  'cli.missing': 'Missing',
  'cli.unusable': 'Unusable',
  'cli.version': 'Version',
  'cli.executable': 'Executable',
  'cli.dataDir': 'Data directory',
  'cli.dataDirMissing': 'Not configured',
  'cli.writable': 'Writable',
  'cli.notWritable': 'Not writable',
  'cli.dataDirError': 'Data directory is not writable ({detail}). Check path permissions.',
  'cli.loginState': 'Sign-in state',
  'cli.statusUnknown': 'Unknown (unavailable)',
  'cli.statusLoggedin': 'Signed in',
  'cli.statusUnauthenticated': 'Not signed in',
  'cli.unknownReason': 'Sign-in status can\'t be checked here. Please verify it in your terminal.',
  'cli.unknownReasonProtocol': 'Can\'t tell whether you\'re signed in from here. Check it in the terminal.',
  'cli.refresh': 'Refresh status',
  'cli.openLogin': 'Open login terminal',
  'cli.probeFailed': 'Couldn\'t check CLI status. Click Refresh to try again.',
  'cli.remoteUnavailable': 'Local service unavailable; CLI status can\'t be checked right now. Please try again later.',
  'cli.unknownValue': 'unknown',
  'cli.notProbed': 'Not probed',
  'cli.reasonMissing': 'No usable Antigravity CLI found. Install it first, then refresh.',
  'cli.reasonDataDir': 'Data directory is missing or not writable, so sign-in status can\'t be checked. Check its path and permissions.',
  'cli.reasonProbeFailed': 'Status check failed, so sign-in status is unavailable. Click Refresh to retry.',
  'cli.reasonBridgeClosed': 'Connection is closed; CLI status can\'t be checked. Reload the page or restart the service.',
  'cli.unknownReasonCode': 'Reason code: {code}',
  'cli.flowTerminal': 'Official sign-in opened in your terminal. Click "Refresh status" once done.',
  'cli.flowAlreadyLoggedIn': 'Already signed in; no need to authorize again.',
  'cli.flowNone': 'Can\'t start sign-in yet. Install the CLI and set a writable data directory first.',
  'cli.bridgeMessage': 'The CLI also returned: {detail}',
  'cli.detailsSummary': 'Notes',
  'activity.title': 'Antigravity activity',
  'activity.readonly': 'Read-only activity reported by Antigravity',
  'activity.empty': 'No tool activity in this turn',
  'activity.error': 'Could not read activity',
  'activity.kind.execute': 'Execute',
  'activity.kind.edit': 'Edit',
  'activity.kind.read': 'Read',
  'activity.kind.other': 'Other',
  'activity.kind.unknown': 'Unknown',
  'thought.summary': 'Thinking summary',
  'session.label': 'Current session',
};

const DICTIONARIES = Object.freeze({ zh, en });
const LOCALE_KEYS = Object.freeze(Object.keys(zh));

const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g;

/** Minimal translator that also works outside the DSH runtime (tests, stories). */
function createTranslator(dictionaries = DICTIONARIES, locale = 'zh') {
  const primary = dictionaries[locale] || dictionaries.en;
  return function translate(key, params) {
    const template = primary[key] ?? (dictionaries.en && dictionaries.en[key]) ?? key;
    if (!params) return template;
    return template.replace(PLACEHOLDER, (match, name) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
    );
  };
}

/**
 * Register the namespace as an owned effect. `ctx.locale.register(ns, { zh, en })`
 * requires both baseline dictionaries; the returned disposer is handled by the
 * caller's effect (see client/index.js).
 */
function registerLocale(ctx) {
  if (!ctx || !ctx.locale || typeof ctx.locale.register !== 'function') {
    return null;
  }
  return ctx.locale.register(PANEL_NAMESPACE, { zh, en });
}

function bindTranslator(ctx) {
  if (ctx && ctx.locale && typeof ctx.locale.bind === 'function') {
    return ctx.locale.bind(PANEL_NAMESPACE);
  }
  return createTranslator();
}        return { PANEL_NAMESPACE, DICTIONARIES, LOCALE_KEYS, createTranslator, registerLocale, bindTranslator };
      })();
      var panelApi = (function () {
/**
 * Panel logic for the Antigravity bridge (staging).
 *
 * Split in two so both halves can be reasoned about (and tested) without a browser:
 *   createPanelController(...)  plain state machine: one click -> one dispatch, status
 *                               polling that stops on session change / close, explicit
 *                               capability gating, no text ever leaves except message.
 *   createPanelComponent(...)   thin React view (call with the host's `require('react')`)
 *                               mounted for the selected Session in the sidebar page.
 *
 * The panel is a *client* of the local bridge. It never talks to a model upstream;
 * DSH supplies the Agent scope for bridge calls.
 */

var createTranslator = localeApi.createTranslator;

const PANEL_SLOT = 'sidebar.panellist';
const PANEL_ID = 'antigravity-bridge';
const PANEL_ORDER = 31;
const DEFAULT_POLL_MS = 1500;
const NATIVE_POLL_MS = 2500;
const NATIVE_HIDDEN_POLL_MS = 10000;
const MAX_PATH_REFS = 8;
const MAX_MESSAGE_CHARS = 100000;

const HOST_TO_PHASE = {
  pending: 'pending',
  accepted: 'accepted',
  acceptance_unknown: 'acceptance_unknown',
  replied: 'replied',
  failed: 'failed',
  cancelled: 'cancelled',
  not_sent: 'not_sent',
  busy: 'busy',
};

const TERMINAL_PHASES = new Set(['replied', 'failed', 'cancelled', 'not_sent']);

function readErrorCode(error) {
  if (error && typeof error.code === 'string' && error.code !== '') return error.code;
  if (error && error.data && typeof error.data.code === 'string') return error.data.code;
  return 'request_failed';
}

function createUnavailableBridge(reason = 'remote_unavailable') {
  const reject = async () => {
    const error = new Error(reason);
    error.code = reason;
    throw error;
  };
  return {
    available: false,
    reason,
    capabilities: reject,
    dispatch: reject,
    status: reject,
    reply: reject,
    cancel: reject,
    activity: reject,
    nativeActivity: reject,
    authStatus: reject,
    login: reject,
  };
}

/**
 * Resolve one mounted Remote namespace.
 *
 * The Gateway registers every mounted namespace as its own Cordis service
 * (`remote.<namespace>`); it is also reachable as `remote[namespace]` on plain
 * objects. Resolution is retried on every call because `$mount` is asynchronous:
 * the panel may render before the namespace fiber has started.
 */
function resolveNamespace(source, namespace) {
  if (!source) return null;
  try {
    // A Cordis Context throws on un-injected property reads. Only plain
    // fixtures use the direct shape; resolve service access from the caller.
    const service = typeof source.get === 'function'
      ? source.get(`remote.${namespace}`)
      : source[namespace];
    return service && typeof service.dispatch === 'function' ? service : null;
  } catch {
    return null;
  }
}

/**
 * Pick the context a Remote call must be read through.
 *
 * Identity on the Host comes from the *access site*: Cordis hands out traceable
 * service proxies whose `ctx` is the context that read them, and the Gateway client
 * derives the caller identity from exactly that context. Reading
 * `remote.<namespace>` from the plugin root therefore produces a submission without
 * an agent (`expected 2 argument(s), got 1`); reading it from the session-scoped
 * context produces one request with the right agent id.
 *
 * `session` is only a selector for that context - it is never sent as an RPC
 * argument. Without a `sessions` service (plain-object test doubles) the source is
 * used as-is; with one, a missing scope rejects instead of silently falling back to
 * the root context.
 */
function resolveHolder(source, session) {
  if (!source) return null;
  if (typeof session !== 'string' || session === '') return source;
  if (typeof source.get !== 'function') return source;
  let sessions = null;
  try {
    sessions = source.get('sessions');
  } catch {
    sessions = null;
  }
  if (!sessions || typeof sessions.scope !== 'function') return source;
  const scoped = sessions.scope(session);
  if (!scoped) {
    const error = new Error('scope_unavailable');
    error.code = 'scope_unavailable';
    throw error;
  }
  return scoped;
}

/**
 * Recognize the Client Gateway's RemoteResult envelope.
 *
 * A real Gateway call resolves to `{ ok: true, value }` on success and
 * `{ ok: false, error }` on failure, while the Host's own business results also
 * use `ok`. The envelope is therefore identified structurally: the success form
 * is exactly the two-key object `{ ok, value }`, and the failure form carries an
 * `Error`.
 */
function isRemoteEnvelope(result) {
  if (!result || typeof result !== 'object' || result.ok !== true) return false;
  const keys = Object.keys(result);
  return keys.length === 2 && keys.includes('value');
}

/**
 * Unwrap the Gateway envelope at the single Remote entry point.
 *
 * The controller speaks the Host contract (`{ ok, status, jobId, ... }`), not the
 * transport contract. Unwrapping `value` keeps the inner business `ok`/`status`
 * intact, and an outer Remote failure (for example `cross_session_denied`, or
 * `gateway/cancelled`) becomes a thrown Error whose `code` the controller already
 * surfaces as the job error.
 */
function decodeRemoteResult(result) {
  if (result && typeof result === 'object' && result.ok === false && result.error instanceof Error) {
    const error = result.error;
    if (typeof error.code !== 'string' || error.code === '') error.code = 'remote_failure';
    throw error;
  }
  return isRemoteEnvelope(result) ? result.value : result;
}

/**
 * Wrap a mounted remote namespace (`remote.<namespace>` service, or `ctx`) in the
 * flat port the controller consumes. The namespace - and the context it is read
 * through - is resolved on every call: `$mount` is asynchronous, a session scope may
 * not exist yet, and a cached proxy would pin the identity of whichever context read
 * it first. A call made before the mount settled rejects with `remote_unavailable`
 * instead of doing nothing silently.
 */
function createRemoteBridge(source, namespace = 'antigravityBridge') {
  const unavailable = createUnavailableBridge();
  const invoke = (name, args, options) => {
    try {
      const holder = resolveHolder(source, options && options.session);
      const ns = resolveNamespace(holder, namespace);
      if (!ns) return unavailable[name]();
      return Promise.resolve(ns[name](...args)).then(decodeRemoteResult);
    } catch (error) {
      return Promise.reject(error);
    }
  };
  return {
    get available() {
      return resolveNamespace(source, namespace) !== null;
    },
    capabilities: (options) => invoke('capabilities', [], options),
    dispatch: (payload, options) => invoke('dispatch', [payload], options),
    status: (jobId, options) => invoke('status', [{ jobId }], options),
    reply: (jobId, options) => invoke('reply', [{ jobId }], options),
    cancel: (jobId, options) => invoke('cancel', [{ jobId }], options),
    activity: (jobId, options) => invoke('activity', [{ jobId }], options),
    nativeActivity: (sessionId, options) => invoke('nativeActivity', [{ sessionId }], options),
    authStatus: (options) => invoke('authStatus', [], options),
    login: (options) => invoke('login', [], options),
  };
}

function isAbsoluteHostPath(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text === '' || text.includes('\u0000')) return false;
  return /^[a-zA-Z]:[\\/]/.test(text) || text.startsWith('\\\\');
}

function createPanelController(options = {}) {
  const {
    bridge,
    sessionId = null,
    pollMs = DEFAULT_POLL_MS,
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (handle) => clearTimeout(handle),
    limits = {},
    uploader = null,
    getUploader = () => uploader,
  } = options;
  if (!bridge) throw new TypeError('createPanelController requires a bridge port');
  const maxPathRefs = limits.maxPathRefs ?? MAX_PATH_REFS;
  const maxMessageChars = limits.maxMessageChars ?? MAX_MESSAGE_CHARS;
  const maxFiles = limits.maxFiles ?? 10;

  const listeners = new Set();
  let boundSession = sessionId || null;
  let inFlight = null;
  let inFlightGeneration = -1;
  let timer = null;
  let timerGeneration = -1;
  let timerJobId = null;
  let nativeTimer = null;
  let nativeTimerGeneration = -1;
  let nativeTimerSessionId = null;
  let disposed = false;
  let requestSeq = 0;
  /**
   * Bumped on every session change. Asynchronous work captures it before an await
   * and drops its result when the value moved, so a reply that belongs to the old
   * conversation can never be rendered inside the new one.
   */
  let sessionGeneration = 0;

  let state = {
    collapsed: false,
    sessionId: boundSession,
    sessionReady: Boolean(boundSession),
    bridgeAvailable: bridge.available !== false,
    capabilities: null,
    capabilitiesError: null,
    transport: 'acp',
    model: '',
    effort: '',
    pathRefs: [],
    files: [],
    uploading: false,
    message: '',
    busy: false,
    phase: 'idle',
    intentId: null,
    intentRequest: null,
    jobId: null,
    view: null,
    replyText: null,
    replyAvailable: false,
    activityJobId: '',
    activitySource: 'none',
    activityTruncated: false,
    activityEvents: [],
    activityPhase: 'idle',
    activityError: '',
    thoughts: [],
    thoughtSummaryEnabled: true,
    error: null,
    notice: null,
    cliAuthStatus: 'unknown',
    cliInstallation: 'unknown',
    cliExecutable: '',
    cliVersion: '',
    cliAuthMessage: null,
    cliAuthFlow: null,
  };

  function snapshot() {
    return Object.freeze({
      ...state,
      pathRefs: Object.freeze([...state.pathRefs]),
      files: Object.freeze(state.files.map((entry) => Object.freeze({ ...entry }))),
      activityEvents: Object.freeze(state.activityEvents.map((entry) => Object.freeze({ ...entry }))),
      thoughts: Object.freeze(state.thoughts.map((entry) => Object.freeze({ ...entry }))),
      capabilities: state.capabilities ? Object.freeze({ ...state.capabilities }) : null,
    });
  }

  function emit() {
    const view = snapshot();
    for (const listener of listeners) listener(view);
  }

  function patch(next) {
    state = { ...state, ...next };
    emit();
  }

  function bridgeUp() {
    return !disposed && bridge.available !== false;
  }

  /**
   * Clear the polling timer. When `expect` is given the timer is only cleared if it
   * still belongs to that generation/job: a late reply for conversation A must not
   * cancel the timer that keeps conversation B reading its own final answer.
   */
  function stopPoll(expect) {
    if (timer === null) return;
    if (expect && (expect.generation !== timerGeneration || expect.jobId !== timerJobId)) return;
    clearTimer(timer);
    timer = null;
    timerGeneration = -1;
    timerJobId = null;
  }

  function schedulePoll() {
    stopPoll();
    if (disposed || state.collapsed || !state.jobId || !state.sessionReady) return;
    if (TERMINAL_PHASES.has(state.phase)) return;
    if (!bridgeUp()) return;
    const jobAtSchedule = state.jobId;
    const generationAtSchedule = sessionGeneration;
    timerGeneration = generationAtSchedule;
    timerJobId = jobAtSchedule;
    timer = setTimer(() => {
      timer = null;
      timerGeneration = -1;
      timerJobId = null;
      if (disposed || state.collapsed) return;
      if (sessionGeneration !== generationAtSchedule) return;
      if (state.jobId !== jobAtSchedule) return;
      void tick();
    }, pollMs);
  }

  function stopNativePoll(expect) {
    if (nativeTimer === null) return;
    if (expect && (expect.generation !== nativeTimerGeneration || expect.sessionId !== nativeTimerSessionId)) return;
    clearTimer(nativeTimer);
    nativeTimer = null;
    nativeTimerGeneration = -1;
    nativeTimerSessionId = null;
  }

  function isPageHidden() {
    return typeof document !== 'undefined' && document !== null && document.hidden === true;
  }

  // Known limitation: native ACP session activity relies on local single-shot polling
  // (NATIVE_POLL_MS = 2500ms, or NATIVE_HIDDEN_POLL_MS = 10000ms when document.hidden === true),
  // rather than ACP server push.
  function scheduleNativePoll() {
    stopNativePoll();
    if (disposed || state.collapsed || state.jobId || !state.sessionReady || !state.sessionId) return;
    if (!bridgeUp() || typeof bridge.nativeActivity !== 'function') return;
    const sessionAtSchedule = state.sessionId;
    const generationAtSchedule = sessionGeneration;
    const delay = isPageHidden() ? NATIVE_HIDDEN_POLL_MS : NATIVE_POLL_MS;
    nativeTimerGeneration = generationAtSchedule;
    nativeTimerSessionId = sessionAtSchedule;
    nativeTimer = setTimer(() => {
      nativeTimer = null;
      nativeTimerGeneration = -1;
      nativeTimerSessionId = null;
      if (disposed || state.collapsed || state.jobId || !state.sessionReady) return;
      if (sessionGeneration !== generationAtSchedule || state.sessionId !== sessionAtSchedule) return;
      void nativeTick(generationAtSchedule, sessionAtSchedule);
    }, delay);
  }

  async function nativeTick(generation, session) {
    await fetchNativeActivity(generation, session);
    if (disposed || state.collapsed || state.jobId || !state.sessionReady) return;
    if (generation !== sessionGeneration || state.sessionId !== session) return;
    scheduleNativePoll();
  }

  async function tick() {
    if (disposed || !state.jobId) return;
    const generation = sessionGeneration;
    const jobId = state.jobId;
    const session = state.sessionId;
    try {
      const result = await bridge.status(jobId, { session });
      if (disposed || generation !== sessionGeneration || state.jobId !== jobId) return;
      const view = result && result.view ? result.view : null;
      if (result && result.ok === false) {
        // A business failure is not a state update: keep the error code and the
        // last readable view, and keep observing only when the job can still move.
        patch({
          view: view || state.view,
          error: result.code || 'status_failed',
          notice: result.message || 'status_failed',
        });
        if (view && TERMINAL_PHASES.has(HOST_TO_PHASE[view.state] || 'unknown')) stopPoll();
        else schedulePoll();
        return;
      }
      const hostState = view && view.state ? view.state : 'accepted';
      const terminal = TERMINAL_PHASES.has(HOST_TO_PHASE[hostState] || 'unknown');
      const actualCancel = Boolean(view && view.stopReason === 'cancelled');
      const detailPhase =
        !terminal && view && view.detail && view.detail.phase === 'permission' ? 'permission' : null;
      const phase = actualCancel
        ? 'cancelled'
        : detailPhase || HOST_TO_PHASE[hostState] || 'unknown';
      patch({
        view,
        phase,
        error: terminal && !actualCancel && view && view.code ? view.code : null,
        notice: result && result.warning ? result.warning : null,
      });
      void fetchActivity(generation, jobId);
      if (phase === 'replied') {
        await fetchReply(generation, jobId);
        if (disposed || generation !== sessionGeneration || state.jobId !== jobId) return;
        stopPoll({ generation, jobId });
        return;
      }
      if (TERMINAL_PHASES.has(phase)) {
        stopPoll();
        return;
      }
      schedulePoll();
    } catch (error) {
      if (disposed || generation !== sessionGeneration || state.jobId !== jobId) return;
      patch({ error: readErrorCode(error), notice: 'status_unavailable' });
      schedulePoll();
    }
  }

  async function fetchReply(generation = sessionGeneration, jobId = state.jobId) {
    if (!jobId) return;
    const session = state.sessionId;
    try {
      const result = await bridge.reply(jobId, { session });
      if (disposed || generation !== sessionGeneration || state.jobId !== jobId) return;
      patch({
        replyAvailable: Boolean(result && result.available),
        replyText: result && result.available ? result.text : null,
        notice: result && result.warning ? result.warning : null,
      });
    } catch (error) {
      if (disposed || generation !== sessionGeneration || state.jobId !== jobId) return;
      patch({ error: readErrorCode(error) });
    }
  }

  async function fetchActivity(generation = sessionGeneration, jobId = state.jobId) {
    if (!jobId || disposed || typeof bridge.activity !== 'function') return;
    const session = state.sessionId;
    if (state.activityJobId !== jobId) {
      patch({
        activityJobId: jobId,
        activitySource: 'job',
        activityTruncated: false,
        activityEvents: [],
        thoughts: [],
        activityPhase: 'checking',
        activityError: '',
      });
    }
    try {
      const result = await bridge.activity(jobId, { session });
      if (disposed || generation !== sessionGeneration || state.jobId !== jobId) return;
      if (result && result.ok === false) {
        patch({
          activityJobId: jobId,
          activitySource: 'job',
          activityTruncated: false,
          activityEvents: [],
          thoughts: [],
          activityPhase: 'error',
          activityError: result.message || result.code || 'activity_failed',
        });
        return;
      }
      const events = Array.isArray(result && result.events)
        ? result.events.map((ev) => ({
            toolCallId: String(ev && ev.toolCallId !== undefined ? ev.toolCallId : ''),
            kind: ['execute', 'edit', 'read', 'other'].includes(ev && ev.kind) ? ev.kind : 'unknown',
            title: String(ev && ev.title !== undefined ? ev.title : ''),
            status: String(ev && ev.status !== undefined ? ev.status : ''),
          }))
        : [];
      const thoughts = Array.isArray(result && result.thoughts)
        ? result.thoughts.map((it) => ({ text: String(it && it.text !== undefined ? it.text : '') }))
        : [];
      const thoughtSummaryEnabled = result && typeof result.thoughtSummaryEnabled === 'boolean'
        ? result.thoughtSummaryEnabled
        : true;
      patch({
        activityJobId: jobId,
        activitySource: 'job',
        activityTruncated: false,
        activityEvents: events,
        activityPhase: 'ready',
        activityError: '',
        thoughts,
        thoughtSummaryEnabled,
      });
    } catch (error) {
      if (disposed || generation !== sessionGeneration || state.jobId !== jobId) return;
      patch({
        activityJobId: jobId,
        activitySource: 'job',
        activityTruncated: false,
        activityEvents: [],
        thoughts: [],
        activityPhase: 'error',
        activityError: (error && error.message) || readErrorCode(error),
      });
    }
  }

  async function fetchNativeActivity(generation = sessionGeneration, session = state.sessionId) {
    if (disposed || !session || state.jobId || typeof bridge.nativeActivity !== 'function') return;
    try {
      const result = await bridge.nativeActivity(session, { session });
      if (disposed || generation !== sessionGeneration || state.jobId || state.sessionId !== session) return;
      if (result && result.ok === false) {
        patch({
          activityJobId: '',
          activitySource: 'session',
          activityTruncated: false,
          activityPhase: 'error',
          activityError: result.message || result.code || 'activity_failed',
        });
        return;
      }
      const events = Array.isArray(result && result.events)
        ? result.events.map((ev) => ({
            toolCallId: String(ev && ev.toolCallId !== undefined ? ev.toolCallId : ''),
            kind: ['execute', 'edit', 'read', 'other'].includes(ev && ev.kind) ? ev.kind : 'unknown',
            title: String(ev && ev.title !== undefined ? ev.title : ''),
            status: String(ev && ev.status !== undefined ? ev.status : ''),
          }))
        : [];
      const thoughts = Array.isArray(result && result.thoughts)
        ? result.thoughts.map((it) => ({ text: String(it && it.text !== undefined ? it.text : '') }))
        : [];
      const thoughtSummaryEnabled = result && typeof result.thoughtSummaryEnabled === 'boolean'
        ? result.thoughtSummaryEnabled
        : true;
      patch({
        activityJobId: '',
        activitySource: 'session',
        activityTruncated: Boolean(result && result.truncated),
        activityEvents: events,
        activityPhase: events.length > 0 || thoughts.length > 0 ? 'ready' : 'idle',
        activityError: '',
        thoughts,
        thoughtSummaryEnabled,
      });
    } catch (error) {
      if (disposed || generation !== sessionGeneration || state.jobId || state.sessionId !== session) return;
      patch({
        activityJobId: '',
        activitySource: 'session',
        activityTruncated: false,
        activityPhase: 'error',
        activityError: (error && error.message) || readErrorCode(error),
      });
    }
  }

  async function refreshCapabilities() {
    const available = bridgeUp();
    if (!available) {
      patch({ bridgeAvailable: false, capabilitiesError: 'remote_unavailable' });
      return null;
    }
    if (!state.sessionReady) {
      patch({ capabilities: null, capabilitiesError: null });
      return null;
    }
    const generation = sessionGeneration;
    const session = state.sessionId;
    try {
      const result = await bridge.capabilities({ session });
      // A late answer for the previous conversation must not overwrite the
      // options of the conversation the user is looking at now.
      if (disposed || generation !== sessionGeneration || state.sessionId !== session) return null;
      const capabilities = result && result.capabilities ? result.capabilities : null;
      const transports = capabilities && Array.isArray(capabilities.transports) ? capabilities.transports : [];
      const transport = transports.includes(state.transport) ? state.transport : transports[0] || 'acp';
      patch({ capabilities, capabilitiesError: null, transport, bridgeAvailable: true });
      if (!state.jobId && session) {
        void fetchNativeActivity(generation, session);
        scheduleNativePoll();
      }
      return capabilities;
    } catch (error) {
      if (disposed || generation !== sessionGeneration || state.sessionId !== session) return null;
      patch({ capabilitiesError: readErrorCode(error), capabilities: null, bridgeAvailable: bridgeUp() });
      return null;
    }
  }

  function freezeRequest(payload) {
    return Object.freeze({
      ...payload,
      pathRefs: Object.freeze([...payload.pathRefs]),
      attachments: Object.freeze([...payload.attachments]),
    });
  }

  function dispatch() {
    // Only a submission for the *same* generation may share the in-flight promise.
    // A submission for the new conversation must start on its own so it can receive
    // its own job id instead of the previous conversation's.
    if (inFlight && inFlightGeneration === sessionGeneration) return inFlight;
    if (disposed) return Promise.resolve({ ok: false, code: 'disposed' });
    if (!state.sessionReady) {
      patch({ error: 'session_unknown' });
      return Promise.resolve({ ok: false, code: 'session_unknown' });
    }
    if (state.busy) return Promise.resolve({ ok: false, code: 'busy' });
    if (state.uploading) return Promise.resolve({ ok: false, code: 'upload_pending' });
    if (state.message.trim() === '') {
      patch({ error: 'bad_request', notice: 'empty_message' });
      return Promise.resolve({ ok: false, code: 'bad_request' });
    }
    if (state.message.length > maxMessageChars) {
      patch({ error: 'message_too_long', notice: 'message_too_long' });
      return Promise.resolve({ ok: false, code: 'message_too_long' });
    }
    if (!bridgeUp()) {
      patch({ bridgeAvailable: false, error: 'remote_unavailable' });
      return Promise.resolve({ ok: false, code: 'remote_unavailable' });
    }

    // The intent id survives an ambiguous acceptance: pressing Dispatch again
    // observes the same Host job instead of producing a second prompt. A new
    // intent is a separate, explicit user action (newIntent()).
    const requestId = state.intentId || `crid_${now().toString(36)}_${++requestSeq}`;
    const generation = sessionGeneration;
    const sessionAtDispatch = state.sessionId;
    // Once an intent exists its request snapshot is immutable: retrying the
    // same intent (including after a lost acknowledgement) must not turn edited
    // local fields into a different request. Only newIntent() starts over.
    const payload =
      state.intentId && state.intentRequest
        ? state.intentRequest
        : freezeRequest({
            clientRequestId: requestId,
            message: state.message,
            transport: state.transport,
            model: state.model || null,
            effort: state.effort || null,
            pathRefs: [...state.pathRefs],
            attachments: state.files.map((entry) => entry.receiptId),
          });
    patch({
      busy: true,
      intentId: requestId,
      intentRequest: payload,
      error: null,
      notice: requestId === state.intentId && state.phase === 'acceptance_unknown' ? 'intent_kept' : null,
      phase: 'pending',
      replyText: null,
      replyAvailable: false,
    });

    inFlightGeneration = generation;
    inFlight = (async () => {
      const stillCurrent = () =>
        !disposed && generation === sessionGeneration && state.sessionId === sessionAtDispatch;
      try {
        const result = await bridge.dispatch(payload, { session: sessionAtDispatch });
        if (!stillCurrent()) {
          // The user moved to another conversation while this dispatch was in
          // flight. The job stays owned by the original session on the Host; the new
          // conversation must not adopt its id or its reply.
          return { ok: false, code: 'stale_session' };
        }
        if (!result || result.ok !== true) {
          const code = (result && result.code) || 'not_sent';
          const notSent = Boolean(result && result.status === 'not_sent');
          patch({
            busy: false,
            phase: notSent ? 'not_sent' : 'unknown',
            intentId: notSent ? null : requestId,
            intentRequest: notSent ? null : payload,
            jobId: (result && result.jobId) || null,
            error: code,
          });
          return { ok: false, code, jobId: (result && result.jobId) || null };
        }
        const phase = HOST_TO_PHASE[result.status] || 'accepted';
        // Only an explicit new intent may change the request identity. In
        // particular reused/accepted/acceptance_unknown must keep the same id, or
        // a transport retry would silently become a second prompt. The uploaded
        // receipts are still cleared once the Host accepted this dispatch; a
        // retry for a not-sent job keeps them for the same deliberate retry.
        const keepIntent = result.status !== 'not_sent';
        const nextJobId = result.jobId || null;
        const resetActivity = Boolean(nextJobId && state.activityJobId !== nextJobId);
        patch({
          busy: false,
          intentId: keepIntent ? requestId : null,
          intentRequest: keepIntent ? payload : null,
          jobId: nextJobId,
          phase,
          view: result.view || null,
          files: result.status === 'not_sent' ? state.files : [],
          ...(resetActivity
            ? {
                activityJobId: nextJobId,
                activitySource: 'job',
                activityTruncated: false,
                activityEvents: [],
                thoughts: [],
                activityPhase: 'idle',
                activityError: '',
              }
            : {}),
        });
        if (result.jobId) {
          stopNativePoll();
          schedulePoll();
        }
        return { ok: true, jobId: result.jobId, phase };
      } catch (error) {
        if (!stillCurrent()) return { ok: false, code: 'stale_session' };
        const code = readErrorCode(error);
        patch({ busy: false, error: code, phase: code === 'not_sent' ? 'not_sent' : 'acceptance_unknown' });
        return { ok: false, code };
      } finally {
        // A late finish for the previous generation must not clear the submission
        // that the new conversation already started.
        if (inFlightGeneration === generation) {
          inFlight = null;
          inFlightGeneration = -1;
        }
      }
    })();
    return inFlight;
  }

  function cancel() {
    if (!state.jobId || !bridgeUp()) return Promise.resolve({ ok: false, code: 'no_job' });
    const generation = sessionGeneration;
    const jobId = state.jobId;
    const session = state.sessionId;
    return (async () => {
      try {
        const result = await bridge.cancel(jobId, { session });
        if (disposed || generation !== sessionGeneration || state.jobId !== jobId) {
          return { ok: false, code: 'stale_session' };
        }
        if (result && result.ok === false) {
          patch({ error: result.code || 'cancel_failed', view: result.view || state.view });
          return { ok: false, code: result.code || 'cancel_failed' };
        }
        const view = result && result.view ? result.view : null;
        const hostState = view && view.state ? view.state : '';
        const actualCancel = Boolean(view && view.stopReason === 'cancelled');
        if (actualCancel) {
          stopPoll({ generation, jobId });
          patch({ view, phase: 'cancelled', notice: 'cancelled', error: null });
          return { ok: true, phase: 'cancelled' };
        }
        if (hostState === 'replied') {
          patch({ view, phase: 'replied', notice: 'cancel_already_replied' });
          await fetchReply(generation, jobId);
          // The reply fetch can outlive the conversation. Re-check both the
          // generation and the job before touching the timer: a slow reply for A
          // must not stop the poll that belongs to B. The scoped stopPoll is a
          // second guard in case the timer was replaced while awaiting.
          if (disposed || generation !== sessionGeneration || state.jobId !== jobId) {
            return { ok: false, code: 'stale_session' };
          }
          stopPoll({ generation, jobId });
          return { ok: true, phase: 'replied' };
        }
        if (hostState === 'failed' || hostState === 'not_sent') {
          stopPoll({ generation, jobId });
          patch({
            view,
            phase: HOST_TO_PHASE[hostState] || 'failed',
            error: view && view.code ? view.code : 'cancel_failed',
          });
          return { ok: true, phase: hostState };
        }
        // session/cancel was accepted but the prompt has not settled yet. Keep the
        // job id and polling: only the actual cancelled stopReason may render the
        // cancelled state.
        patch({ view, phase: HOST_TO_PHASE[hostState] || 'accepted', notice: 'cancel_pending' });
        schedulePoll();
        return { ok: true, phase: 'cancel_pending' };
      } catch (error) {
        if (disposed || generation !== sessionGeneration || state.jobId !== jobId) {
          return { ok: false, code: 'stale_session' };
        }
        const code = readErrorCode(error);
        patch({ error: code });
        return { ok: false, code };
      }
    })();
  }

  function setSession(next) {
    const value = next || null;
    if (value === boundSession) return false;
    boundSession = value;
    // Invalidate every in-flight read/dispatch started for the previous session.
    sessionGeneration += 1;
    stopPoll();
    stopNativePoll();
    patch({
      sessionId: value,
      sessionReady: Boolean(value),
      // Inputs and pickers belong to the conversation. Clearing them is
      // deliberate: no draft cache is kept, so the first submission in the new
      // conversation can never carry the previous conversation's text, paths,
      // transport, model or effort.
      message: '',
      pathRefs: [],
      files: [],
      uploading: false,
      transport: 'acp',
      model: '',
      effort: '',
      capabilities: null,
      capabilitiesError: null,
      bridgeAvailable: bridge.available !== false,
      jobId: null,
      view: null,
      phase: 'idle',
      intentId: null,
      intentRequest: null,
      busy: false,
      replyText: null,
      replyAvailable: false,
      activityJobId: '',
      activitySource: 'none',
      activityTruncated: false,
      activityEvents: [],
      activityPhase: 'idle',
      activityError: '',
      thoughts: [],
      thoughtSummaryEnabled: true,
      error: null,
      notice: null,
      cliAuthStatus: 'unknown',
      cliAuthMessage: null,
      cliAuthFlow: null,
    });
    if (value && !state.collapsed) scheduleNativePoll();
    return true;
  }

  function setCollapsed(collapsed) {
    if (state.collapsed === collapsed) return;
    if (collapsed) {
      stopPoll();
      stopNativePoll();
    }
    patch({ collapsed });
    if (!collapsed) {
      schedulePoll();
      scheduleNativePoll();
    }
  }

  function newIntent() {
    stopNativePoll();
    patch({
      intentId: null,
      intentRequest: null,
      notice: 'new_intent',
      replyText: null,
      replyAvailable: false,
      activityJobId: '',
      activitySource: 'none',
      activityTruncated: false,
      activityEvents: [],
      activityPhase: 'idle',
      activityError: '',
      thoughts: [],
      thoughtSummaryEnabled: true,
    });
    return true;
  }

  function setMessage(message) {
    patch({ message: typeof message === 'string' ? message : '' });
  }

  function setTransport(transport) {
    const transports = state.capabilities && Array.isArray(state.capabilities.transports) ? state.capabilities.transports : ['acp'];
    if (!transports.includes(transport)) {
      patch({ error: 'unsupported_capability', notice: 'transport' });
      return false;
    }
    patch({ transport });
    return true;
  }

  function setModel(model) {
    const models = state.capabilities ? state.capabilities.models : null;
    const value = typeof model === 'string' ? model : '';
    if (value !== '' && (!Array.isArray(models) || !models.includes(value))) {
      patch({ error: 'unsupported_capability', notice: 'model' });
      return false;
    }
    patch({ model: value });
    return true;
  }

  function setEffort(effort) {
    const efforts = state.capabilities ? state.capabilities.efforts : null;
    const value = typeof effort === 'string' ? effort : '';
    if (value !== '' && (!Array.isArray(efforts) || !efforts.includes(value))) {
      patch({ error: 'unsupported_capability', notice: 'effort' });
      return false;
    }
    patch({ effort: value });
    return true;
  }

  function addPathRef(path) {
    if (!isAbsoluteHostPath(path)) {
      patch({ error: 'bad_request', notice: 'path_not_absolute' });
      return false;
    }
    if (state.pathRefs.length >= maxPathRefs) {
      patch({ error: 'bad_request', notice: 'too_many_paths' });
      return false;
    }
    const value = path.trim();
    if (state.pathRefs.includes(value)) return true;
    patch({ pathRefs: [...state.pathRefs, value] });
    return true;
  }

  function removePathRef(path) {
    patch({ pathRefs: state.pathRefs.filter((entry) => entry !== path) });
  }

  /**
   * Upload browser-selected files through the DSH session upload service. The
   * bytes are stored by DSH under this exact session; only the receipt id is
   * sent with the dispatch. The Host resolves that receipt with the calling
   * agent, so a receipt from another session cannot be relayed.
   */
  async function addFiles(fileList) {
    const uploader = getUploader();
    if (!uploader || typeof uploader.upload !== 'function') {
      patch({ error: 'unsupported_capability', notice: 'upload' });
      return { ok: false, code: 'unsupported_capability' };
    }
    if (!state.sessionId) {
      patch({ error: 'session_unknown' });
      return { ok: false, code: 'session_unknown' };
    }
    const files = Array.from(fileList || []).filter((file) => file && typeof file.name === 'string');
    if (files.length === 0) return { ok: true, added: 0 };
    if (state.uploading) return { ok: false, code: 'busy' };
    if (state.files.length + files.length > maxFiles) {
      patch({ error: 'bad_request', notice: 'too_many_files' });
      return { ok: false, code: 'bad_request' };
    }
    const generation = sessionGeneration;
    const session = state.sessionId;
    patch({ uploading: true, error: null, notice: 'uploading' });
    const added = [];
    try {
      for (const file of files) {
        const raw = await uploader.upload(session, file, file.name);
        if (disposed || generation !== sessionGeneration || state.sessionId !== session) {
          return { ok: false, code: 'stale_session' };
        }
        if (raw && raw.ok === false) throw new Error(raw.error || 'upload_failed');
        const value = raw && raw.value !== undefined ? raw.value : raw;
        if (!value || typeof value.receiptId !== 'string' || value.receiptId === '') {
          throw new Error('upload_receipt_missing');
        }
        if (state.files.some((entry) => entry.receiptId === value.receiptId)) continue;
        const info = value.file || {};
        added.push({
          receiptId: value.receiptId,
          name: typeof info.name === 'string' ? info.name : file.name,
          bytes:
            typeof info.bytes === 'number'
              ? info.bytes
              : typeof file.size === 'number'
                ? file.size
                : null,
        });
      }
      if (added.length > 0) patch({ files: [...state.files, ...added], uploading: false, notice: null });
      else patch({ uploading: false, notice: null });
      return { ok: true, added: added.length };
    } catch (error) {
      if (disposed || generation !== sessionGeneration) return { ok: false, code: 'stale_session' };
      patch({ uploading: false, error: readErrorCode(error) || 'upload_failed', notice: 'upload_failed' });
      return { ok: false, code: 'upload_failed' };
    }
  }

  function removeFile(receiptId) {
    patch({ files: state.files.filter((entry) => entry.receiptId !== receiptId) });
  }

  function refresh() {
    if (!state.jobId) return Promise.resolve({ ok: false, code: 'no_job' });
    return tick();
  }

  function readReply() {
    if (!state.jobId) return Promise.resolve({ ok: false, code: 'no_job' });
    return fetchReply();
  }

  async function refreshAuthStatus() {
    if (disposed) return { ok: false, authStatus: 'unknown', code: 'disposed' };
    if (!state.sessionReady) {
      patch({ cliAuthStatus: 'unknown', cliAuthMessage: null });
      return { ok: false, authStatus: 'unknown', code: 'session_unknown' };
    }
    if (!bridgeUp() || typeof bridge.authStatus !== 'function') {
      patch({ cliAuthStatus: 'unknown', cliAuthMessage: null });
      return { ok: false, authStatus: 'unknown', code: 'remote_unavailable' };
    }
    const generation = sessionGeneration;
    const session = state.sessionId;
    patch({ cliAuthStatus: 'checking', cliAuthMessage: null });
    try {
      const result = await bridge.authStatus({ session });
      if (disposed || generation !== sessionGeneration || state.sessionId !== session) {
        return { ok: false, authStatus: 'unknown', code: 'stale_session' };
      }
      const nextStatus =
        result && (result.authStatus === 'loggedin' || result.authStatus === 'unauthenticated')
          ? result.authStatus
          : 'unknown';
      patch({
        cliAuthStatus: nextStatus,
        cliInstallation: result?.installation || 'unknown',
        cliExecutable: result?.executable || '',
        cliVersion: result?.version || '',
        cliAuthMessage: result && typeof result.message === 'string' && result.message !== '' ? result.message : null,
      });
      return { ok: Boolean(result && result.ok), authStatus: nextStatus, message: result?.message || null };
    } catch (error) {
      if (disposed || generation !== sessionGeneration || state.sessionId !== session) {
        return { ok: false, authStatus: 'unknown', code: 'stale_session' };
      }
      patch({ cliAuthStatus: 'unknown', cliAuthMessage: null, error: readErrorCode(error) });
      return { ok: false, authStatus: 'unknown', code: readErrorCode(error) };
    }
  }

  async function loginCli() {
    if (disposed) return { ok: false, authStatus: 'unknown', code: 'disposed' };
    if (!state.sessionReady) {
      patch({ error: 'session_unknown' });
      return { ok: false, authStatus: 'unknown', code: 'session_unknown' };
    }
    if (!bridgeUp() || typeof bridge.login !== 'function') {
      patch({ bridgeAvailable: bridgeUp(), error: 'remote_unavailable' });
      return { ok: false, authStatus: 'unknown', code: 'remote_unavailable' };
    }
    const generation = sessionGeneration;
    const session = state.sessionId;
    patch({ cliAuthStatus: 'logging_in', cliAuthMessage: null, cliAuthFlow: null, error: null });
    try {
      const result = await bridge.login({ session });
      if (disposed || generation !== sessionGeneration || state.sessionId !== session) {
        return { ok: false, authStatus: 'unknown', code: 'stale_session' };
      }
      const nextStatus =
        result && (result.authStatus === 'loggedin' || result.authStatus === 'unauthenticated')
          ? result.authStatus
          : 'unknown';
      patch({
        cliAuthStatus: nextStatus,
        cliAuthFlow: result && typeof result.flow === 'string' ? result.flow : null,
        cliAuthMessage: result && typeof result.message === 'string' && result.message !== '' ? result.message : null,
        error: result && result.ok === false ? result.code || 'login_failed' : null,
      });
      return {
        ok: Boolean(result && result.ok),
        authStatus: nextStatus,
        flow: result?.flow || null,
        message: result?.message || null,
      };
    } catch (error) {
      if (disposed || generation !== sessionGeneration || state.sessionId !== session) {
        return { ok: false, authStatus: 'unknown', code: 'stale_session' };
      }
      const code = readErrorCode(error);
      patch({ cliAuthStatus: 'unknown', error: code });
      return { ok: false, authStatus: 'unknown', code };
    }
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function dispose() {
    disposed = true;
    stopPoll();
    stopNativePoll();
    listeners.clear();
  }

  return {
    getState: snapshot,
    subscribe,
    dispatch,
    newIntent,
    cancel,
    refresh,
    refreshNativeActivity: () => fetchNativeActivity(),
    readReply,
    refreshCapabilities,
    refreshAuthStatus,
    loginCli,
    setSession,
    setCollapsed,
    setMessage,
    setTransport,
    setModel,
    setEffort,
    addPathRef,
    removePathRef,
    addFiles,
    removeFile,
    dispose,
    _internal: {
      hasTimer: () => timer !== null,
      hasNativeTimer: () => nativeTimer !== null,
      timerJobId: () => timerJobId,
      inFlightGeneration: () => inFlightGeneration,
      sessionGeneration: () => sessionGeneration,
      isDisposed: () => disposed,
    },
  };
}

function phaseTextKey(phase) {
  switch (phase) {
    case 'pending':
      return 'state.pending';
    case 'accepted':
      return 'state.accepted';
    case 'acceptance_unknown':
      return 'state.acceptanceUnknown';
    case 'busy':
      return 'state.busy';
    case 'replied':
      return 'state.replied';
    case 'failed':
      return 'state.failed';
    case 'cancelled':
      return 'state.cancelled';
    case 'not_sent':
      return 'state.notSent';
    case 'idle':
      return 'state.idle';
    default:
      return 'state.unknown';
  }
}

function authStatusTextKey(status) {
  switch (status) {
    case 'loggedin':
      return 'auth.statusLoggedin';
    case 'unauthenticated':
      return 'auth.statusUnauthenticated';
    case 'checking':
      return 'auth.statusChecking';
    case 'logging_in':
      return 'auth.loggingIn';
    default:
      return 'auth.statusUnknown';
  }
}

const AUTH_COPY = Object.freeze({
  'auth.label': 'Antigravity CLI 登录',
  'auth.login': '登录 Antigravity CLI',
  'auth.loggingIn': '正在发起登录…',
  'auth.refresh': '刷新登录状态',
  'auth.statusLoggedin': '已登录',
  'auth.statusUnauthenticated': '未登录',
  'auth.statusUnknown': '状态未知',
  'auth.statusChecking': '检查中…',
  'auth.unauthenticatedHint': 'Antigravity CLI 尚未登录，请点击“登录 Antigravity CLI”完成官方授权。',
});

function authText(t, key) {
  const translated = t(key);
  return translated === key ? (AUTH_COPY[key] ?? key) : translated;
}

/**
 * React view. `React` is injected so this module stays loadable in Node tests and
 * never imports a second copy of React.
 */
const PANEL_STYLES = `
.antigravity-bridge { --ag-space: var(--dsw-alias-spacing-md, 12px); box-sizing: border-box; display: grid; gap: var(--ag-space); width: 100%; max-width: 760px; padding: var(--dsw-alias-spacing-lg, 16px); color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28)); border-radius: var(--dsw-alias-radius-lg, 12px); box-shadow: var(--dsw-alias-shadow-surface, 0 4px 16px rgb(0 0 0 / 12%)); }
.antigravity-bridge, .antigravity-bridge * { box-sizing: border-box; }
.antigravity-bridge__header { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding-bottom: 10px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28)); }
.antigravity-bridge__toggle { display: flex; align-items: center; gap: 9px; min-width: 0; padding: 0; color: inherit; background: transparent; border: 0; cursor: pointer; font: inherit; text-align: left; }
.antigravity-bridge__title { font-size: 14px; font-weight: 600; letter-spacing: .01em; }
.antigravity-bridge__phase, .antigravity-bridge__transport-badge { padding: 3px 8px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border-radius: 999px; font-size: 12px; white-space: nowrap; }
.antigravity-bridge__body { display: grid; gap: var(--ag-space); }
.antigravity-bridge__field { display: grid; gap: 6px; min-width: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 500; }
.antigravity-bridge__field input, .antigravity-bridge__field select, .antigravity-bridge__field textarea { width: 100%; height: 32px; min-height: 32px; padding: 4px 10px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28)); border-radius: var(--dsw-alias-radius-sm, 6px); font: inherit; font-size: 13px; font-weight: 400; resize: vertical; }
.antigravity-bridge__field textarea { height: auto; min-height: 96px; padding: 8px 10px; line-height: 1.45; }
.antigravity-bridge__field input:focus-visible, .antigravity-bridge__field select:focus-visible, .antigravity-bridge__field textarea:focus-visible, .antigravity-bridge button:focus-visible { outline: 2px solid var(--dsw-alias-focus-ring, var(--dsw-alias-brand-primary)); outline-offset: 2px; }
.antigravity-bridge__row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--ag-space); }
.antigravity-bridge__pathrow, .antigravity-bridge__files { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.antigravity-bridge__file-input { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
.antigravity-bridge__pathrow input { flex: 1 1 220px; }
.antigravity-bridge button { height: 32px; min-height: 32px; padding: 0 12px; color: var(--dsw-alias-label-primary); background: transparent; border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28)); border-radius: var(--dsw-alias-radius-sm, 6px); cursor: pointer; font: inherit; font-size: 13px; font-weight: 500; display: inline-flex; align-items: center; justify-content: center; }
.antigravity-bridge button:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.12)); }
.antigravity-bridge button:disabled { cursor: not-allowed; opacity: .55; }
.antigravity-bridge__primary { color: var(--dsw-alias-label-primary-foreground, #ffffff) !important; background: var(--dsw-alias-brand-primary) !important; border-color: var(--dsw-alias-brand-primary) !important; font-weight: 600; }
.antigravity-bridge__actions { display: flex; gap: 8px; flex-wrap: wrap; padding-top: 4px; }
.antigravity-bridge__auth { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; padding: 8px 10px; background: var(--dsw-alias-bg-layer-2); border-radius: var(--dsw-alias-radius-sm, 6px); }
.antigravity-bridge__auth-info { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.antigravity-bridge__auth-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.antigravity-status-pill { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; line-height: 1.4; }
.antigravity-status-pill--success { color: var(--dsw-alias-state-success-primary, #15803d); }
.antigravity-status-pill--error { color: var(--dsw-alias-state-error-primary, #b42318); }
.antigravity-status-pill--warn { color: var(--dsw-alias-state-warn-primary, #b45309); }
.antigravity-status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 999px; background: currentColor; flex: 0 0 auto; }
.antigravity-status-word { font-weight: 700; }
.antigravity-bridge__details { margin: 0; padding: 6px 10px; background: var(--dsw-alias-bg-layer-2); border-radius: var(--dsw-alias-radius-sm, 6px); }
.antigravity-bridge__summary { cursor: pointer; font-size: 12px; line-height: 1.4; color: var(--dsw-alias-label-secondary); font-weight: 500; list-style-position: inside; }
.antigravity-bridge__details-body { display: grid; gap: 6px; margin-top: 6px; }
.antigravity-bridge__banner, .antigravity-bridge__permission, .antigravity-bridge__notice, .antigravity-bridge__error { margin: 0; padding: 9px 11px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border-left: 3px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28)); border-radius: var(--dsw-alias-radius-sm, 6px); font-size: 12px; line-height: 1.45; }
.antigravity-bridge__error { color: var(--dsw-alias-state-error-primary, #b42318); border-left-color: var(--dsw-alias-state-error-primary, #b42318); }
.antigravity-bridge__paths { display: grid; gap: 5px; margin: 6px 0 0; padding: 0; list-style: none; }
.antigravity-bridge__paths li { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 8px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border-radius: var(--dsw-alias-radius-sm, 6px); font-size: .78rem; }
.antigravity-bridge__paths code { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.antigravity-bridge__hint { color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 400; }
.antigravity-bridge__status { display: grid; grid-template-columns: auto 1fr; gap: 5px 12px; margin: 0; padding: 12px; background: var(--dsw-alias-bg-layer-2); border-radius: var(--dsw-alias-radius-sm, 6px); font-size: .8rem; }
.antigravity-bridge__status dt { color: var(--dsw-alias-label-secondary); font-weight: 600; font-size: 12px; }
.antigravity-bridge__status dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.antigravity-bridge__reply { max-height: 260px; overflow: auto; white-space: pre-wrap; line-height: 1.5; }
.antigravity-bridge__activity { display: grid; gap: 6px; padding: 10px 12px; background: var(--dsw-alias-bg-layer-2); border-radius: var(--dsw-alias-radius-sm, 6px); font-size: .8rem; }
.antigravity-bridge__activity-title { margin: 0; font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.antigravity-bridge__activity-list { display: grid; gap: 6px; margin: 0; padding-left: 18px; color: var(--dsw-alias-label-secondary); }
.antigravity-bridge__activity-row { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.antigravity-chip { display: inline-flex; align-items: center; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; line-height: 1.5; border: 1px solid transparent; }
.antigravity-chip--warn { color: var(--dsw-alias-state-warn-primary, #b45309); background: var(--dsw-alias-state-warn-bg, rgba(180, 83, 9, 0.12)); border-color: var(--dsw-alias-state-warn-border, rgba(180, 83, 9, 0.28)); }
.antigravity-chip--business { color: var(--dsw-alias-brand-primary, #1d4ed8); background: var(--dsw-alias-brand-bg, rgba(29, 78, 216, 0.12)); border-color: var(--dsw-alias-brand-border, rgba(29, 78, 216, 0.28)); }
.antigravity-chip--success { color: var(--dsw-alias-state-success-primary, #15803d); background: var(--dsw-alias-state-success-bg, rgba(21, 128, 61, 0.12)); border-color: var(--dsw-alias-state-success-border, rgba(21, 128, 61, 0.28)); }
.antigravity-chip--error { color: var(--dsw-alias-state-error-primary, #b42318); background: var(--dsw-alias-state-error-bg, rgba(180, 35, 24, 0.12)); border-color: var(--dsw-alias-state-error-border, rgba(180, 35, 24, 0.28)); }
.antigravity-chip--neutral { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); border-color: var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28)); }
.antigravity-bridge__thought { margin: 0; padding: 8px 11px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border-radius: var(--dsw-alias-radius-sm, 6px); font-size: .8rem; line-height: 1.4; }
.antigravity-bridge__thought-label { font-weight: 600; }
.antigravity-bridge--collapsed { padding: 12px 16px; }
@media (max-width: 640px) { .antigravity-bridge { padding: 14px; } .antigravity-bridge__row { grid-template-columns: 1fr; } .antigravity-bridge__header { align-items: flex-start; flex-direction: column; } .antigravity-bridge__actions button { flex: 1 1 auto; } }
`;

function statusToneFromLogin(status) {
  if (status === 'loggedin') return 'success';
  if (status === 'unauthenticated') return 'error';
  return 'warn';
}

function statusToneFromInstall(installation) {
  if (installation === 'available') return 'success';
  if (installation === 'missing' || installation === 'unusable') return 'error';
  return 'warn';
}

function statusToneFromWritable(writable) {
  if (writable === true) return 'success';
  if (writable === false) return 'error';
  return 'warn';
}

function activityChipClass(status) {
  if (status === 'pending') return 'antigravity-chip antigravity-chip--warn';
  if (status === 'in_progress') return 'antigravity-chip antigravity-chip--business';
  if (status === 'completed') return 'antigravity-chip antigravity-chip--success';
  if (status === 'failed') return 'antigravity-chip antigravity-chip--error';
  return 'antigravity-chip antigravity-chip--neutral';
}

function renderStatusPill(h, tone, label, extraProps = {}) {
  return h(
    'span',
    { ...extraProps, className: `antigravity-status-pill antigravity-status-pill--${tone}` },
    h('span', { className: 'antigravity-status-dot', 'aria-hidden': 'true' }),
    h('span', { className: 'antigravity-status-word' }, label),
  );
}

function createPanelComponent({ React, translate = createTranslator(), bridge, uploader = null, getUploader = null }) {
  if (!React || typeof React.createElement !== 'function') {
    throw new TypeError('createPanelComponent requires React');
  }
  const h = React.createElement;
  const { useEffect, useRef, useState } = React;
  const t = translate;
  const styleTag = h('style', { 'data-antigravity-bridge-style': 'true' }, PANEL_STYLES);

  return function AntigravityBridgePanel(props) {
    const slotSessionId = (props && (props.sessionId || (props.session && props.session.id) || (props.conversation && props.conversation.id))) || null;
    const controllerRef = useRef(null);
    if (controllerRef.current === null) {
      controllerRef.current = createPanelController({
        bridge, sessionId: slotSessionId, uploader, getUploader: getUploader || undefined,
      });
    }
    const controller = controllerRef.current;
    const [state, setState] = useState(controller.getState());
    const pathInputRef = useRef(null);
    const fileInputRef = useRef(null);

    useEffect(() => {
      const unsubscribe = controller.subscribe(setState);
      return () => {
        unsubscribe();
        controller.dispose();
      };
    }, [controller]);

    useEffect(() => {
      // Switching the slot's conversation clears the panel's inputs (see
      // setSession) and re-reads the capabilities of the conversation now shown,
      // so B's pickers never advertise A's options.
      controller.setSession(slotSessionId);
      void controller.refreshCapabilities();
    }, [controller, slotSessionId]);

    const capabilities = state.capabilities;
    const transports = capabilities && Array.isArray(capabilities.transports) ? capabilities.transports : ['acp'];
    const desktopAvailable = transports.includes('desktop');
    const models = capabilities && Array.isArray(capabilities.models) ? capabilities.models : null;
    const efforts = capabilities && Array.isArray(capabilities.efforts) ? capabilities.efforts : null;
    const pathRefsSupported = Boolean(capabilities && capabilities.attachments && capabilities.attachments.pathRefs);
    const uploadSupported = Boolean(
      capabilities && capabilities.attachments && capabilities.attachments.uploadReceipt && (getUploader || uploader),
    );

    const header = h(
      'div',
      { className: 'antigravity-bridge__header' },
      h(
        'button',
        {
          type: 'button',
          className: 'antigravity-bridge__toggle',
          'aria-expanded': state.collapsed ? 'false' : 'true',
          'aria-label': state.collapsed ? t('panel.expand') : t('panel.collapse'),
          onClick: () => controller.setCollapsed(!state.collapsed),
        },
        h('span', { className: 'antigravity-bridge__title' }, t('title')),
        h('span', { className: 'antigravity-bridge__phase', 'data-phase': state.phase }, t(phaseTextKey(state.phase))),
      ),
      h(
        'span',
        { className: 'antigravity-bridge__transport-badge' },
        state.transport === 'desktop' ? t('transport.desktop') : t('transport.acp'),
      ),
    );

    if (state.collapsed) {
      return h('section', { className: 'antigravity-bridge antigravity-bridge--collapsed', 'aria-label': t('title') }, styleTag, header);
    }

    const banners = [];
    if (!state.sessionReady) {
      banners.push(h('p', { key: 'nosession', className: 'antigravity-bridge__banner', role: 'status' }, t('banner.noSession')));
    }
    if (!state.bridgeAvailable) {
      banners.push(h('p', { key: 'noremote', className: 'antigravity-bridge__banner', role: 'status' }, t('banner.noRemote')));
    }
    if (state.capabilitiesError) {
      banners.push(h('p', { key: 'nocaps', className: 'antigravity-bridge__banner', role: 'alert' }, t('banner.capabilitiesFailed')));
    }
    if (state.phase === 'permission') {
      banners.push(
        h(
          'div',
          { key: 'permission', className: 'antigravity-bridge__permission', role: 'alert' },
          h('p', null, t('permission.title')),
          h('p', null, t('permission.hint')),
        ),
      );
    }
    if (state.error === 'cross_session_denied') {
      banners.push(h('p', { key: 'xsession', className: 'antigravity-bridge__banner', role: 'alert' }, t('banner.crossSession')));
    }

    const transportField = h(
      'label',
      { className: 'antigravity-bridge__field', key: 'transport' },
      h('span', null, t('transport.label')),
      h(
        'select',
        {
          value: state.transport,
          disabled: state.busy,
          onChange: (event) => controller.setTransport(event.target.value),
        },
        h('option', { value: 'acp' }, t('transport.acp')),
        h('option', { value: 'desktop', disabled: !desktopAvailable }, desktopAvailable ? t('transport.desktop') : t('transport.desktopUnavailable')),
      ),
    );

    const modelField = h(
      'label',
      { className: 'antigravity-bridge__field', key: 'model' },
      h('span', null, t('model.label')),
      models && models.length > 0
        ? h(
            'select',
            { value: state.model, disabled: state.busy, onChange: (event) => controller.setModel(event.target.value) },
            h('option', { value: '' }, t('model.auto')),
            models.map((value) => h('option', { key: value, value }, value)),
          )
        : h('span', { className: 'antigravity-bridge__hint' }, t('model.unsupported')),
    );

    const effortField = h(
      'label',
      { className: 'antigravity-bridge__field', key: 'effort' },
      h('span', null, t('effort.label')),
      efforts && efforts.length > 0
        ? h(
            'select',
            { value: state.effort, disabled: state.busy, onChange: (event) => controller.setEffort(event.target.value) },
            h('option', { value: '' }, t('effort.auto')),
            efforts.map((value) => h('option', { key: value, value }, value)),
          )
        : h('span', { className: 'antigravity-bridge__hint' }, t('effort.unsupported')),
    );

    const attachmentField = h(
      'div',
      { className: 'antigravity-bridge__field', key: 'attachments' },
      h('span', null, t('attachments.label')),
      pathRefsSupported
        ? h(
            'div',
            { className: 'antigravity-bridge__pathrow' },
            h('input', {
              ref: pathInputRef,
              type: 'text',
              placeholder: t('attachments.placeholder'),
              disabled: state.busy,
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  const value = event.currentTarget.value;
                  if (controller.addPathRef(value) && pathInputRef.current) pathInputRef.current.value = '';
                }
              },
            }),
            h(
              'button',
              {
                type: 'button',
                disabled: state.busy,
                onClick: () => {
                  const value = pathInputRef.current ? pathInputRef.current.value : '';
                  if (controller.addPathRef(value) && pathInputRef.current) pathInputRef.current.value = '';
                },
              },
              t('attachments.add'),
            ),
          )
        : h('span', { className: 'antigravity-bridge__hint' }, t('attachments.unsupported')),
      state.pathRefs.length > 0
        ? h(
            'ul',
            { className: 'antigravity-bridge__paths' },
            state.pathRefs.map((entry) =>
              h(
                'li',
                { key: entry },
                h('code', null, entry),
                h(
                  'button',
                  { type: 'button', onClick: () => controller.removePathRef(entry), 'aria-label': t('attachments.remove') },
                  '\u00d7',
                ),
              ),
            ),
          )
        : null,
      h('span', { className: 'antigravity-bridge__hint' }, t('attachments.pathOnly')),
      uploadSupported
        ? h(
            'div',
            { className: 'antigravity-bridge__files' },
            h('span', null, t('attachments.filesLabel')),
            h('input', {
              ref: fileInputRef,
              className: 'antigravity-bridge__file-input',
              type: 'file',
              multiple: true,
              disabled: state.busy || state.uploading,
              'aria-label': t('attachments.choose'),
              onChange: async (event) => {
                const input = event.currentTarget;
                if (input.files && input.files.length > 0) await controller.addFiles(input.files);
                input.value = '';
              },
            }),
            state.uploading
              ? h('span', { className: 'antigravity-bridge__hint', role: 'status' }, t('attachments.uploading'))
              : h('button', { type: 'button', disabled: state.busy, onClick: () => fileInputRef.current && fileInputRef.current.click() }, t('attachments.choose')),
            state.files.length > 0
              ? h(
                  'ul',
                  { className: 'antigravity-bridge__paths' },
                  state.files.map((entry) =>
                    h(
                      'li',
                      { key: entry.receiptId },
                      h('code', null, entry.name),
                      entry.bytes === null
                        ? null
                        : h('span', { className: 'antigravity-bridge__hint' }, t('attachments.bytes').replace('{bytes}', String(entry.bytes))),
                      h(
                        'button',
                        { type: 'button', onClick: () => controller.removeFile(entry.receiptId), 'aria-label': t('attachments.remove') },
                        '\u00d7',
                      ),
                    ),
                  ),
                )
              : null,
            state.notice === 'upload'
              ? h('span', { className: 'antigravity-bridge__hint', role: 'status' }, t('attachments.fileUnsupported'))
              : null,
            state.notice === 'upload_failed'
              ? h('span', { className: 'antigravity-bridge__hint', role: 'alert' }, t('attachments.uploadFailed'))
              : null,
          )
        : h('span', { className: 'antigravity-bridge__hint' }, t('attachments.fileUnsupported')),
    );

    const authBar = h(
      'div',
      { className: 'antigravity-bridge__auth', 'data-auth-status': state.cliAuthStatus },
      h(
        'div',
        { className: 'antigravity-bridge__auth-info' },
        h('span', null, authText(t, 'auth.label')),
        renderStatusPill(
          h,
          statusToneFromLogin(state.cliAuthStatus),
          authText(t, authStatusTextKey(state.cliAuthStatus)),
          { 'data-auth-badge': state.cliAuthStatus },
        ),
      ),
      h(
        'div',
        { className: 'antigravity-bridge__auth-actions' },
        h(
          'button',
          {
            type: 'button',
            'data-action': 'cli-login',
            disabled: state.busy || !state.sessionReady || !state.bridgeAvailable || state.cliInstallation === 'missing' || state.cliAuthStatus === 'logging_in',
            onClick: () => void controller.loginCli(),
          },
          state.cliAuthStatus === 'logging_in' ? authText(t, 'auth.loggingIn') : authText(t, 'auth.login'),
        ),
        h(
          'button',
          {
            type: 'button',
            'data-action': 'cli-auth-refresh',
            disabled: state.busy || !state.sessionReady || !state.bridgeAvailable || state.cliAuthStatus === 'checking',
            onClick: () => void controller.refreshAuthStatus(),
          },
          authText(t, 'auth.refresh'),
        ),
      ),
    );

    const authNotes = [];
    if (state.cliAuthStatus === 'unknown') authNotes.push(h('p', { key: 'auth-unknown', className: 'antigravity-bridge__notice' }, authText(t, 'auth.terminalHint')));
    authNotes.push(h('p', { key: 'auth-privacy', className: 'antigravity-bridge__notice', 'data-auth-privacy': '' }, authText(t, 'auth.privacy')));
    banners.push(
      h(
        'details',
        { key: 'auth-notes', className: 'antigravity-bridge__details' },
        h('summary', { className: 'antigravity-bridge__summary' }, authText(t, 'auth.notesSummary')),
        h('div', { className: 'antigravity-bridge__details-body' }, authNotes),
      ),
    );
    if (state.cliExecutable) banners.push(h('p', { key: 'cli-path', className: 'antigravity-bridge__notice', 'data-cli-installation': state.cliInstallation }, `${state.cliExecutable} ${state.cliVersion}`));
    if (state.cliInstallation === 'missing') banners.push(h('p', { key: 'cli-install', className: 'antigravity-bridge__notice' }, authText(t, 'auth.installHint')));
    if (state.cliAuthStatus === 'unauthenticated') {
      banners.push(
        h('p', { key: 'unauth', className: 'antigravity-bridge__banner', role: 'alert', 'data-auth-hint': 'unauthenticated' }, authText(t, 'auth.unauthenticatedHint')),
      );
    }
    if (state.cliAuthMessage) {
      banners.push(
        h('p', { key: 'authmsg', className: 'antigravity-bridge__notice', role: 'status', 'data-auth-message': '' }, state.cliAuthMessage),
      );
    }

    const embedded = Boolean(props && props.embedded);
    const body = h(
      'div',
      { className: 'antigravity-bridge__body' },
      embedded ? null : authBar,
      banners,
      h(
        'label',
        { className: 'antigravity-bridge__field' },
        h('span', null, t('message.label')),
        h('textarea', {
          rows: 3,
          value: state.message,
          placeholder: t('message.placeholder'),
          disabled: state.busy,
          onChange: (event) => controller.setMessage(event.target.value),
        }),
      ),
      h('div', { className: 'antigravity-bridge__row' }, transportField, modelField, effortField),
      attachmentField,
      h(
        'div',
        { className: 'antigravity-bridge__actions' },
        h(
          'button',
          {
            type: 'button',
            className: 'antigravity-bridge__primary',
            disabled: state.busy || !state.sessionReady || !state.bridgeAvailable || state.message.trim() === '',
            onClick: () => void controller.dispatch(),
          },
          state.busy ? t('state.pending') : t('actions.dispatch'),
        ),
        state.intentId
          ? h(
              'button',
              {
                type: 'button',
                disabled: state.busy,
                onClick: () => controller.newIntent(),
              },
              t('actions.newIntent'),
            )
          : null,
        h(
          'button',
          {
            type: 'button',
            disabled: !state.jobId || state.phase === 'cancelled' || state.phase === 'replied',
            onClick: () => void controller.cancel(),
          },
          t('actions.cancel'),
        ),
        h('button', { type: 'button', disabled: !state.jobId, onClick: () => void controller.refresh() }, t('actions.refresh')),
        h(
          'button',
          { type: 'button', disabled: !state.jobId, onClick: () => void controller.readReply() },
          t('actions.readReply'),
        ),
      ),
      h(
        'dl',
        { className: 'antigravity-bridge__status', 'data-phase': state.phase },
        h('dt', null, t('session.label')),
        h('dd', null, state.sessionId || '\u2014'),
        state.jobId ? h('dt', null, 'jobId') : null,
        state.jobId ? h('dd', null, h('code', null, state.jobId)) : null,
        state.view?.workspaceRoot ? h('dt', null, 'Workspace') : null,
        state.view?.workspaceRoot ? h('dd', null, h('code', null, state.view.workspaceRoot)) : null,
        h('dt', null, t('reply.label')),
        h('dd', { className: 'antigravity-bridge__reply' }, state.replyAvailable ? state.replyText : t('reply.empty')),
      ),
      (state.jobId || (state.sessionId && state.activitySource === 'session' && (state.activityPhase === 'ready' || state.activityPhase === 'error' || state.activityEvents.length > 0)))
        ? h(
            'section',
            {
              className: 'antigravity-bridge__activity',
              'data-activity-region': '',
              'data-activity-source': state.jobId ? 'job' : 'session',
            },
            h('h3', { className: 'antigravity-bridge__activity-title' }, t(state.jobId ? 'activity.title' : 'nativeActivity.title')),
            h('p', { className: 'antigravity-bridge__hint' }, t(state.jobId ? 'activity.readonly' : 'nativeActivity.readonly')),
            !state.jobId
              ? h('p', { className: 'antigravity-bridge__hint', 'data-activity-local-derived': '' }, t('nativeActivity.localDerivedNote'))
              : null,
            !state.jobId && state.activityTruncated
              ? h('p', { className: 'antigravity-bridge__hint', 'data-activity-truncated': '' }, t('nativeActivity.truncated'))
              : null,
            state.activityPhase === 'error'
              ? h('p', { className: 'antigravity-bridge__error', role: 'alert' }, `${t('activity.error')}: ${state.activityError}`)
              : state.activityPhase === 'ready' && state.activityEvents.length === 0
                ? h('p', { className: 'antigravity-bridge__hint' }, t(state.jobId ? 'activity.empty' : 'nativeActivity.empty'))
                : state.activityEvents.length > 0
                  ? h(
                      'ul',
                      { className: 'antigravity-bridge__activity-list' },
                      state.activityEvents.map((ev, idx) =>
                        h(
                          'li',
                          {
                            key: `${ev.toolCallId || 'ev'}-${idx}`,
                            'data-activity-item': '',
                            'data-activity-kind': ev.kind,
                            'data-activity-status': ev.status,
                          },
                          h(
                            'span',
                            { className: 'antigravity-bridge__activity-row' },
                            h('span', null, `${t(`activity.kind.${['execute', 'edit', 'read', 'other'].includes(ev.kind) ? ev.kind : 'unknown'}`)} · ${ev.title || '\u2014'}`),
                            h('span', { className: activityChipClass(ev.status) }, ev.status || '\u2014'),
                          ),
                        ),
                      ),
                    )
                  : null,
          )
        : null,
      state.thoughtSummaryEnabled !== false && state.thoughts.length > 0
        ? h(
            'div',
            { className: 'antigravity-bridge__thought', 'data-thought-region': '', role: 'note' },
            h('span', { className: 'antigravity-bridge__thought-label' }, t('thought.summary')),
            h('span', { 'data-thought-line': '' }, `：${state.thoughts.map((it) => String(it?.text ?? '')).filter(Boolean).join(' · ').slice(0, 300)}`),
          )
        : null,
      state.notice ? h('p', { className: 'antigravity-bridge__notice', role: 'status' }, state.notice) : null,
      state.error ? h('p', { className: 'antigravity-bridge__error', role: 'alert', 'data-error-code': state.error }, t('error.label')) : null,
    );

    return h('section', { className: 'antigravity-bridge', 'aria-label': t('title'), 'data-phase': state.phase }, styleTag, header, body);
  };
}

const SIDEBAR_COPY = {
  zh: {
    'sidebar.chooseSession': '选择 DSH 会话',
    'sidebar.noSessions': '没有可选的 DSH 会话。请先创建会话。',
    'sidebar.opening': '正在连接选定的会话…',
    'nativeActivity.title': '原生 ACP 活动流',
    'nativeActivity.readonly': '来自原生 ACP 会话的只读活动',
    'nativeActivity.empty': '本会话暂无原生工具活动',
    'nativeActivity.truncated': '仅保留最近部分活动记录',
    'nativeActivity.localDerivedNote': '更新时间、来源与截断标记由插件本地补充，非底层原始字段。',
  },
  en: {
    'sidebar.chooseSession': 'Select a DSH session',
    'sidebar.noSessions': 'No DSH sessions are available. Create a session first.',
    'sidebar.opening': 'Connecting to the selected session…',
    'nativeActivity.title': 'Native ACP activity',
    'nativeActivity.readonly': 'Read-only activity from native ACP session',
    'nativeActivity.empty': 'No native tool activity in this session',
    'nativeActivity.truncated': 'Showing most recent activity entries',
    'nativeActivity.localDerivedNote': 'Timestamps, sources, and truncation flags are added locally by this plugin rather than reported directly.',
  },
};

const SIDEBAR_STYLES = `
.antigravity-sidebar-page { min-height: 100%; }
.antigravity-sidebar-page__content { display: grid; gap: var(--dsw-alias-spacing-md, 12px); width: min(100%, 920px); margin-inline: auto; }
.antigravity-sidebar-page__title { margin: 0; color: var(--dsw-alias-label-primary); font-size: 1.35rem; line-height: 1.2; }
.antigravity-sidebar-page__session { display: grid; gap: 6px; color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 500; }
.antigravity-sidebar-page__session select { width: 100%; height: 32px; min-height: 32px; padding: 4px 10px; }
.antigravity-sidebar-page__empty { margin: 0; padding: 16px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); border: 1px dashed var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28)); border-radius: var(--dsw-alias-radius-md, 8px); line-height: 1.5; }
.antigravity-cli-status { display: grid; gap: var(--dsw-alias-spacing-md, 12px); padding: var(--dsw-alias-spacing-lg, 16px); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28)); border-radius: var(--dsw-alias-radius-md, 8px); font-size: .84rem; }
.antigravity-cli-status__title { margin: 0; font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.antigravity-cli-status__row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary); }
.antigravity-cli-status__label { font-size: 12px; color: var(--dsw-alias-label-secondary); font-weight: 500; }
.antigravity-cli-status__badge { padding: 2px 8px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 12px; }
.antigravity-status-pill { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; line-height: 1.4; }
.antigravity-status-pill--success { color: var(--dsw-alias-state-success-primary, #15803d); }
.antigravity-status-pill--error { color: var(--dsw-alias-state-error-primary, #b42318); }
.antigravity-status-pill--warn { color: var(--dsw-alias-state-warn-primary, #b45309); }
.antigravity-status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 999px; background: currentColor; flex: 0 0 auto; }
.antigravity-status-word { font-weight: 700; }
.antigravity-cli-status__details { margin: 0; padding: 6px 10px; background: var(--dsw-alias-bg-layer-2); border-radius: var(--dsw-alias-radius-sm, 6px); }
.antigravity-cli-status__summary { cursor: pointer; font-size: 12px; line-height: 1.4; color: var(--dsw-alias-label-secondary); font-weight: 500; list-style-position: inside; }
.antigravity-cli-status__reason { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.45; }
.antigravity-cli-status__actions { display: flex; flex-wrap: wrap; gap: 8px; }
.antigravity-cli-status__actions button { height: 32px; min-height: 32px; padding: 0 12px; color: var(--dsw-alias-label-primary); background: transparent; border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28)); border-radius: var(--dsw-alias-radius-sm, 6px); cursor: pointer; font: inherit; font-size: 13px; font-weight: 500; }
.antigravity-cli-status__error { margin: 0; padding: 8px 10px; color: var(--dsw-alias-state-error-primary, #b42318); background: var(--dsw-alias-bg-layer-2); border-left: 3px solid var(--dsw-alias-state-error-primary, #b42318); border-radius: var(--dsw-alias-radius-sm, 6px); font-size: .8rem; }
.antigravity-cli-status__notice { margin: 0; color: var(--dsw-alias-label-secondary); font-size: .8rem; }
`;

function createCliStatusController({ bridge } = {}) {
  const activeBridge = bridge || createUnavailableBridge();
  const listeners = new Set();
  let disposed = false;
  let state = {
    bridgeAvailable: null,
    phase: 'idle',
    installation: null,
    executable: null,
    version: null,
    status: 'unknown',
    reasonCode: null,
    probe: { authMethodCount: 0, sessionProbe: 'skipped', verifiedStatus: null },
    dataDir: null,
    dataDirWritable: null,
    dataDirError: null,
    flow: null,
    message: null,
    error: null,
  };

  function emit() {
    for (const fn of [...listeners]) {
      try {
        fn(state);
      } catch {
        // Ignore listener errors.
      }
    }
  }

  function patch(next) {
    state = { ...state, ...next };
    emit();
  }

  function getState() {
    return state;
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  async function refresh() {
    if (disposed) return { ok: false, code: 'disposed' };
    const available = Boolean(activeBridge && activeBridge.available !== false && typeof activeBridge.authStatus === 'function');
    if (!available) {
      patch({ bridgeAvailable: false, phase: 'error', status: 'unknown', error: 'remote_unavailable' });
      return { ok: false, code: 'remote_unavailable' };
    }
    patch({ bridgeAvailable: true, phase: 'checking', error: null });
    try {
      const result = await activeBridge.authStatus({});
      if (disposed) return { ok: false, code: 'disposed' };
      const verified = result && result.probe ? result.probe.verifiedStatus : null;
      const status = verified === 'loggedin' || verified === 'unauthenticated' ? verified : 'unknown';
      patch({
        bridgeAvailable: true,
        phase: 'ready',
        installation: result?.installation ?? null,
        executable: result?.executable ?? null,
        version: result?.version ?? null,
        status,
        reasonCode: result?.reasonCode ?? null,
        probe: result?.probe ?? { authMethodCount: 0, sessionProbe: 'skipped', verifiedStatus: null },
        dataDir: result?.dataDir ?? null,
        dataDirWritable: typeof result?.dataDirWritable === 'boolean' ? result.dataDirWritable : null,
        dataDirError: result?.dataDirError ?? null,
        message: result?.message ?? null,
        error: null,
      });
      return result;
    } catch (err) {
      if (disposed) return { ok: false, code: 'disposed' };
      const code = readErrorCode(err);
      patch({ bridgeAvailable: code === 'remote_unavailable' ? false : available, phase: 'error', status: 'unknown', error: code });
      return { ok: false, code };
    }
  }

  async function login() {
    if (disposed) return { ok: false, code: 'disposed' };
    const available = Boolean(activeBridge && activeBridge.available !== false && typeof activeBridge.login === 'function');
    if (!available) {
      patch({ bridgeAvailable: false, phase: 'error', error: 'remote_unavailable' });
      return { ok: false, code: 'remote_unavailable' };
    }
    patch({ bridgeAvailable: true });
    try {
      const result = await activeBridge.login({});
      if (disposed) return { ok: false, code: 'disposed' };
      patch({
        bridgeAvailable: true,
        flow: result?.flow ?? null,
        message: result?.message ?? null,
        error: result && result.ok === false ? (result.code || 'login_failed') : null,
      });
      return result;
    } catch (err) {
      if (disposed) return { ok: false, code: 'disposed' };
      const code = readErrorCode(err);
      patch({ bridgeAvailable: code === 'remote_unavailable' ? false : available, error: code });
      return { ok: false, code };
    }
  }

  function dispose() {
    disposed = true;
    listeners.clear();
  }

  return { getState, subscribe, refresh, login, dispose };
}

function cliReasonTextKey(reasonCode) {
  switch (reasonCode) {
    case 'cli_missing':
    case 'cli_unavailable':
      return 'cli.reasonMissing';
    case 'cli_data_directory_required':
    case 'cli_data_unavailable':
      return 'cli.reasonDataDir';
    case 'auth_probe_failed':
      return 'cli.reasonProbeFailed';
    case 'bridge_closed':
      return 'cli.reasonBridgeClosed';
    default:
      return 'cli.unknownReasonCode';
  }
}

function createCliSectionComponent({ React, translate: t = createTranslator(), controller }) {
  const h = React.createElement;
  const { useEffect, useState } = React;
  return function AntigravityCliSection(props) {
    const [state, setState] = useState(() => controller.getState());
    useEffect(() => {
      const unsub = controller.subscribe(setState);
      void controller.refresh();
      return unsub;
    }, [controller]);

    const bridgeAvailable = typeof state.bridgeAvailable === 'boolean'
      ? state.bridgeAvailable
      : (props && typeof props.bridgeAvailable === 'boolean' ? props.bridgeAvailable : true);

    const installText = state.installation === 'available'
      ? t('cli.available')
      : state.installation === 'missing'
        ? t('cli.missing')
        : state.installation === 'unusable'
          ? t('cli.unusable')
          : t('cli.notProbed');
    const writableText = state.dataDirWritable === true
      ? t('cli.writable')
      : state.dataDirWritable === false
        ? t('cli.notWritable')
        : t('cli.notProbed');
    const loginText = state.status === 'loggedin'
      ? t('cli.statusLoggedin')
      : state.status === 'unauthenticated'
        ? t('cli.statusUnauthenticated')
        : t('cli.statusUnknown');
    const probe = state.probe || { authMethodCount: 0, sessionProbe: 'skipped' };
    const isProtocolAmbiguous = state.status === 'unknown' && state.reasonCode === 'protocol_ambiguous' && probe.sessionProbe === 'ok';
    const flowHint = state.flow === 'terminal'
      ? h('p', { className: 'antigravity-cli-status__notice', 'data-cli-hint': 'terminal' }, t('cli.flowTerminal'))
      : state.flow === 'already_logged_in'
        ? h('p', { className: 'antigravity-cli-status__notice', 'data-cli-hint': 'already_logged_in' }, t('cli.flowAlreadyLoggedIn'))
        : state.flow === 'none'
          ? h('p', { className: 'antigravity-cli-status__notice', 'data-cli-hint': 'none' }, t('cli.flowNone'))
          : null;

    return h(
      'section',
      { className: 'antigravity-cli-status', 'data-cli-section': '' },
      h('h2', { className: 'antigravity-cli-status__title' }, t('cli.title')),
      !bridgeAvailable ? h('p', { className: 'antigravity-cli-status__notice', role: 'status' }, t('cli.remoteUnavailable')) : null,
      h(
        'div',
        { className: 'antigravity-cli-status__row', 'data-cli-field': 'installation' },
        h('span', { className: 'antigravity-cli-status__label' }, `${t('cli.availability')}:`),
        renderStatusPill(h, statusToneFromInstall(state.installation), installText),
        h('span', { className: 'antigravity-cli-status__badge', 'data-cli-field': 'version' }, state.version || t('cli.unknownValue')),
        state.executable ? h('code', { 'data-cli-field': 'executable' }, state.executable) : null,
      ),
      h(
        'div',
        { className: 'antigravity-cli-status__row', 'data-cli-field': 'data-dir' },
        h('span', { className: 'antigravity-cli-status__label' }, `${t('cli.dataDir')}:`),
        h('code', null, state.dataDir || t('cli.dataDirMissing')),
        renderStatusPill(h, statusToneFromWritable(state.dataDirWritable), writableText),
      ),
      state.dataDirError
        ? h('p', { className: 'antigravity-cli-status__error', role: 'alert', 'data-cli-error': '' }, t('cli.dataDirError', { detail: state.dataDirError }))
        : null,
      h(
        'div',
        { className: 'antigravity-cli-status__row', 'data-cli-field': 'login-state' },
        h('span', { className: 'antigravity-cli-status__label' }, `${t('cli.loginState')}:`),
        renderStatusPill(h, statusToneFromLogin(state.status), loginText),
      ),
      
      isProtocolAmbiguous
        ? h(
            'details',
            { className: 'antigravity-cli-status__details' },
            h('summary', { className: 'antigravity-cli-status__summary' }, t('cli.detailsSummary')),
            h('p', { className: 'antigravity-cli-status__reason', 'data-cli-reason': 'protocol_ambiguous' }, t('cli.unknownReasonProtocol')),
          )
        : null,
      state.status === 'unknown' && state.reasonCode && !isProtocolAmbiguous
        ? h(
            'p',
            { className: 'antigravity-cli-status__reason', 'data-cli-reason': state.reasonCode },
            t(cliReasonTextKey(state.reasonCode), { code: state.reasonCode }),
          )
        : null,
      h(
        'div',
        { className: 'antigravity-cli-status__actions' },
        h('button', { type: 'button', 'data-action': 'cli-status-refresh', onClick: () => void controller.refresh() }, t('cli.refresh')),
        h('button', { type: 'button', 'data-action': 'cli-login-terminal', disabled: state.installation === 'missing', onClick: () => void controller.login() }, t('cli.openLogin')),
      ),
      flowHint,
      state.message
        ? h('p', { className: 'antigravity-cli-status__notice', 'data-cli-message': '' }, t('cli.bridgeMessage', { detail: state.message }))
        : null,
      state.error
        ? h('p', { className: 'antigravity-cli-status__error', role: 'alert', 'data-cli-error': '' }, t('cli.probeFailed', { detail: state.error }))
        : null,
    );
  };
}

/** The native sidebar supplies the button and selects the paired main entry. */
function createSidebarIcon(React) {
  const h = React.createElement;
  return function AntigravitySidebarIcon({ size = 20 }) {
    return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
      h('path', { d: 'M12 2.75 14.4 9.6 21.25 12 14.4 14.4 12 21.25 9.6 14.4 2.75 12 9.6 9.6Z', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round' }),
    );
  };
}

function createSidebarPage({ React, translate: t, Panel, retainSession, bridge, cliController }) {
  const h = React.createElement;
  const { useEffect, useRef, useState } = React;
  // The factory lives for this Client plugin, not the time the sidebar page is open.
  let lastSelected = '';
  const pageStyle = {
    boxSizing: 'border-box', height: '100%', overflow: 'auto',
    background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
    paddingBlock: 'calc(24px + var(--dsh-frame-top-clearance, 0px)) 24px',
    paddingInline: 'clamp(16px, 4vw, 40px)',
  };
  const contentStyle = { width: '100%', maxWidth: '920px', marginInline: 'auto', display: 'grid', gap: 'var(--dsw-alias-spacing-md, 12px)' };
  const selectStyle = {
    maxWidth: '100%', minWidth: 0, padding: '6px 10px', font: 'inherit', color: 'inherit',
    background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28))',
    borderRadius: 'var(--dsw-radius-sm)',
  };
  return function AntigravitySidebarPage({ useSessions }) {
    if (typeof useSessions !== 'function') {
      return h('div', { style: pageStyle, role: 'status' }, t('banner.noSession'));
    }
    return h(SessionBoundPage, { useSessions });
  };

  function SessionBoundPage({ useSessions }) {
    const ids = useSessions((state) => state.ids);
    const byId = useSessions((state) => state.byId);
    const phase = useSessions((state) => state.phase);
    const [choice, setChoice] = useState(() => lastSelected);
    const sessionId = ids.includes(choice) ? choice : '';
    const [scope, setScope] = useState(null);
    const cliControllerRef = useRef(cliController || null);
    if (cliControllerRef.current === null) {
      cliControllerRef.current = createCliStatusController({ bridge: bridge || createUnavailableBridge() });
    }
    const cliSectionRef = useRef(null);
    if (cliSectionRef.current === null) {
      cliSectionRef.current = createCliSectionComponent({
        React,
        translate: t,
        controller: cliControllerRef.current,
      });
    }
    useEffect(() => () => {
      if (!cliController && cliControllerRef.current) cliControllerRef.current.dispose();
    }, []);

    useEffect(() => {
      if (!sessionId) return undefined;
      let reference;
      try {
        reference = retainSession(sessionId);
      } catch {
        setScope({ sessionId, failed: true });
        return undefined;
      }
      let current = true;
      void reference.ready.then(
        () => { if (current) setScope({ sessionId, failed: false }); },
        () => { if (current) setScope({ sessionId, failed: true }); },
      );
      return () => {
        current = false;
        reference.release();
      };
    }, [sessionId]);

    const changeSession = (event) => {
      const next = event.target.value;
      if (next !== '' && !ids.includes(next)) return;
      lastSelected = next;
      setScope(null);
      setChoice(next);
    };
    const selectedScope = sessionId && scope?.sessionId === sessionId ? scope : null;
    const waiting = (!ids.length && phase !== 'ready') || (sessionId && !selectedScope);
    return h('div', { className: 'antigravity-sidebar-page', style: pageStyle, 'data-antigravity-sidebar-page': '' },
      h('style', { 'data-antigravity-sidebar-style': 'true' }, SIDEBAR_STYLES),
      h('div', { className: 'antigravity-sidebar-page__content', style: contentStyle },
        h(cliSectionRef.current, { bridgeAvailable: Boolean(cliController || (bridge && bridge.available !== false)) }),
        h('h1', { className: 'antigravity-sidebar-page__title' }, t('title')),
        h('label', { className: 'antigravity-sidebar-page__session' }, t('sidebar.chooseSession'),
          h('select', { value: sessionId, onChange: changeSession, disabled: ids.length === 0, style: selectStyle },
            h('option', { value: '' }, '—'),
            ids.map((id) => h('option', { key: id, value: id }, `${byId[id]?.displayTitle || id} · ${id.slice(0, 8)}`)),
          ),
        ),
        selectedScope && !selectedScope.failed
          ? h(Panel, { key: sessionId, sessionId, embedded: true })
          : h('p', { className: 'antigravity-sidebar-page__empty', role: 'status' },
            t(waiting ? 'sidebar.opening' : !ids.length ? 'sidebar.noSessions' : selectedScope?.failed ? 'banner.noSession' : 'sidebar.chooseSession'),
          ),
      ),
    );
  }
}

const PANEL_REGISTRATION = Object.freeze({ name: PANEL_SLOT, id: PANEL_ID, order: PANEL_ORDER });        return { PANEL_SLOT, PANEL_ID, PANEL_ORDER, DEFAULT_POLL_MS, MAX_PATH_REFS, MAX_MESSAGE_CHARS, HOST_TO_PHASE, TERMINAL_PHASES, readErrorCode, createUnavailableBridge, resolveNamespace, resolveHolder, isRemoteEnvelope, decodeRemoteResult, createRemoteBridge, isAbsoluteHostPath, createPanelController, phaseTextKey, PANEL_STYLES, createPanelComponent, SIDEBAR_COPY, SIDEBAR_STYLES, createSidebarIcon, createSidebarPage, PANEL_REGISTRATION };
      })();
      function __reviveRemote(value) {
        if (Array.isArray(value)) return value.map(__reviveRemote);
        if (value && typeof value === "object") {
          if (value.__codec) {
            var schema = value.jsonSchema;
            return {
              mode: "strict",
              typeSymbol: value.typeSymbol,
              create: function () {
                return {
                  parse: function (v) { return v; },
                  safeParse: function (v) { return { success: true, data: v }; },
                  toJSON: function () { return schema; },
                };
              },
              jsonSchema: schema,
            };
          }
          var out = {};
          for (var key in value) out[key] = __reviveRemote(value[key]);
          return out;
        }
        return value;
      }
      var TYPERT_REMOTE = __reviveRemote({"package":"dsh-agy-bridge","descriptors":[{"id":"dsh-agy-bridge#antigravityBridge/capabilities","package":"dsh-agy-bridge","service":"antigravityBridge","namespace":"antigravityBridge","method":"capabilities","invocation":{"kind":"direct"},"scope":{"context":"agent","wire":"agentId"},"parameters":[{"name":"agent","wire":"agentId","source":"lookup","lookup":"agent","description":"caller Agent resolved by the Host from the connection","codec":{"__codec":true,"typeSymbol":"typert:agentId","jsonSchema":{"type":"string"}},"strictCodec":{"__codec":true,"typeSymbol":"typert:agentId","jsonSchema":{"type":"string"}}}],"result":{"__codec":true,"typeSymbol":"bridge:CapabilitiesResult","jsonSchema":{"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean"},"reused":{"type":"boolean"},"jobId":{"type":"string"},"status":{"type":"string"},"code":{"type":"string"},"message":{"type":"string"},"view":{"type":"object","additionalProperties":false,"properties":{"jobId":{"type":"string"},"transport":{"type":"string"},"state":{"type":"string"},"status":{"type":"string"},"conversationId":{"type":"string"},"sessionId":{"type":"string"},"desktopConversationId":{"type":"string"},"targetKind":{"type":"string"},"title":{"type":"string"},"code":{"type":"string"},"message":{"type":"string"},"wakeState":{"type":"string"},"stopReason":{"type":"string"},"cancelRequested":{"type":"boolean"},"permissionPending":{"type":"boolean"},"reply":{"type":"string"},"fileMode":{"type":"string"},"detail":{"type":"object","additionalProperties":false,"properties":{"phase":{"type":"string"}},"required":["phase"]},"requested":{"type":"object","additionalProperties":true},"effective":{"type":"object","additionalProperties":true},"confirmed":{"type":"object","additionalProperties":true},"permissions":{"type":"array","items":{"type":"object","additionalProperties":true}},"configOptions":{"type":"array","items":{"type":"object","additionalProperties":true}},"createdAt":{"type":"number"},"updatedAt":{"type":"number"}},"required":["jobId","state"]},"available":{"type":"boolean"},"text":{"type":"string"},"state":{"type":"string"},"cached":{"type":"boolean"},"cancelSent":{"type":"boolean"},"settled":{"type":"boolean"},"stopControl":{"type":"string"},"capabilities":{"type":"object","additionalProperties":true},"authStatus":{"type":"string"},"authMethods":{"type":"array","items":{"type":"object","additionalProperties":true}},"installation":{"type":"string"},"executable":{"type":"string"},"version":{"type":"string"},"dataDir":{"oneOf":[{"type":"string"},{"type":"null"}]},"dataDirWritable":{"type":"boolean"},"dataDirError":{"oneOf":[{"type":"string"},{"type":"null"}]},"reasonCode":{"oneOf":[{"type":"string"},{"type":"null"}]},"probe":{"type":"object","additionalProperties":false,"properties":{"authMethodCount":{"type":"number"},"sessionProbe":{"type":"string","enum":["ok","failed","skipped"]},"verifiedStatus":{"oneOf":[{"type":"string"},{"type":"null"}]}},"required":["authMethodCount","sessionProbe","verifiedStatus"]},"flow":{"type":"string"},"methodId":{"type":"string"},"command":{"type":"string"},"events":{"type":"array","items":{"type":"object","additionalProperties":false,"properties":{"toolCallId":{"type":"string"},"kind":{"type":"string","enum":["execute","edit","read","other","unknown"]},"title":{"type":"string"},"status":{"type":"string"},"updatedAt":{"type":"number"},"source":{"type":"string"}},"required":["toolCallId","kind","title","status"]}},"thoughts":{"type":"array","items":{"type":"object","additionalProperties":false,"properties":{"text":{"type":"string"},"updatedAt":{"type":"number"},"source":{"type":"string"}},"required":["text"]}},"truncated":{"type":"boolean"},"thoughtSummaryEnabled":{"type":"boolean"}},"required":["ok"]}}},{"id":"dsh-agy-bridge#antigravityBridge/dispatch","package":"dsh-agy-bridge","service":"antigravityBridge","namespace":"antigravityBridge","method":"dispatch","invocation":{"kind":"direct"},"scope":{"context":"agent","wire":"agentId"},"parameters":[{"name":"agent","wire":"agentId","source":"lookup","lookup":"agent","description":"caller Agent resolved by the Host from the connection","codec":{"__codec":true,"typeSymbol":"typert:agentId","jsonSchema":{"type":"string"}},"strictCodec":{"__codec":true,"typeSymbol":"typert:agentId","jsonSchema":{"type":"string"}}},{"name":"request","wire":"request","source":"json","codec":{"__codec":true,"typeSymbol":"bridge:DispatchRequest","jsonSchema":{"type":"object","additionalProperties":false,"properties":{"clientRequestId":{"type":"string","maxLength":200},"message":{"type":"string","maxLength":100000},"transport":{"type":"string","enum":["acp","desktop"]},"conversationId":{"type":"string","maxLength":200},"profile":{"oneOf":[{"type":"string"},{"type":"null"}]},"model":{"oneOf":[{"type":"string"},{"type":"null"}]},"effort":{"oneOf":[{"type":"string"},{"type":"null"}]},"pathRefs":{"type":"array","items":{"type":"string"},"maxItems":20},"attachments":{"type":"array","items":{"type":"string"},"maxItems":10}},"required":["message"]}},"strictCodec":{"__codec":true,"typeSymbol":"bridge:DispatchRequest","jsonSchema":{"type":"object","additionalProperties":false,"properties":{"clientRequestId":{"type":"string","maxLength":200},"message":{"type":"string","maxLength":100000},"transport":{"type":"string","enum":["acp","desktop"]},"conversationId":{"type":"string","maxLength":200},"profile":{"oneOf":[{"type":"string"},{"type":"null"}]},"model":{"oneOf":[{"type":"string"},{"type":"null"}]},"effort":{"oneOf":[{"type":"string"},{"type":"null"}]},"pathRefs":{"type":"array","items":{"type":"string"},"maxItems":20},"attachments":{"type":"array","items":{"type":"string"},"maxItems":10}},"required":["message"]}}}],"result":{"__codec":true,"typeSymbol":"bridge:DispatchResult","jsonSchema":{"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean"},"reused":{"type":"boolean"},"jobId":{"type":"string"},"status":{"type":"string"},"code":{"type":"string"},"message":{"type":"string"},"view":{"type":"object","additionalProperties":false,"properties":{"jobId":{"type":"string"},"transport":{"type":"string"},"state":{"type":"string"},"status":{"type":"string"},"conversationId":{"type":"string"},"sessionId":{"type":"string"},"desktopConversationId":{"type":"string"},"targetKind":{"type":"string"},"title":{"type":"string"},"code":{"type":"string"},"message":{"type":"string"},"wakeState":{"type":"string"},"stopReason":{"type":"string"},"cancelRequested":{"type":"boolean"},"permissionPending":{"type":"boolean"},"reply":{"type":"string"},"fileMode":{"type":"string"},"detail":{"type":"object","additionalProperties":false,"properties":{"phase":{"type":"string"}},"required":["phase"]},"requested":{"type":"object","additionalProperties":true},"effective":{"type":"object","additionalProperties":true},"confirmed":{"type":"object","additionalProperties":true},"permissions":{"type":"array","items":{"type":"object","additionalProperties":true}},"configOptions":{"type":"array","items":{"type":"object","additionalProperties":true}},"createdAt":{"type":"number"},"updatedAt":{"type":"number"}},"required":["jobId","state"]},"available":{"type":"boolean"},"text":{"type":"string"},"state":{"type":"string"},"cached":{"type":"boolean"},"cancelSent":{"type":"boolean"},"settled":{"type":"boolean"},"stopControl":{"type":"string"},"capabilities":{"type":"object","additionalProperties":true},"authStatus":{"type":"string"},"authMethods":{"type":"array","items":{"type":"object","additionalProperties":true}},"installation":{"type":"string"},"executable":{"type":"string"},"version":{"type":"string"},"dataDir":{"oneOf":[{"type":"string"},{"type":"null"}]},"dataDirWritable":{"type":"boolean"},"dataDirError":{"oneOf":[{"type":"string"},{"type":"null"}]},"reasonCode":{"oneOf":[{"type":"string"},{"type":"null"}]},"probe":{"type":"object","additionalProperties":false,"properties":{"authMethodCount":{"type":"number"},"sessionProbe":{"type":"string","enum":["ok","failed","skipped"]},"verifiedStatus":{"oneOf":[{"type":"string"},{"type":"null"}]}},"required":["authMethodCount","sessionProbe","verifiedStatus"]},"flow":{"type":"string"},"methodId":{"type":"string"},"command":{"type":"string"},"events":{"type":"array","items":{"type":"object","additionalProperties":false,"properties":{"toolCallId":{"type":"string"},"kind":{"type":"string","enum":["execute","edit","read","other","unknown"]},"title":{"type":"string"},"status":{"type":"string"},"updatedAt":{"type":"number"},"source":{"type":"string"}},"required":["toolCallId","kind","title","status"]}},"thoughts":{"type":"array","items":{"type":"object","additionalProperties":false,"properties":{"text":{"type":"string"},"updatedAt":{"type":"number"},"source":{"type":"string"}},"required":["text"]}},"truncated":{"type":"boolean"},"thoughtSummaryEnabled":{"type":"boolean"}},"required":["ok"]}}},{"id":"dsh-agy-bridge#antigravityBridge/status","package":"dsh-agy-bridge","service":"antigravityBridge","namespace":"antigravityBridge","method":"status","invocation":{"kind":"direct"},"scope":{"context":"agent","wire":"agentId"},"parameters":[{"name":"agent","wire":"agentId","source":"lookup","lookup":"agent","description":"caller Agent resolved by the Host from the connection","codec":{"__codec":true,"typeSymbol":"typert:agentId","jsonSchema":{"type":"string"}},"strictCodec":{"__codec":true,"typeSymbol":"typert:agentId","jsonSchema":{"type":"string"}}},{"name":"request","wire":"request","source":"json","codec":{"__codec":true,"typeSymbol":"bridge:JobRequest","jsonSchema":{"type":"object","additionalProperties":false,"properties":{"jobId":{"type":"string","maxLength":200}},"required":["jobId"]}},"strictCodec":{"__codec":true,"typeSymbol":"bridge:JobRequest","jsonSchema":{"type":"object","additionalProperties":false,"properties":{"jobId":{"type":"string","maxLength":200}},"required":["jobId"]}}}],"result":{"__codec":true,"typeSymbol":"bridge:StatusResult","jsonSchema":{"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean"},"reused":{"type":"boolean"},"jobId":{"type":"string"},"status":{"type":"string"},"code":{"type":"string"},"message":{"type":"string"},"view":{"type":"object","additionalProperties":false,"properties":{"jobId":{"type":"string"},"transport":{"type":"string"},"state":{"type":"string"},"status":{"type":"string"},"conversationId":{"type":"string"},"sessionId":{"type":"string"},"desktopConversationId":{"type":"string"},"targetKind":{"type":"string"},"title":{"type":"string"},"code":{"type":"string"},"message":{"type":"string"},"wakeState":{"type":"string"},"stopReason":{"type":"string"},"cancelRequested":{"type":"boolean"},"permissionPending":{"type":"boolean"},"reply":{"type":"string"},"fileMode":{"type":"string"},"detail":{"type":"object","additionalProperties":false,"properties":{"phase":{"type":"string"}},"required":["phase"]},"requested":{"type":"object","additionalProperties":true},"effective":{"type":"object","additionalProperties":true},"confirmed":{"type":"object","additionalProperties":true},"permissions":{"type":"array","items":{"type":"object","additionalProperties":true}},"configOptions":{"type":"array","items":{"type":"object","additionalProperties":true}},"createdAt":{"type":"number"},"updatedAt":{"type":"number"}},"required":["jobId","state"]},"available":{"type":"boolean"},"text":{"type":"string"},"state":{"type":"string"},"cached":{"type":"boolean"},"cancelSent":{"type":"boolean"},"settled":{"type":"boolean"},"stopControl":{"type":"string"},"capabilities":{"type":"object","additionalProperties":true},"authStatus":{"type":"string"},"authMethods":{"type":"array","items":{"type":"object","additionalProperties":true}},"installation":{"type":"string"},"executable":{"type":"string"},"version":{"type":"string"},"dataDir":{"oneOf":[{"type":"string"},{"type":"null"}]},"dataDirWritable":{"type":"boolean"},"dataDirError":{"oneOf":[{"type":"string"},{"type":"null"}]},"reasonCode":{"oneOf":[{"type":"string"},{"type":"null"}]},"probe":{"type":"object","additionalProperties":false,"properties":{"authMethodCount":{"type":"number"},"sessionProbe":{"type":"string","enum":["ok","failed","skipped"]},"verifiedStatus":{"oneOf":[{"type":"string"},{"type":"null"}]}},"required":["authMethodCount","sessionProbe","verifiedStatus"]},"flow":{"type":"string"},"methodId":{"type":"string"},"command":{"type":"string"},"events":{"type":"array","items":{"type":"object","additionalProperties":false,"properties":{"toolCallId":{"type":"string"},"kind":{"type":"string","enum":["execute","edit","read","other","unknown"]},"title":{"type":"string"},"status":{"type":"string"},"updatedAt":{"type":"number"},"source":{"type":"string"}},"required":["toolCallId","kind","title","status"]}},"thoughts":{"type":"array","items":{"type":"object","additionalProperties":false,"properties":{"text":{"type":"string"},"updatedAt":{"type":"number"},"source":{"type":"string"}},"required":["text"]}},"truncated":{"type":"boolean"},"thoughtSummaryEnabled":{"type":"boolean"}},"required":["ok"]}}},{"id":"dsh-agy-bridge#antigravityBridge/reply","package":"dsh-agy-bridge","service":"antigravityBridge","namespace":"antigravityBridge","method":"reply","invocation":{"kind":"direct"},"scope":{"context":"agent","wire":"agentId"},"parameters":[{"name":"agent","wire":"agentId","source":"lookup","lookup":"agent","description":"caller Agent resolved by the Host from the connection","codec":{"__codec":true,"typeSymbol":"typert:agentId","jsonSchema":{"type":"string"}},"strictCodec":{"__codec":true,"typeSymbol":"typert:agentId","jsonSchema":{"type":"string"}}},{"name":"request","wire":"request","source":"json","codec":{"__codec":true,"typeSymbol":"bridge:JobRequest","jsonSchema":{"type":"object","additionalProperties":false,"properties":{"jobId":{"type":"string","maxLength":200}},"required":["jobId"]}},"strictCodec":{"__codec":true,"typeSymbol":"bridge:JobRequest","jsonSchema":{"type":"object","additionalProperties":false,"properties":{"jobId":{"type":"string","maxLength":200}},"required":["jobId"]}}}],"result":{"__codec":true,"typeSymbol":"bridge:ReplyResult","jsonSchema":{"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean"},"reused":{"type":"boolean"},"jobId":{"type":"string"},"status":{"type":"string"},"code":{"type":"string"},"message":{"type":"string"},"view":{"type":"object","additionalProperties":false,"properties":{"jobId":{"type":"string"},"transport":{"type":"string"},"state":{"type":"string"},"status":{"type":"string"},"conversationId":{"type":"string"},"sessionId":{"type":"string"},"desktopConversationId":{"type":"string"},"targetKind":{"type":"string"},"title":{"type":"string"},"code":{"type":"string"},"message":{"type":"string"},"wakeState":{"type":"string"},"stopReason":{"type":"string"},"cancelRequested":{"type":"boolean"},"permissionPending":{"type":"boolean"},"reply":{"type":"string"},"fileMode":{"type":"string"},"detail":{"type":"object","additionalProperties":false,"properties":{"phase":{"type":"string"}},"required":["phase"]},"requested":{"type":"object","additionalProperties":true},"effective":{"type":"object","additionalProperties":true},"confirmed":{"type":"object","additionalProperties":true},"permissions":{"type":"array","items":{"type":"object","additionalProperties":true}},"configOptions":{"type":"array","items":{"type":"object","additionalProperties":true}},"createdAt":{"type":"number"},"updatedAt":{"type":"number"}},"required":["jobId","state"]},"available":{"type":"boolean"},"text":{"type":"string"},"state":{"type":"string"},"cached":{"type":"boolean"},"cancelSent":{"type":"boolean"},"settled":{"type":"boolean"},"stopControl":{"type":"string"},"capabilities":{"type":"object","additionalProperties":true},"authStatus":{"type":"string"},"authMethods":{"type":"array","items":{"type":"object","additionalProperties":true}},"installation":{"type":"string"},"executable":{"type":"string"},"version":{"type":"string"},"dataDir":{"oneOf":[{"type":"string"},{"type":"null"}]},"dataDirWritable":{"type":"boolean"},"dataDirError":{"oneOf":[{"type":"string"},{"type":"null"}]},"reasonCode":{"oneOf":[{"type":"string"},{"type":"null"}]},"probe":{"type":"object","additionalProperties":false,"properties":{"authMethodCount":{"type":"number"},"sessionProbe":{"type":"string","enum":["ok","failed","skipped"]},"verifiedStatus":{"oneOf":[{"type":"string"},{"type":"null"}]}},"required":["authMethodCount","sessionProbe","verifiedStatus"]},"flow":{"type":"string"},"methodId":{"type":"string"},"command":{"type":"string"},"events":{"type":"array","items":{"type":"object","additionalProperties":false,"properties":{"toolCallId":{"type":"string"},"kind":{"type":"string","enum":["execute","edit","read","other","unknown"]},"title":{"type":"string"},"status":{"type":"string"},"updatedAt":{"type":"number"},"source":{"type":"string"}},"required":["toolCallId","kind","title","status"]}},"thoughts":{"type":"array","items":{"type":"object","additionalProperties":false,"properties":{"text":{"type":"string"},"updatedAt":{"type":"number"},"source":{"type":"string"}},"required":["text"]}},"truncated":{"type":"boolean"},"thoughtSummaryEnabled":{"type":"boolean"}},"required":["ok"]}}},{"id":"dsh-agy-bridge#antigravityBridge/cancel","package":"dsh-agy-bridge","service":"antigravityBridge","namespace":"antigravityBridge","method":"cancel","invocation":{"kind":"direct"},"scope":{"context":"agent","wire":"agentId"},"parameters":[{"name":"agent","wire":"agentId","source":"lookup","lookup":"agent","description":"caller Agent resolved by the Host from the connection","codec":{"__codec":true,"typeSymbol":"typert:agentId","jsonSchema":{"type":"string"}},"strictCodec":{"__codec":true,"typeSymbol":"typert:agentId","jsonSchema":{"type":"string"}}},{"name":"request","wire":"request","source":"json","codec":{"__codec":true,"typeSymbol":"bridge:JobRequest","jsonSchema":{"type":"object","additionalProperties":false,"properties":{"jobId":{"type":"string","maxLength":200}},"required":["jobId"]}},"strictCodec":{"__codec":true,"typeSymbol":"bridge:JobRequest","jsonSchema":{"type":"object","additionalProperties":false,"properties":{"jobId":{"type":"string","maxLength":200}},"required":["jobId"]}}}],"result":{"__codec":true,"typeSymbol":"bridge:CancelResult","jsonSchema":{"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean"},"reused":{"type":"boolean"},"jobId":{"type":"string"},"status":{"type":"string"},"code":{"type":"string"},"message":{"type":"string"},"view":{"type":"object","additionalProperties":false,"properties":{"jobId":{"type":"string"},"transport":{"type":"string"},"state":{"type":"string"},"status":{"type":"string"},"conversationId":{"type":"string"},"sessionId":{"type":"string"},"desktopConversationId":{"type":"string"},"targetKind":{"type":"string"},"title":{"type":"string"},"code":{"type":"string"},"message":{"type":"string"},"wakeState":{"type":"string"},"stopReason":{"type":"string"},"cancelRequested":{"type":"boolean"},"permissionPending":{"type":"boolean"},"reply":{"type":"string"},"fileMode":{"type":"string"},"detail":{"type":"object","additionalProperties":false,"properties":{"phase":{"type":"string"}},"required":["phase"]},"requested":{"type":"object","additionalProperties":true},"effective":{"type":"object","additionalProperties":true},"confirmed":{"type":"object","additionalProperties":true},"permissions":{"type":"array","items":{"type":"object","additionalProperties":true}},"configOptions":{"type":"array","items":{"type":"object","additionalProperties":true}},"createdAt":{"type":"number"},"updatedAt":{"type":"number"}},"required":["jobId","state"]},"available":{"type":"boolean"},"text":{"type":"string"},"state":{"type":"string"},"cached":{"type":"boolean"},"cancelSent":{"type":"boolean"},"settled":{"type":"boolean"},"stopControl":{"type":"string"},"capabilities":{"type":"object","additionalProperties":true},"authStatus":{"type":"string"},"authMethods":{"type":"array","items":{"type":"object","additionalProperties":true}},"installation":{"type":"string"},"executable":{"type":"string"},"version":{"type":"string"},"dataDir":{"oneOf":[{"type":"string"},{"type":"null"}]},"dataDirWritable":{"type":"boolean"},"dataDirError":{"oneOf":[{"type":"string"},{"type":"null"}]},"reasonCode":{"oneOf":[{"type":"string"},{"type":"null"}]},"probe":{"type":"object","additionalProperties":false,"properties":{"authMethodCount":{"type":"number"},"sessionProbe":{"type":"string","enum":["ok","failed","skipped"]},"verifiedStatus":{"oneOf":[{"type":"string"},{"type":"null"}]}},"required":["authMethodCount","sessionProbe","verifiedStatus"]},"flow":{"type":"string"},"methodId":{"type":"string"},"command":{"type":"string"},"events":{"type":"array","items":{"type":"object","additionalProperties":false,"properties":{"toolCallId":{"type":"string"},"kind":{"type":"string","enum":["execute","edit","read","other","unknown"]},"title":{"type":"string"},"status":{"type":"string"},"updatedAt":{"type":"number"},"source":{"type":"string"}},"required":["toolCallId","kind","title","status"]}},"thoughts":{"type":"array","items":{"type":"object","additionalProperties":false,"properties":{"text":{"type":"string"},"updatedAt":{"type":"number"},"source":{"type":"string"}},"required":["text"]}},"truncated":{"type":"boolean"},"thoughtSummaryEnabled":{"type":"boolean"}},"required":["ok"]}}},{"id":"dsh-agy-bridge#antigravityBridge/activity","package":"dsh-agy-bridge","service":"antigravityBridge","namespace":"antigravityBridge","method":"activity","invocation":{"kind":"direct"},"scope":{"context":"agent","wire":"agentId"},"parameters":[{"name":"agent","wire":"agentId","source":"lookup","lookup":"agent","description":"caller Agent resolved by the Host from the connection","codec":{"__codec":true,"typeSymbol":"typert:agentId","jsonSchema":{"type":"string"}},"strictCodec":{"__codec":true,"typeSymbol":"typert:agentId","jsonSchema":{"type":"string"}}},{"name":"request","wire":"request","source":"json","codec":{"__codec":true,"typeSymbol":"bridge:JobRequest","jsonSchema":{"type":"object","additionalProperties":false,"properties":{"jobId":{"type":"string","maxLength":200}},"required":["jobId"]}},"strictCodec":{"__codec":true,"typeSymbol":"bridge:JobRequest","jsonSchema":{"type":"object","additionalProperties":false,"properties":{"jobId":{"type":"string","maxLength":200}},"required":["jobId"]}}}],"result":{"__codec":true,"typeSymbol":"bridge:ActivityResult","jsonSchema":{"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean"},"reused":{"type":"boolean"},"jobId":{"type":"string"},"status":{"type":"string"},"code":{"type":"string"},"message":{"type":"string"},"view":{"type":"object","additionalProperties":false,"properties":{"jobId":{"type":"string"},"transport":{"type":"string"},"state":{"type":"string"},"status":{"type":"string"},"conversationId":{"type":"string"},"sessionId":{"type":"string"},"desktopConversationId":{"type":"string"},"targetKind":{"type":"string"},"title":{"type":"string"},"code":{"type":"string"},"message":{"type":"string"},"wakeState":{"type":"string"},"stopReason":{"type":"string"},"cancelRequested":{"type":"boolean"},"permissionPending":{"type":"boolean"},"reply":{"type":"string"},"fileMode":{"type":"string"},"detail":{"type":"object","additionalProperties":false,"properties":{"phase":{"type":"string"}},"required":["phase"]},"requested":{"type":"object","additionalProperties":true},"effective":{"type":"object","additionalProperties":true},"confirmed":{"type":"object","additionalProperties":true},"permissions":{"type":"array","items":{"type":"object","additionalProperties":true}},"configOptions":{"type":"array","items":{"type":"object","additionalProperties":true}},"createdAt":{"type":"number"},"updatedAt":{"type":"number"}},"required":["jobId","state"]},"available":{"type":"boolean"},"text":{"type":"string"},"state":{"type":"string"},"cached":{"type":"boolean"},"cancelSent":{"type":"boolean"},"settled":{"type":"boolean"},"stopControl":{"type":"string"},"capabilities":{"type":"object","additionalProperties":true},"authStatus":{"type":"string"},"authMethods":{"type":"array","items":{"type":"object","additionalProperties":true}},"installation":{"type":"string"},"executable":{"type":"string"},"version":{"type":"string"},"dataDir":{"oneOf":[{"type":"string"},{"type":"null"}]},"dataDirWritable":{"type":"boolean"},"dataDirError":{"oneOf":[{"type":"string"},{"type":"null"}]},"reasonCode":{"oneOf":[{"type":"string"},{"type":"null"}]},"probe":{"type":"object","additionalProperties":false,"properties":{"authMethodCount":{"type":"number"},"sessionProbe":{"type":"string","enum":["ok","failed","skipped"]},"verifiedStatus":{"oneOf":[{"type":"string"},{"type":"null"}]}},"required":["authMethodCount","sessionProbe","verifiedStatus"]},"flow":{"type":"string"},"methodId":{"type":"string"},"command":{"type":"string"},"events":{"type":"array","items":{"type":"object","additionalProperties":false,"properties":{"toolCallId":{"type":"string"},"kind":{"type":"string","enum":["execute","edit","read","other","unknown"]},"title":{"type":"string"},"status":{"type":"string"},"updatedAt":{"type":"number"},"source":{"type":"string"}},"required":["toolCallId","kind","title","status"]}},"thoughts":{"type":"array","items":{"type":"object","additionalProperties":false,"properties":{"text":{"type":"string"},"updatedAt":{"type":"number"},"source":{"type":"string"}},"required":["text"]}},"truncated":{"type":"boolean"},"thoughtSummaryEnabled":{"type":"boolean"}},"required":["ok"]}}},{"id":"dsh-agy-bridge#antigravityBridge/nativeActivity","package":"dsh-agy-bridge","service":"antigravityBridge","namespace":"antigravityBridge","method":"nativeActivity","invocation":{"kind":"direct"},"scope":{"context":"agent","wire":"agentId"},"parameters":[{"name":"agent","wire":"agentId","source":"lookup","lookup":"agent","description":"caller Agent resolved by the Host from the connection","codec":{"__codec":true,"typeSymbol":"typert:agentId","jsonSchema":{"type":"string"}},"strictCodec":{"__codec":true,"typeSymbol":"typert:agentId","jsonSchema":{"type":"string"}}},{"name":"request","wire":"request","source":"json","codec":{"__codec":true,"typeSymbol":"bridge:NativeActivityRequest","jsonSchema":{"type":"object","additionalProperties":false,"properties":{"sessionId":{"type":"string","maxLength":200},"scope":{"type":"string","maxLength":200},"agentId":{"type":"string","maxLength":200}},"required":["sessionId"]}},"strictCodec":{"__codec":true,"typeSymbol":"bridge:NativeActivityRequest","jsonSchema":{"type":"object","additionalProperties":false,"properties":{"sessionId":{"type":"string","maxLength":200},"scope":{"type":"string","maxLength":200},"agentId":{"type":"string","maxLength":200}},"required":["sessionId"]}}}],"result":{"__codec":true,"typeSymbol":"bridge:NativeActivityResult","jsonSchema":{"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean"},"reused":{"type":"boolean"},"jobId":{"type":"string"},"status":{"type":"string"},"code":{"type":"string"},"message":{"type":"string"},"view":{"type":"object","additionalProperties":false,"properties":{"jobId":{"type":"string"},"transport":{"type":"string"},"state":{"type":"string"},"status":{"type":"string"},"conversationId":{"type":"string"},"sessionId":{"type":"string"},"desktopConversationId":{"type":"string"},"targetKind":{"type":"string"},"title":{"type":"string"},"code":{"type":"string"},"message":{"type":"string"},"wakeState":{"type":"string"},"stopReason":{"type":"string"},"cancelRequested":{"type":"boolean"},"permissionPending":{"type":"boolean"},"reply":{"type":"string"},"fileMode":{"type":"string"},"detail":{"type":"object","additionalProperties":false,"properties":{"phase":{"type":"string"}},"required":["phase"]},"requested":{"type":"object","additionalProperties":true},"effective":{"type":"object","additionalProperties":true},"confirmed":{"type":"object","additionalProperties":true},"permissions":{"type":"array","items":{"type":"object","additionalProperties":true}},"configOptions":{"type":"array","items":{"type":"object","additionalProperties":true}},"createdAt":{"type":"number"},"updatedAt":{"type":"number"}},"required":["jobId","state"]},"available":{"type":"boolean"},"text":{"type":"string"},"state":{"type":"string"},"cached":{"type":"boolean"},"cancelSent":{"type":"boolean"},"settled":{"type":"boolean"},"stopControl":{"type":"string"},"capabilities":{"type":"object","additionalProperties":true},"authStatus":{"type":"string"},"authMethods":{"type":"array","items":{"type":"object","additionalProperties":true}},"installation":{"type":"string"},"executable":{"type":"string"},"version":{"type":"string"},"dataDir":{"oneOf":[{"type":"string"},{"type":"null"}]},"dataDirWritable":{"type":"boolean"},"dataDirError":{"oneOf":[{"type":"string"},{"type":"null"}]},"reasonCode":{"oneOf":[{"type":"string"},{"type":"null"}]},"probe":{"type":"object","additionalProperties":false,"properties":{"authMethodCount":{"type":"number"},"sessionProbe":{"type":"string","enum":["ok","failed","skipped"]},"verifiedStatus":{"oneOf":[{"type":"string"},{"type":"null"}]}},"required":["authMethodCount","sessionProbe","verifiedStatus"]},"flow":{"type":"string"},"methodId":{"type":"string"},"command":{"type":"string"},"events":{"type":"array","items":{"type":"object","additionalProperties":false,"properties":{"toolCallId":{"type":"string"},"kind":{"type":"string","enum":["execute","edit","read","other","unknown"]},"title":{"type":"string"},"status":{"type":"string"},"updatedAt":{"type":"number"},"source":{"type":"string"}},"required":["toolCallId","kind","title","status"]}},"thoughts":{"type":"array","items":{"type":"object","additionalProperties":false,"properties":{"text":{"type":"string"},"updatedAt":{"type":"number"},"source":{"type":"string"}},"required":["text"]}},"truncated":{"type":"boolean"},"thoughtSummaryEnabled":{"type":"boolean"}},"required":["ok"]}}},{"id":"dsh-agy-bridge#antigravityBridge/authStatus","package":"dsh-agy-bridge","service":"antigravityBridge","namespace":"antigravityBridge","method":"authStatus","invocation":{"kind":"direct"},"parameters":[],"result":{"__codec":true,"typeSymbol":"bridge:AuthStatusResult","jsonSchema":{"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean"},"reused":{"type":"boolean"},"jobId":{"type":"string"},"status":{"type":"string"},"code":{"type":"string"},"message":{"type":"string"},"view":{"type":"object","additionalProperties":false,"properties":{"jobId":{"type":"string"},"transport":{"type":"string"},"state":{"type":"string"},"status":{"type":"string"},"conversationId":{"type":"string"},"sessionId":{"type":"string"},"desktopConversationId":{"type":"string"},"targetKind":{"type":"string"},"title":{"type":"string"},"code":{"type":"string"},"message":{"type":"string"},"wakeState":{"type":"string"},"stopReason":{"type":"string"},"cancelRequested":{"type":"boolean"},"permissionPending":{"type":"boolean"},"reply":{"type":"string"},"fileMode":{"type":"string"},"detail":{"type":"object","additionalProperties":false,"properties":{"phase":{"type":"string"}},"required":["phase"]},"requested":{"type":"object","additionalProperties":true},"effective":{"type":"object","additionalProperties":true},"confirmed":{"type":"object","additionalProperties":true},"permissions":{"type":"array","items":{"type":"object","additionalProperties":true}},"configOptions":{"type":"array","items":{"type":"object","additionalProperties":true}},"createdAt":{"type":"number"},"updatedAt":{"type":"number"}},"required":["jobId","state"]},"available":{"type":"boolean"},"text":{"type":"string"},"state":{"type":"string"},"cached":{"type":"boolean"},"cancelSent":{"type":"boolean"},"settled":{"type":"boolean"},"stopControl":{"type":"string"},"capabilities":{"type":"object","additionalProperties":true},"authStatus":{"type":"string"},"authMethods":{"type":"array","items":{"type":"object","additionalProperties":true}},"installation":{"type":"string"},"executable":{"type":"string"},"version":{"type":"string"},"dataDir":{"oneOf":[{"type":"string"},{"type":"null"}]},"dataDirWritable":{"type":"boolean"},"dataDirError":{"oneOf":[{"type":"string"},{"type":"null"}]},"reasonCode":{"oneOf":[{"type":"string"},{"type":"null"}]},"probe":{"type":"object","additionalProperties":false,"properties":{"authMethodCount":{"type":"number"},"sessionProbe":{"type":"string","enum":["ok","failed","skipped"]},"verifiedStatus":{"oneOf":[{"type":"string"},{"type":"null"}]}},"required":["authMethodCount","sessionProbe","verifiedStatus"]},"flow":{"type":"string"},"methodId":{"type":"string"},"command":{"type":"string"},"events":{"type":"array","items":{"type":"object","additionalProperties":false,"properties":{"toolCallId":{"type":"string"},"kind":{"type":"string","enum":["execute","edit","read","other","unknown"]},"title":{"type":"string"},"status":{"type":"string"},"updatedAt":{"type":"number"},"source":{"type":"string"}},"required":["toolCallId","kind","title","status"]}},"thoughts":{"type":"array","items":{"type":"object","additionalProperties":false,"properties":{"text":{"type":"string"},"updatedAt":{"type":"number"},"source":{"type":"string"}},"required":["text"]}},"truncated":{"type":"boolean"},"thoughtSummaryEnabled":{"type":"boolean"}},"required":["ok"]}}},{"id":"dsh-agy-bridge#antigravityBridge/login","package":"dsh-agy-bridge","service":"antigravityBridge","namespace":"antigravityBridge","method":"login","invocation":{"kind":"direct"},"parameters":[],"result":{"__codec":true,"typeSymbol":"bridge:LoginResult","jsonSchema":{"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean"},"reused":{"type":"boolean"},"jobId":{"type":"string"},"status":{"type":"string"},"code":{"type":"string"},"message":{"type":"string"},"view":{"type":"object","additionalProperties":false,"properties":{"jobId":{"type":"string"},"transport":{"type":"string"},"state":{"type":"string"},"status":{"type":"string"},"conversationId":{"type":"string"},"sessionId":{"type":"string"},"desktopConversationId":{"type":"string"},"targetKind":{"type":"string"},"title":{"type":"string"},"code":{"type":"string"},"message":{"type":"string"},"wakeState":{"type":"string"},"stopReason":{"type":"string"},"cancelRequested":{"type":"boolean"},"permissionPending":{"type":"boolean"},"reply":{"type":"string"},"fileMode":{"type":"string"},"detail":{"type":"object","additionalProperties":false,"properties":{"phase":{"type":"string"}},"required":["phase"]},"requested":{"type":"object","additionalProperties":true},"effective":{"type":"object","additionalProperties":true},"confirmed":{"type":"object","additionalProperties":true},"permissions":{"type":"array","items":{"type":"object","additionalProperties":true}},"configOptions":{"type":"array","items":{"type":"object","additionalProperties":true}},"createdAt":{"type":"number"},"updatedAt":{"type":"number"}},"required":["jobId","state"]},"available":{"type":"boolean"},"text":{"type":"string"},"state":{"type":"string"},"cached":{"type":"boolean"},"cancelSent":{"type":"boolean"},"settled":{"type":"boolean"},"stopControl":{"type":"string"},"capabilities":{"type":"object","additionalProperties":true},"authStatus":{"type":"string"},"authMethods":{"type":"array","items":{"type":"object","additionalProperties":true}},"installation":{"type":"string"},"executable":{"type":"string"},"version":{"type":"string"},"dataDir":{"oneOf":[{"type":"string"},{"type":"null"}]},"dataDirWritable":{"type":"boolean"},"dataDirError":{"oneOf":[{"type":"string"},{"type":"null"}]},"reasonCode":{"oneOf":[{"type":"string"},{"type":"null"}]},"probe":{"type":"object","additionalProperties":false,"properties":{"authMethodCount":{"type":"number"},"sessionProbe":{"type":"string","enum":["ok","failed","skipped"]},"verifiedStatus":{"oneOf":[{"type":"string"},{"type":"null"}]}},"required":["authMethodCount","sessionProbe","verifiedStatus"]},"flow":{"type":"string"},"methodId":{"type":"string"},"command":{"type":"string"},"events":{"type":"array","items":{"type":"object","additionalProperties":false,"properties":{"toolCallId":{"type":"string"},"kind":{"type":"string","enum":["execute","edit","read","other","unknown"]},"title":{"type":"string"},"status":{"type":"string"},"updatedAt":{"type":"number"},"source":{"type":"string"}},"required":["toolCallId","kind","title","status"]}},"thoughts":{"type":"array","items":{"type":"object","additionalProperties":false,"properties":{"text":{"type":"string"},"updatedAt":{"type":"number"},"source":{"type":"string"}},"required":["text"]}},"truncated":{"type":"boolean"},"thoughtSummaryEnabled":{"type":"boolean"}},"required":["ok"]}}}]});
      return {
        name: "dsh-agy-bridge",
        inject: ['slots', 'locale', 'remote'],
        apply: function apply(ctx) {
          ctx.effect(function () {
            var dispose = ctx.locale.register(localeApi.PANEL_NAMESPACE, {
              zh: Object.assign({}, localeApi.DICTIONARIES.zh, panelApi.SIDEBAR_COPY.zh),
              en: Object.assign({}, localeApi.DICTIONARIES.en, panelApi.SIDEBAR_COPY.en),
            });
            return typeof dispose === 'function' ? dispose : function () {};
          });
          ctx.effect(function () {
            var disposed = false;
            var unmount = null;
            if (!ctx.remote || typeof ctx.remote.$mount !== "function") {
              return function () {};
            }
            Promise.resolve(ctx.remote.$mount(TYPERT_REMOTE)).then(function (result) {
              if (disposed) { if (typeof result === 'function') result(); return; }
              unmount = typeof result === 'function' ? result : null;
            }, function () { /* mount failures surface as remote_unavailable */ });
            return function () {
              disposed = true;
              if (unmount) { unmount(); unmount = null; }
            };
          });
          var bridge = panelApi.createRemoteBridge(ctx, "antigravityBridge");
          var translate = localeApi.bindTranslator(ctx);
          var getUploader = function () { return ctx.get('fileUpload'); };
          var Panel = panelApi.createPanelComponent({ React: React, translate: translate, bridge: bridge, getUploader: getUploader });
          var SidebarIcon = panelApi.createSidebarIcon(React);
          var SidebarPage = panelApi.createSidebarPage({
            React: React, translate: translate, Panel: Panel, bridge: bridge,
            retainSession: function (sessionId) {
              var sessions = ctx.get('sessions');
              if (!sessions || !sessions.retain) throw new Error('scope_unavailable');
              return sessions.retain(sessionId, { source: 'antigravityBridgePanel' });
            },
          });
          ctx.slots.inject('main', function () {
            return ctx.slots.inject(panelApi.PANEL_SLOT, function () {
              var stopMain = ctx.slots.register({ name: 'main', key: panelApi.PANEL_ID }, SidebarPage);
              var stopIcon;
              try {
                stopIcon = ctx.slots.register(Object.assign({}, panelApi.PANEL_REGISTRATION, {
                  label: function () { return 'Antigravity'; },
                }), SidebarIcon);
              } catch (error) {
                stopMain();
                throw error;
              }
              return function () { stopIcon(); stopMain(); };
            });
          });
        },
      };
    },
  });
})();
