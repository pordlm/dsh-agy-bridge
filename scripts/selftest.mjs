/**
 * Offline ACP self-test for the bridge.
 *
 * This launches the local mock agent (no network, no account) and checks the
 * same wire path the plugin uses: initialize, session/new, configOptions,
 * session/set_config_option, session/prompt, assistant chunks and stopReason.
 *
 * Usage: node scripts/selftest.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AcpClient, pickModelOption, pickThoughtOption, resolveConfigValue } from '../lib/acp.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const temp = mkdtempSync(join(tmpdir(), 'ag-bridge-selftest-'))
const mock = join(here, 'mock-agy-acp.mjs')
const state = join(temp, 'state.json')
const log = join(temp, 'events.jsonl')

const client = new AcpClient(
  {
    agyExecutable: process.execPath,
    agyArgs: [mock, `--state=${state}`, `--log=${log}`],
    cwd: temp,
  },
  { warn: (line) => console.log(`WARN ${line}`) },
)

let failures = 0
function check(label, condition, detail = '') {
  if (condition) console.log(`PASS ${label}${detail ? ` — ${detail}` : ''}`)
  else {
    failures += 1
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

try {
  const capabilities = await client.ready()
  check('initialize ACP v1', capabilities.protocolVersion === 1)
  check('prompt capabilities negotiated', capabilities.promptCapabilities.image === true)

  const session = await client.createSession({ cwd: temp })
  check('session/new returns id', typeof session.sessionId === 'string' && session.sessionId !== '')

  const model = pickModelOption(session.configOptions)
  const thought = pickThoughtOption(session.configOptions)
  check('model configOption present', model !== null, model?.currentValue)
  check('thought configOption present', thought !== null, thought?.currentValue)

  const modelValue = resolveConfigValue(model, 'Test Model A')
  await client.setConfigOption(session.sessionId, model.id, modelValue)
  const effortValue = resolveConfigValue(thought, 'High')
  const applied = await client.setConfigOption(session.sessionId, thought.id, effortValue)
  check(
    'set_config_option confirmed',
    pickModelOption(applied.configOptions)?.currentValue === 'test-model-a' &&
      pickThoughtOption(applied.configOptions)?.currentValue === 'high',
  )

  const reply = await client.promptSession({
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: 'selftest: reply with one line' }],
    onPermission: () => {},
  })
  check('session/prompt end_turn', reply.stopReason === 'end_turn')
  check('assistant text received', reply.text.startsWith('MOCK-REPLY:'), reply.text.slice(0, 60))
} catch (error) {
  failures += 1
  console.log(`FAIL harness — ${error?.stack ?? error}`)
} finally {
  client.close()
  await new Promise((resolve) => setTimeout(resolve, 150))
  try {
    rmSync(temp, { recursive: true, force: true })
  } catch {
    // Windows may briefly hold the mock's cwd; the temp directory is harmless.
  }
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1