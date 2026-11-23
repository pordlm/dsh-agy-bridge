// Isolated test capability, deliberately not enabled by production config.
import { realpath, stat, readFile, open, lstat } from 'node:fs/promises'
import { relative, isAbsolute, dirname, basename, join } from 'node:path'
const fail = (code) => { throw Object.assign(new Error(code), { code }) }
export function createProbeHandler({ readOnly = false, maxBytes = 65536 } = {}) {
  return async (method, params, session) => {
    if (!session?.activePrompt || !session.cwd || session.id !== params.sessionId) fail('fs_session_unbound')
    if (typeof params.path !== 'string' || !isAbsolute(params.path)) fail('fs_absolute_path_required')
    const root = await realpath(session.cwd)
    const contained = (target) => { const rel = relative(root, target); if (isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../')) fail('fs_outside_workspace') }
    const writing = method === 'fs/write_text_file'
    if (writing && readOnly) fail('fs_read_only')
    let target
    try { target = await realpath(params.path); contained(target) }
    catch (error) {
      if (!writing || error.code !== 'ENOENT') throw error
      // No implicit mkdir: the immediate parent must exist and remain in root.
      const parent = await realpath(dirname(params.path)); contained(parent)
      target = join(parent, basename(params.path)); contained(target)
      try { await lstat(target); fail('fs_unsafe_target') } catch (e) { if (e.code !== 'ENOENT') throw e }
    }
    if (writing) {
      if (typeof params.content !== 'string' || params.content.includes('\u0000') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(params.content)) fail('fs_invalid_utf8')
      const data = Buffer.from(params.content, 'utf8'); if (data.length > maxBytes) fail('fs_too_large')
      // Existing files are opened without truncation, validated, then changed.
      let handle
      try {
        try { handle = await open(target, 'r+') } catch (error) { if (error.code !== 'ENOENT') throw error; handle = await open(target, 'wx') }
        const info = await handle.stat(); if (!info.isFile()) fail('fs_not_file')
        contained(await realpath(target))
        await handle.writeFile(data); await handle.truncate(data.length)
      } finally { await handle?.close() }
      return {}
    }
    const info = await stat(target); if (!info.isFile()) fail('fs_not_file'); if (info.size > maxBytes) fail('fs_too_large')
    const data = await readFile(target); if (data.length > maxBytes) fail('fs_too_large')
    let content; try { content = new TextDecoder('utf-8', { fatal: true }).decode(data) } catch { fail('fs_invalid_utf8') }
    if (content.includes('\u0000')) fail('fs_invalid_utf8')
    const { line = 1, limit } = params
    if (!Number.isSafeInteger(line) || line < 1 || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))) fail('fs_invalid_range')
    return { content: content.split('\n').slice(line - 1, limit === undefined ? undefined : line - 1 + limit).join('\n') }
  }
}
