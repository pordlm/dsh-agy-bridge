/**
 * Remove every global tool from this preset's agent scope.
 *
 * The ACP text adapter rejects tool catalogs, so an empty preset `plugins: []`
 * is not enough: it would still inherit the root tool surface. `tools.restrict`
 * is a scoped, reversible mask and is the public Cordis contract for this.
 */

export const name = 'antigravity-bridge-zero-tools'

export const inject = ['tools']

export function apply(ctx) {
  const known = ctx.tools?.view?.()?.restrictableNames
  if (!known || known.size === 0) return
  ctx.effect(() => ctx.tools.restrict({ deny: [...known] }))
}