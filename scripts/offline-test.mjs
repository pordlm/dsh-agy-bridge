/**
 * Offline regression suite for the official ACP bridge.
 *
 * Every scenario uses a fresh temporary state directory, the local mock ACP
 * agent, and synthetic files. It never starts the real Antigravity CLI, reads
 * a user file, or touches an account.
 *
 * Usage: node scripts/offline-test.mjs
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'
import { Bridge, defaultConfig } from '../lib/bridge.js'
import { AcpClient, acpBackend, pickModelOption, pickThoughtOption } from '../lib/acp.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const mockPath = join(here, 'mock-agy-acp.mjs')

let failures = 0
const checks = []
function check(label, condition, detail = '') {
  checks.push({ label, condition, detail })
  if (condition) console.log(`PASS ${label}${detail ? ` — ${detail}` : ''}`)
  else {
    failures += 1
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readEvents(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

class Harness {
  constructor(name, { mockArgs = [], stateSeed = null, autoWake = true, mountLlm = false } = {}) {
    this.name = name
    this.temp = mkdtempSync(join(tmpdir(), `ag-bridge-${name}-`))
    this.logPath = join(this.temp, 'events.jsonl')
    this.statePath = join(this.temp, 'state.json')
    if (stateSeed) writeFileSync(this.statePath, JSON.stringify(stateSeed, null, 2), 'utf8')
    this.wakes = []
    this.agents = new Map()
    this.cleanups = []
    const tools = new Map()
    // mountLlm: give apply() a minimal `llm` service plus ctx.get, so the real
    // plugin entry point (apply -> createAdapter -> resolveWorkspace) is what
    // gets exercised instead of a hand-built adapter.
    const adapters = new Map()
    const llm = {
      registerAdapter(providers, adapter) {
        const routes = Array.isArray(providers) ? providers : [providers]
        for (const route of routes) adapters.set(route, adapter)
        this.registered = routes
        return () => {
          for (const route of routes) adapters.delete(route)
        }
      },
    }
    this.llm = llm
    this.adapters = adapters
    const ctx = {
      logger: { warn: (line) => console.log(`WARN[${name}] ${line}`) },
      tools: {
        register(definition) {
          tools.set(definition.name, definition)
          return () => tools.delete(definition.name)
        },
      },
      agents: {
        get: (id) => this.agents.get(String(id)),
        list: () => [...this.agents.values()],
      },
      on: () => () => {},
      effect: (fn) => {
        const cleanup = fn()
        if (typeof cleanup === 'function') this.cleanups.push(cleanup)
      },
    }
    if (mountLlm) {
      ctx.llm = llm
      ctx.get = (serviceName) => (serviceName === 'llm' ? llm : undefined)
    }
    apply(ctx, {
      agyExecutable: process.execPath,
      agyArgs: [
        mockPath,
        `--state=${this.statePath}`,
        `--log=${this.logPath}`,
        `--write-root=${this.temp}`,
        ...mockArgs,
      ],
      cwd: this.temp,
      stateFile: this.statePath,
      waitPollMs: 50,
      pollMs: 1000,
      autoWake,
      maxReplyChars: 20000,
    })
    this.tools = tools
  }

  agent(id = 'agent-a') {
    let agent = this.agents.get(id)
    if (!agent) {
      agent = {
        id,
        followup: (message) => {
          this.wakes.push({ id, message })
        },
      }
      this.agents.set(id, agent)
    }
    return agent
  }

  async call(name, args, agentId = 'agent-a') {
    const tool = this.tools.get(name)
    if (!tool) throw new Error(`missing tool ${name}`)
    return tool.execute(args, { agent: this.agent(agentId) })
  }

  events() {
    return readEvents(this.logPath)
  }

  async close() {
    for (const cleanup of [...this.cleanups].reverse()) {
      try {
        await cleanup()
      } catch (error) {
        console.log(`WARN[${this.name}] cleanup: ${error?.message ?? error}`)
      }
    }
    await sleep(120)
    try {
      rmSync(this.temp, { recursive: true, force: true })
    } catch {
      // Windows may briefly hold the mock's cwd; test assertions already ran.
    }
  }
}

async function settle(harness, jobId, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await harness.call('antigravity_read', { job_id: jobId })
    if (last.status === 'replied' || last.status === 'failed') return last
    await sleep(40)
  }
  return last
}

async function main() {
  // 0. Real agy 1.5.14 advertises model / thought_level / mode categories.
  {
    const realLike = [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'auto',
        options: [{ value: 'auto', name: 'Auto' }],
      },
      {
        id: 'thought_level',
        name: 'Thinking Level',
        category: 'thought_level',
        type: 'select',
        currentValue: 'medium',
        options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }],
      },
      {
        id: 'mode',
        name: 'Mode',
        category: 'mode',
        type: 'select',
        currentValue: 'default',
        options: [{ value: 'default', name: 'Default' }],
      },
    ]
    check('real model category recognized', pickModelOption(realLike)?.id === 'model')
    check('real thought_level category recognized', pickThoughtOption(realLike)?.id === 'thought_level')
    check('real thought_level current value', pickThoughtOption(realLike)?.currentValue === 'medium')
  }

  // 1. New session, model + thought config, assistant text, one wake.
  {
    const harness = new Harness('new-session')
    try {
      const sent = await harness.call('antigravity_send', {
        message: 'reply with one line',
        model: 'Test Model A',
        effort: 'High',
      })
      check('new session accepted', sent.status === 'accepted', `${sent.jobId} ${sent.sessionId}`)
      check('new session effective model', sent.effective.model === 'test-model-a', sent.effective.model)
      check('new session effective effort', sent.effective.effort === 'high', sent.effective.effort)
      check('new session target kind', sent.targetKind === 'acp_session')
      const settled = await settle(harness, sent.jobId)
      check('new session replied', settled.status === 'replied', settled.status)
      check('reply text only from assistant chunks', settled.reply.startsWith('MOCK-REPLY:'), settled.reply)
      check('thought chunk excluded', !settled.reply.includes('THOUGHT-SHOULD-NOT-BE-REPLY'))
      const events = harness.events()
      const sets = events.filter((event) => event.event === 'set_config')
      check(
        'model applied before thought',
        sets.length === 2 && sets[0].configId === 'model' && sets[1].configId === 'thought',
        sets.map((event) => `${event.configId}=${event.value}`).join(','),
      )
      check('wake delivered once', harness.wakes.length === 1, String(harness.wakes.length))
      check(
        'wake message carries job and reply',
        harness.wakes[0]?.message?.content?.[0]?.text?.includes('MOCK-REPLY:'),
      )
      await harness.call('antigravity_read', { job_id: sent.jobId })
      check('read does not duplicate wake', harness.wakes.length === 1)
    } finally {
      await harness.close()
    }
  }

  // 2. Config listing and continuation with a different model/effort.
  {
    const harness = new Harness('resume')
    try {
      const listed = await harness.call('antigravity_config', {})
      check('config lists model and thought', listed.configOptions.length >= 2)
      check('config capability image', listed.capabilities.image === true)
      const resumed = await harness.call('antigravity_send', {
        conversation_id: listed.sessionId,
        message: 'continue here',
        model: 'test-model-b',
        effort: 'low',
      })
      check('continuation accepted', resumed.status === 'accepted', resumed.status)
      check('continuation keeps session id', resumed.sessionId === listed.sessionId)
      const settled = await settle(harness, resumed.jobId)
      check('continuation replied', settled.status === 'replied', settled.status)
      const events = harness.events()
      check('resume event observed', events.some((event) => event.event === 'session/resume' && event.found))
      check(
        'continuation model/effort applied',
        events.some((event) => event.event === 'set_config' && event.value === 'test-model-b') &&
          events.some((event) => event.event === 'set_config' && event.value === 'low'),
      )
      const after = await harness.call('antigravity_config', { conversation_id: listed.sessionId })
      check(
        'config read back after switch',
        after.configOptions.find((item) => item.id === 'model')?.currentValue === 'test-model-b' &&
          after.configOptions.find((item) => item.id === 'thought')?.currentValue === 'low',
      )
    } finally {
      await harness.close()
    }
  }

  // 3. Resume falls back to session/load when session/resume is not implemented.
  {
    const harness = new Harness('resume-load', { mockArgs: ['--no-resume'] })
    try {
      const listed = await harness.call('antigravity_config', {})
      const resumed = await harness.call('antigravity_send', {
        conversation_id: listed.sessionId,
        message: 'load this session',
      })
      const settled = await settle(harness, resumed.jobId)
      check('load fallback replied', settled.status === 'replied', settled.status)
      check('load fallback used session/load', harness.events().some((event) => event.event === 'session/load'))
      check(
        'load replay is not part of the reply',
        !settled.reply.includes('REPLAYED-OLD-ANSWER') && settled.reply.startsWith('MOCK-REPLY:'),
        settled.reply,
      )
    } finally {
      await harness.close()
    }
  }

  // 4. A model can succeed while a later thought value fails; report the
  //    applied model snapshot, send no prompt, and allow a safe retry.
  {
    const harness = new Harness('partial-config')
    try {
      const sent = await harness.call('antigravity_send', {
        message: 'must not be sent',
        model: 'test-model-b',
        effort: 'not-a-real-level',
      })
      check('partial config not sent', sent.status === 'not_sent', sent.status)
      check('partial config code', sent.code === 'unsupported_capability', sent.code)
      check('partial config keeps applied model', sent.effective.model === 'test-model-b', sent.effective.model)
      check(
        'partial config exposes snapshot',
        sent.configOptions.find((item) => item.id === 'model')?.currentValue === 'test-model-b',
      )
      check(
        'partial config sent no prompt',
        !harness.events().some((event) => event.event === 'prompt'),
      )
    } finally {
      await harness.close()
    }
  }

  // 5. Real attachment bytes and path-reference-only mode.
  {
    const harness = new Harness('attachments')
    const textPath = join(harness.temp, 'note.txt')
    const imagePath = join(harness.temp, 'pixel.png')
    const textBytes = Buffer.from('ATTACHMENT-TEXT-验证\n', 'utf8')
    const imageBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52,
    ])
    writeFileSync(textPath, textBytes)
    writeFileSync(imagePath, imageBytes)
    try {
      const sent = await harness.call('antigravity_send', {
        message: 'inspect the attachments',
        attachments: [textPath, imagePath],
      })
      check('attachment send accepted', sent.status === 'accepted', sent.status)
      check('attachment file mode', sent.fileMode === 'attachment', sent.fileMode)
      check('attachment metadata counted', sent.requested.attachments === 2)
      const settled = await settle(harness, sent.jobId)
      check('attachment reply', settled.status === 'replied', settled.status)
      const events = harness.events()
      const prompt = events.find((event) => event.event === 'prompt')
      check(
        'image bytes hash matches',
        prompt?.attachments?.some(
          (item) => item.kind === 'image' && item.sha256 === sha256(imageBytes),
        ) === true,
      )
      check(
        'embedded text bytes hash matches',
        prompt?.attachments?.some(
          (item) => item.kind === 'resource' && item.sha256 === sha256(textBytes),
        ) === true,
      )
      check(
        'reply reports attachment hashes',
        settled.reply.includes(sha256(imageBytes)) && settled.reply.includes(sha256(textBytes)),
      )

      const refSent = await harness.call('antigravity_send', {
        message: 'reference only',
        path_refs: [textPath],
      })
      const refSettled = await settle(harness, refSent.jobId)
      check('path reference replied', refSettled.status === 'replied', refSettled.status)
      check('path reference file mode', refSent.fileMode === 'path_reference', refSent.fileMode)
      const refPrompt = harness
        .events()
        .filter((event) => event.event === 'prompt')
        .at(-1)
      check('path reference in text', refPrompt?.text?.includes('[path_reference]') === true)
      check('path reference has no attachment bytes', !refPrompt?.attachments?.length)
    } finally {
      await harness.close()
    }
  }

  // 4. Capability rejection happens before any prompt or file read.
  {
    const harness = new Harness('no-image', { mockArgs: ['--no-image'] })
    const imagePath = join(harness.temp, 'pixel.png')
    writeFileSync(
      imagePath,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
    )
    const jobsBefore = (await harness.call('antigravity_list', {})).jobs.length
    let error = null
    try {
      await harness.call('antigravity_send', { message: 'image', attachments: [imagePath] })
    } catch (caught) {
      error = caught
    }
    check('image rejected without capability', error?.code === 'unsupported_capability', error?.message)
    check('rejection created no job', (await harness.call('antigravity_list', {})).jobs.length === jobsBefore)
    check(
      'rejection sent no prompt',
      !harness.events().some((event) => event.event === 'prompt'),
    )
    await harness.close()
  }

  // 5. Permission request is visible and never auto-approved.
  {
    const harness = new Harness('permission')
    try {
      const sent = await harness.call('antigravity_send', { message: 'PERMISSION please write' })
      const settled = await settle(harness, sent.jobId)
      check('permission prompt failed', settled.status === 'failed', settled.status)
      check('permission failure code', settled.code === 'permission_denied', settled.code)
      check('permission event recorded', settled.permissions.length === 1)
      check(
        'permission decision is rejection',
        settled.permissions[0]?.decision === 'rejected',
        settled.permissions[0]?.decision,
      )
      check(
        'permission was not auto-approved',
        !harness.events().some(
          (event) =>
            event.event === 'permission_response' &&
            event.result?.outcome?.optionId === 'allow-once',
        ),
      )
      check('permission failure does not wake', harness.wakes.length === 0)
    } finally {
      await harness.close()
    }
  }

  // 6. Read-only progress hangs; wait times out; no wake and no resend.
  {
    const harness = new Harness('hang')
    try {
      const sent = await harness.call('antigravity_send', { message: 'HANG here' })
      check('hang accepted', sent.status === 'accepted', sent.status)
      const read = await harness.call('antigravity_read', { job_id: sent.jobId })
      check('read-only progress is not a reply', read.status === 'accepted' && read.reply === '', read.status)
      const waited = await harness.call('antigravity_wait', {
        job_id: sent.jobId,
        timeout_sec: 10,
      })
      check('wait timeout code', waited.code === 'wait_timeout', waited.code)
      check('wait timeout keeps status', waited.status === 'accepted', waited.status)
      check('wait timeout returns job id', waited.jobId === sent.jobId)
      check('timeout did not wake', harness.wakes.length === 0)
      const after = await harness.call('antigravity_read', { job_id: sent.jobId })
      check('job still queryable after timeout', after.status === 'accepted' && after.reply === '')
      const prompts = harness.events().filter((event) => event.event === 'prompt')
      check('timeout did not resend', prompts.length === 1, String(prompts.length))
    } finally {
      await harness.close()
    }
  }

  // 7. Successful prompt with wait=true suppresses the automatic wake.
  {
    const harness = new Harness('wait')
    try {
      const waited = await harness.call('antigravity_send', {
        message: 'wait for me',
        wait: true,
        timeout_sec: 10,
      })
      check('send wait replied', waited.status === 'replied', waited.status)
      check('send wait suppresses wake', waited.wakeState === 'suppressed', waited.wakeState)
      check('send wait delivered zero wakes', harness.wakes.length === 0)
    } finally {
      await harness.close()
    }
  }

  // 8. Empty and truncated prompts are not final replies and do not wake.
  {
    const harness = new Harness('stop-reasons')
    try {
      const empty = await harness.call('antigravity_send', { message: 'EMPTY answer' })
      const emptySettled = await settle(harness, empty.jobId)
      check('empty reply fails', emptySettled.status === 'failed' && emptySettled.code === 'empty_reply', emptySettled.code)
      const max = await harness.call('antigravity_send', { message: 'MAX tokens' })
      const maxSettled = await settle(harness, max.jobId)
      check('max_tokens fails', maxSettled.status === 'failed' && maxSettled.code === 'truncated', maxSettled.code)
      check('stop failures do not wake', harness.wakes.length === 0)
    } finally {
      await harness.close()
    }
  }

  // 9. Concurrency: one in-flight prompt per session, busy is explicit.
  {
    const harness = new Harness('busy')
    try {
      const listed = await harness.call('antigravity_config', {})
      const first = await harness.call('antigravity_send', {
        conversation_id: listed.sessionId,
        message: 'LATE:600 first',
      })
      let busy = null
      try {
        await harness.call('antigravity_send', {
          conversation_id: listed.sessionId,
          message: 'second',
        })
      } catch (error) {
        busy = error
      }
      check('same-session concurrency rejected', busy?.code === 'busy', busy?.message)
      const firstSettled = await settle(harness, first.jobId)
      check('first concurrency reply', firstSettled.status === 'replied', firstSettled.status)
      const second = await harness.call('antigravity_send', {
        conversation_id: listed.sessionId,
        message: 'after first',
      })
      const secondSettled = await settle(harness, second.jobId)
      check('session reusable after reply', secondSettled.status === 'replied', secondSettled.status)
      check(
        'only one prompt while busy',
        harness.events().filter((event) => event.event === 'prompt').length === 2,
      )
    } finally {
      await harness.close()
    }
  }

  // 10. Ownership and ambiguous legacy selector.
  {
    const harness = new Harness('ownership')
    try {
      const listed = await harness.call('antigravity_config', {})
      const first = await harness.call('antigravity_send', {
        conversation_id: listed.sessionId,
        message: 'owner only',
        wait: true,
        timeout_sec: 10,
      })
      check('owner sent', first.status === 'replied', first.status)
      let forbidden = null
      try {
        await harness.call('antigravity_read', { job_id: first.jobId }, 'agent-b')
      } catch (error) {
        forbidden = error
      }
      check('other agent cannot read job', forbidden?.code === 'forbidden', forbidden?.message)
      let forbiddenSend = null
      try {
        await harness.call(
          'antigravity_send',
          { conversation_id: listed.sessionId, message: 'hijack' },
          'agent-b',
        )
      } catch (error) {
        forbiddenSend = error
      }
      check('other agent cannot send into owned session', forbiddenSend?.code === 'forbidden')
      const second = await harness.call('antigravity_send', {
        conversation_id: listed.sessionId,
        message: 'second owner job',
        wait: true,
        timeout_sec: 10,
      })
      let ambiguous = null
      try {
        await harness.call('antigravity_read', { conversation_id: listed.sessionId })
      } catch (error) {
        ambiguous = error
      }
      check('two jobs make legacy selector ambiguous', ambiguous?.code === 'ambiguous_job', ambiguous?.message)
      check('job id still works', (await harness.call('antigravity_read', { job_id: second.jobId })).jobId === second.jobId)
    } finally {
      await harness.close()
    }
  }

  // 11. Unknown continuation fails before the prompt.
  {
    const harness = new Harness('unknown-session')
    try {
      const sent = await harness.call('antigravity_send', {
        conversation_id: 'missing-session',
        message: 'should not send',
      })
      const listed = await harness.call('antigravity_list', {})
      check('unknown session not sent', sent.status === 'not_sent' && sent.code === 'workspace_binding_unknown', `${sent.status}/${sent.code}`)
      check('unknown session job not_sent', listed.jobs[0]?.status === 'not_sent', listed.jobs[0]?.status)
      check('unknown session no prompt', !harness.events().some((event) => event.event === 'prompt'))
    } finally {
      await harness.close()
    }
  }

  // 12. Reload recovery never resends; pre-prompt work is not_sent.
  {
    const temp = mkdtempSync(join(tmpdir(), 'ag-bridge-reload-'))
    const state = {
      version: 3,
      owners: { sess: 'agent-a' },
      locks: { sess: 'agj-prompting' },
      legacy: {},
      jobs: {
        'agj-prompting': {
          jobId: 'agj-prompting',
          ownerAgentId: 'agent-a',
          conversationId: 'sess',
          targetKind: 'acp_session',
          kind: 'continue',
          status: 'accepted',
          phase: 'prompting',
          code: '',
          message: '',
          requested: {
            model: '',
            effort: '',
            profile: '',
            title: '',
            pathRefs: [],
            attachments: 0,
            attachmentInfo: [],
          },
          effective: { model: '', effort: '', profile: '', source: '', verified: false },
          configOptions: [],
          permissions: [],
          title: '',
          reply: null,
          wakeState: 'none',
          wakeTries: 0,
          ack: '',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        'agj-creating': {
          jobId: 'agj-creating',
          ownerAgentId: 'agent-a',
          conversationId: '',
          targetKind: 'acp_session',
          kind: 'create',
          status: 'acceptance_unknown',
          phase: 'creating',
          code: '',
          message: '',
          requested: {
            model: '',
            effort: '',
            profile: '',
            title: '',
            pathRefs: [],
            attachments: 0,
            attachmentInfo: [],
          },
          effective: { model: '', effort: '', profile: '', source: '', verified: false },
          configOptions: [],
          permissions: [],
          title: '',
          reply: null,
          wakeState: 'none',
          wakeTries: 0,
          ack: '',
          createdAt: '2026-01-01T00:00:01.000Z',
          updatedAt: '2026-01-01T00:00:01.000Z',
        },
      },
    }
    const harness = new Harness('reload', { stateSeed: state })
    try {
      const prompting = await harness.call('antigravity_read', { job_id: 'agj-prompting' })
      check(
        'prompting recovery is acceptance_unknown',
        prompting.status === 'acceptance_unknown' &&
          prompting.code === 'dispatch_interrupted' &&
          prompting.wakeState === 'none',
        `${prompting.status}/${prompting.code}`,
      )
      const creating = await harness.call('antigravity_read', { job_id: 'agj-creating' })
      check(
        'pre-prompt recovery is not_sent',
        creating.status === 'not_sent' && creating.code === 'dispatch_interrupted_before_prompt',
        `${creating.status}/${creating.code}`,
      )
      check('recovery sent no prompt', !harness.events().some((event) => event.event === 'prompt'))
    } finally {
      await harness.close()
      rmSync(temp, { recursive: true, force: true })
    }
  }

  // 12b. Old state versions stay readable, but are never dispatched or woken.
  {
    const temp = mkdtempSync(join(tmpdir(), 'ag-bridge-legacy-'))
    const state = {
      version: 2,
      owners: {},
      locks: {},
      legacy: { conversations: { 'desktop-uuid': { pending: [] } } },
      jobs: {
        'agj-old': {
          jobId: 'agj-old',
          ownerAgentId: 'agent-a',
          conversationId: 'desktop-uuid',
          status: 'accepted',
          phase: 'prompting',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    }
    const harness = new Harness('legacy', { stateSeed: state })
    try {
      const read = await harness.call('antigravity_read', { job_id: 'agj-old' })
      check(
        'legacy job is failed read-only',
        read.status === 'failed' && read.code === 'legacy_state',
        `${read.status}/${read.code}`,
      )
      check('legacy job has schema-safe fields', read.targetKind === 'acp_session' && read.desktopConversationId === '')
      const listed = await harness.call('antigravity_list', {})
      check(
        'legacy job remains listable without prompting',
        listed.jobs.some((job) => job.jobId === 'agj-old' && job.status === 'failed'),
      )
      check('legacy job sent no prompt', !harness.events().some((event) => event.event === 'prompt'))
      check('legacy job did not wake', harness.wakes.length === 0)
    } finally {
      await harness.close()
      rmSync(temp, { recursive: true, force: true })
    }
  }

  // 13. Effective write and completion receipt through the mock agent.
  {
    const harness = new Harness('write')
    const target = join(harness.temp, 'written.txt')
    try {
      const sent = await harness.call('antigravity_send', {
        message: `WRITE:${target}|hello from mock`,
      })
      check('write prompt accepted', sent.status === 'accepted', sent.status)
      const settled = await settle(harness, sent.jobId)
      check('write prompt replied', settled.status === 'replied', settled.status)
      check('write actually landed', readFileSync(target, 'utf8') === 'hello from mock')
      check(
        'write completion receipt',
        settled.reply === `WROTE ${sha256('hello from mock')}`,
        settled.reply,
      )
      check('write woke once', harness.wakes.length === 1, String(harness.wakes.length))
      const reread = await harness.call('antigravity_read', { job_id: sent.jobId })
      check('write reply is re-readable', reread.reply === settled.reply)
      check('write read does not wake again', harness.wakes.length === 1, String(harness.wakes.length))
    } finally {
      await harness.close()
    }
  }

  // 14. Input validation paths are rejected before any job.
  {
    const harness = new Harness('validation')
    try {
      let relative = null
      let missing = null
      let directory = null
      try {
        await harness.call('antigravity_send', { message: 'x', path_refs: ['relative.txt'] })
      } catch (error) {
        relative = error
      }
      try {
        await harness.call('antigravity_send', {
          message: 'x',
          attachments: [join(harness.temp, 'missing.txt')],
        })
      } catch (error) {
        missing = error
      }
      try {
        await harness.call('antigravity_send', { message: 'x', path_refs: [harness.temp] })
      } catch (error) {
        directory = error
      }
      check('relative path rejected', relative?.code === 'invalid_path')
      check('missing attachment rejected', missing?.code === 'invalid_path')
      check('directory reference rejected', directory?.code === 'invalid_path')
      check('validation created no jobs', (await harness.call('antigravity_list', {})).jobs.length === 0)
    } finally {
      await harness.close()
    }
  }

  // 15. Profile is explicitly unsupported, not silently ignored.
  {
    const harness = new Harness('profile')
    try {
      let error = null
      try {
        await harness.call('antigravity_send', { message: 'x', profile: 'work' })
      } catch (caught) {
        error = caught
      }
      check('profile rejected explicitly', error?.code === 'unsupported_capability', error?.message)
      check('profile created no job', (await harness.call('antigravity_list', {})).jobs.length === 0)
    } finally {
      await harness.close()
    }
  }

  // 16. List only shows the caller's jobs.
  {
    const harness = new Harness('list-owner')
    try {
      await harness.call('antigravity_send', { message: 'mine', wait: true, timeout_sec: 10 })
      const mine = await harness.call('antigravity_list', {})
      const other = await harness.call('antigravity_list', {}, 'agent-b')
      check('list shows own job', mine.jobs.length === 1)
      check('list hides other agent jobs', other.jobs.length === 0)
    } finally {
      await harness.close()
    }
  }

  // 17. Explicit cancel uses session/cancel and the actual stopReason.
  {
    const harness = new Harness('cancel')
    try {
      const sent = await harness.call('antigravity_send', { message: 'CANCEL-ME please stop' })
      check('cancel target accepted', sent.status === 'accepted', sent.status)
      const cancelled = await harness.call('antigravity_cancel', {
        job_id: sent.jobId,
        timeout_sec: 2,
      })
      check('cancel updated from stopReason', cancelled.status === 'failed' && cancelled.code === 'cancelled', `${cancelled.status}/${cancelled.code}`)
      check('cancel exposes actual stopReason', cancelled.stopReason === 'cancelled', cancelled.stopReason)
      check('cancel marked the request', cancelled.cancelRequested === true)
      check('cancel sent session/cancel', harness.events().some((event) => event.event === 'cancel'))
      check('cancel did not wake', harness.wakes.length === 0)
      let forbidden
      try {
        await harness.call('antigravity_cancel', { job_id: sent.jobId }, 'agent-b')
      } catch (error) {
        forbidden = error
      }
      check('other agent cannot cancel job', forbidden?.code === 'forbidden')
    } finally {
      await harness.close()
    }
  }

  // 18. Multiple waiters keep suppressing wake until the last one leaves.
  {
    const temp = mkdtempSync(join(tmpdir(), 'ag-bridge-waiters-'))
    let wakes = 0
    const agent = { id: 'agent-a', followup: () => { wakes += 1 } }
    const bridge = new Bridge(
      { agents: { get: (id) => (String(id) === 'agent-a' ? agent : undefined) } },
      defaultConfig({
        stateFile: join(temp, 'state.json'),
        backend: {},
        messageFactory: ({ content, source }) => ({ content, source }),
      }),
    )
    try {
      const { job } = bridge.beginSend({
        agentId: 'agent-a',
        message: 'waiters',
        requested: {},
      })
      bridge.markAccepted(job, {})
      bridge.beginWaiter(job.jobId)
      bridge.beginWaiter(job.jobId)
      check('two waiters counted', bridge.waiterCount(job.jobId) === 2)
      bridge.endWaiter(job.jobId)
      check('one waiter remains after first leaves', bridge.waiterCount(job.jobId) === 1)
      bridge.finishReply(job, { text: 'done', stopReason: 'end_turn' })
      check('first waiter did not allow wake', (await bridge.maybeWake(job)) === false)
      check('no wake while another waiter remains', wakes === 0)
      bridge.endWaiter(job.jobId)
      check('all waiters cleared', bridge.waiterCount(job.jobId) === 0)
      check('wake after last waiter', (await bridge.maybeWake(job)) === true)
      check('wake delivered once', wakes === 1)
    } finally {
      bridge.dispose()
      rmSync(temp, { recursive: true, force: true })
    }
  }

  // 19. Concurrent completion/tick wake attempts deliver exactly once; a
  // followup that throws is never retried because it may already be queued.
  {
    const temp = mkdtempSync(join(tmpdir(), 'ag-bridge-wake-once-'))
    const stateFile = join(temp, 'state.json')
    let wakes = 0
    let followupThrows = false
    const agent = {
      id: 'agent-a',
      followup: () => {
        wakes += 1
        if (followupThrows) throw new Error('followup may already be queued')
      },
    }
    const ctx = { agents: { get: (id) => (String(id) === 'agent-a' ? agent : undefined) } }
    const config = defaultConfig({
      stateFile,
      backend: {},
      messageFactory: async ({ content, source }) => {
        await sleep(20)
        return { content, source }
      },
    })
    const bridge = new Bridge(ctx, config)
    try {
      const first = bridge.beginSend({ agentId: 'agent-a', message: 'wake once', requested: {} })
      bridge.markAccepted(first.job, {})
      bridge.completeJob(first.job, {
        text: 'one',
        stopReason: 'end_turn',
        tools: [],
        permissions: [],
      })
      await bridge.tick()
      await sleep(60)
      check('completion/tick overlap delivered once', wakes === 1, String(wakes))
      check('completion/tick overlap reaches delivered', first.job.wakeState === 'delivered', first.job.wakeState)

      const second = bridge.beginSend({ agentId: 'agent-a', message: 'wake throws', requested: {} })
      bridge.markAccepted(second.job, {})
      bridge.finishReply(second.job, { text: 'two', stopReason: 'end_turn' })
      followupThrows = true
      check('throwing wake is not reported delivered', (await bridge.maybeWake(second.job)) === false)
      check('throwing wake becomes unknown', second.job.wakeState === 'delivery_unknown', second.job.wakeState)
      const beforeRetry = wakes
      check('unknown wake is not retried', (await bridge.maybeWake(second.job)) === false)
      check('no second followup after unknown', wakes === beforeRetry, String(wakes))
    } finally {
      bridge.dispose()
      rmSync(temp, { recursive: true, force: true })
    }
  }

  // 20. Reload converts a persisted delivering wake to delivery_unknown and
  // never re-wakes a job that may already have entered followup.
  {
    const temp = mkdtempSync(join(tmpdir(), 'ag-bridge-wake-reload-'))
    const stateFile = join(temp, 'state.json')
    let wakes = 0
    const agent = { id: 'agent-a', followup: () => { wakes += 1 } }
    const ctx = { agents: { get: (id) => (String(id) === 'agent-a' ? agent : undefined) } }
    const config = defaultConfig({
      stateFile,
      backend: {},
      messageFactory: ({ content, source }) => ({ content, source }),
    })
    const first = new Bridge(ctx, config)
    let jobId
    try {
      const sent = first.beginSend({ agentId: 'agent-a', message: 'reload wake', requested: {} })
      jobId = sent.job.jobId
      first.markAccepted(sent.job, {})
      first.finishReply(sent.job, { text: 'three', stopReason: 'end_turn' })
    } finally {
      first.dispose()
    }
    const raw = JSON.parse(readFileSync(stateFile, 'utf8'))
    raw.jobs[jobId].wakeState = 'delivering'
    writeFileSync(stateFile, JSON.stringify(raw, null, 2), 'utf8')
    const second = new Bridge(ctx, config)
    try {
      check('reload marks delivering unknown', second.job(jobId).wakeState === 'delivery_unknown', second.job(jobId).wakeState)
      await second.tick()
      check('reload does not re-wake', wakes === 0, String(wakes))
    } finally {
      second.dispose()
      rmSync(temp, { recursive: true, force: true })
    }
  }

  // 20b. A wake checkpoint that cannot be persisted must block followup; after
  // the write path recovers the same pending job may wake exactly once.
  {
    const temp = mkdtempSync(join(tmpdir(), 'ag-bridge-wake-checkpoint-'))
    const stateFile = join(temp, 'state.json')
    let wakes = 0
    const agent = { id: 'agent-a', followup: () => { wakes += 1 } }
    const ctx = { agents: { get: (id) => (String(id) === 'agent-a' ? agent : undefined) } }
    const bridge = new Bridge(ctx, defaultConfig({
      stateFile,
      backend: {},
      messageFactory: ({ content, source }) => ({ content, source }),
    }))
    try {
      const sent = bridge.beginSend({ agentId: 'agent-a', message: 'checkpoint', requested: {} })
      bridge.markAccepted(sent.job, {})
      bridge.finishReply(sent.job, { text: 'checkpoint reply', stopReason: 'end_turn' })
      mkdirSync(`${stateFile}.tmp`)
      check('failed checkpoint blocks wake', (await bridge.maybeWake(sent.job)) === false)
      check('failed checkpoint keeps pending in memory', sent.job.wakeState === 'pending', sent.job.wakeState)
      check('failed checkpoint sends no followup', wakes === 0, String(wakes))
      const blockedDisk = JSON.parse(readFileSync(stateFile, 'utf8'))
      check('failed checkpoint leaves disk pending', blockedDisk.jobs[sent.job.jobId].wakeState === 'pending', blockedDisk.jobs[sent.job.jobId].wakeState)
      rmSync(`${stateFile}.tmp`, { recursive: true, force: true })
      check('wake succeeds after checkpoint recovers', (await bridge.maybeWake(sent.job)) === true)
      check('recovered checkpoint wakes once', wakes === 1, String(wakes))
      check('recovered checkpoint is delivered', sent.job.wakeState === 'delivered', sent.job.wakeState)
    } finally {
      bridge.dispose()
      rmSync(temp, { recursive: true, force: true })
    }
  }

  // 20c. If the delivered marker cannot be persisted after followup, keep the
  // durable delivering checkpoint; reload must become delivery_unknown and
  // must not wake the same owner again.
  {
    const temp = mkdtempSync(join(tmpdir(), 'ag-bridge-wake-post-'))
    const stateFile = join(temp, 'state.json')
    let wakes = 0
    const agent = { id: 'agent-a', followup: () => { wakes += 1 } }
    const ctx = { agents: { get: (id) => (String(id) === 'agent-a' ? agent : undefined) } }
    const config = defaultConfig({
      stateFile,
      backend: {},
      messageFactory: ({ content, source }) => {
        // The checkpoint has already been written. Break the next state write
        // so followup succeeds but the delivered marker cannot be persisted.
        mkdirSync(`${stateFile}.tmp`)
        return { content, source }
      },
    })
    const first = new Bridge(ctx, config)
    let jobId
    try {
      const sent = first.beginSend({ agentId: 'agent-a', message: 'post-followup', requested: {} })
      jobId = sent.job.jobId
      first.markAccepted(sent.job, {})
      first.finishReply(sent.job, { text: 'post reply', stopReason: 'end_turn' })
      check('post-followup wake still delivers', (await first.maybeWake(sent.job)) === true)
      check('post-followup wake sends one followup', wakes === 1, String(wakes))
      check('failed delivered marker is unknown', sent.job.wakeState === 'delivery_unknown', sent.job.wakeState)
      const deliveredDisk = JSON.parse(readFileSync(stateFile, 'utf8'))
      check('failed delivered marker keeps disk delivering', deliveredDisk.jobs[jobId].wakeState === 'delivering', deliveredDisk.jobs[jobId].wakeState)
    } finally {
      first.dispose()
    }
    const second = new Bridge(ctx, config)
    try {
      check('reload after failed delivered marker is unknown', second.job(jobId).wakeState === 'delivery_unknown', second.job(jobId).wakeState)
      await second.tick()
      check('reload after failed delivered marker does not re-wake', wakes === 1, String(wakes))
    } finally {
      second.dispose()
      rmSync(temp, { recursive: true, force: true })
    }
  }

  // 21. A session/prompt JSON-RPC error is acceptance-unknown, not a safe retry.
  {
    const harness = new Harness('prompt-reject')
    try {
      const sent = await harness.call('antigravity_send', { message: 'REJECT-PROMPT please' })
      check('prompt rejection was written once', sent.status === 'accepted', sent.status)
      const settled = await settle(harness, sent.jobId)
      check('prompt rejection is unknown', settled.status === 'acceptance_unknown', settled.status)
      check('prompt rejection code', settled.code === 'acceptance_unknown', settled.code)
      check('prompt rejection did not wake', harness.wakes.length === 0)
      const prompts = harness.events().filter((event) => event.event === 'prompt')
      check('prompt rejection was not resent', prompts.length === 1, String(prompts.length))
      const reread = await harness.call('antigravity_read', { job_id: sent.jobId })
      check('prompt rejection stays readable', reread.status === 'acceptance_unknown')
    } finally {
      await harness.close()
    }
  }

  // 22. The reproduced case: session/new succeeds, then the state file becomes
  // unwritable before session/prompt. The prompt must not be written, and the
  // job must remain a safe not_sent with its jobId and target.
  {
    const temp = mkdtempSync(join(tmpdir(), 'ag-bridge-pre-prompt-save-'))
    const stateFile = join(temp, 'state.json')
    const mockStateFile = join(temp, 'mock-state.json')
    const logPath = join(temp, 'events.jsonl')
    const target = join(temp, 'pre-prompt-must-not-exist.txt')
    let wakes = 0
    const agent = { id: 'agent-a', followup: () => { wakes += 1 } }
    const ctx = { agents: { get: (id) => (String(id) === 'agent-a' ? agent : undefined) } }
    const base = acpBackend(
      {
        agyExecutable: process.execPath,
        agyArgs: [
          mockPath,
          `--state=${mockStateFile}`,
          `--log=${logPath}`,
          `--write-root=${temp}`,
        ],
        cwd: temp,
      },
      { warn: () => {} },
    )
    let prompts = 0
    const backend = {
      ...base,
      createSession: async (options) => {
        const session = await base.createSession(options)
        mkdirSync(`${stateFile}.tmp`)
        return session
      },
      promptSession: (options) => {
        prompts += 1
        return base.promptSession(options)
      },
    }
    const bridge = new Bridge(
      ctx,
      defaultConfig({
        stateFile,
        backend,
        cwd: temp,
        waitPollMs: 50,
        messageFactory: ({ content, source }) => ({ content, source }),
      }),
    )
    let jobId
    try {
      const { job } = bridge.beginSend({ agentId: 'agent-a', message: 'pre-prompt', requested: {} })
      jobId = job.jobId
      await bridge.dispatch(job, {
        message: `WRITE:${target}|must not be written`,
        requested: {},
        attachments: [],
        cwd: temp,
      })
      check('pre-prompt save failure is not_sent', job.status === 'not_sent', job.status)
      check('pre-prompt save failure code', job.code === 'state_write_failed', job.code)
      check('pre-prompt save failure keeps jobId', job.jobId === jobId && job.jobId.startsWith('agj-'), job.jobId)
      check('pre-prompt save failure keeps target', job.conversationId !== '', job.conversationId)
      check('pre-prompt save failure sends no prompt', prompts === 0, String(prompts))
      check('pre-prompt save failure writes no file', !existsSync(target))
      check('pre-prompt save failure wakes nobody', wakes === 0, String(wakes))
      const events = readEvents(logPath)
      check('pre-prompt save failure did create the ACP session', events.some((event) => event.event === 'session_new'))
      check('pre-prompt save failure logged no prompt', !events.some((event) => event.event === 'prompt'))
      const blockedDisk = JSON.parse(readFileSync(stateFile, 'utf8'))
      check(
        'blocked disk did not record prompting',
        blockedDisk.jobs[jobId].phase !== 'prompting',
        blockedDisk.jobs[jobId].phase,
      )
      rmSync(`${stateFile}.tmp`, { recursive: true, force: true })
      const reloaded = new Bridge(
        ctx,
        defaultConfig({
          stateFile,
          backend: {},
          cwd: temp,
          waitPollMs: 50,
          messageFactory: ({ content, source }) => ({ content, source }),
        }),
      )
      try {
        const recovered = reloaded.job(jobId)
        check(
          'reload keeps unpublished request retryable',
          recovered.status === 'not_sent' && recovered.code === 'dispatch_interrupted_before_prompt',
          `${recovered.status}/${recovered.code}`,
        )
        check('reload did not resend the blocked request', prompts === 0, String(prompts))
        check('reload wrote no file', !existsSync(target))
        await reloaded.tick()
        check('tick did not resend the blocked request', prompts === 0, String(prompts))
      } finally {
        reloaded.dispose()
      }
    } finally {
      await base.close()
      await sleep(150)
      try {
        rmSync(temp, { recursive: true, force: true })
      } catch {
        // The mock may briefly hold its cwd on Windows; assertions already ran.
      }
    }
  }

  // 22b. If session/prompt was actually written but the following state commit
  // fails, a reload must classify it as acceptance_unknown, never not_sent, and
  // must not automatically send a second prompt.
  {
    const temp = mkdtempSync(join(tmpdir(), 'ag-bridge-post-prompt-save-'))
    const stateFile = join(temp, 'state.json')
    const mockStateFile = join(temp, 'mock-state.json')
    const logPath = join(temp, 'events.jsonl')
    const target = join(temp, 'post-prompt-written.txt')
    let wakes = 0
    const agent = { id: 'agent-a', followup: () => { wakes += 1 } }
    const ctx = { agents: { get: (id) => (String(id) === 'agent-a' ? agent : undefined) } }
    const base = acpBackend(
      {
        agyExecutable: process.execPath,
        agyArgs: [
          mockPath,
          `--state=${mockStateFile}`,
          `--log=${logPath}`,
          `--write-root=${temp}`,
        ],
        cwd: temp,
      },
      { warn: () => {} },
    )
    let prompts = 0
    const backend = {
      ...base,
      promptSession: (options) => {
        prompts += 1
        const promise = base.promptSession(options)
        mkdirSync(`${stateFile}.tmp`)
        return promise
      },
    }
    const bridge = new Bridge(
      ctx,
      defaultConfig({
        stateFile,
        backend,
        cwd: temp,
        waitPollMs: 50,
        messageFactory: ({ content, source }) => ({ content, source }),
      }),
    )
    let jobId
    try {
      const { job } = bridge.beginSend({ agentId: 'agent-a', message: 'post-prompt', requested: {} })
      jobId = job.jobId
      await bridge.dispatch(job, {
        message: `WRITE:${target}|sent before state commit`,
        requested: {},
        attachments: [],
        cwd: temp,
      })
      const deadline = Date.now() + 1500
      while (!existsSync(target) && Date.now() < deadline) await sleep(20)
      check('post-prompt save failure actually sent one prompt', prompts === 1, String(prompts))
      check('post-prompt save failure wrote the synthetic file', existsSync(target))
      const blockedDisk = JSON.parse(readFileSync(stateFile, 'utf8'))
      check(
        'post-prompt blocked disk keeps prompting intent',
        blockedDisk.jobs[jobId].phase === 'prompting',
        blockedDisk.jobs[jobId].phase,
      )
      rmSync(`${stateFile}.tmp`, { recursive: true, force: true })
      const reloaded = new Bridge(
        ctx,
        defaultConfig({
          stateFile,
          backend: {},
          cwd: temp,
          waitPollMs: 50,
          messageFactory: ({ content, source }) => ({ content, source }),
        }),
      )
      try {
        const recovered = reloaded.job(jobId)
        check(
          'reload after sent-but-uncommitted is acceptance_unknown',
          recovered.status === 'acceptance_unknown',
          recovered.status,
        )
        check('reload after sent-but-uncommitted uses dispatch_interrupted', recovered.code === 'dispatch_interrupted', recovered.code)
        const before = prompts
        await reloaded.tick()
        await sleep(30)
        check('reload after sent-but-uncommitted does not resend', prompts === before, String(prompts))
      } finally {
        reloaded.dispose()
      }
    } finally {
      await base.close()
      await sleep(150)
      try {
        rmSync(temp, { recursive: true, force: true })
      } catch {
        // The mock may briefly hold its cwd on Windows; assertions already ran.
      }
    }
  }

  // 22d. Continuation uses the same pre-prompt save gate: a failed state commit
  // after resume returns must not write session/prompt or leave a stale lock.
  {
    const temp = mkdtempSync(join(tmpdir(), 'ag-bridge-continue-save-'))
    const stateFile = join(temp, 'state.json')
    let prompts = 0
    const backend = {
      resumeSession: async () => {
        mkdirSync(`${stateFile}.tmp`)
        return { sessionId: 'acp-existing', configOptions: [] }
      },
      promptSession: () => {
        prompts += 1
        return Promise.resolve({ stopReason: 'end_turn', text: 'unexpected' })
      },
    }
    const bridge = new Bridge(
      { agents: { get: () => undefined } },
      defaultConfig({
        stateFile,
        backend,
        cwd: temp,
        messageFactory: ({ content, source }) => ({ content, source }),
      }),
    )
    let jobId
    // This fixture represents a previously bound session, not a legacy unknown id.
    bridge.state.workspaces['acp-existing'] = temp
    try {
      const { job } = bridge.beginSend({
        agentId: 'agent-a',
        conversationId: 'acp-existing',
        message: 'continue blocked',
        requested: {},
      })
      jobId = job.jobId
      await bridge.dispatch(job, {
        message: 'continue blocked',
        requested: {},
        attachments: [],
        cwd: temp,
      })
      check('continue pre-prompt save failure is not_sent', job.status === 'not_sent', job.status)
      check('continue pre-prompt save failure code', job.code === 'state_write_failed', job.code)
      check('continue pre-prompt save failure sends no prompt', prompts === 0, String(prompts))
      check('continue pre-prompt save failure keeps target', job.conversationId === 'acp-existing')
      check(
        'continue pre-prompt save failure releases only its own lock',
        bridge.state.locks['acp-existing'] === undefined,
        bridge.state.locks['acp-existing'],
      )
      check('continue pre-prompt save failure keeps jobId', job.jobId === jobId)
    } finally {
      rmSync(`${stateFile}.tmp`, { recursive: true, force: true })
      bridge.dispose()
      rmSync(temp, { recursive: true, force: true })
    }
  }

  // 22c. The pre-prompt failure path must only release the failing job's own
  // lock. A target that is already owned by another in-flight job stays locked.
  {
    const temp = mkdtempSync(join(tmpdir(), 'ag-bridge-save-lock-guard-'))
    const stateFile = join(temp, 'state.json')
    const backend = {
      createSession: async () => {
        mkdirSync(`${stateFile}.tmp`)
        return { sessionId: 'acp-shared', configOptions: [] }
      },
    }
    const bridge = new Bridge(
      { agents: { get: () => undefined } },
      defaultConfig({
        stateFile,
        backend,
        cwd: temp,
        messageFactory: ({ content, source }) => ({ content, source }),
      }),
    )
    try {
      const first = bridge.beginSend({
        agentId: 'agent-a',
        conversationId: 'acp-shared',
        message: 'existing in-flight',
        requested: {},
      })
      const second = bridge.beginSend({ agentId: 'agent-a', message: 'new target collides', requested: {} })
      await bridge.dispatch(second.job, {
        message: 'new target collides',
        requested: {},
        attachments: [],
        cwd: temp,
      })
      check('colliding create save failure is not_sent', second.job.status === 'not_sent', second.job.status)
      check('colliding create save failure code', second.job.code === 'state_write_failed', second.job.code)
      check(
        'save failure keeps the other job lock',
        bridge.state.locks['acp-shared'] === first.job.jobId,
        bridge.state.locks['acp-shared'],
      )
      check('save failure did not change the other job owner', bridge.state.owners['acp-shared'] === 'agent-a')
      check('save failure did not wake', bridge.state.jobs[first.job.jobId].wakeState === 'none')
    } finally {
      rmSync(`${stateFile}.tmp`, { recursive: true, force: true })
      bridge.dispose()
      rmSync(temp, { recursive: true, force: true })
    }
  }
// 23. A config-created ACP session is owned by the calling DSH agent. The
  // same agent may continue it; another agent cannot read or reconfigure it, and
  // a live prompt makes config resume refuse rather than replace its collector.
  {
    const harness = new Harness('r1-config-owner')
    try {
      const created = await harness.call('antigravity_config', {})
      check('config-created session', created.created === true && created.sessionId !== '')
      const continued = await harness.call('antigravity_send', {
        conversation_id: created.sessionId,
        message: 'owned continuation',
      })
      check('config-created session continues for its owner', continued.status === 'accepted' || continued.status === 'replied', continued.status)
      const reply = await settle(harness, continued.jobId)
      check('config-created continuation replied', reply.status === 'replied', reply.status)

      let crossOwner = null
      try {
        await harness.call('antigravity_config', { conversation_id: created.sessionId }, 'agent-b')
      } catch (error) {
        crossOwner = error
      }
      check('cross-owner config is forbidden', crossOwner?.code === 'forbidden', crossOwner?.code)

      const late = await harness.call('antigravity_send', {
        message: 'LATE:600',
        model: 'test-model-a',
      })
      let busy = null
      try {
        await harness.call('antigravity_config', { conversation_id: late.conversationId })
      } catch (error) {
        busy = error
      }
      check('config during active prompt is busy', busy?.code === 'busy', busy?.code)
      await harness.call('antigravity_cancel', { job_id: late.jobId })
    } finally {
      await harness.close()
    }
  }

  // 23b. The ACP client itself refuses resume/load while a prompt collector is
  // active, so a direct backend caller cannot silently replace it either.
  {
    const temp = mkdtempSync(join(tmpdir(), 'ag-bridge-r1-active-'))
    const backend = acpBackend(
      {
        agyExecutable: process.execPath,
        agyArgs: [
          mockPath,
          `--state=${join(temp, 'mock-state.json')}`,
          `--log=${join(temp, 'events.jsonl')}`,
        ],
        cwd: temp,
      },
      { warn: () => {} },
    )
    try {
      const session = await backend.createSession({ cwd: temp })
      const prompt = backend.promptSession({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'HANG' }],
      })
      await sleep(120)
      let resumeError = null
      try {
        await backend.resumeSession({ sessionId: session.sessionId, cwd: temp })
      } catch (error) {
        resumeError = error
      }
      check('active prompt blocks direct resume', resumeError?.code === 'busy', resumeError?.code)
      await backend.cancelSession(session.sessionId)
      const result = await prompt
      check('direct active collector still completes after cancel', result.stopReason === 'cancelled', result.stopReason)
    } finally {
      await backend.close()
      await sleep(150)
      try {
        rmSync(temp, { recursive: true, force: true })
      } catch {
        // Windows may briefly hold the mock cwd; assertions already ran.
      }
    }
  }

  // 24. A real stdin failure after session/prompt was written is an unknown
  // outcome. Injected through AcpClient's transport error path: the job becomes
  // acceptance_unknown, keeps its lock, stays readable, and is never resent.
  {
    const temp = mkdtempSync(join(tmpdir(), 'ag-bridge-r2-stdin-'))
    const stateFile = join(temp, 'state.json')
    const client = new AcpClient(
      {
        agyExecutable: process.execPath,
        agyArgs: [
          mockPath,
          `--state=${join(temp, 'mock-state.json')}`,
          `--log=${join(temp, 'events.jsonl')}`,
        ],
        cwd: temp,
      },
      { warn: () => {} },
    )
    const backend = {
      ready: () => client.ready(),
      createSession: ({ cwd }) => client.createSession({ cwd }),
      resumeSession: ({ sessionId, cwd }) => client.resumeSession({ sessionId, cwd }),
      setConfigOption: (sessionId, configId, value) =>
        client.setConfigOption(sessionId, configId, value),
      promptSession: (options) => client.promptSession(options),
      cancelSession: (sessionId) => client.cancelSession(sessionId),
      close: () => client.close(),
    }
    const wakes = []
    const agent = { id: 'agent-a', followup: (message) => wakes.push(message) }
    const bridge = new Bridge(
      { agents: { get: (id) => (String(id) === 'agent-a' ? agent : undefined) } },
      defaultConfig({
        stateFile,
        backend,
        cwd: temp,
        waitPollMs: 50,
        messageFactory: ({ content, source }) => ({ content, source }),
      }),
    )
    try {
      const { job } = bridge.beginSend({
        agentId: 'agent-a',
        message: 'HANG',
        requested: {},
      })
      await bridge.dispatch(job, {
        message: 'HANG',
        requested: {},
        attachments: [],
        cwd: temp,
      })
      check('stdin-error prompt was accepted before failure', job.status === 'accepted', job.status)
      client.onStdinError(new Error('simulated EPIPE'), client.child)
      await sleep(120)
      const view = bridge.view(job)
      check('stdin error after receipt is acceptance_unknown', view.status === 'acceptance_unknown', view.status)
      check('stdin error keeps the lock', bridge.state.locks[view.conversationId] === job.jobId)
      let resend = null
      try {
        const second = bridge.beginSend({
          agentId: 'agent-a',
          conversationId: view.conversationId,
          message: 'must not resend',
          requested: {},
        })
        if (second.error) resend = second.error
      } catch (error) {
        resend = error
      }
      check('stdin error forbids automatic resend', resend?.code === 'busy', resend?.code)
      const reread = bridge.view(job)
      check('stdin error job remains queryable', reread.jobId === job.jobId && reread.reply === '')
      check('stdin error did not wake', wakes.length === 0, String(wakes.length))
    } finally {
      bridge.dispose()
      client.close()
      await sleep(150)
      try {
        rmSync(temp, { recursive: true, force: true })
      } catch {
        // Windows may briefly hold the mock cwd; assertions already ran.
      }
    }
  }

  // 25. A config_option_update during a prompt is the actual runtime state. It
  // must be persisted and reported separately from the pre-dispatch confirmation.
  {
    const harness = new Harness('r3-fallback')
    try {
      const sent = await harness.call('antigravity_send', {
        message: 'FALLBACK',
        model: 'test-model-a',
        effort: 'high',
      })
      const view = await settle(harness, sent.jobId)
      check('fallback reply completed', view.status === 'replied', view.status)
      check('fallback confirmed model', view.confirmed?.model === 'test-model-a', view.confirmed?.model)
      check('fallback confirmed effort', view.confirmed?.effort === 'high', view.confirmed?.effort)
      check('fallback actual model', view.effective?.model === 'auto', view.effective?.model)
      check('fallback actual effort', view.effective?.effort === 'medium', view.effective?.effort)
      check('fallback reply is the final assistant text', view.reply === 'FALLBACK-ACTUAL-REPLY', view.reply)
      check('fallback woke once', harness.wakes.length === 1, String(harness.wakes.length))
    } finally {
      await harness.close()
    }
  }

  // 25b. A failed completion still reports the latest actual config and does not
  // wake the original DSH session.
  {
    const harness = new Harness('r3-fallback-max')
    try {
      const sent = await harness.call('antigravity_send', {
        message: 'FALLBACK-MAX',
        model: 'test-model-a',
        effort: 'high',
      })
      const view = await settle(harness, sent.jobId)
      check('fallback max failed', view.status === 'failed' && view.code === 'truncated', `${view.status}/${view.code}`)
      check('fallback max actual model', view.effective?.model === 'auto', view.effective?.model)
      check('fallback max actual effort', view.effective?.effort === 'medium', view.effective?.effort)
      check('fallback max did not wake', harness.wakes.length === 0, String(harness.wakes.length))
    } finally {
      await harness.close()
    }
  }

  // 26. A set_config_option response without complete configOptions cannot be
  // confirmed; a stale currentValue is a real mismatch and must be reported from
  // the service snapshot, never from the old local cache.
  {
    const missing = new Harness('r4-missing-options', { mockArgs: ['--set-missing-options'] })
    try {
      const sent = await missing.call('antigravity_send', { message: 'no complete response', model: 'test-model-a' })
      check('missing config responses are not_sent', sent.status === 'not_sent', sent.status)
      check('missing config response code', sent.code === 'config_incomplete', sent.code)
      check('missing config response sent no prompt', missing.events().filter((event) => event.event === 'prompt').length === 0)
    } finally {
      await missing.close()
    }

    const mismatch = new Harness('r4-mismatch', { mockArgs: ['--set-mismatch'] })
    try {
      const sent = await mismatch.call('antigravity_send', { message: 'mismatch', model: 'test-model-a' })
      check('config mismatch is not_sent', sent.status === 'not_sent', sent.status)
      check('config mismatch code', sent.code === 'config_not_applied', sent.code)
      check('config mismatch reports actual snapshot', sent.effective?.model === 'auto', sent.effective?.model)
      check('config mismatch sent no prompt', mismatch.events().filter((event) => event.event === 'prompt').length === 0)
    } finally {
      await mismatch.close()
    }
  }

  // 27. Grouped select options are valid ACP values and must be flattened, not
  // rejected. The plain child display name still selects the grouped value.
  {
    const harness = new Harness('r5-grouped-options', { mockArgs: ['--grouped-options'] })
    try {
      const created = await harness.call('antigravity_config', {})
      const model = created.configOptions.find((option) => option.id === 'model')
      const names = (model?.options ?? []).map((option) => option.name)
      check('grouped model options are flattened', names.includes('Advanced / Test Model A'), names.join(','))
      const sent = await harness.call('antigravity_send', {
        message: 'grouped selection',
        model: 'Test Model A',
      })
      const view = await settle(harness, sent.jobId)
      check('grouped child name selects the value', view.effective?.model === 'test-model-a', view.effective?.model)
    } finally {
      await harness.close()
    }
  }

  // 28. Text attachments must be valid UTF-8. Invalid bytes are rejected before
  // any prompt is sent, rather than silently replaced with U+FFFD.
  {
    const harness = new Harness('r5-strict-utf8')
    try {
      const invalid = join(harness.temp, 'invalid.txt')
      writeFileSync(invalid, Buffer.from([0xc3, 0x28]))
      const sent = await harness.call('antigravity_send', {
        message: 'invalid utf8',
        attachments: [invalid],
      })
      check('invalid UTF-8 attachment is not_sent', sent.status === 'not_sent', sent.status)
      check('invalid UTF-8 attachment code', sent.code === 'invalid_attachment', sent.code)
      check('invalid UTF-8 attachment sent no prompt', harness.events().filter((event) => event.event === 'prompt').length === 0)
    } finally {
      await harness.close()
    }
  }

  // 29. Antigravity CLI login button rendering, click routing, unauthenticated
  // hint, unknown/acp_authenticate/terminal flows, and zero credential persistence.
  {
    const { createPanelComponent, createPanelController, createRemoteBridge } = await import('../client/panel.js')
    const { AntigravityBridgeService } = await import('../lib/web-remote.js')
    const { Bridge, defaultConfig } = await import('../lib/bridge.js')
    const { readFileSync: readDisk, existsSync: existsDisk } = await import('node:fs')

    const tempDir = join(tmpdir(), `ag-cli-login-${Date.now()}`)
    mkdirSync(tempDir, { recursive: true })
    const stateFile = join(tempDir, 'state.json')
    const launched = []
    let authMethods = [
      { id: 'oauth-personal', name: 'Log in with Google', description: 'Log in with your Google account' },
    ]
    let authenticateMode = 'fail' // 'fail' -> fallback to terminal, 'succeed' -> loggedin

    const mockBackend = {
      kind: 'acp',
      ready: async () => ({
        protocolVersion: 1,
        loadSession: false,
        promptCapabilities: {},
        authMethods,
      }),
      authStatus: async () => ({ status: authMethods.length ? 'unauthenticated' : 'loggedin' }),
      createSession: async () => {
        if (authMethods.length) throw Object.assign(new Error('Authentication required'), { data: { rpcCode: -32000 } })
        return { sessionId: 'login-status-probe' }
      },
      authenticate: async (methodId) => {
        if (authenticateMode === 'fail') throw new Error('No browser available')
        authMethods = []
        return { methodId }
      },
      close: () => {},
    }

    const config = defaultConfig({
      agyExecutable: 'agy.exe',
      agyArgs: ['acp', '--gemini-dir', tempDir],
      cliProbe: async () => ({ installation: 'available', executable: 'agy.exe', version: '1.5.14' }),
      cwd: tempDir,
      stateFile,
      backend: mockBackend,
      cliLoginLauncher: async (opts) => {
        launched.push(opts)
      },
    })
    const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
    const bridge = new Bridge({}, config, noopLogger)
    const service = new AntigravityBridgeService({ ctx: { get: () => undefined }, bridge, config })
    const fakeAgent = { id: 'agent-login-test', session: { id: 'sess-login-1' } }
    const remotePort = createRemoteBridge({
      antigravityBridge: {
        capabilities: () => service.capabilities(fakeAgent),
        dispatch: (req) => service.dispatch(fakeAgent, req),
        status: (req) => service.status(fakeAgent, req),
        reply: (req) => service.reply(fakeAgent, req),
        cancel: (req) => service.cancel(fakeAgent, req),
        authStatus: () => service.authStatus(fakeAgent),
        login: () => service.login(fakeAgent),
      },
    })

    // Render component with minimal React test double and verify button + unauthenticated hint
    function findNodes(node, pred, out = []) {
      if (!node || typeof node !== 'object') return out
      if (Array.isArray(node)) {
        for (const item of node) findNodes(item, pred, out)
        return out
      }
      if (pred(node)) out.push(node)
      if (node.props && node.props.children !== undefined) findNodes(node.props.children, pred, out)
      return out
    }
    let currentState
    let stateSetter
    const fakeReact = {
      createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
      useRef: (init) => ({ current: init }),
      useState: (init) => {
        if (currentState === undefined) currentState = typeof init === 'function' ? init() : init
        return [currentState, (next) => {
          currentState = typeof next === 'function' ? next(currentState) : next
          stateSetter?.(currentState)
        }]
      },
      useEffect: () => {},
    }
    const Panel = createPanelComponent({ React: fakeReact, bridge: remotePort })
    const initialTree = Panel({ sessionId: 'sess-login-1' })
    const loginBtns = findNodes(initialTree, (n) => n.type === 'button' && n.props?.['data-action'] === 'cli-login')
    check('panel renders CLI login button', loginBtns.length === 1 && loginBtns[0].props.children.join('') === '登录 Antigravity CLI')
    const refreshBtns = findNodes(initialTree, (n) => n.type === 'button' && n.props?.['data-action'] === 'cli-auth-refresh')
    check('panel renders CLI auth refresh button', refreshBtns.length === 1)

    // Controller flow: unauthenticated -> terminal fallback -> unknown (never fake loggedin) -> acp_authenticate -> loggedin
    const ctrl = createPanelController({ bridge: remotePort, sessionId: 'sess-login-1' })
    const st1 = await ctrl.refreshAuthStatus()
    check('unauthenticated CLI status detected', st1.authStatus === 'unauthenticated' && ctrl.getState().cliAuthStatus === 'unauthenticated')

    // Render with unauthenticated state to verify hint banner
    currentState = ctrl.getState()
    const unauthTree = Panel({ sessionId: 'sess-login-1' })
    const unauthHints = findNodes(unauthTree, (n) => n.props?.['data-auth-hint'] === 'unauthenticated')
    check('panel renders unauthenticated hint', unauthHints.length === 1)

    // Click routing: trigger login button onClick -> bridge.login -> terminal fallback
    const clickRes = await ctrl.loginCli()
    check('click routing invokes terminal fallback when authenticate fails', clickRes.flow === 'terminal' && launched.length === 1)
    check('rendered login button has onClick handler', typeof loginBtns[0].props.onClick === 'function')
    loginBtns[0].props.onClick()
    await new Promise((r) => setTimeout(r, 20))
    check('rendered button onClick routes to bridge.login', launched.length === 2)
    check('terminal fallback uses verified agy acp --login', launched[0]?.executable === 'agy.exe' && JSON.stringify(launched[0]?.args) === JSON.stringify(['acp', '--login', '--gemini-dir', tempDir]))
    check('terminal fallback keeps status unknown (never fakes loggedin)', ctrl.getState().cliAuthStatus === 'unknown')
    check('terminal fallback provides completion instructions', typeof ctrl.getState().cliAuthMessage === 'string' && ctrl.getState().cliAuthMessage.includes('acp --login'))

    // Official ACP authenticate path when supported & succeeds
    authenticateMode = 'succeed'
    const acpLoginRes = await ctrl.loginCli()
    check('official ACP authenticate succeeds and reports loggedin', acpLoginRes.flow === 'acp_authenticate' && ctrl.getState().cliAuthStatus === 'loggedin')

    // Unknown probe failure never fakes loggedin
    mockBackend.ready = async () => { throw new Error('spawn ENOENT') }
    const unknownRes = await ctrl.refreshAuthStatus()
    check('failed probe reports unknown, never loggedin', unknownRes.authStatus === 'unknown' && ctrl.getState().cliAuthStatus === 'unknown')

    // No credentials persisted to disk and permissionPolicy unchanged
    check('permissionPolicy remains reject', config.permissionPolicy === 'reject')
    const diskText = existsDisk(stateFile) ? readDisk(stateFile, 'utf8') : ''
    check('no credentials persisted on disk', !/(access_token|refresh_token|cookie|password|apiKey)/i.test(diskText))

    ctrl.dispose()
    bridge.dispose()
    rmSync(tempDir, { recursive: true, force: true })
  }

  // 30. Assembly coverage: the native model adapter is mounted by apply(), not
  // hand-built. This is the path round2-test's --live branch used to bypass
  // (Neon E2), so resolveWorkspace / provider id / cwd resolution are exercised
  // through the real plugin entry point.
  {
    const { PROVIDER_ID } = await import('../lib/model-catalog.js')
    const harness = new Harness('r2-assembly', { mountLlm: true })
    try {
      const adapter = harness.adapters.get(PROVIDER_ID)
      check('apply() registers a native adapter on the catalog route', adapter !== undefined, String(harness.llm.registered))

      // The catalog comes from the ACP configOptions the mock advertises; the
      // adapter under test is the one apply() mounted, with the resolveWorkspace
      // closure apply() built.
      const models = await adapter.listModels()
      const model = models[0]?.id
      check('apply-mounted adapter lists the ACP-driven catalog', models.length >= 1 && typeof model === 'string', models.map((m) => m.id).join(','))

      // The Host store is keyed by session id (that is what the plugin's
      // resolveWorkspace closure looks up), so register it under that key.
      const agent = { id: 'agent-assembly', session: { id: 'sess-assembly-1' } }
      harness.agents.set('sess-assembly-1', agent)
      const chunks = []
      const prepared = await adapter.prepareCall(PROVIDER_ID, model)
      for await (const chunk of prepared.stream({
        sessionId: 'sess-assembly-1',
        model,
        messages: [{ role: 'user', id: 'u1', content: [{ type: 'text', text: 'assembly hello' }] }],
      })) {
        chunks.push(chunk)
      }
      const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
      check('apply-mounted adapter streams through the real resolveWorkspace', text === 'MOCK-REPLY: assembly hello', JSON.stringify(text))
      const promptEvents = harness.events().filter((event) => event.event === 'prompt')
      check('assembly path used the Host workspace, not the plugin cwd', promptEvents.length === 1)

      // A Host session that does not exist must fail with its own code, not a
      // bare Error normalized to UNKNOWN.
      const ghost = await adapter.prepareCall(PROVIDER_ID, model)
      let ghostError = null
      try {
        for await (const _chunk of ghost.stream({
          sessionId: 'missing-session',
          model,
          messages: [{ role: 'user', id: 'u1', content: [{ type: 'text', text: 'hi' }] }],
        })) { /* drain */ }
      } catch (error) {
        ghostError = error
      }
      check('unknown Host session keeps workspace_session_unknown', ghostError?.code === 'workspace_session_unknown', ghostError?.code)
      check('unknown Host session carries a stable failure snapshot', ghostError?.failure?.code === 'workspace_session_unknown', JSON.stringify(ghostError?.failure))

      // Disposing the plugin must unregister the adapter through ctx.effect.
      for (const cleanup of [...harness.cleanups].reverse()) await cleanup()
      check('plugin cleanup unregisters the native adapter', harness.adapters.size === 0, String(harness.adapters.size))
    } finally {
      await harness.close()
    }
  }

  // 31. antigravity_reset_session resets only caller's own session, rejects when busy, and writes tombstone for next-turn rebaseline.
  {
    const { PROVIDER_ID } = await import('../lib/model-catalog.js')
    const harness = new Harness('r1-reset-session', { mountLlm: true })
    try {
      const adapter = harness.adapters.get(PROVIDER_ID)
      const models = await adapter.listModels()
      const model = models[0]?.id
      const agent = harness.agent('agent-reset')
      agent.session = { id: 'sess-reset-1' }
      harness.agents.set('sess-reset-1', agent)
      const turn1Chunks = []
      for await (const chunk of adapter.stream({
        sessionId: 'sess-reset-1',
        model,
        messages: [{ role: 'user', id: 'u1', content: [{ type: 'text', text: 'hello' }] }],
      })) {
        turn1Chunks.push(chunk)
      }
      check('reset-session turn 1 succeeded', turn1Chunks.at(-1)?.reason?.kind === 'stop')
      check('reset-session created binding', adapter.nativeSessions['sess-reset-1']?.rebaseline !== true)

      // Busy check: activeSessions blocks reset with AGY_ACP_RESET_BUSY (constraint-equivalent to AGY_ACP_ACCEPTANCE_UNKNOWN).
      adapter.activeSessions.add('sess-reset-1')
      let busyErr = null
      try {
        await harness.call('antigravity_reset_session', {}, 'agent-reset')
      } catch (error) {
        busyErr = error
      } finally {
        adapter.activeSessions.delete('sess-reset-1')
      }
      check('reset-session rejects busy session with AGY_ACP_RESET_BUSY and no-resend guard', busyErr?.code === 'AGY_ACP_RESET_BUSY' && /禁止重发同一 prompt/.test(busyErr?.message ?? ''), busyErr?.code)

      // Idle reset: succeeds, writes tombstone, closes liveSessions.
      const resetRes = await harness.call('antigravity_reset_session', {}, 'agent-reset')
      check('reset-session returns sessionId', resetRes.sessionId === 'sess-reset-1', resetRes.sessionId)
      check('reset-session reports hadBinding=true', resetRes.hadBinding === true)
      check('reset-session returns nextTurnBehavior', resetRes.nextTurnBehavior === 'rebaseline_new_session', resetRes.nextTurnBehavior)
      const tombstone = adapter.nativeSessions['sess-reset-1']
      check('reset-session writes tombstone', tombstone?.rebaseline === true && tombstone?.reasonCode === 'manual_reset' && typeof tombstone?.resetAt === 'number' && tombstone?.lastCommittedUserId === 'u1' && tombstone?.consecutiveRebaselines === 0)
      check('reset-session clears liveSessions', adapter.liveSessions.has('sess-reset-1') === false)

      // Next turn with multi-turn history after reset rebaselines instead of AGY_ACP_BINDING_UNKNOWN.
      const turn2Chunks = []
      for await (const chunk of adapter.stream({
        sessionId: 'sess-reset-1',
        model,
        messages: [
          { role: 'user', id: 'u1', content: [{ type: 'text', text: 'hello' }] },
          { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'MOCK-REPLY: hello' }] },
          { role: 'user', id: 'u2', content: [{ type: 'text', text: 'after reset' }] },
        ],
      })) {
        turn2Chunks.push(chunk)
      }
      check('post-reset multi-turn rebaselines cleanly', turn2Chunks.at(-1)?.reason?.kind === 'stop')

      // Unbound session without tombstone still throws AGY_ACP_BINDING_UNKNOWN.
      harness.agents.set('sess-unbound', { id: 'agent-unbound', session: { id: 'sess-unbound' } })
      let unboundErr = null
      try {
        for await (const _chunk of adapter.stream({
          sessionId: 'sess-unbound',
          model,
          messages: [
            { role: 'user', id: 'u1', content: [{ type: 'text', text: 'hello' }] },
            { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'prev' }] },
            { role: 'user', id: 'u2', content: [{ type: 'text', text: 'hi' }] },
          ],
        })) { /* drain */ }
      } catch (error) {
        unboundErr = error
      }
      check('unbound multi-turn without tombstone still throws AGY_ACP_BINDING_UNKNOWN', unboundErr?.code === 'AGY_ACP_BINDING_UNKNOWN', unboundErr?.code)
    } finally {
      await harness.close()
    }
  }

  // 32. Fault-tolerant model catalog, read-only refresh endpoint, and panel refresh tests.
  {
    const { runCatalogTests } = await import('./catalog-test.mjs')
    await runCatalogTests({ check })
  }

  // 33. Output schema verification across all registered tools.
  {
    const { runOutputCheck } = await import('./output-check.mjs')
    const result = await runOutputCheck({ quiet: true })
    check(
      'output-check validates every tool output against its declared schema',
      result.failures === 0,
      `tools=${result.tools.join(',')} failures=${result.failures}`,
    )
  }
}

await main()
console.log(`\n${checks.filter((item) => item.condition).length}/${checks.length} checks passed`)
process.exitCode = failures === 0 ? 0 : 1