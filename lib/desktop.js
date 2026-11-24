/**
 * Explicit desktop transport.
 *
 * ACP stays the default and the only route the model tools use unless the
 * caller asks for `transport: 'desktop'`. This module then drives the already
 * running Antigravity desktop window through the bundled Windows UIA driver
 * (`lib/uia-driver.ps1`, one JSON in / one JSON out) and decides the reply with
 * the frozen attribution module (`lib/desktop-attribution.js`).
 *
 * Boundaries, all deliberate:
 *
 * - The target is a pinned five-tuple (pid, process start time, HWND, document
 *   URI, and the unique session link the driver verifies). Nothing scans for a
 *   window at dispatch time, so a rebuilt window or another document can never
 *   silently receive the task.
 * - The driver is invoked once per observation with `action: 'inspect'`, and
 *   exactly once with `action: 'dispatch'`. A non-`invoked` outcome is final:
 *   it is never retried and never turned into a second write.
 * - A job is delivered/woken only after the round was observed running (busy
 *   or permission) and two complete idle snapshots agree on the final text.
 *   Progress, stale text, timeouts and ambiguous results never wake anyone.
 * - No private RPC, database, credential or upstream proxy is involved.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createBaseline,
  createTracker,
  toJobUpdate,
} from './desktop-attribution.js'

export const DESKTOP_TRANSPORT = 'desktop'
export const DEFAULT_DRIVER_NAME = 'uia-driver.ps1'
export const DRIVER_VERSION_EXPECTED = '1.0.0'

const LIB_DIR = dirname(fileURLToPath(import.meta.url))

/** Failures that happened before the UIA Send invoke: safe to report not_sent. */
function notSentError(code, message, detail) {
  return Object.assign(new Error(message), {
    code,
    phase: 'before_write',
    ...(detail !== undefined ? { detail } : {}),
  })
}

/**
 * 桌面错误码归一对照表（v1，同一语义全仓只留一个码）：
 * - uri_mismatch / target_mismatch / process_not_found / window_not_found / desktop_document_unverified / targetKey 变化 -> desktop_target_changed (附 detail.driftField ∈ {pid, startedAt, hwnd, uri})
 * - session_link_ambiguous / desktop_session_ambiguous / session_link_not_found / desktop_session_unverified -> desktop_target_unverified
 * - permission_prompt / awaiting_permission (markPermissionPending & observe 超时) -> desktop_permission_pending
 * - web-remote desktop.enabled=false -> desktop_disabled (不再混用 unsupported_capability)
 */
const DRIFT_CODE_FIELD = {
  uri_mismatch: 'uri',
  desktop_document_unverified: 'uri',
  target_mismatch: 'uri',
  process_not_found: 'pid',
  window_not_found: 'hwnd',
}
const VALID_DRIFT_FIELDS = new Set(['pid', 'startedAt', 'hwnd', 'uri'])

function normalizeDesktopError(rawCode, detail, fallbackCode = 'desktop_target_unverified') {
  const code = typeof rawCode === 'string' && rawCode.trim() !== '' ? rawCode.trim() : fallbackCode
  if (Object.hasOwn(DRIFT_CODE_FIELD, code) || code === 'desktop_target_changed') {
    const rawField = typeof detail?.driftField === 'string' ? detail.driftField : typeof detail?.field === 'string' ? detail.field : ''
    const driftField = VALID_DRIFT_FIELDS.has(rawField) ? rawField : (DRIFT_CODE_FIELD[code] ?? 'uri')
    return { code: 'desktop_target_changed', detail: { ...(detail && typeof detail === 'object' ? detail : {}), driftField } }
  }
  if (
    code === 'session_link_ambiguous' ||
    code === 'desktop_session_ambiguous' ||
    code === 'session_link_not_found' ||
    code === 'desktop_session_unverified'
  ) {
    return { code: 'desktop_target_unverified', detail }
  }
  if (code === 'permission_prompt' || code === 'awaiting_permission') {
    return { code: 'desktop_permission_pending', detail }
  }
  return { code, detail }
}

/** Failures after a possible invoke: the job must stay queryable, never resent. */
function unknownError(code, message) {
  return Object.assign(new Error(message), { code, phase: 'after_write' })
}

export function defaultDesktopConfig() {
  return {
    /** Opt-in. Nothing in this module runs while this is false. */
    enabled: false,
    /** '' resolves to the bundled uia-driver.ps1 next to this file. */
    driverPath: '',
    powershell: 'pwsh',
    /** Hard limit for one driver invocation (inspect or dispatch). */
    timeoutMs: 20000,
    /** Observation cadence after an invoked dispatch. */
    pollMs: 2500,
    /** Stop observing after this long; the job stays acceptance_unknown. */
    replyTimeoutMs: 600000,
    /** Pinned window identity: {pid, startedAt, hwnd, uri}. */
    target: null,
    /** Extra environment for the driver process (offline tests inject a fake UIA scenario). */
    env: null,
  }
}

function requirePositiveInt(value, label) {
  const parsed = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw notSentError('desktop_target_invalid', `${label} must be a positive integer`)
  }
  return parsed
}

function parseHwnd(value) {
  if (typeof value === 'number') return requirePositiveInt(value, 'target.hwnd')
  if (typeof value === 'string') {
    const text = value.trim()
    const parsed = /^0x[0-9a-f]+$/i.test(text) ? Number.parseInt(text, 16) : Number(text)
    return requirePositiveInt(parsed, 'target.hwnd')
  }
  throw notSentError('desktop_target_invalid', 'target.hwnd must be a number or a hex string')
}

/**
 * Normalize a configured target. Missing pieces are configuration errors, not
 * guesses: the transport never discovers a target on its own.
 */
export function normalizeDesktopTarget(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw notSentError(
      'desktop_target_not_configured',
      'desktop transport requires config.desktop.target = {pid, startedAt, hwnd, uri}; nothing was sent.',
    )
  }
  const pid = requirePositiveInt(raw.pid, 'target.pid')
  const hwnd = parseHwnd(raw.hwnd)
  const startedAt = typeof raw.startedAt === 'string' ? raw.startedAt.trim() : ''
  if (startedAt === '') throw notSentError('desktop_target_invalid', 'target.startedAt must be an ISO timestamp')
  if (Number.isNaN(Date.parse(startedAt))) {
    throw notSentError('desktop_target_invalid', 'target.startedAt is not a parseable timestamp')
  }
  const uri = typeof raw.uri === 'string' ? raw.uri.trim() : ''
  let parsed
  try {
    parsed = new URL(uri)
  } catch {
    throw notSentError('desktop_target_invalid', 'target.uri must be an absolute http(s) document URI')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw notSentError('desktop_target_invalid', 'target.uri must be an absolute http(s) document URI')
  }
  return { pid, startedAt, hwnd, uri }
}

/**
 * Stable lock key for one pinned window, derived without touching the app.
 * The driver's own `targetKey` (aguia1:…) is stored on the job once known; this
 * key only serializes dispatch intents on the same target.
 */
export function desktopLockKey(target) {
  return `desktop:${target.pid}:${target.startedAt}:${target.hwnd}`
}

/**
 * Compare two desktop targets across {pid, startedAt, hwnd, uri} and return
 * the list of drifted field names.
 */
export function driftFields(expected, actual) {
  if (!expected || !actual) return ['pid', 'startedAt', 'hwnd', 'uri']
  const drifted = []
  if (Number(expected.pid) !== Number(actual.pid)) drifted.push('pid')
  const expMs = Date.parse(expected.startedAt ?? '')
  const actMs = Date.parse(actual.startedAt ?? '')
  if (Number.isNaN(expMs) || Number.isNaN(actMs) || Math.abs(expMs - actMs) > 2000) {
    drifted.push('startedAt')
  }
  try {
    if (parseHwnd(expected.hwnd) !== parseHwnd(actual.hwnd)) drifted.push('hwnd')
  } catch {
    if (String(expected.hwnd) !== String(actual.hwnd)) drifted.push('hwnd')
  }
  if (String(expected.uri ?? '').split('#')[0] !== String(actual.uri ?? '').split('#')[0]) {
    drifted.push('uri')
  }
  return drifted
}

/** Turn a driver snapshot into the frozen attribution snapshot contract. */
export function attributionSnapshot(raw, expectedTargetKey = '') {
  const turns = Array.isArray(raw?.turns)
    ? raw.turns
        .filter((turn) => turn && (turn.role === 'user' || turn.role === 'assistant'))
        .map((turn) => ({ role: turn.role, text: typeof turn.text === 'string' ? turn.text : '' }))
        .filter((turn) => turn.text !== '')
    : []
  const phase = raw?.phase === 'idle' || raw?.phase === 'busy' || raw?.phase === 'permission' ? raw.phase : 'unknown'
  return {
    targetKey: typeof raw?.targetKey === 'string' && raw.targetKey !== '' ? raw.targetKey : expectedTargetKey,
    turns,
    phase,
    // `history.complete` is the harvest completeness. The driver's root
    // `complete` is "stable ending" and must not be mistaken for it.
    complete: raw?.history?.complete === true,
  }
}

function lastAssistantText(turns) {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index].role === 'assistant') return turns[index].text
  }
  return ''
}

function userTurnCount(turns) {
  let count = 0
  for (const turn of turns) if (turn.role === 'user') count += 1
  return count
}

function sameTurns(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]?.role !== right[index]?.role || left[index]?.text !== right[index]?.text) return false
  }
  return true
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(finish, ms)
    function finish() {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', finish)
      resolve()
    }
    signal?.addEventListener?.('abort', finish, { once: true })
  })
}

/**
 * Spawn one PowerShell invocation per request. The message is passed inside the
 * JSON body on stdin and is never interpolated into a command line.
 */
export function createDriverProcess({
  powershell = 'pwsh',
  driverPath,
  timeoutMs = 20000,
  spawnImpl = spawn,
  env = process.env,
} = {}) {
  if (typeof driverPath !== 'string' || driverPath === '') {
    throw new Error('antigravity-bridge: desktop driverPath is required')
  }
  return {
    driverPath,
    async run(request) {
      const args = [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        driverPath,
      ]
      return new Promise((resolve, reject) => {
        let child
        try {
          child = spawnImpl(powershell, args, {
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env,
          })
        } catch (error) {
          reject(
            Object.assign(new Error(`desktop driver could not start: ${error?.message ?? error}`), {
              code: 'driver_start_failed',
            }),
          )
          return
        }
        let stdout = ''
        let stderr = ''
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          try {
            child.kill()
          } catch {
            // Already gone.
          }
          reject(
            Object.assign(new Error(`desktop driver timed out after ${timeoutMs}ms`), {
              code: 'driver_timeout',
            }),
          )
        }, Math.max(1000, Number(timeoutMs) || 20000))
        child.stdout?.setEncoding?.('utf8')
        child.stdout?.on?.('data', (chunk) => {
          stdout += chunk
        })
        child.stderr?.setEncoding?.('utf8')
        child.stderr?.on?.('data', (chunk) => {
          stderr += chunk
        })
        child.on?.('error', (error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(
            Object.assign(new Error(`desktop driver failed: ${error?.message ?? error}`), {
              code: 'driver_start_failed',
            }),
          )
        })
        child.on?.('close', () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          const text = stdout.trim()
          if (text === '') {
            reject(
              Object.assign(
                new Error(`desktop driver produced no JSON${stderr ? `: ${stderr.trim().slice(0, 400)}` : ''}`),
                { code: 'driver_protocol_error' },
              ),
            )
            return
          }
          let parsed
          try {
            parsed = JSON.parse(text.split(/\r?\n/).filter(Boolean).pop())
          } catch (error) {
            reject(
              Object.assign(new Error(`desktop driver returned invalid JSON: ${error?.message ?? error}`), {
                code: 'driver_protocol_error',
              }),
            )
            return
          }
          resolve(parsed)
        })
        try {
          child.stdin?.end?.(JSON.stringify(request), 'utf8')
        } catch (error) {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(
            Object.assign(new Error(`desktop driver stdin failed: ${error?.message ?? error}`), {
              code: 'driver_start_failed',
            }),
          )
        }
      })
    },
  }
}

/**
 * The desktop transport for one Bridge instance.
 *
 * The Bridge owns jobs, ownership, wake and query; this channel only performs
 * the pinned-window operations and reports evidence back through the same
 * helpers the ACP path uses.
 */
export class DesktopChannel {
  constructor({ bridge, config, logger }) {
    this.bridge = bridge
    this.config = config ?? {}
    this.logger = logger
    this.desktop = { ...defaultDesktopConfig(), ...(this.config.desktop ?? {}) }
    this.controllers = new Map()
    this.stopped = false
    this.activeDriver = null
    if (this.desktop.driver && typeof this.desktop.driver.run === 'function') {
      // Injected runner (offline tests). Never a real window.
      this.activeDriver = this.desktop.driver
    }
  }

  get enabled() {
    return this.desktop.enabled === true
  }

  driverPath() {
    if (typeof this.desktop.driverPath === 'string' && this.desktop.driverPath !== '') {
      return this.desktop.driverPath
    }
    return join(LIB_DIR, DEFAULT_DRIVER_NAME)
  }

  driver() {
    if (this.activeDriver) return this.activeDriver
    const path = this.driverPath()
    if (!existsSync(path)) {
      throw notSentError('desktop_driver_missing', `desktop UIA driver not found: ${path}; nothing was sent.`)
    }
    this.activeDriver = createDriverProcess({
      powershell: this.desktop.powershell,
      driverPath: path,
      timeoutMs: this.desktop.timeoutMs,
      env: { ...process.env, ...(this.desktop.env ?? {}) },
    })
    return this.activeDriver
  }

  pinFilePath() {
    const stateFile = typeof this.config?.stateFile === 'string' ? this.config.stateFile.trim() : ''
    if (stateFile !== '') return join(dirname(stateFile), 'desktop-target.json')
    return join(homedir(), '.dsh-antigravity-bridge', 'desktop-target.json')
  }

  readPin() {
    const file = this.pinFilePath()
    if (!existsSync(file)) return null
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (!parsed || parsed.version !== 1 || typeof parsed.targetKey !== 'string' || typeof parsed.pinnedAt !== 'string') {
        throw new Error('invalid desktop-target.json schema')
      }
      const target = normalizeDesktopTarget(parsed.target)
      return { ...parsed, target }
    } catch (error) {
      this.logger?.warn?.(`[desktop] ignoring invalid desktop-target.json (${file}): ${error?.message ?? error}`)
      return null
    }
  }

  writePin(record) {
    const file = this.pinFilePath()
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8')
      renameSync(tmp, file)
    } catch (error) {
      try { unlinkSync(tmp) } catch {}
      throw notSentError('state_write_failed', `failed to persist desktop-target.json: ${error?.message ?? error}`)
    }
  }

  clearPin() {
    const file = this.pinFilePath()
    if (!existsSync(file)) return false
    try {
      unlinkSync(file)
      return true
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw notSentError('state_write_failed', `failed to remove desktop-target.json: ${error?.message ?? error}`)
    }
  }

  effectiveTarget() {
    const pin = this.readPin()
    if (pin) return pin.target
    if (this.desktop.target) return normalizeDesktopTarget(this.desktop.target)
    return null
  }

  target() {
    if (!this.enabled) {
      throw notSentError(
        'desktop_disabled',
        'desktop transport is disabled; ACP is the default. Set config.desktop.enabled = true and pin a target first.',
      )
    }
    return normalizeDesktopTarget(this.effectiveTarget())
  }

  /** Public capability block: only what has been verified for the desktop path. */
  capabilities() {
    const configured = this.enabled ? this.publicTarget() : null
    return {
      transports: this.enabled ? ['acp', DESKTOP_TRANSPORT] : ['acp'],
      desktop: this.enabled,
      target: configured,
      models: [],
      efforts: [],
      attachments: { pathRefs: true, native: false },
      profile: false,
      modelSelection: 'unavailable_on_desktop',
      effortSelection: 'unavailable_on_desktop',
      evidence: 'uia-driver 1.0.0 offline suite; live single-turn Send verified 2026-11-25 (reply delivered); permission controls / multi-turn unverified',
    }
  }

  publicTarget() {
    try {
      const target = this.effectiveTarget()
      if (!target) return null
      return { ...target, uri: redactUri(target.uri) }
    } catch {
      return null
    }
  }

  async discover({ hwnd, pid } = {}) {
    let driver
    let listRes
    try {
      driver = this.driver()
      listRes = await driver.run({ action: 'inspect' })
    } catch (error) {
      return {
        ok: false,
        code: error?.code ?? 'desktop_target_unverified',
        message: error?.message ?? 'failed to invoke desktop driver',
        candidates: [],
      }
    }
    if (!listRes || listRes.ok !== true) {
      const norm = normalizeDesktopError(listRes?.code, listRes?.detail, 'desktop_target_unverified')
      return {
        ok: false,
        code: norm.code,
        message: listRes?.message ?? 'failed to enumerate desktop window candidates',
        ...(norm.detail !== undefined ? { detail: norm.detail } : {}),
        candidates: [],
      }
    }
    const rawCandidates = Array.isArray(listRes.candidates) ? listRes.candidates : []
    const expectedHwnd = hwnd !== undefined ? parseHwnd(hwnd) : null
    const expectedPid = pid !== undefined ? requirePositiveInt(pid, 'pid') : null
    const filtered = rawCandidates.filter((c) => {
      if (!c || typeof c !== 'object') return false
      if (c.window?.visible === false) return false
      if ((c.window?.cloaked ?? 0) !== 0) return false
      if (c.window?.minimized === true) return false
      if (c.executableOk === false || c.exeAllowed === false) return false
      if (expectedPid !== null && Number(c.pid) !== expectedPid) return false
      if (expectedHwnd !== null) {
        try {
          if (parseHwnd(c.hwnd) !== expectedHwnd) return false
        } catch {
          return false
        }
      }
      return true
    })
    if (filtered.length === 0) {
      return {
        ok: false,
        code: 'desktop_target_unverified',
        message: 'no eligible Antigravity desktop window candidate found',
        candidates: [],
      }
    }
    if (filtered.length > 1 && expectedHwnd === null) {
      return {
        ok: false,
        code: 'desktop_target_ambiguous',
        message: `found ${filtered.length} desktop window candidates; specify hwnd to pin one`,
        candidates: filtered.map((c) => ({
          pid: c.pid,
          startedAt: c.startedAt,
          hwnd: c.hwnd,
          redactedUri: c.uri ? redactUri(c.uri) : '',
          isForeground: Boolean(c.isForeground),
        })),
      }
    }
    const chosen = filtered[0]
    let probeRes
    try {
      probeRes = await driver.run({
        action: 'probe_window',
        target: { pid: chosen.pid, startedAt: chosen.startedAt, hwnd: chosen.hwnd },
      })
    } catch (error) {
      return {
        ok: false,
        code: error?.code ?? 'desktop_target_unverified',
        message: error?.message ?? 'probe_window failed',
      }
    }
    if (!probeRes || probeRes.ok !== true) {
      const norm = normalizeDesktopError(probeRes?.code, probeRes?.detail, 'desktop_target_unverified')
      return {
        ok: false,
        code: norm.code,
        message: probeRes?.message ?? 'probe_window failed',
        ...(norm.detail !== undefined ? { detail: norm.detail } : {}),
      }
    }
    return {
      ok: true,
      target: normalizeDesktopTarget(probeRes.target),
      targetKey: probeRes.targetKey,
      verified: probeRes.verified,
      diagnostics: probeRes.diagnostics,
    }
  }

  async pin({ hwnd, pid } = {}) {
    const discovered = await this.discover({ hwnd, pid })
    if (!discovered.ok) return discovered
    const record = {
      version: 1,
      pinnedAt: new Date().toISOString(),
      target: discovered.target,
      targetKey: discovered.targetKey,
      evidence: {
        verified: discovered.verified,
        diagnostics: discovered.diagnostics,
      },
    }
    try {
      this.writePin(record)
    } catch (error) {
      return {
        ok: false,
        code: error?.code ?? 'state_write_failed',
        message: error?.message ?? String(error),
      }
    }
    return { ok: true, ...record }
  }

  /** 只读状态探测（不写 pin），供工具与 web-remote 共用。 */
  async statusSnapshot({ includeCandidates = false } = {}) {
    const pin = this.readPin()
    const target = this.effectiveTarget()
    const redacted = target ? { ...target, uri: redactUri(target.uri) } : null
    let verified = false
    let code = target ? undefined : 'desktop_target_not_configured'
    let message = target ? undefined : 'desktop target is not configured'
    let detail
    if (target) {
      try {
        const driver = this.driver()
        const probeRes = await driver.run({
          action: 'probe_window',
          target: { pid: target.pid, startedAt: target.startedAt, hwnd: target.hwnd },
        })
        if (probeRes && probeRes.ok === true) {
          const drift = driftFields(target, probeRes.target)
          if (drift.length > 0) {
            code = 'desktop_target_changed'
            detail = { driftField: drift[0], driftFields: drift }
            message = `desktop target drifted on ${drift[0]}`
          } else {
            verified = true
          }
        } else {
          const norm = normalizeDesktopError(probeRes?.code, probeRes?.detail, 'desktop_target_unverified')
          code = norm.code
          detail = norm.detail
          message = probeRes?.message ?? 'desktop target probe failed'
        }
      } catch (error) {
        code = error?.code ?? 'desktop_target_unverified'
        message = error?.message ?? String(error)
      }
    }
    let candidates
    if (includeCandidates) {
      try {
        const driver = this.driver()
        const listRes = await driver.run({ action: 'inspect' })
        if (listRes && listRes.ok === true && Array.isArray(listRes.candidates)) {
          candidates = listRes.candidates.map((c) => ({
            pid: c.pid,
            startedAt: c.startedAt,
            hwnd: c.hwnd,
            redactedUri: c.uri ? redactUri(c.uri) : '',
            isForeground: Boolean(c.isForeground),
          }))
        } else {
          candidates = []
        }
      } catch {
        candidates = []
      }
    }
    return {
      ok: true,
      enabled: this.enabled,
      target: redacted,
      pinned: Boolean(pin),
      verified,
      ...(code ? { code } : {}),
      ...(message ? { message } : {}),
      ...(detail !== undefined ? { detail } : {}),
      ...(candidates !== undefined ? { candidates } : {}),
    }
  }

  /** 固定或清除桌面目标（工具与 web-remote 共用同一路径）。 */
  async pinAction({ action = 'pin', hwnd, pid } = {}) {
    if (action === 'clear') {
      try {
        this.clearPin()
        return { ok: true, pinned: false, fallbackTarget: this.publicTarget() }
      } catch (error) {
        return {
          ok: false,
          pinned: Boolean(this.readPin()),
          code: error?.code ?? 'state_write_failed',
          message: error?.message ?? String(error),
        }
      }
    }
    if (action !== 'pin') {
      return { ok: false, pinned: Boolean(this.readPin()), code: 'invalid_request', message: `unknown action: ${action}` }
    }
    const res = await this.pin({ hwnd, pid })
    if (!res.ok) return { ...res, pinned: false }
    return {
      ok: true,
      pinned: true,
      target: res.target,
      targetKey: res.targetKey,
      evidence: res.evidence,
    }
  }

  /** New job fields for a desktop dispatch (called from Bridge.beginSend). */
  jobFields() {
    const target = this.target()
    return {
      transport: DESKTOP_TRANSPORT,
      targetKind: 'desktop_window',
      desktopLockKey: desktopLockKey(target),
      target,
    }
  }

  async inspect(driver, target, hint) {
    const request = { action: 'inspect', target }
    if (hint) request.baseline = hint
    const result = await driver.run(request)
    if (!result || result.ok !== true) {
      const norm = normalizeDesktopError(result?.code, result?.detail, 'desktop_target_unverified')
      throw notSentError(
        norm.code,
        `desktop inspect failed: ${result?.message ?? 'no result'}; nothing was sent.`,
        norm.detail,
      )
    }
    const verified = result.verified ?? {}
    if (verified.process !== true || verified.startTime !== true || verified.executable !== true || verified.window !== true) {
      throw notSentError('desktop_target_unverified', 'desktop window identity could not be verified; nothing was sent.')
    }
    if (verified.documentUri !== true) {
      throw notSentError('desktop_target_changed', 'the current document URI is not the pinned one; nothing was sent.', {
        driftField: 'uri',
      })
    }
    if (verified.sessionLink === 'ambiguous') {
      throw notSentError('desktop_target_unverified', 'more than one session link matches the document; refusing to guess.')
    }
    if (verified.sessionLink !== 'unique') {
      throw notSentError('desktop_target_unverified', 'the unique session link for this document was not found; nothing was sent.')
    }
    return result
  }

  /**
   * Two consecutive read-only observations before the one allowed write.
   *
   * The first inspect carries no baseline, so it cannot prove a *stable
   * ending* (`complete`); it can prove the window is harvestable and idle
   * (`phase === 'idle'`, complete history, no stop control, no permission
   * card). The second read must agree, including the whole turn list, before
   * this counts as a safe baseline for attribution.
   */
  async preflight(driver, target) {
    const read = async (hint, label) => {
      const result = await this.inspect(driver, target, hint)
      const raw = result.snapshot ?? {}
      const snapshot = attributionSnapshot(raw, result.targetKey ?? '')
      const evidence = raw.evidence ?? {}
      const unreadable = Array.isArray(raw.unreadable) ? raw.unreadable : []
      const logFound = !unreadable.includes('conversation_log_not_found')
      const harvestComplete = raw.history?.complete === true
      const noStopControl = evidence.stopControl === false
      const noPermissionCard = evidence.permissionCard === false
      // The driver's own `idle` needs a baseline (a stable ending), which the
      // first pre-dispatch read cannot have. A new round may still be written
      // when the log is readable, the harvest is complete and neither a stop
      // control nor a permission card is present. The second read must agree;
      // `complete` (stable ending) is only produced *after* the round.
      const explicitIdle = snapshot.phase === 'idle'
      const inferredIdle =
        snapshot.phase === 'unknown' && logFound && harvestComplete && noStopControl && noPermissionCard
      if (!explicitIdle && !inferredIdle) {
        throw notSentError(
          'desktop_not_idle',
          `desktop session is ${snapshot.phase} on the ${label} pre-dispatch read, not provably idle; a reply could not be attributed to a new round. Nothing was sent.`,
        )
      }
      if (!harvestComplete) {
        throw notSentError(
          'desktop_history_incomplete',
          `desktop history could not be harvested completely on the ${label} pre-dispatch read (virtualized or mid-render); nothing was sent.`,
        )
      }
      return { snapshot, raw }
    }

    const first = await read(undefined, 'first')
    await sleep(300)
    const second = await read(this.hintFrom(first.raw), 'second')
    if (second.snapshot.targetKey !== first.snapshot.targetKey) {
      throw notSentError(
        'desktop_target_changed',
        'the desktop window switched sessions between the two pre-dispatch reads; nothing was sent.',
        { driftField: 'uri' },
      )
    }
    if (!sameTurns(first.snapshot.turns, second.snapshot.turns)) {
      throw notSentError(
        'desktop_not_idle',
        'the desktop conversation changed between the two pre-dispatch reads, so the baseline is not stable; nothing was sent.',
      )
    }
    // Attribution only needs "a new round may start here"; both reads proved
    // that. `complete` (stable ending) becomes meaningful after the write.
    return {
      ...second.snapshot,
      phase: 'idle',
      idleBasis: second.snapshot.phase === 'idle' ? 'driver_idle' : 'no_stop+complete_harvest+stable_double_read',
    }
  }

  /**
   * Run one desktop round. Called by Bridge.dispatch for transport desktop.
   * Returns the job; every terminal decision goes through Bridge helpers so the
   * persisted record, wake state and ownership stay identical to the ACP path.
   */
  async dispatch(job, { message, requested = {} }) {
    const target = this.target()
    if (typeof message !== 'string' || message.trim() === '') {
      throw notSentError('invalid_request', 'message is empty')
    }
    if (requested.model || requested.effort) {
      throw notSentError(
        'unsupported_capability',
        'desktop transport has no verified model/effort switch; use ACP for model or effort selection. Nothing was sent.',
      )
    }
    if (Array.isArray(requested.attachments) && requested.attachments.length > 0) {
      throw notSentError(
        'unsupported_capability',
        'desktop transport has no verified native attachment upload; pass path_refs instead. Nothing was sent.',
      )
    }
    const driver = this.driver()
    const baselineSnapshot = await this.preflight(driver, target)
    let baseline
    try {
      baseline = createBaseline(baselineSnapshot)
    } catch (error) {
      throw notSentError(
        error?.code ?? 'baseline_unsafe',
        `desktop baseline rejected: ${error?.message ?? error}; nothing was sent.`,
      )
    }

    // Pin the window and the in-flight phase *before* the write. If this cannot
    // be persisted the round is aborted: otherwise a restart would forget the
    // job and its lock while the app may already have received the message.
    job.desktopConversationId = String(baselineSnapshot.targetKey)
    job.targetKey = baselineSnapshot.targetKey
    job.phase = 'prompting'
    job.updatedAt = new Date().toISOString()
    if (this.bridge.save() !== true) {
      throw notSentError(
        'state_write_failed',
        'bridge state could not be persisted before the desktop write; nothing was sent. Fix the state file and retry.',
      )
    }

    const tracker = createTracker({
      dispatchText: message,
      baseline,
      jobId: job.jobId,
    })
    const sent = await driver.run({ action: 'dispatch', target, message })
    if (!sent || typeof sent.status !== 'string') {
      this.bridge.markAcceptanceUnknown(job, {
        code: 'desktop_driver_protocol',
        message: 'The desktop driver returned no dispatch status; the request may have been written. Not retried.',
      })
      return job
    }
    if (sent.status === 'not_sent') {
      this.bridge.markFailure(job, 'not_sent', {
        code: String(sent.reason ?? sent.code ?? 'desktop_not_sent'),
        message: `桌面派发没有发出：${describeDriverRefusal(sent)}`,
      })
      return job
    }
    if (sent.status === 'acceptance_unknown') {
      this.bridge.markAcceptanceUnknown(job, {
        code: 'desktop_acceptance_unknown',
        message: `桌面派发的受理无法确认（${describeDriverRefusal(sent)}）；不重发、不唤醒，可按 job_id 查询。`,
      })
      return job
    }
    this.bridge.markAccepted(job, {
      code: 'desktop_invoked',
      message: '桌面 UIA Send 已调用一次；本轮是否受理与最终回复由后续稳定快照归属验证。',
      ackEvidence: 'desktop_uia_invoke',
    })
    // The durable Send result is returned now; observation is an independent
    // active promise, exactly like the ACP path. wait=false and short tool
    // timeouts therefore never delay the caller or hide the jobId.
    const observation = this.observe(job, { driver, target, tracker, message })
    void observation.catch((error) => {
      this.bridge.trace(
        "desktop-observe-failed job=" + job.jobId + " error=" + (error?.message ?? error),
      )
      if (!this.isCurrent(job)) return
      this.bridge.markAcceptanceUnknown(job, {
        code: 'desktop_observation_failed',
        message: '桌面观察循环异常结束；Send 已发出过，结果不明，保留为可查询且不重发。',
      })
    })
    return job
  }

  async observe(job, { driver, target, tracker, message }) {
    if (!this.isCurrent(job)) return job
    const controller = new AbortController()
    const pollMs = Math.max(100, Number(this.desktop.pollMs) || 2500)
    const deadline = Date.now() + Math.max(pollMs, Number(this.desktop.replyTimeoutMs) || 600000)
    let hint = this.hintFrom(tracker.baseline ?? null)
    let lastVerdict = null
    let lastSnapshot = null
    const promise = (async () => {
      try {
        for (;;) {
          if (!this.isCurrent(job)) return job
          if (controller.signal.aborted || job.cancelRequested === true) return this.finishCancelled(job)
          const remaining = deadline - Date.now()
          if (remaining <= 0) {
            if (!this.isCurrent(job)) return job
            if (job.permissionPending === true) {
              // A permission card is a known state, not an unknown outcome: keep
              // the job accepted and queryable so the user can act and re-check.
              job.code = 'desktop_permission_pending'
              job.message =
                '桌面会话停在权限提示上；请在 Antigravity 窗口处理权限后重新查询。不会自动批准，也不唤醒。'
              job.updatedAt = new Date().toISOString()
              this.bridge.save()
              return job
            }
            const v = lastVerdict ?? tracker.last?.() ?? null
            job.detail = {
              turnCount: lastSnapshot?.turns?.length ?? v?.observed?.turnCount ?? null,
              roundMatched: Boolean(v?.round),
              turnIndex: v?.round?.turnIndex ?? null,
              assistantTurns: v?.round?.assistantTurns ?? null,
              idleConfirmations: v?.round?.idleConfirmations ?? 0,
              observedRunning: v?.round?.activity?.observedRunning ?? false,
              lastCode: v?.code ?? null,
              lastDetail: v?.detail ?? null,
            }
            this.bridge.markAcceptanceUnknown(job, {
              code: 'desktop_reply_timeout',
              message:
                '观察窗口内没有取得可归属的最终回复；任务保留为结果不明，可查询，不重发、不唤醒。',
            })
            return job
          }
          await sleep(Math.min(pollMs, remaining), controller.signal)
          // Cancel and lifecycle are re-checked after every await: a page that
          // arrives after the user cancelled (or after dispose) must never
          // revive the round, commit state or wake anyone.
          if (controller.signal.aborted || job.cancelRequested === true) return this.finishCancelled(job)
          if (!this.isCurrent(job)) return job
          let page
          try {
            page = await driver.run({ action: 'inspect', target, baseline: hint })
          } catch (error) {
            this.bridge.trace('desktop-inspect-error job=' + job.jobId + ' error=' + (error?.message ?? error))
            continue
          }
          if (controller.signal.aborted || job.cancelRequested === true) return this.finishCancelled(job)
          if (!this.isCurrent(job)) return job
          if (!page || page.ok !== true) {
            this.bridge.trace('desktop-inspect-failed job=' + job.jobId + ' code=' + (page?.code ?? ''))
            continue
          }
          const snapshot = attributionSnapshot(page.snapshot, tracker.targetKey ?? '')
          lastSnapshot = snapshot
          hint = this.hintFrom(snapshot)
          if (snapshot.targetKey !== tracker.targetKey) {
            this.bridge.markAcceptanceUnknown(job, {
              code: 'desktop_target_changed',
              message: 'The verified desktop target changed while observing; this round cannot be attributed. Not retried.',
            })
            return job
          }
          let verdict
          try {
            verdict = tracker.observe(snapshot)
            lastVerdict = verdict
          } catch (error) {
            this.bridge.trace('desktop-attribution-error job=' + job.jobId + ' error=' + (error?.message ?? error))
            continue
          }
          if (controller.signal.aborted || job.cancelRequested === true) return this.finishCancelled(job)
          if (!this.isCurrent(job)) return job
          const applied = this.applyVerdict(job, verdict)
          if (verdict.state === 'replied' || applied === 'terminal') return job
        }
      } finally {
        this.controllers.delete(job.jobId)
        this.bridge.activePrompts.delete(job.jobId)
      }
    })()
    this.controllers.set(job.jobId, controller)
    this.bridge.activePrompts.set(job.jobId, {
      promise,
      sessionId: job.desktopConversationId ?? job.desktopLockKey ?? '',
      transport: DESKTOP_TRANSPORT,
    })
    return promise
  }

  /** A job stays usable only while both its channel and its owner are alive. */
  isCurrent(job) {
    if (this.stopped || this.bridge.closed === true) return false
    if (!job || typeof job.jobId !== 'string' || job.jobId === '') return false
    return this.bridge.job(job.jobId) === job
  }

  /** Stop local observation for every job. Never touches the app. */
  stop() {
    this.stopped = true
    for (const controller of this.controllers.values()) {
      try {
        controller.abort()
      } catch {
        // Aborting is best effort; the loop re-checks the stopped flag.
      }
    }
    this.controllers.clear()
  }

  hintFrom(snapshot) {
    if (!snapshot) return null
    return {
      observedAt: snapshot.observedAt ?? new Date().toISOString(),
      lastAssistantText: lastAssistantText(snapshot.turns ?? []),
      userTurnCount: userTurnCount(snapshot.turns ?? []),
    }
  }

  applyVerdict(job, verdict) {
    // Re-check identity and cancel intent at the last possible moment: the
    // verdict may be based on a page that raced with cancel or dispose.
    if (!this.isCurrent(job)) return 'stale'
    if (job.cancelRequested === true) {
      this.finishCancelled(job)
      return 'terminal'
    }
    const update = toJobUpdate(verdict)
    if (verdict.state === 'replied') {
      this.bridge.finishReply(job, {
        text: typeof verdict.reply === 'string' ? verdict.reply : '',
        stopReason: 'end_turn',
      })
      // Wake only while this instance still owns the job and the user has not
      // cancelled the round in the meantime.
      if (this.isCurrent(job) && job.cancelRequested !== true) {
        void this.bridge.maybeWake(job).catch((error) => {
          this.logger?.warn?.(`antigravity-bridge: desktop wake failed: ${error?.message ?? error}`)
        })
      }
      return 'terminal'
    }
    if (verdict.state === 'awaiting_permission') {
      this.markPermissionPending(job, verdict)
      return 'running'
    }
    if (verdict.state === 'indeterminate') {
      this.clearPermissionPending(job)
      // A known end without text is final; anything else may still have been
      // delivered, so it must stay queryable instead of suggesting a retry.
      if (verdict.code === 'round_ended_without_reply') {
        this.bridge.markFailure(job, 'failed', {
          code: 'empty_reply',
          message: '桌面回合在运行后结束，但没有可归属的 assistant 文本；没有唤醒。',
        })
        return 'terminal'
      }
      this.bridge.markAcceptanceUnknown(job, {
        code: `desktop_${verdict.code ?? 'indeterminate'}`,
        message: `桌面回复归属不成立（${verdict.code ?? 'indeterminate'}）：${verdict.detail ?? ''} 不重发、不唤醒。`,
      })
      return 'terminal'
    }
    this.clearPermissionPending(job)
    if (update.status === 'accepted' && job.status !== 'accepted') {
      this.bridge.markAccepted(job, {
        code: String(update.code ?? 'desktop_running'),
        message: '桌面会话已观察到本轮；等待生成结束与稳定的最终文本。',
      })
    }
    return 'running'
  }

  markPermissionPending(job, verdict) {
    if (!this.isCurrent(job) || job.cancelRequested === true) return
    if (job.permissionPending === true) return
    job.permissionPending = true
    job.permissions = Array.isArray(job.permissions) ? job.permissions : []
    job.permissions.push({
      toolCallId: '',
      title: 'Antigravity 桌面权限提示',
      kind: 'desktop_permission',
      decision: 'pending',
      optionId: '',
    })
    job.message =
      '桌面会话正在等待权限确认；请在 Antigravity 窗口中处理。桥不会自动批准，也不会重复发送。'
    job.code = 'desktop_permission_pending'
    job.updatedAt = new Date().toISOString()
    this.bridge.save()
  }

  clearPermissionPending(job) {
    if (job.permissionPending !== true) return
    if (!this.isCurrent(job)) return
    job.permissionPending = false
    job.updatedAt = new Date().toISOString()
    this.bridge.save()
  }

  finishCancelled(job) {
    if (this.bridge.closed === true) return job
    this.bridge.markFailure(job, 'failed', {
      code: 'cancelled',
      message:
        '桌面观察已停止。桌面驱动没有经过验证的 Stop 控件，因此无法证明应用端生成已停止；没有唤醒，也不会重发。',
    })
    return job
  }

  /** Stop observing this job. Never clicks a Stop control in the app. */
  cancel(job) {
    const controller = this.controllers.get(job?.jobId)
    if (!controller) return false
    controller.abort()
    return true
  }
}

function describeDriverRefusal(result) {
  const reason = typeof result.reason === 'string' ? result.reason : ''
  const code = typeof result.code === 'string' ? result.code : ''
  const text = typeof result.message === 'string' ? result.message : ''
  return [reason, code, text].filter(Boolean).join(' / ') || 'no reason reported'
}

function redactUri(uri) {
  try {
    const parsed = new URL(uri)
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return uri
  }
}