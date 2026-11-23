/**
 * Runtime output schema verification for all 6 antigravity-bridge tools.
 *
 * Uses a stub ACP transport backend (no real `agy` subprocess, no network, no
 * default state.json) while keeping apply(), Bridge, view(), listJobs() and
 * publicView() real, then validates every returned value with the Harness'
 * own `validateJsonSchemaValue`.
 *
 * Usage:
 *   node scripts/output-check.mjs [--validator <path>] [--quiet] [--inject-undeclared] [--expect-desktop-target]
 *
 * Note: strict desktop assertions are now enabled by default; `--expect-desktop-target`
 * is retained as a harmless CLI alias for backward compatibility.
 */

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { apply } from '../lib/index.js'

const REQUIRED_TOOLS = [
  'antigravity_send',
  'antigravity_cancel',
  'antigravity_config',
  'antigravity_wait',
  'antigravity_read',
  'antigravity_list',
]

function deepCopy(value) {
  return JSON.parse(JSON.stringify(value))
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function discoverValidator(explicit = '') {
  const chosen = explicit || process.env.DSH_JSON_SCHEMA_VALIDATOR || ''
  if (chosen !== '') {
    if (!existsSync(chosen)) {
      throw new Error(`output-check: validator not found: ${chosen}`)
    }
    return chosen
  }
  const candidates = []
  for (const home of [process.env.DSH_HOME, 'D:\\dsh-home', 'D:\\dsh-data'].filter(Boolean)) {
    const versions = join(home, 'versions')
    if (existsSync(versions)) {
      for (const entry of readdirSync(versions)) {
        const file = join(
          versions,
          entry,
          'node_modules',
          '@deepseek-ai',
          'dsh-tools',
          'lib',
          'types',
          'json-schema.js',
        )
        if (existsSync(file)) candidates.push({ file, mtime: statSync(file).mtimeMs })
      }
    }
    const profile = join(
      home,
      'profiles',
      'web',
      'node_modules',
      '@deepseek-ai',
      'dsh-tools',
      'lib',
      'types',
      'json-schema.js',
    )
    if (existsSync(profile)) candidates.push({ file: profile, mtime: statSync(profile).mtimeMs })
  }
  if (candidates.length === 0) {
    throw new Error(
      'output-check: could not locate @deepseek-ai/dsh-tools/lib/types/json-schema.js; pass --validator <path>',
    )
  }
  candidates.sort((left, right) => right.mtime - left.mtime)
  return candidates[0].file
}

function makeStubBackend() {
  const baseOptions = [
    {
      id: 'model',
      name: 'Model',
      description: '',
      category: 'model',
      type: 'select',
      currentValue: 'test-model-a',
      options: [
        { value: 'test-model-a', name: 'Test Model A', description: '' },
        { value: 'test-model-b', name: 'Test Model B', description: '' },
      ],
    },
    {
      id: 'thought_level',
      name: 'Thinking',
      description: '',
      category: 'thought_level',
      type: 'select',
      currentValue: 'medium',
      options: [
        { value: 'low', name: 'Low', description: '' },
        { value: 'medium', name: 'Medium', description: '' },
        { value: 'high', name: 'High', description: '' },
      ],
    },
  ]

  let current = deepCopy(baseOptions)
  let pending = null
  let autoResolveText = ''
  let cancelCount = 0

  const caps = {
    protocolVersion: 1,
    loadSession: true,
    promptCapabilities: { image: true, audio: false, embeddedContext: true },
    authMethods: [],
  }

  const backend = {
    async ready() {
      return deepCopy(caps)
    },
    async capabilities() {
      return deepCopy(caps)
    },
    async createSession() {
      return { sessionId: 'acp-out-1', configOptions: deepCopy(current) }
    },
    async resumeSession() {
      return { sessionId: 'acp-out-1', configOptions: deepCopy(current) }
    },
    async setConfigOption(_sessionId, optionId, value) {
      const target = current.find((item) => item.id === optionId)
      if (target) target.currentValue = String(value)
      return { configOptions: deepCopy(current) }
    },
    promptSession() {
      if (autoResolveText !== '') {
        return Promise.resolve({
          text: autoResolveText,
          stopReason: 'end_turn',
          configOptions: deepCopy(current),
        })
      }
      return new Promise((resolvePromise, rejectPromise) => {
        pending = { resolve: resolvePromise, reject: rejectPromise }
      })
    },
    cancelSession() {
      cancelCount += 1
      if (pending) {
        const active = pending
        pending = null
        active.resolve({
          text: '',
          stopReason: 'cancelled',
          permissions: [],
          configOptions: deepCopy(current),
        })
      }
    },
    async close() {
      return {}
    },
  }

  return {
    backend,
    getPending() {
      return pending
    },
    clearPending() {
      pending = null
    },
    setAutoResolveText(text) {
      autoResolveText = text
    },
    getCancelCount() {
      return cancelCount
    },
    snapshotOptions() {
      return deepCopy(current)
    },
  }
}

async function createHarness(extraConfig = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), 'antigravity-output-check-'))
  const registrations = []
  const disposers = []
  const ctx = {
    tools: {
      register(def) {
        registrations.push(def)
        return () => {}
      },
    },
    effect(fn) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
      return () => {}
    },
    get: () => undefined,
    logger: { debug() {}, info() {}, warn() {}, error() {}, trace() {} },
    on: () => () => {},
    reflect: { provide() {}, get: () => undefined },
    root: {},
  }
  const stub = makeStubBackend()
  const config = {
    cwd: tempDir,
    stateFile: join(tempDir, 'state.json'),
    autoWake: false,
    pollMs: 1000,
    waitPollMs: 50,
    permissionPolicy: 'reject',
    backend: stub.backend,
    ...extraConfig,
  }
  await apply(ctx, config)
  const tools = new Map(registrations.map((def) => [def.name, def]))

  async function dispose() {
    for (const d of [...disposers].reverse()) {
      try {
        await d()
      } catch (error) {
        console.warn(`output-check: dispose warning: ${error?.message ?? error}`)
      }
    }
    rmSync(tempDir, { recursive: true, force: true })
  }

  return { tempDir, registrations, tools, stub, dispose }
}

export async function runOutputCheck(options = {}) {
  const quiet = options.quiet === true
  const injectUndeclared = options.injectUndeclared === true
  const expectDesktopTarget = options.expectDesktopTarget === true
  let failures = 0
  let checks = 0
  const passedTools = new Set()
  const failedTools = new Set()

  let validatorPath
  let validator
  try {
    validatorPath = discoverValidator(options.validator ?? '')
    validator = await import(pathToFileURL(validatorPath).href)
  } catch (error) {
    console.log(error?.message ?? String(error))
    return { failures: 1, checks: 0, tools: [] }
  }

  if (
    typeof validator.assertSupportedJsonSchema !== 'function' ||
    typeof validator.validateJsonSchemaValue !== 'function'
  ) {
    console.log(
      `output-check: validator ${validatorPath} is missing assertSupportedJsonSchema/validateJsonSchemaValue`,
    )
    return { failures: 1, checks: 0, tools: [] }
  }

  const { assertSupportedJsonSchema, validateJsonSchemaValue } = validator

  function assertCond(label, condition, detail = '') {
    checks += 1
    if (!condition) {
      failures += 1
      console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    }
  }

  function checkOutput(name, schema, value) {
    const violations = validateJsonSchemaValue(schema, value, 'value')
    if (!Array.isArray(violations)) {
      throw new Error(`validateJsonSchemaValue did not return an array for ${name}`)
    }
    checks += 1
    if (violations.length === 0) {
      passedTools.add(name)
      if (!quiet) console.log(`PASS ${name}`)
    } else {
      failures += 1
      failedTools.add(name)
      console.log(`FAIL ${name}: ${violations[0]}`)
      for (let i = 1; i < violations.length; i += 1) {
        console.log(`  - ${violations[i]}`)
      }
    }
    return violations
  }

  const exec = {
    agent: {
      id: 'agent-output-check',
      session: { id: 'sess-output-check' },
      followup: async () => {},
    },
    signal: undefined,
  }

  const harness = await createHarness()
  try {
    for (const def of harness.registrations) {
      try {
        assertSupportedJsonSchema(def?.output?.schema)
      } catch (error) {
        failures += 1
        console.log(`FAIL schema ${def?.name ?? '(unnamed)'}: ${error?.message ?? error}`)
        return { failures, checks, tools: [...harness.tools.keys()] }
      }
    }

    for (const toolName of REQUIRED_TOOLS) {
      if (!harness.tools.has(toolName)) {
        failures += 1
        console.log(`FAIL missing required tool: ${toolName}`)
        return { failures, checks, tools: [...harness.tools.keys()] }
      }
    }

    const sendTool = harness.tools.get('antigravity_send')
    const cancelTool = harness.tools.get('antigravity_cancel')
    const configTool = harness.tools.get('antigravity_config')
    const waitTool = harness.tools.get('antigravity_wait')
    const readTool = harness.tools.get('antigravity_read')
    const listTool = harness.tools.get('antigravity_list')

    // 1. config ACP
    const cfgAcp = await configTool.execute({}, exec)
    assertCond('config ACP sessionId', cfgAcp.sessionId === 'acp-out-1', String(cfgAcp.sessionId))
    assertCond('config ACP configOptions', cfgAcp.configOptions.length === 2, String(cfgAcp.configOptions.length))
    assertCond('config ACP capabilities.image', cfgAcp.capabilities?.image === true)
    assertCond('config ACP desktop.target', cfgAcp.desktop?.target === null)
    assertCond(
      'config ACP workspaceRoot',
      typeof cfgAcp.workspaceRoot === 'string' && cfgAcp.workspaceRoot.length > 0,
    )
    checkOutput('antigravity_config', configTool.output.schema, cfgAcp)

    // 2. send in-flight
    const sendOut = await sendTool.execute(
      { message: 'output-check hello', model: 'Test Model A', effort: 'High', title: 'out' },
      exec,
    )
    assertCond('send accepted status', sendOut.status === 'accepted', sendOut.status)
    assertCond('send accepted jobId', typeof sendOut.jobId === 'string' && sendOut.jobId.length > 0)
    assertCond('send accepted transport', sendOut.transport === 'acp', sendOut.transport)
    assertCond('send accepted requested.model', sendOut.requested?.model === 'Test Model A')
    assertCond('send accepted effective.model', sendOut.effective?.model === 'test-model-a')
    assertCond('send accepted effective.verified', sendOut.effective?.verified === true)
    assertCond(
      'send accepted configOptions',
      Array.isArray(sendOut.configOptions) && sendOut.configOptions.length > 0,
    )
    assertCond(
      'send accepted workspaceRoot',
      typeof sendOut.workspaceRoot === 'string' && sendOut.workspaceRoot.length > 0,
    )
    assertCond('send accepted permissions', Array.isArray(sendOut.permissions))
    checkOutput('antigravity_send', sendTool.output.schema, sendOut)

    // 3. read in-flight
    const readInFlight = await readTool.execute({ job_id: sendOut.jobId }, exec)
    assertCond('read in-flight status', readInFlight.status === 'accepted', readInFlight.status)
    checkOutput('antigravity_read', readTool.output.schema, readInFlight)

    // 4. resolve -> poll -> read settled
    const pending = harness.stub.getPending()
    assertCond('pending prompt exists', pending !== null)
    if (pending) {
      harness.stub.clearPending()
      pending.resolve({
        text: 'deadline ok',
        stopReason: 'end_turn',
        configOptions: harness.stub.snapshotOptions(),
        permissions: [
          {
            requestId: '1',
            policy: 'reject',
            toolCallId: 'tc1',
            title: 'run',
            kind: 'execute',
            decision: 'rejected',
            optionId: 'opt-1',
          },
        ],
      })
    }
    for (let i = 0; i < 200; i += 1) {
      const probe = await readTool.execute({ job_id: sendOut.jobId }, exec)
      if (probe.status === 'replied') break
      await sleep(20)
    }
    const readSettled = await readTool.execute({ job_id: sendOut.jobId }, exec)
    assertCond('read settled status', readSettled.status === 'replied', readSettled.status)
    assertCond('read settled reply', typeof readSettled.reply === 'string' && readSettled.reply.length > 0)
    assertCond('read settled permissions', readSettled.permissions.length === 1)
    assertCond('read settled stopReason', readSettled.stopReason === 'end_turn', readSettled.stopReason)
    checkOutput('antigravity_read', readTool.output.schema, readSettled)

    // 5. wait on settled job (bridge.waitFor sets wakeState='suppressed' when not 'delivered')
    const waitOut = await waitTool.execute({ job_id: sendOut.jobId }, exec)
    assertCond('wait settled status', waitOut.status === 'replied', waitOut.status)
    assertCond('wait settled reply', typeof waitOut.reply === 'string' && waitOut.reply.length > 0)
    assertCond('wait settled wakeState', waitOut.wakeState === 'suppressed', waitOut.wakeState)
    checkOutput('antigravity_wait', waitTool.output.schema, waitOut)

    // 6. send wait=true fast path
    harness.stub.setAutoResolveText('immediate')
    const sendImmediate = await sendTool.execute(
      { message: 'immediate reply', wait: true, timeout_sec: 60 },
      exec,
    )
    assertCond('send wait=true status', sendImmediate.status === 'replied', sendImmediate.status)
    assertCond('send wait=true reply', sendImmediate.reply === 'immediate', sendImmediate.reply)
    checkOutput('antigravity_send', sendTool.output.schema, sendImmediate)

    // 7. cancel in-flight
    harness.stub.setAutoResolveText('')
    const sendCancelTarget = await sendTool.execute({ message: 'to be cancelled' }, exec)
    const cancelInFlight = await cancelTool.execute({ job_id: sendCancelTarget.jobId }, exec)
    assertCond('cancel in-flight jobId', cancelInFlight.jobId === sendCancelTarget.jobId)
    assertCond('cancel in-flight cancelRequested', cancelInFlight.cancelRequested === true)
    assertCond('cancel in-flight sent to backend', harness.stub.getCancelCount() >= 1)
    checkOutput('antigravity_cancel', cancelTool.output.schema, cancelInFlight)

    // 8. cancel settled job
    const cancelSettled = await cancelTool.execute({ job_id: sendOut.jobId }, exec)
    assertCond('cancel settled status', cancelSettled.status === 'replied', cancelSettled.status)
    assertCond('cancel settled cancelRequested', cancelSettled.cancelRequested === false)
    checkOutput('antigravity_cancel', cancelTool.output.schema, cancelSettled)

    // 9. list
    const listOut = await listTool.execute({ limit: 10 }, exec)
    const cleanListCopy = deepCopy(listOut)
    assertCond('list jobs count', listOut.jobs.length >= 3, String(listOut.jobs.length))
    assertCond(
      'list clientRequestId present',
      listOut.jobs.every((row) => typeof row.clientRequestId === 'string'),
    )
    assertCond(
      'list jobId non-empty',
      listOut.jobs.every((row) => typeof row.jobId === 'string' && row.jobId.length > 0),
    )
    if (injectUndeclared && listOut.jobs.length > 0) {
      listOut.jobs[0].bogusField = 1
    }
    checkOutput('antigravity_list', listTool.output.schema, listOut)

    // 10. config desktop (disabled)
    const cfgDeskOff = await configTool.execute({ transport: 'desktop' }, exec)
    assertCond('config desktop off sessionId', cfgDeskOff.sessionId === '')
    assertCond('config desktop off created', cfgDeskOff.created === false)
    assertCond(
      'config desktop off capabilities',
      cfgDeskOff.capabilities.image === false &&
        cfgDeskOff.capabilities.audio === false &&
        cfgDeskOff.capabilities.embeddedContext === false &&
        cfgDeskOff.capabilities.loadSession === false,
    )
    assertCond('config desktop off disabled', cfgDeskOff.desktop.enabled === false)
    assertCond('config desktop off target', cfgDeskOff.desktop.target === null)
    assertCond(
      'config desktop off configOptions',
      Array.isArray(cfgDeskOff.configOptions) && cfgDeskOff.configOptions.length === 0,
    )
    checkOutput('antigravity_config', configTool.output.schema, cfgDeskOff)

    // 11. config desktop (enabled with object target) in an isolated second harness
    const harness2 = await createHarness({
      desktop: {
        enabled: true,
        target: {
          pid: 4242,
          startedAt: '2026-01-01T00:00:00.000Z',
          hwnd: 31,
          uri: 'https://antigravity.test/window/1',
        },
      },
    })
    let cfgDeskOn
    try {
      const configTool2 = harness2.tools.get('antigravity_config')
      cfgDeskOn = await configTool2.execute({ transport: 'desktop' }, exec)
      const target = cfgDeskOn.desktop.target
      assertCond('config desktop on enabled', cfgDeskOn.desktop.enabled === true)
      assertCond('config desktop on target object', target !== null && typeof target === 'object')
      assertCond('config desktop on target pid', target?.pid === 4242)
      assertCond('config desktop on target startedAt', target?.startedAt === '2026-01-01T00:00:00.000Z')
      assertCond('config desktop on target hwnd', target?.hwnd === 31)
      assertCond('config desktop on target uri', target?.uri === 'https://antigravity.test/window/1')
      checkOutput('antigravity_config', configTool2.output.schema, cfgDeskOn)
    } finally {
      await harness2.dispose()
    }

    // Negative control (6/6 must be rejected by validateJsonSchemaValue)
    let negRejected = 0
    const neg1 = deepCopy(cleanListCopy)
    neg1.jobs[0].bogusField = 1
    const v1 = validateJsonSchemaValue(listTool.output.schema, neg1, 'value')
    checks += 1
    if (Array.isArray(v1) && v1.some((msg) => msg.includes('jobs[0].bogusField'))) {
      negRejected += 1
    } else {
      failures += 1
      console.log('FAIL negative-control: injected undeclared field was accepted')
    }

    const neg2 = deepCopy(cleanListCopy)
    delete neg2.jobs[0].jobId
    const v2 = validateJsonSchemaValue(listTool.output.schema, neg2, 'value')
    checks += 1
    if (Array.isArray(v2) && v2.some((msg) => msg.includes('jobs[0].jobId'))) {
      negRejected += 1
    } else {
      failures += 1
      console.log('FAIL negative-control: deleted required jobId was accepted')
    }

    const neg3 = deepCopy(cfgAcp)
    neg3.capabilities.image = 'yes'
    const v3 = validateJsonSchemaValue(configTool.output.schema, neg3, 'value')
    checks += 1
    if (Array.isArray(v3) && v3.some((msg) => msg.includes('capabilities.image'))) {
      negRejected += 1
    } else {
      failures += 1
      console.log('FAIL negative-control: wrong type capabilities.image was accepted')
    }

    const neg4 = deepCopy(sendOut)
    delete neg4.workspaceRoot
    const v4 = validateJsonSchemaValue(sendTool.output.schema, neg4, 'value')
    checks += 1
    if (Array.isArray(v4) && v4.some((msg) => msg.includes('workspaceRoot'))) {
      negRejected += 1
    } else {
      failures += 1
      console.log('FAIL negative-control: deleted required workspaceRoot was accepted')
    }

    const neg5 = deepCopy(cfgDeskOn)
    delete neg5.desktop.target
    const v5 = validateJsonSchemaValue(configTool.output.schema, neg5, 'value')
    checks += 1
    if (Array.isArray(v5) && v5.some((msg) => msg.includes('desktop.target'))) {
      negRejected += 1
    } else {
      failures += 1
      console.log('FAIL negative-control: deleted required desktop.target was accepted')
    }

    const neg6 = deepCopy(cleanListCopy)
    delete neg6.jobs[0].clientRequestId
    const v6 = validateJsonSchemaValue(listTool.output.schema, neg6, 'value')
    checks += 1
    if (Array.isArray(v6) && v6.some((msg) => msg.includes('jobs[0].clientRequestId'))) {
      negRejected += 1
    } else {
      failures += 1
      console.log('FAIL negative-control: deleted required clientRequestId was accepted')
    }

    if (negRejected === 6 && !quiet) {
      console.log('negative-control: 6/6 rejected')
    }
  } finally {
    await harness.dispose()
  }

  const toolsGreen = REQUIRED_TOOLS.filter(
    (name) => passedTools.has(name) && !failedTools.has(name),
  ).length
  console.log(
    `output-check: ${toolsGreen}/${REQUIRED_TOOLS.length} tools, ${checks} checks, ${failures} failures`,
  )
  return { failures, checks, tools: REQUIRED_TOOLS }
}

const isEntry = (() => {
  if (!process.argv[1]) return false
  try {
    const selfPath = realpathSync(fileURLToPath(import.meta.url)).toLowerCase()
    const argPath = realpathSync(resolve(process.argv[1])).toLowerCase()
    return selfPath === argPath
  } catch {
    return false
  }
})()

if (isEntry) {
  const args = process.argv.slice(2)
  const valIdx = args.indexOf('--validator')
  const validator = valIdx !== -1 ? String(args[valIdx + 1] ?? '') : ''
  const quiet = args.includes('--quiet')
  const injectUndeclared = args.includes('--inject-undeclared')
  const expectDesktopTarget = args.includes('--expect-desktop-target')
  const result = await runOutputCheck({ validator, quiet, injectUndeclared, expectDesktopTarget })
  process.exitCode = result.failures === 0 ? 0 : 1
}
