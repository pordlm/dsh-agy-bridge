import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'
import { ERROR_CODES } from '../lib/model-adapter.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function collectRegisteredTools() {
  const registered = new Map()
  const noop = () => () => {}
  const ctx = {
    tools: {
      register(def) {
        registered.set(def.name, def)
        return () => {}
      },
    },
    effect: (fn) => {
      if (typeof fn === 'function') fn()
      return noop
    },
    get: () => undefined,
    logger: { debug() {}, info() {}, warn() {}, error() {}, trace() {} },
    on: () => noop,
    reflect: { provide: () => {}, get: () => undefined },
    root: {},
  }
  apply(ctx, {})
  return registered
}

const tools = collectRegisteredTools()
const briefTool = tools.get('antigravity_relay_brief')

test('T1: antigravity_relay_brief is registered alongside the 6 existing tools', () => {
  assert.ok(briefTool, 'antigravity_relay_brief must be registered')
  assert.equal(tools.size, 7, 'total registered tools must be 7')
  assert.deepEqual(briefTool.parameters.properties.role.enum, ['implement', 'review'])
  assert.deepEqual(briefTool.parameters.required, ['role'])
  assert.equal(briefTool.parameters.additionalProperties, false)
})

test('T2: implement and review return expected model, effort, send rules, promptTemplate, mustNot, and watchCodes', async () => {
  const impl = await briefTool.execute({ role: 'implement' })
  assert.equal(impl.role, 'implement')
  assert.equal(impl.model, 'gemini-4-hydrogen')
  assert.equal(impl.effort, 'medium')
  assert.equal(impl.send.wait, true)
  assert.equal(impl.send.neverResendSamePrompt, true)
  assert.ok(impl.send.pathRefsRule.includes('path_refs'))
  assert.ok(impl.send.timeoutSecHint.includes('timeout_sec'))
  assert.ok(impl.send.onTimeout.includes('antigravity_read'))
  assert.ok(impl.promptTemplate.includes('{{TASK}}'))
  assert.ok(impl.promptTemplate.includes('{{PATHS}}'))
  assert.ok(Array.isArray(impl.mustNot) && impl.mustNot.length >= 4)

  const rev = await briefTool.execute({ role: 'review' })
  assert.equal(rev.role, 'review')
  assert.equal(rev.model, 'gemini-4-neon')
  assert.equal(rev.effort, 'medium')
  assert.equal(rev.send.wait, true)
  assert.equal(rev.send.neverResendSamePrompt, true)
  assert.ok(rev.promptTemplate.includes('{{TASK}}'))
  assert.ok(rev.promptTemplate.includes('{{PATHS}}'))

  for (const res of [impl, rev]) {
    const codes = res.watchCodes.map((w) => w.code)
    for (const expected of [
      'AGY_ACP_UNSUPPORTED_TOOLS',
      'AGY_ACP_ACCEPTANCE_UNKNOWN',
      'AGY_ACP_BINDING_UNKNOWN',
      'AGY_ACP_SYSTEM_CHANGED',
    ]) {
      assert.ok(codes.includes(expected), `watchCodes must include ${expected}`)
    }
    for (const entry of res.watchCodes) {
      assert.equal(typeof entry.explanation, 'string')
      assert.ok(entry.explanation.trim().length > 0)
    }
  }
})

test('T3: invalid role rejects explicitly and never falls back to implement', async () => {
  for (const bad of ['admin', '', undefined, null, 123]) {
    await assert.rejects(
      () => briefTool.execute({ role: bad }),
      (err) => err instanceof Error && err.code === 'invalid_role',
      `invalid role ${JSON.stringify(bad)} must reject`,
    )
  }
})

test('T4: deterministic output across repeated calls for both roles', async () => {
  const i1 = await briefTool.execute({ role: 'implement' })
  const i2 = await briefTool.execute({ role: 'implement' })
  assert.equal(JSON.stringify(i1), JSON.stringify(i2))

  const r1 = await briefTool.execute({ role: 'review' })
  const r2 = await briefTool.execute({ role: 'review' })
  assert.equal(JSON.stringify(r1), JSON.stringify(r2))
})

test('T5: watchCodes cross-check against ERROR_CODES and lib/model-adapter.js source literals', async () => {
  const modelAdapterSrc = readFileSync(join(ROOT, 'lib', 'model-adapter.js'), 'utf8')
  const res = await briefTool.execute({ role: 'implement' })
  const codes = new Set(res.watchCodes.map((w) => w.code))

  assert.equal(ERROR_CODES.UNSUPPORTED_TOOLS, 'AGY_ACP_UNSUPPORTED_TOOLS')
  assert.ok(codes.has(ERROR_CODES.UNSUPPORTED_TOOLS))

  for (const literal of [
    'AGY_ACP_ACCEPTANCE_UNKNOWN',
    'AGY_ACP_BINDING_UNKNOWN',
    'AGY_ACP_SYSTEM_CHANGED',
  ]) {
    assert.ok(codes.has(literal), `watchCodes missing ${literal}`)
    assert.ok(
      new RegExp(`['"]${literal}['"]`).test(modelAdapterSrc),
      `lib/model-adapter.js source must contain literal ${literal}`,
    )
  }
})
