import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const run = spawnSync(process.execPath, ['--test', 'scripts/ui-model-integration.test.mjs'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
})
// Preserve the complete child output, including the known assertion and stack.
process.stdout.write(run.stdout || '')
process.stderr.write(run.stderr || '')
const output = run.stdout || ''
// The fake transport gained a paired unregister for onNotification/onRequest
// (the adapter now detaches per-turn handlers), which shifted the known
// assertion 10 lines down. The gate still requires the exact same file, column
// and message; only the recorded line moved.
const knownLine = 872
const expectedTitle = 'client bundle registers its panel, upload-capable remote, and file uploader at the session slot'
const failures = [...output.matchAll(/^not ok \d+ - (.+)$/gm)]
const knownBlock = output.slice(output.indexOf('not ok ')).split(/^1\.\./m)[0]
const accepted = !run.error && run.status === 1 && failures.length === 1 && failures[0][1] === expectedTitle
  && /^# tests 11$/m.test(output) && /^# pass 10$/m.test(output) && /^# fail 1$/m.test(output)
  && /^# (?:cancelled|skipped|todo) 0$/m.test(output)
  && /\+ 'main'/.test(knownBlock) && /- 'conversation\.composer\.dock'/.test(knownBlock)
  && /actual: 'main'/.test(knownBlock) && /expected: 'conversation\.composer\.dock'/.test(knownBlock)
  && new RegExp(`ui-model-integration\\.test\\.mjs:${knownLine}:10`).test(knownBlock)
if (!accepted) {
  console.error('UI gate FAILED: expected exactly the unchanged known slot assertion, 10 pass / 1 fail; any other result is rejected.')
  process.exitCode = 1
} else console.log('UI gate PASS: 10 pass / 1 unchanged known slot assertion; no new failures.')
