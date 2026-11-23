/**
 * Explicit attachment paths -> ACP content blocks.
 *
 * Nothing here is guessed from the prompt: the caller names absolute file
 * paths. Inspection (stat + extension) happens before any file content is
 * read, so an unsupported capability or type fails with zero reads. The
 * bridge only reads bytes after the ACP initialize response advertised the
 * matching prompt capability.
 */

import { readFileSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, normalize } from 'node:path'
import { pathToFileURL } from 'node:url'

export class AttachmentError extends Error {
  constructor(code, message, phase = 'before_write') {
    super(message)
    this.name = 'AttachmentError'
    this.code = code
    this.phase = phase
  }
}

const IMAGE_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
])

const TEXT_TYPES = new Map([
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.json', 'application/json'],
  ['.jsonl', 'application/x-ndjson'],
  ['.csv', 'text/csv'],
  ['.tsv', 'text/tab-separated-values'],
  ['.log', 'text/plain'],
  ['.xml', 'application/xml'],
  ['.html', 'text/html'],
  ['.htm', 'text/html'],
  ['.css', 'text/css'],
  ['.js', 'text/javascript'],
  ['.mjs', 'text/javascript'],
  ['.cjs', 'text/javascript'],
  ['.ts', 'text/plain'],
  ['.tsx', 'text/plain'],
  ['.jsx', 'text/plain'],
  ['.py', 'text/x-python'],
  ['.sh', 'text/x-shellscript'],
  ['.ps1', 'text/plain'],
  ['.yml', 'application/yaml'],
  ['.yaml', 'application/yaml'],
  ['.sql', 'text/plain'],
  ['.ini', 'text/plain'],
  ['.toml', 'text/plain'],
])

function isDevicePath(value) {
  return /^[\\/]{2}[.?][\\/]/.test(value)
}

function isUncPath(value) {
  return /^[\\/]{2}[^\\/]/.test(value)
}

function detectImageMime(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString('ascii') === 'GIF87a') return 'image/gif'
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif'
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return ''
}

function looksBinary(buffer) {
  return buffer.includes(0)
}

/**
 * Validate explicit paths and produce descriptors without reading content.
 *
 * @param {unknown} input
 * @param {{image?: boolean, embeddedContext?: boolean}} promptCapabilities
 * @param {{maxAttachments:number,maxAttachmentBytes:number,maxTotalAttachmentBytes:number}} limits
 */
export function inspectAttachments(input, promptCapabilities, limits) {
  if (input === undefined) return []
  if (!Array.isArray(input)) {
    throw new AttachmentError('invalid_request', 'attachments 必须是绝对文件路径数组。')
  }
  if (input.length === 0) return []
  if (!promptCapabilities?.image && !promptCapabilities?.embeddedContext) {
    throw new AttachmentError(
      'unsupported_capability',
      'Antigravity 的 ACP initialize 没有声明 image 或 embeddedContext 能力；没有读取任何文件，也没有派发。',
    )
  }
  if (input.length > limits.maxAttachments) {
    throw new AttachmentError(
      'invalid_request',
      `attachments 最多 ${limits.maxAttachments} 个（收到 ${input.length} 个）。`,
    )
  }
  const seen = new Set()
  const descriptors = []
  let total = 0
  for (const raw of input) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new AttachmentError('invalid_path', 'attachments 的每一项都必须是非空字符串路径。')
    }
    const value = raw.trim()
    if (isDevicePath(value)) throw new AttachmentError('invalid_path', `不接受设备路径：${value}`)
    if (isUncPath(value)) throw new AttachmentError('invalid_path', `不接受 UNC 路径：${value}`)
    if (!isAbsolute(value)) throw new AttachmentError('invalid_path', `必须是绝对路径：${value}`)
    const path = normalize(value)
    if (seen.has(path)) continue
    seen.add(path)
    let stat
    try {
      stat = statSync(path)
    } catch {
      throw new AttachmentError('invalid_path', `路径不存在或无法访问：${path}`)
    }
    if (!stat.isFile()) throw new AttachmentError('invalid_path', `不是普通文件：${path}`)
    if (stat.size <= 0) throw new AttachmentError('invalid_attachment', `空文件不能作为附件：${path}`)
    if (stat.size > limits.maxAttachmentBytes) {
      throw new AttachmentError(
        'attachment_too_large',
        `附件 ${basename(path)} 为 ${stat.size} 字节，超过单件上限 ${limits.maxAttachmentBytes} 字节。`,
      )
    }
    total += stat.size
    if (total > limits.maxTotalAttachmentBytes) {
      throw new AttachmentError(
        'attachment_too_large',
        `附件总大小超过上限 ${limits.maxTotalAttachmentBytes} 字节。`,
      )
    }
    const ext = extname(path).toLowerCase()
    if (IMAGE_TYPES.has(ext)) {
      if (promptCapabilities.image !== true) {
        throw new AttachmentError(
          'unsupported_capability',
          `Antigravity 没有声明 image 能力，拒绝图片附件 ${basename(path)}；没有读取文件内容。`,
        )
      }
      descriptors.push({
        path,
        name: basename(path),
        size: stat.size,
        kind: 'image',
        mimeType: IMAGE_TYPES.get(ext),
      })
      continue
    }
    if (TEXT_TYPES.has(ext)) {
      if (promptCapabilities.embeddedContext !== true) {
        throw new AttachmentError(
          'unsupported_capability',
          `Antigravity 没有声明 embeddedContext 能力，拒绝文本附件 ${basename(path)}；没有读取文件内容。`,
        )
      }
      descriptors.push({
        path,
        name: basename(path),
        size: stat.size,
        kind: 'resource',
        mimeType: TEXT_TYPES.get(ext),
      })
      continue
    }
    throw new AttachmentError(
      'unsupported_attachment_type',
      `不支持的附件类型 ${ext || '（无扩展名）'}：${basename(path)}。只接受 png/jpeg/gif/webp 图片和文本类文件。`,
    )
  }
  return descriptors
}

/** Read the already-validated descriptors and build ACP prompt content blocks. */
export function readAttachmentBlocks(descriptors, limits) {
  const blocks = []
  let total = 0
  for (const descriptor of descriptors) {
    const buffer = readFileSync(descriptor.path)
    if (buffer.length !== descriptor.size) {
      throw new AttachmentError(
        'attachment_changed',
        `附件 ${descriptor.name} 在检查后大小发生变化，已停止派发。`,
      )
    }
    total += buffer.length
    if (total > limits.maxTotalAttachmentBytes) {
      throw new AttachmentError(
        'attachment_too_large',
        `附件总大小超过上限 ${limits.maxTotalAttachmentBytes} 字节。`,
      )
    }
    if (descriptor.kind === 'image') {
      const actual = detectImageMime(buffer)
      if (actual !== descriptor.mimeType) {
        throw new AttachmentError(
          'invalid_attachment',
          `图片 ${descriptor.name} 的文件内容与扩展名（${descriptor.mimeType}）不符。`,
        )
      }
      blocks.push({
        type: 'image',
        mimeType: descriptor.mimeType,
        data: buffer.toString('base64'),
      })
      continue
    }
    if (looksBinary(buffer)) {
      throw new AttachmentError(
        'invalid_attachment',
        `文本附件 ${descriptor.name} 含二进制内容，不能作为 embeddedContext 文本发送。`,
      )
    }
    let text
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    } catch {
      throw new AttachmentError(
        'invalid_attachment',
        `文本附件 ${descriptor.name} 不是有效的 UTF-8 文本，不能作为 embeddedContext 发送。`,
      )
    }
    blocks.push({
      type: 'resource',
      resource: {
        uri: pathToFileURL(descriptor.path).href,
        mimeType: descriptor.mimeType,
        text,
      },
    })
  }
  return blocks
}

export function attachmentInfo(descriptors) {
  return descriptors.map((descriptor) => ({
    name: descriptor.name,
    kind: descriptor.kind,
    mimeType: descriptor.mimeType,
    bytes: descriptor.size,
  }))
}