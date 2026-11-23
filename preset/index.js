/**
 * Minimal zero-tool Agent preset for the pure-text ACP model route.
 *
 * The model adapter refuses tool catalogs and unbound history imports. This preset
 * makes the empty tool surface explicit in the composition instead of relying
 * on the adapter to ignore tools. It registers only its own definition.
 */

export const name = 'antigravity-bridge-text-preset'

export const inject = ['agentPresets']

export const PRESET_ID = 'antigravity-acp-text'

export const PRESET_NAME = 'Antigravity ACP 纯文本多轮'

export const PRESET_DESCRIPTION =
  '零工具的 Agent 组合：只适合 antigravity-agy-acp 的纯文本多轮模型（无工具、无附件；同一工作区与模型持续对话）。'

export function presetDefinition(config = {}) {
  return {
    id: typeof config.id === 'string' && config.id !== '' ? config.id : PRESET_ID,
    name: typeof config.name === 'string' && config.name !== '' ? config.name : PRESET_NAME,
    description:
      typeof config.description === 'string' && config.description !== ''
        ? config.description
        : PRESET_DESCRIPTION,
    plugins: [{ name: 'dsh-agy-bridge/preset/tool-scope' }],
  }
}

/**
 * Register the preset in an existing context. Returns the disposer when the
 * registry provides one, so the caller can bind it to the plugin lifetime.
 */
export async function registerPreset(ctx, config = {}) {
  const dispose = await ctx.agentPresets.register(presetDefinition(config))
  return typeof dispose === 'function' ? dispose : undefined
}

export async function apply(ctx, config = {}) {
  const dispose = await registerPreset(ctx, config)
  if (typeof dispose === 'function') ctx.effect(() => dispose)
}