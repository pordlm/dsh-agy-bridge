/** Provider metadata is derived from complete ACP configOptions, never a model whitelist. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const PROVIDER_ID = 'antigravity-agy-acp'
export const PROVIDER_NAME = 'Antigravity ACP (agy) · 纯文本多轮'
export const PROVIDER_DESCRIPTION = '本机官方 agy ACP；纯文本多轮，DSH 工具与附件暂不支持。'
// Compatibility identifiers for older panel/test imports; not discovery input.
export const MODEL_ID = 'gemini-4-argon'
export const MODEL_NAME = 'Gemini 4 Argon (agy ACP)'
export const EFFORT_LOW_ID = 'low'
export const EFFORT_LOW_NAME = '低 (low)'
export const MODEL_DESCRIPTION = 'agy ACP 纯文本多轮；不支持工具调用、图片或文件附件。会话绑定后只发送新增用户输入。'
export const MODEL_CATALOG = Object.freeze([])

export const DEFAULT_PER_MODEL_TIMEOUT_MS = 6000
export const CATALOG_TTL_FULL_MS = 300_000
export const CATALOG_TTL_DEGRADED_MS = 30_000

export function findOption(options, category, fallback = category) {
  if (!Array.isArray(options)) return undefined
  return options.find((item) => item?.category === category) ?? options.find((item) => item?.id === fallback)
}

export function choices(option) {
  const result = []
  for (const item of option?.options ?? []) {
    if (Array.isArray(item?.options)) result.push(...choices(item))
    else if (typeof item?.value === 'string' && item.value) result.push({ id: item.value, name: item.name || item.value })
  }
  return result
}

export function modelEntry(model, entries = MODEL_CATALOG) { return entries.find((entry) => entry.id === model) }
export function effortIds(model, entries = MODEL_CATALOG) { return modelEntry(model, entries)?.efforts.map((item) => item.id) ?? [] }

export function modelInfo(provider, model, entries = MODEL_CATALOG) {
  const entry = modelEntry(model, entries)
  if (!entry) return undefined
  return {
    provider, id: entry.id, name: entry.name, description: MODEL_DESCRIPTION,
    inputModalities: ['text'],
    ...(Array.isArray(entry.efforts) && entry.efforts.length ? { reasoning: { efforts: entry.efforts.map((item) => ({ ...item })) } } : {}),
    ...(entry.degraded ? { degraded: true, degradedReason: entry.degradedReason } : {}),
    // No defaultEffort: DSH must preserve the CLI's current default.
  }
}

export function listModelInfos(entries = MODEL_CATALOG) { return entries.map((entry) => modelInfo(PROVIDER_ID, entry.id, entries)) }
export function providerInfo(provider) { return { id: provider, name: PROVIDER_NAME, description: PROVIDER_DESCRIPTION } }

function isTransportDead(transport, error = null) {
  if (transport && typeof transport === 'object') {
    if (transport.isClosed === true || transport.closed === true) return true
    const child = transport.child
    if (child && typeof child === 'object' && (child.exitCode != null || child.signalCode != null)) return true
  }
  const code = typeof error?.code === 'string' ? error.code : ''
  if (code === 'AGY_ACP_TRANSPORT_CLOSED' || code === 'AGY_ACP_EXITED') return true
  return false
}

/**
 * Independent metadata-only session. It never issues session/prompt.
 * Uses ONE scratch session and switches models via session/set_config_option
 * with per-model timeout and fault isolation.
 */
export async function discoverCatalog(transport, cwd, optionsOrTimeout = 30000) {
  const opts = typeof optionsOrTimeout === 'number' ? { timeoutMs: optionsOrTimeout } : (optionsOrTimeout ?? {})
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 30000
  const perModelTimeoutMs = Number.isFinite(opts.perModelTimeoutMs) && opts.perModelTimeoutMs > 0 ? opts.perModelTimeoutMs : DEFAULT_PER_MODEL_TIMEOUT_MS
  const logger = opts.logger ?? null
  const probeStart = Date.now()
  transport.start()
  try {
    await transport.request('initialize', {
      protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'dsh-antigravity-catalog', version: '0.4.0' },
    }, { timeoutMs })
    const session = await transport.request('session/new', { cwd, mcpServers: [] }, { timeoutMs })
    const initial = session.configOptions
    const model = findOption(initial, 'model')
    const modelChoices = choices(model)
    if (!session.sessionId || !model || modelChoices.length === 0) {
      throw Object.assign(new Error('ACP catalog has no model choices'), { code: 'AGY_ACP_CONFIG_INCOMPLETE' })
    }
    const entries = []
    const degraded = []
    for (const candidate of modelChoices) {
      if (isTransportDead(transport)) {
        throw Object.assign(new Error('ACP transport closed during catalog discovery'), {
          code: 'AGY_ACP_TRANSPORT_CLOSED',
          partialEntries: entries,
          degraded,
        })
      }
      const modelStart = Date.now()
      try {
        const response = await transport.request(
          'session/set_config_option',
          { sessionId: session.sessionId, configId: model.id, value: candidate.id },
          { timeoutMs: perModelTimeoutMs },
        )
        const options = response?.configOptions
        if (findOption(options, 'model')?.currentValue !== candidate.id) {
          throw Object.assign(new Error(`ACP catalog model readback mismatch: ${candidate.id}`), { code: 'AGY_ACP_CONFIG_NOT_APPLIED' })
        }
        const thought = findOption(options, 'thought_level', 'thought')
        if (thought && thought.type !== undefined && thought.type !== 'select') {
          throw Object.assign(new Error(`Invalid thought option type for ${candidate.id}`), { code: 'AGY_ACP_CONFIG_INCOMPLETE' })
        }
        entries.push({ ...candidate, efforts: choices(thought), configOptions: options, probeMs: Date.now() - modelStart })
      } catch (error) {
        if (isTransportDead(transport, error)) {
          throw Object.assign(new Error(`ACP transport closed during catalog probe: ${error?.message ?? error}`), {
            code: error?.code || 'AGY_ACP_TRANSPORT_CLOSED',
            cause: error,
            partialEntries: entries,
            degraded,
          })
        }
        const elapsedMs = Date.now() - modelStart
        const message = String(error?.message ?? error)
        const timedOut = error?.code === 'AGY_ACP_TIMEOUT' || /timed? ?out/i.test(message)
        const reason = typeof error?.code === 'string' && error.code !== ''
          ? error.code
          : (timedOut ? 'AGY_ACP_TIMEOUT' : 'AGY_ACP_PROBE_FAILED')
        const item = { modelId: candidate.id, name: candidate.name, reason, timedOut, elapsedMs, message }
        degraded.push(item)
        entries.push({ ...candidate, efforts: [], degraded: true, degradedReason: reason, probeMs: elapsedMs })
        logger?.warn?.(`[model-catalog] degraded model=${candidate.id} reason=${reason} timedOut=${timedOut} elapsedMs=${elapsedMs}`)
      }
    }
    return {
      entries,
      degraded,
      defaultModel: model.currentValue,
      initialConfigOptions: initial,
      discoveredAt: new Date().toISOString(),
      elapsedMs: Date.now() - probeStart,
    }
  } finally {
    transport.close?.()
  }
}

/**
 * Shared fault-tolerant catalog store (single-flight, 300s/30s TTL,
 * disk snapshot fallback ONLY on failure, never writing empty entries).
 */
export function createCatalogStore(options = {}) {
  const {
    transportFactory,
    cwd,
    cacheFile = '',
    timeoutMs = 30000,
    perModelTimeoutMs = DEFAULT_PER_MODEL_TIMEOUT_MS,
    logger = null,
    now = () => Date.now(),
    fsOps = { existsSync, mkdirSync, readFileSync, writeFileSync },
  } = options

  let cache = null
  let pending = null

  function ttlFor(snapshot) {
    return Array.isArray(snapshot?.degraded) && snapshot.degraded.length > 0
      ? CATALOG_TTL_DEGRADED_MS
      : CATALOG_TTL_FULL_MS
  }

  function isFresh(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.entries) || snapshot.entries.length === 0) return false
    return (now() - (snapshot.cachedAt ?? 0)) < ttlFor(snapshot)
  }

  function readDiskFallback() {
    if (!cacheFile) return null
    try {
      if (!fsOps.existsSync(cacheFile)) return null
      const parsed = JSON.parse(fsOps.readFileSync(cacheFile, 'utf8'))
      if (!parsed || !Array.isArray(parsed.entries) || parsed.entries.length === 0) return null
      return parsed
    } catch {
      return null
    }
  }

  function writeDiskSnapshot(snapshot) {
    if (!cacheFile || !Array.isArray(snapshot?.entries) || snapshot.entries.length === 0) return
    try {
      fsOps.mkdirSync(dirname(cacheFile), { recursive: true })
      fsOps.writeFileSync(cacheFile, JSON.stringify({
        version: 1,
        entries: snapshot.entries,
        degraded: snapshot.degraded ?? [],
        defaultModel: snapshot.defaultModel,
        discoveredAt: snapshot.discoveredAt,
        elapsedMs: snapshot.elapsedMs,
      }, null, 2), 'utf8')
    } catch (error) {
      logger?.warn?.(`[model-catalog] disk cache write failed: ${error?.message ?? error}`)
    }
  }

  async function getCatalog({ force = false, allowFallback = true } = {}) {
    if (!force && isFresh(cache)) return cache
    if (pending) return pending
    pending = (async () => {
      const probeAt = now()
      try {
        const snapshot = await discoverCatalog(transportFactory(), cwd, { timeoutMs, perModelTimeoutMs, logger })
        if (!Array.isArray(snapshot?.entries) || snapshot.entries.length === 0) {
          throw Object.assign(new Error('ACP catalog returned 0 models'), { code: 'AGY_ACP_CONFIG_INCOMPLETE' })
        }
        const next = {
          ...snapshot,
          cachedAt: now(),
          lastProbeAt: probeAt,
          fromFallback: false,
        }
        writeDiskSnapshot(next)
        cache = next
        return cache
      } catch (error) {
        if (!allowFallback) throw error
        const fallback = (cache && Array.isArray(cache.entries) && cache.entries.length > 0 ? cache : null) ?? readDiskFallback()
        if (fallback) {
          return {
            ...fallback,
            degraded: Array.isArray(fallback.degraded) ? fallback.degraded : [],
            fromFallback: true,
            fallbackReason: typeof error?.code === 'string' && error.code !== '' ? error.code : String(error?.message ?? error),
            cachedAt: now(),
            lastProbeAt: probeAt,
          }
        }
        throw error
      }
    })().finally(() => {
      pending = null
    })
    return pending
  }

  async function resolveModel(provider, model) {
    let snapshot = await getCatalog()
    let info = modelInfo(provider, model, snapshot.entries)
    if (info === undefined) {
      const elapsedSinceProbe = now() - (snapshot.lastProbeAt ?? 0)
      if (elapsedSinceProbe >= CATALOG_TTL_DEGRADED_MS) {
        snapshot = await getCatalog({ force: true })
        info = modelInfo(provider, model, snapshot.entries)
      }
    }
    return { info, snapshot }
  }

  return {
    getCatalog,
    resolveModel,
    getCached: () => cache,
  }
}
