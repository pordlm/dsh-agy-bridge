/** Provider metadata is derived from complete ACP configOptions, never a model whitelist. */
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
    ...(entry.efforts.length ? { reasoning: { efforts: entry.efforts.map((item) => ({ ...item })) } } : {}),
    // No defaultEffort: DSH must preserve the CLI's current default.
  }
}
export function listModelInfos(entries = MODEL_CATALOG) { return entries.map((entry) => modelInfo(PROVIDER_ID, entry.id, entries)) }
export function providerInfo(provider) { return { id: provider, name: PROVIDER_NAME, description: PROVIDER_DESCRIPTION } }

/** Independent metadata-only session. It never issues session/prompt. */
export async function discoverCatalog(transport, cwd, timeoutMs = 30000) {
  transport.start()
  try {
    await transport.request('initialize', {
      protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'dsh-antigravity-catalog', version: '0.3.0' },
    }, { timeoutMs })
    const session = await transport.request('session/new', { cwd, mcpServers: [] }, { timeoutMs })
    const initial = session.configOptions
    const model = findOption(initial, 'model')
    if (!session.sessionId || !model || choices(model).length === 0) throw Object.assign(new Error('ACP catalog has no model choices'), { code: 'AGY_ACP_CONFIG_INCOMPLETE' })
    const entries = []
    for (const candidate of choices(model)) {
      // A fresh session for every model prevents a prior model's explicit or
      // inherited effort from becoming the next model's alleged CLI baseline.
      const scratch = await transport.request('session/new', { cwd, mcpServers: [] }, { timeoutMs })
      const selector = findOption(scratch.configOptions, 'model')
      if (!scratch.sessionId || !selector) throw Object.assign(new Error('Scratch session has no model option'), { code: 'AGY_ACP_CONFIG_INCOMPLETE' })
      const response = await transport.request('session/set_config_option', { sessionId: scratch.sessionId, configId: selector.id, value: candidate.id }, { timeoutMs })
      const options = response?.configOptions
      if (findOption(options, 'model')?.currentValue !== candidate.id) throw Object.assign(new Error(`ACP catalog model readback mismatch: ${candidate.id}`), { code: 'AGY_ACP_CONFIG_NOT_APPLIED' })
      const thought = findOption(options, 'thought_level', 'thought')
      if (thought && thought.type !== undefined && thought.type !== 'select') throw Object.assign(new Error(`Invalid thought option type for ${candidate.id}`), { code: 'AGY_ACP_CONFIG_INCOMPLETE' })
      entries.push({ ...candidate, efforts: choices(thought), cliCurrentEffort: thought?.currentValue, configOptions: options })
    }
    return { entries, defaultModel: model.currentValue, initialConfigOptions: initial, discoveredAt: new Date().toISOString() }
  } finally { transport.close?.() }
}
