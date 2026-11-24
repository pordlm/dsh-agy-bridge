/**
 * Live probe for correction-turn text match (LIVE_CORRECTION_TEXT_MATCH).
 * standalone 环境下必然 BLOCKED：本探针无法挂载宿主会话落库；
 * 判 A/B 需要真实 DSH 宿主进程内同时捕获 adapter 侧 yield 文本与宿主持久层读回文本再比 sha256。
 */

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { AgyAcpAdapter, TOOL_BRIDGE_CORRECTION } from '../lib/model-adapter.js'

const CASE_NAME = 'LIVE_CORRECTION_TEXT_MATCH'
const repoRoot = resolve('D:/lnu-seat/antigravity-bridge')
const defaultExe = join(repoRoot, 'desktop-staging', 'verification', 'official-cli', 'agy.exe')
const defaultShared = join(repoRoot, 'desktop-staging', 'verification', 'agy-data')
const agyExecutable = process.env.AGY_EXECUTABLE || defaultExe
const sharedDir = process.env.AGY_GEMINI_DIR || defaultShared

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

async function main() {
  if (!existsSync(agyExecutable)) {
    console.log(JSON.stringify({ case: CASE_NAME, status: 'BLOCKED', reason: `agyExecutable not found: ${agyExecutable}` }, null, 2))
    return
  }
  if (!existsSync(sharedDir)) {
    console.log(JSON.stringify({ case: CASE_NAME, status: 'BLOCKED', reason: `agy-data dir not found: ${sharedDir}` }, null, 2))
    return
  }

  const tempDir = mkdtempSync(join(process.env.TEMP || tmpdir(), 'agy-corr-live-'))
  const authDir = join(tempDir, 'login-copy')
  cpSync(sharedDir, authDir, { recursive: true })

  let adapter = null
  try {
    adapter = new AgyAcpAdapter({
      agyExecutable,
      agyArgs: ['acp', '--gemini-dir', authDir],
      cwd: repoRoot,
      acpToolBridge: true,
    })

    const chunks = []
    for await (const chunk of adapter.stream({
      sessionId: 'live-corr-probe',
      model: 'gemini-4-hydrogen',
      reasoningEffort: 'medium',
      tools: [{
        name: 'claim_task',
        description: 'Claim a task',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
      }],
      messages: [{
        role: 'user',
        id: 'corr-u1',
        content: [{
          type: 'text',
          text: 'Reply with only the bare words: tool_call test. Do NOT use any code fence or backticks.',
        }],
      }],
    })) {
      chunks.push(chunk)
    }

    const yieldedText = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
    const hasCorrection = yieldedText.includes(TOOL_BRIDGE_CORRECTION)
    if (!hasCorrection) {
      console.log(JSON.stringify({
        case: CASE_NAME,
        status: 'BLOCKED',
        reason: 'model output did not trigger TOOL_BRIDGE_CORRECTION in this run',
        yieldedLen: yieldedText.length,
        yieldedHead: yieldedText.slice(0, 80),
      }, null, 2))
      return
    }

    const yieldHash = sha256(yieldedText)
    console.log(JSON.stringify({
      case: CASE_NAME,
      status: 'BLOCKED',
      reason: 'standalone 探针无法取得宿主会话落库文本，adapter.lastResult.text 与 yield 同源不能作为比对对象',
      hasCorrection: true,
      yielded: {
        length: yieldedText.length,
        head: yieldedText.slice(0, 80),
        sha256Prefix: yieldHash.slice(0, 12),
      },
    }, null, 2))
  } catch (error) {
    const code = error?.code || 'PROBE_FAILED'
    const message = String(error?.message ?? error)
    console.log(JSON.stringify({
      case: CASE_NAME,
      status: 'BLOCKED',
      code,
      reason: message,
    }, null, 2))
  } finally {
    adapter?.dispose?.()
    rmSync(tempDir, { recursive: true, force: true })
  }
}

await main()
