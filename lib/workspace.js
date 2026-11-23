import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

function failure(code, message) {
  return Object.assign(new Error(message), { code, phase: 'before_write' })
}

export function canonicalWorkspace(root) {
  if (typeof root !== 'string' || !root.trim()) throw failure('workspace_unconfigured', 'No project workspace is configured.')
  if (!isAbsolute(root)) throw failure('workspace_invalid', 'Workspace must be an absolute directory.')
  try {
    const canonical = realpathSync(root)
    if (!statSync(canonical).isDirectory()) throw new Error('not a directory')
    accessSync(canonical, constants.R_OK | constants.X_OK)
    return canonical
  } catch (error) {
    throw failure('workspace_unavailable', `Workspace is unavailable: ${root}: ${error.message}`)
  }
}

// get(session) reads the committed Host projection. Do not call ensure(): its
// recovery to the original project would silently change this task's target.
export function resolveHostWorkspace(ctx, agent, config) {
  const service = ctx.workingDirectory ?? ctx.get?.('workingDirectory')
  const selected = service?.get && agent?.session ? service.get(agent.session) : null
  return canonicalWorkspace(selected ?? (config.workspaceConfigured !== false ? config.cwd : null))
}

export function assertWorkspaceBinding(bound, root) {
  if (!bound) throw failure('workspace_binding_unknown', 'This ACP session has no persisted workspace binding; create a new session.')
  if (bound !== root) throw failure('workspace_mismatch', 'The ACP session belongs to another workspace; create a new session for this project.')
}
