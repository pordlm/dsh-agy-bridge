import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const RETRY_RENAME_CODES = new Set(['EBUSY', 'EPERM'])
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4))

function sleepSync(ms) {
  Atomics.wait(SLEEP_BUF, 0, 0, ms)
}

function formatTimestampCompact(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return (
    String(date.getFullYear()) +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  )
}

export function defaultStateDir() {
  const dshHome = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  if (dshHome !== '') return join(dshHome, '.dsh-agy-bridge')
  return join(homedir(), '.dsh-agy-bridge')
}

export function isValidUuidV4(value) {
  return typeof value === 'string' && UUID_V4_RE.test(value.trim())
}

export function readMachineId(fileObj) {
  if (!fileObj || typeof fileObj !== 'object' || Array.isArray(fileObj)) return null
  const raw = typeof fileObj.machineId === 'string' ? fileObj.machineId.trim() : ''
  return raw !== '' ? raw : null
}

export function stampMachineId(obj, id) {
  const base = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {}
  return { ...base, machineId: id }
}

function atomicWriteJsonSync(filePath, payload) {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
  renameSync(tmp, filePath)
}

function renameWithRetrySync(src, dest, maxAttempts = 3, delayMs = 200) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      renameSync(src, dest)
      return { ok: true, error: null }
    } catch (error) {
      if (!RETRY_RENAME_CODES.has(error?.code) || attempt === maxAttempts - 1) {
        return { ok: false, error: String(error?.code || error?.message || error) }
      }
      sleepSync(delayMs)
    }
  }
  return { ok: false, error: 'rename_failed' }
}

/**
 * 读取或原子生成本机唯一身份 `<stateDir>/machine.json`。
 * 损坏时绝不删除，改名为 `machine.json.corrupt-<yyyyMMddHHmmss>` 后重建。
 */
export function getMachineId(stateDir, logger) {
  const dir = typeof stateDir === 'string' && stateDir.trim() !== '' ? stateDir.trim() : defaultStateDir()
  const filePath = join(dir, 'machine.json')
  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
      if (parsed && typeof parsed === 'object' && isValidUuidV4(parsed.id)) {
        return parsed.id.trim()
      }
      throw new Error('invalid machine.json id')
    } catch (error) {
      const stamp = formatTimestampCompact()
      let corruptPath = `${filePath}.corrupt-${stamp}`
      if (existsSync(corruptPath)) {
        corruptPath = `${filePath}.corrupt-${stamp}-${process.pid}`
      }
      const renamed = renameWithRetrySync(filePath, corruptPath)
      logger?.warn?.(
        `machine_identity_corrupt_quarantined: file=${basename(filePath)} renamedTo=${renamed.ok ? basename(corruptPath) : 'failed'} error=${error?.message ?? error}`,
      )
    }
  }

  const record = { id: randomUUID(), createdAt: new Date().toISOString() }
  try {
    atomicWriteJsonSync(filePath, record)
    return record.id
  } catch (error) {
    // 并发创建竞争时尝试回读已落盘的合法 machine.json
    try {
      const tmp = `${filePath}.tmp-${process.pid}`
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {}
    if (existsSync(filePath)) {
      try {
        const existing = JSON.parse(readFileSync(filePath, 'utf8'))
        if (existing && typeof existing === 'object' && isValidUuidV4(existing.id)) {
          return existing.id.trim()
        }
      } catch {}
    }
    logger?.warn?.(`machine_identity_write_failed: file=${basename(filePath)} error=${error?.message ?? error}`)
    return record.id
  }
}

/**
 * 隔离外来机器的状态文件：只改名、绝不删除；EBUSY/EPERM 重试 3×200ms，失败不抛异常。
 */
export function quarantineFile(filePath, { foreignId = 'unknown', logger } = {}) {
  const at = new Date().toISOString()
  const cleanForeign = typeof foreignId === 'string' && foreignId.trim() !== '' ? foreignId.trim() : 'unknown'
  const shortId = cleanForeign.slice(0, 8)
  const dir = dirname(filePath)
  const ext = extname(filePath)
  const base = basename(filePath, ext)
  const stamp = formatTimestampCompact()
  let target = join(dir, `${base}.foreign-${shortId}-${stamp}${ext}`)
  if (existsSync(target)) {
    target = join(dir, `${base}.foreign-${shortId}-${stamp}-${process.pid}${ext}`)
  }
  const res = renameWithRetrySync(filePath, target, 3, 200)
  if (!res.ok) {
    logger?.warn?.(
      `state_foreign_machine_quarantine_failed: file=${basename(filePath)} foreignMachineId=${shortId} error=${res.error}`,
    )
    return { ok: false, renamedTo: null, foreignId: cleanForeign, at, error: res.error }
  }
  logger?.warn?.(
    `state_foreign_machine_quarantined: file=${basename(filePath)} foreignMachineId=${shortId} renamedTo=${basename(target)}`,
  )
  return { ok: true, renamedTo: target, foreignId: cleanForeign, at, error: null }
}
