import { cpSync, mkdtempSync, readdirSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AcpClient } from '../lib/acp.js'

import test from 'node:test'
import assert from 'node:assert/strict'
import { Bridge, defaultConfig } from '../lib/bridge.js'
import { probeCli, loginArgs } from '../lib/cli-probe.js'

const root = resolve(import.meta.dirname, '../../..')
const shared = join(root, 'desktop-staging/verification/agy-data')
function snapshot(dir = shared, prefix = '') { return readdirSync(dir, { withFileTypes: true }).flatMap((d) => { const p = join(dir, d.name); const name = join(prefix, d.name); if (d.isDirectory()) return snapshot(p, name); const s = statSync(p); return [{ path: name, size: s.size, mtimeMs: s.mtimeMs }] }) }
if (!process.argv.includes('--probe-auth')) {
  test('CLI executable detection separates available/missing/unusable', async () => {
    assert.equal((await probeCli({ agyExecutable: process.execPath, cwd: root })).installation, 'available')
    assert.equal((await probeCli({ agyExecutable: join(root, 'does-not-exist.exe'), cwd: root })).installation, 'missing')
    assert.equal((await probeCli({ agyExecutable: root, cwd: root })).installation, 'unusable')
  })
  test('login preserves bridge arguments and rejects implicit or malformed directories', () => {
    const args = ['acp', '--gemini-dir', 'D:\\private space\\root', '--app-data-dir=C:\\private']
    assert.deepEqual(loginArgs({ agyArgs: args }), ['acp', '--login', ...args.slice(1)])
    for (const agyArgs of [['acp'], ['acp', '--gemini-dir'], ['acp', '--gemini-dir', 'relative']]) assert.throws(() => loginArgs({ agyArgs }), { code: 'cli_data_directory_required' })
  })
  test('authMethods and successful session/new NEVER imply loggedin; no prompts or state writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-auth-unit-'))
    let prompts = 0
    try {
      for (const authMethods of [[], [{ id: 'oauth-personal' }]]) {
        const config = defaultConfig({ cwd: dir, agyArgs: ['acp', '--gemini-dir', dir], stateFile: join(dir, 'state.json'), cliProbe: async () => ({ installation: 'available', version: '1.5.14' }), backend: { ready: async () => ({ authMethods }), createSession: async () => ({ sessionId: 'probe' }), promptSession: () => { prompts++ }, close() {} } })
        const bridge = new Bridge({}, config, {})
        assert.equal((await bridge.cliAuthStatus()).status, 'unknown')
        bridge.dispose()
      }
      assert.equal(prompts, 0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}
if (process.argv.includes('--probe-auth')) {
  const before = snapshot(); const temp = mkdtempSync(join(tmpdir(), 'agy-login-probe-')); const results = []
  try {
    cpSync(shared, join(temp, 'known-login'), { recursive: true })
    for (const name of ['known-login', 'empty']) {
      const dir = join(temp, name)
      const { mkdirSync, writeFileSync } = await import('node:fs'); mkdirSync(join(dir, 'antigravity-cli', 'log'), { recursive: true }); if (name === 'empty') writeFileSync(join(dir, 'antigravity-cli', 'installation_id'), 'c38e13c4-997d-4cc7-a80f-8a51218f80a8')
      const config = { agyExecutable: join(root, 'desktop-staging/verification/official-cli/agy.exe'), agyArgs: ['acp', '--gemini-dir', dir], cwd: resolve(root, '..'), permissionPolicy: 'reject' }
      const client = new AcpClient(config, {})
      const item = { source: name }
      try { item.initialize = await client.ready(); const session = await client.createSession({ cwd: config.cwd }); item.sessionCreated = Boolean(session.sessionId) }
      catch (error) { item.error = { code: error.code, message: error.message }; item.denied = /Access is denied/i.test(error.message) }
      finally { client.close() }
      const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
      item.readOnlyCommands = []
      for (const subcommand of ['models', 'agents']) {
        try { const result = await promisify(execFile)(config.agyExecutable, [subcommand, '--gemini-dir', dir], { timeout: 15000, windowsHide: true, maxBuffer: 65536 }); item.readOnlyCommands.push({ subcommand, exitCode: 0, outputBytes: result.stdout.length + result.stderr.length }) }
        catch (e) { item.readOnlyCommands.push({ subcommand, exitCode: e.code, timedOut: Boolean(e.killed), unsupportedDirectoryFlag: /unknown flag|flag provided but not defined|unknown.*gemini-dir/i.test(String(e.stderr)), denied: /access is denied/i.test(String(e.stderr)), authenticationRequired: /not authenticated|not logged in|authentication required/i.test(String(e.stderr)) }) }
      }
      if (name === 'known-login' && process.argv.includes('--visible')) {
        const { launchLoginTerminal, loginArgs } = await import('../lib/cli-probe.js')
        const terminal = await launchLoginTerminal({ executable: config.agyExecutable, args: loginArgs(config), cwd: config.cwd })
        await new Promise((r) => setTimeout(r, 2000))
        const ps = `$p=Get-Process -Id ${terminal.pid}; $children=Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${terminal.pid}'; @{pid=$p.Id;startTime=$p.StartTime.ToString('o');mainWindowHandle=$p.MainWindowHandle.ToInt64();mainWindowTitle=$p.MainWindowTitle;children=@($children | Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath)} | ConvertTo-Json -Depth 4 -Compress`
        try { item.visibleTerminal = { ...terminal, observed: JSON.parse((await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true })).stdout), argv: ['acp', '--login', '--gemini-dir', '[TEMP login-copy]'] } }
        finally { await promisify(execFile)('taskkill.exe', ['/PID', String(terminal.pid), '/T', '/F'], { windowsHide: true }).catch(() => {}) }
      }
      results.push(item)
    }
  } finally {
    rmSync(temp, { recursive: true, force: true }); const after = snapshot(); const b = new Map(before.map((i) => [i.path, i])); const a = new Map(after.map((i) => [i.path, i]));
    console.log(JSON.stringify({ results, sharedCount: [before.length, after.length], sharedDiff: { added: after.filter((i) => !b.has(i.path)), removed: before.filter((i) => !a.has(i.path)), changed: after.filter((i) => b.has(i.path) && (i.size !== b.get(i.path).size || i.mtimeMs !== b.get(i.path).mtimeMs)) }, tempDeleted: true }, null, 2))
  }
}
