#!/usr/bin/env node
/**
 * Offline ACP v1 agent used by the bridge tests.
 *
 * It speaks the same newline-delimited JSON-RPC as `agy acp`, but has no
 * network access and no account. Everything it writes stays in the test's
 * temporary directory. It exists to prove the bridge's wire behavior:
 * session/new and resume, configOptions, set_config_option, prompt streaming,
 * stopReason, permission requests, attachments, and a deliberate read-only
 * hang.
 */

import { createHash } from 'node:crypto'
import { closeSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import readline from 'node:readline'

function argValue(name, fallback = '') {
  const prefix = `--${name}=`
  const found = process.argv.find((arg) => arg.startsWith(prefix))
  return found ? found.slice(prefix.length) : fallback
}

const noImage = process.argv.includes('--no-image')
const noEmbedded = process.argv.includes('--no-embedded')
const noResume = process.argv.includes('--no-resume')
const groupedOptions = process.argv.includes('--grouped-options')
const setMissingOptions = process.argv.includes('--set-missing-options')
const setMismatch = process.argv.includes('--set-mismatch')
const holdAfterStdin = process.argv.includes('--hold-after-stdin')
const logPath = argValue('log', process.env.MOCK_ACP_LOG || '')
const statePath = argValue('state', process.env.MOCK_ACP_STATE || '')
const writeRoot = argValue('write-root', process.env.MOCK_ACP_WRITE_ROOT || '')

if (holdAfterStdin) {
  // Keep the process alive after its stdin is destroyed so the parent can
  // observe a real EPIPE instead of a child-exit race.
  setInterval(() => {}, 1000)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function log(event) {
  if (!logPath) return
  const line = JSON.stringify({ at: new Date().toISOString(), ...event })
  try {
    writeFileSync(logPath, `${line}\n`, { flag: 'a' })
  } catch {
    // The test harness reports a missing log separately.
  }
}

function loadState() {
  if (!statePath || !existsSync(statePath)) return { nextId: 1, sessions: {} }
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
    return {
      nextId: Number(parsed.nextId) || 1,
      sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
    }
  } catch {
    return { nextId: 1, sessions: {} }
  }
}

const state = loadState()

function saveState() {
  if (!statePath) return
  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8')
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const activePrompts = new Map()

function respond(id, result) {
  if (id !== undefined) activePrompts.delete(id)
  send({ jsonrpc: '2.0', id, result })
}

function fail(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } })
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params })
}

function update(sessionId, body) {
  notify('session/update', { sessionId, update: body })
}

function configOptionsFor(session) {
  return session.configOptions
}

function option(session, configId) {
  return session.configOptions.find((item) => item.id === configId)
}

function selectValues(option) {
  const values = []
  for (const item of option.options ?? []) {
    if (Array.isArray(item.options)) {
      for (const child of item.options) values.push(child.value)
    } else {
      values.push(item.value)
    }
  }
  return values
}

function defaultOptions() {
  const modelOptions = groupedOptions
    ? [
        {
          group: 'basic',
          name: 'Basic',
          options: [{ value: 'auto', name: 'Auto', description: 'Server picks' }],
        },
        {
          group: 'advanced',
          name: 'Advanced',
          options: [
            { value: 'test-model-a', name: 'Test Model A', description: 'First mock model' },
            { value: 'test-model-b', name: 'Test Model B', description: 'Second mock model' },
          ],
        },
      ]
    : [
        { value: 'auto', name: 'Auto', description: 'Server picks' },
        { value: 'test-model-a', name: 'Test Model A', description: 'First mock model' },
        { value: 'test-model-b', name: 'Test Model B', description: 'Second mock model' },
      ]
  return [
    {
      id: 'model',
      name: 'Model',
      description: 'Mock model choice',
      category: 'model',
      type: 'select',
      currentValue: 'auto',
      options: modelOptions,
    },
    {
      id: 'thought',
      name: 'Thinking',
      description: 'Mock thought strength',
      category: 'thought',
      type: 'select',
      currentValue: 'medium',
      options: [
        { value: 'low', name: 'Low', description: 'Fast' },
        { value: 'medium', name: 'Medium', description: 'Balanced' },
        { value: 'high', name: 'High', description: 'Deep' },
      ],
    },
  ]
}

function ensureSession(sessionId) {
  return state.sessions[sessionId] ?? null
}

const permissionWaiters = new Map()

function requestPermission(sessionId, toolCall) {
  return new Promise((resolvePromise) => {
    const id = state.nextId++
    permissionWaiters.set(id, { resolve: resolvePromise, sessionId })
    log({ event: 'permission_request', sessionId, id, toolCall })
    send({
      jsonrpc: '2.0',
      id,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall,
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      },
    })
    const timer = setTimeout(() => {
      if (permissionWaiters.delete(id)) resolvePromise({ outcome: 'cancelled' })
    }, 10000)
    timer.unref?.()
  })
}

function textOfPrompt(prompt) {
  const blocks = Array.isArray(prompt) ? prompt : []
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function attachmentSummary(prompt) {
  const blocks = Array.isArray(prompt) ? prompt : []
  return blocks
    .filter((block) => block?.type === 'image' || block?.type === 'resource')
    .map((block) => {
      if (block.type === 'image') {
        const data = typeof block.data === 'string' ? block.data : ''
        const bytes = Buffer.from(data, 'base64')
        return { kind: 'image', mimeType: block.mimeType ?? '', bytes: bytes.length, sha256: sha256(bytes) }
      }
      const resource = block.resource ?? {}
      if (typeof resource.text === 'string') {
        return {
          kind: 'resource',
          mimeType: resource.mimeType ?? '',
          uri: resource.uri ?? '',
          bytes: Buffer.byteLength(resource.text),
          sha256: sha256(resource.text),
        }
      }
      return { kind: 'resource', mimeType: resource.mimeType ?? '', uri: resource.uri ?? '', unsupported: true }
    })
}

async function finishPrompt(message, sessionId, prompt) {
  const text = textOfPrompt(prompt)
  const attachments = attachmentSummary(prompt)
  const session = ensureSession(sessionId)
  log({ event: 'prompt', sessionId, text, textSha256: sha256(text), attachments })

  if (text.includes('REJECT-PROMPT')) {
    fail(message.id, -32603, 'mock prompt rejected after receipt')
    return
  }

  if (text.includes('EPIPE-AFTER-PROMPT')) {
    log({ event: 'prompt_epipe_after_receipt', sessionId })
    // Closing the agent side of stdin makes the next client write fail with
    // EPIPE after the prompt request was already accepted.
    process.stdin.destroy()
    try {
      closeSync(0)
    } catch {
      // Already closed on platforms that close the fd with the stream.
    }
    setTimeout(() => {
      void requestPermission(sessionId, {
        toolCallId: 'epipe-tool',
        title: 'Write after EPIPE',
        kind: 'edit',
        status: 'pending',
      })
    }, 100).unref?.()
    return
  }

  if (text.includes('FALLBACK') && session) {
    // Simulate a runtime model/thought fallback: the prompt completes, but the
    // agent reports a different complete configuration before its final text.
    const actual = defaultOptions()
    session.configOptions = actual
    saveState()
    update(sessionId, {
      sessionUpdate: 'config_option_update',
      configOptions: configOptionsFor(session),
    })
    log({ event: 'config_fallback', sessionId, configOptions: configOptionsFor(session) })
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'FALLBACK-ACTUAL-REPLY' },
    })
    respond(message.id, {
      stopReason: text.includes('FALLBACK-MAX') ? 'max_tokens' : 'end_turn',
    })
    return
  }

  if (text.includes('HANG')) {
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'READ-ONLY-PROGRESS' },
    })
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'hang-tool',
      title: 'Read-only progress',
      kind: 'read',
      status: 'pending',
    })
    log({ event: 'prompt_hang', sessionId })
    return
  }

  if (text.includes('EXIT-NOW')) {
    // Simulate the CLI crashing after it accepted the prompt: the process dies
    // so the client sees a closed transport, never a stopReason.
    log({ event: 'prompt_exit_after_receipt', sessionId })
    setTimeout(() => process.exit(7), 10).unref?.()
    return
  }

  if (text.includes('PERMISSION')) {
    const decision = await requestPermission(sessionId, {
      toolCallId: 'perm-tool',
      title: 'Write a synthetic file',
      kind: 'edit',
      status: 'pending',
    })
    log({ event: 'permission_decision', sessionId, decision })
    if (decision?.outcome?.outcome === 'selected' && decision.outcome.optionId === 'reject-once') {
      respond(message.id, { stopReason: 'refusal' })
      return
    }
    if (decision?.outcome?.outcome === 'selected') {
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'PERMISSION-APPROVED-BY-CLIENT' },
      })
      respond(message.id, { stopReason: 'end_turn' })
      return
    }
    respond(message.id, { stopReason: 'cancelled' })
    return
  }

  if (text.includes('WRITE:')) {
    const match = text.match(/WRITE:([^|\r\n]+)\|([\s\S]*)/)
    const target = match ? resolve(match[1].trim()) : ''
    const content = match ? match[2] : ''
    const root = writeRoot ? resolve(writeRoot) : ''
    if (!target || !root || !target.startsWith(root)) {
      respond(message.id, { stopReason: 'refusal' })
      return
    }
    writeFileSync(target, content, 'utf8')
    const digest = sha256(content)
    log({ event: 'write', target, bytes: Buffer.byteLength(content), sha256: digest })
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `WROTE ${digest}` },
    })
    respond(message.id, { stopReason: 'end_turn' })
    return
  }

  if (text.includes('EMPTY')) {
    respond(message.id, { stopReason: 'end_turn' })
    return
  }

  if (text.includes('MAX')) {
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'PARTIAL-ANSWER' },
    })
    respond(message.id, { stopReason: 'max_tokens' })
    return
  }

  if (text.includes('CANCEL')) {
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'CANCEL-ME' },
    })
    log({ event: 'prompt_waiting_for_cancel', sessionId })
    return
  }

  const late = text.match(/LATE:(\d+)/)
  if (late) {
    setTimeout(() => {
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'LATE-REPLY' },
      })
      respond(message.id, { stopReason: 'end_turn' })
    }, Math.max(10, Number(late[1]) || 500)).unref?.()
    return
  }

  update(sessionId, {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'THOUGHT-SHOULD-NOT-BE-REPLY' },
  })
  update(sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId: 'mock-tool',
    title: 'Mock read',
    kind: 'read',
    status: 'pending',
  })
  const attachmentText = attachments.length
    ? ` attachments=${attachments.map((item) => `${item.kind}:${item.sha256}`).join(',')}`
    : ''
  const firstLine = text.split(/\r?\n/).find((line) => line.trim() !== '') ?? ''
  update(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: `MOCK-REPLY: ${firstLine.slice(0, 120)}${attachmentText}` },
  })
  update(sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'mock-tool',
    title: 'Mock read',
    kind: 'read',
    status: 'completed',
  })
  respond(message.id, { stopReason: 'end_turn' })
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed === '') return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    return
  }
  if (message.method === undefined && message.id !== undefined) {
    const waiter = permissionWaiters.get(message.id)
    if (waiter) {
      permissionWaiters.delete(message.id)
      log({ event: 'permission_response', id: message.id, result: message.result })
      waiter.resolve(message.result ?? { outcome: 'cancelled' })
    }
    return
  }
  if (message.method === 'initialize') {
    log({ event: 'initialize', params: message.params })
    respond(message.id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: noResume ? {} : { resume: {} },
        promptCapabilities: {
          image: !noImage,
          audio: false,
          embeddedContext: !noEmbedded,
        },
      },
      authMethods: [],
    })
    return
  }
  if (message.method === 'session/new') {
    const sessionId = `acp-sess-${state.nextId++}`
    state.sessions[sessionId] = { configOptions: defaultOptions() }
    saveState()
    log({ event: 'session_new', sessionId, params: message.params })
    respond(message.id, { sessionId, configOptions: defaultOptions() })
    return
  }
  if (message.method === 'session/resume' || message.method === 'session/load') {
    if (message.method === 'session/resume' && noResume) {
      fail(message.id, -32601, 'Method not found: session/resume')
      return
    }
    const sessionId = message.params?.sessionId
    const session = ensureSession(sessionId)
    log({ event: message.method, sessionId, found: Boolean(session) })
    if (!session) {
      fail(message.id, -32602, `Unknown session: ${sessionId}`, { reason: 'unknown_session' })
      return
    }
    if (message.method === 'session/load') {
      update(sessionId, {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'REPLAYED-OLD-USER' },
      })
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'REPLAYED-OLD-ANSWER' },
      })
    }
    respond(message.id, { configOptions: configOptionsFor(session) })
    return
  }
  if (message.method === 'session/set_config_option') {
    const sessionId = message.params?.sessionId
    const session = ensureSession(sessionId)
    if (!session) {
      fail(message.id, -32602, `Unknown session: ${sessionId}`, { reason: 'unknown_session' })
      return
    }
    const configId = message.params?.configId
    const value = message.params?.value
    const target = option(session, configId)
    if (!target || !selectValues(target).includes(value)) {
      fail(message.id, -32602, `Invalid config ${configId}=${value}`, {
        reason: 'invalid_config',
        configId,
        value,
      })
      return
    }
    if (!setMismatch) {
      target.currentValue = value
      saveState()
    }
    log({ event: 'set_config', sessionId, configId, value, applied: !setMismatch })
    if (setMissingOptions) {
      respond(message.id, {})
      return
    }
    respond(message.id, { configOptions: configOptionsFor(session) })
    return
  }
  if (message.method === 'session/prompt') {
    const sessionId = message.params?.sessionId
    const session = ensureSession(sessionId)
    if (!session) {
      fail(message.id, -32602, `Unknown session: ${sessionId}`, { reason: 'unknown_session' })
      return
    }
    if (message.id !== undefined) activePrompts.set(message.id, sessionId)
    void finishPrompt(message, sessionId, message.params?.prompt).catch((error) => {
      fail(message.id, -32603, String(error?.message ?? error))
    })
    return
  }
  if (message.method === 'session/cancel') {
    const sessionId = message.params?.sessionId
    log({ event: 'cancel', sessionId })
    for (const [id, owner] of activePrompts.entries()) {
      if (owner === sessionId) {
        respond(id, { stopReason: 'cancelled' })
        break
      }
    }
    return
  }
  if (message.id !== undefined) {
    fail(message.id, -32601, `Method not found: ${message.method}`)
  }
})

rl.on('close', () => {
  if (!holdAfterStdin) process.exit(0)
})