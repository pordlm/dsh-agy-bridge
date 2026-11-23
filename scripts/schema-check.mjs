/**
 * Pre-flight check: every tool schema this plugin registers must satisfy the
 * Harness JSON-schema subset.
 *
 * The Harness rejects a plugin that registers an unsupported schema, which takes
 * the whole plugin down at load time (tools and panel disappear). The offline
 * suites do not cover that path, so this script calls apply() with a stub ctx,
 * collects every tools.register() definition and validates its schemas with the
 * Harness' own validator.
 *
 * Usage: node scripts/schema-check.mjs [--validator <path to dsh-tools json-schema.js>]
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const pluginRoot = join(here, '..')

function argsValue(flag) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? '' : String(process.argv[index + 1] ?? '')
}

function discoverValidator() {
  const explicit = argsValue('--validator') || process.env.DSH_JSON_SCHEMA_VALIDATOR || ''
  if (explicit !== '') {
    if (!existsSync(explicit)) throw new Error(`validator not found: ${explicit}`)
    return explicit
  }
  const candidates = []
  for (const home of [process.env.DSH_HOME, 'D:\\dsh-home', 'D:\\dsh-data'].filter(Boolean)) {
    const versions = join(home, 'versions')
    if (!existsSync(versions)) continue
    for (const entry of readdirSync(versions)) {
      const file = join(versions, entry, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'types', 'json-schema.js')
      if (existsSync(file)) candidates.push({ file, mtime: statSync(file).mtimeMs })
    }
    const profile = join(home, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'types', 'json-schema.js')
    if (existsSync(profile)) candidates.push({ file: profile, mtime: statSync(profile).mtimeMs })
  }
  if (candidates.length === 0) {
    throw new Error('could not locate @deepseek-ai/dsh-tools/lib/types/json-schema.js; pass --validator <path>')
  }
  candidates.sort((left, right) => right.mtime - left.mtime)
  return candidates[0].file
}

const validatorPath = discoverValidator()
const validator = await import(pathToFileURL(validatorPath).href)
if (typeof validator.assertSupportedJsonSchema !== 'function') {
  throw new Error(`${validatorPath} does not export assertSupportedJsonSchema`)
}

const registrations = []
const noop = () => () => {}

function makeLogger() {
  const line = () => {}
  return { debug: line, info: line, warn: line, error: line, trace: line }
}

const stub = {
  tools: {
    register(definition) {
      registrations.push(definition)
      return () => {}
    },
  },
  effect: (fn) => {
    if (typeof fn === 'function') fn()
    return noop
  },
  get: () => undefined,
  logger: makeLogger(),
  on: () => noop,
  reflect: { provide: () => {}, get: () => undefined },
  root: {},
}

const { apply } = await import(pathToFileURL(join(pluginRoot, 'lib', 'index.js')).href)

let failures = 0
function check(label, schema) {
  try {
    validator.assertSupportedJsonSchema(schema)
    console.log(`PASS ${label}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${label} — ${error?.message ?? error}`)
  }
}

try {
  await apply(stub, {})
} catch (error) {
  console.log(`FAIL apply() threw — ${error?.message ?? error}`)
  failures += 1
}

if (registrations.length === 0) {
  console.log('FAIL apply() registered no tools')
  failures += 1
}

for (const definition of registrations) {
  const name = String(definition?.name ?? '(unnamed)')
  check(`${name} parameters`, definition?.parameters)
  if (definition?.output?.schema !== undefined) check(`${name} output.schema`, definition.output.schema)
}

console.log(
  failures === 0
    ? `\nall ${registrations.length} tool schema(s) accepted by the Harness subset`
    : `\n${failures} schema check(s) failed`,
)
process.exitCode = failures === 0 ? 0 : 1
