import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isAbsolute } from 'node:path'
import { existsSync } from 'node:fs'
const execute = promisify(execFile)
export const CLI_INSTALL_URL = 'https://antigravity.google/download'
export async function probeCli(config) {
  try {
    const { stdout } = await execute(config.agyExecutable, ['--version'], { cwd: config.cwd, windowsHide: true, timeout: 10000, maxBuffer: 16384 })
    const version = String(stdout).trim().match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:[-\w.]*)?)/)?.[1]
    if (!version) return { installation: 'unusable', executable: config.agyExecutable, code: 'cli_version_invalid', message: 'CLI --version 未返回有效版本。' }
    return { installation: 'available', executable: config.agyExecutable, version }
  } catch (error) {
    const missing = error.code === 'ENOENT' && !(isAbsolute(config.agyExecutable) && existsSync(config.agyExecutable))
    return { installation: missing ? 'missing' : 'unusable', executable: config.agyExecutable, code: missing ? 'cli_not_installed' : 'cli_not_executable', message: missing ? `未找到 Antigravity CLI。请从 ${CLI_INSTALL_URL} 安装，运行 agy --version 自检。` : `CLI 无法执行 --version（${error.code || 'error'}）。`, installUrl: CLI_INSTALL_URL }
  }
}
export function loginArgs(config) {
  // Retain the bridge's data-directory flags and values; never switch to the
  // inaccessible default account directory implicitly.
  const args = config.agyArgs.filter((arg) => arg !== '--login')
  if (args[0] !== 'acp') throw Object.assign(new Error('CLI 登录要求 agyArgs 以 acp 开头。'), { code: 'cli_login_arguments_invalid' })
  let dataRoot = ''
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--gemini-dir' || args[i] === '--app-data-dir') dataRoot = args[i + 1] || ''
    else if (/^--(?:gemini-dir|app-data-dir)=/.test(args[i])) dataRoot = args[i].slice(args[i].indexOf('=') + 1)
  }
  if (!dataRoot || !isAbsolute(dataRoot) || dataRoot.includes('\0')) {
    throw Object.assign(new Error('请先配置与桥一致的 --gemini-dir 或 --app-data-dir；不会写入默认 CLI 账户目录。'), { code: 'cli_data_directory_required' })
  }
  return ['acp', '--login', ...args.slice(1)]
}
const psQuote = (text) => `'${String(text).replaceAll("'", "''")}'`
export async function launchLoginTerminal({ executable, args, cwd }) {
  if (process.platform !== 'win32') throw Object.assign(new Error('当前登录终端实现仅支持 Windows。'), { code: 'cli_terminal_unsupported' })
  // Two separate processes: the hidden launcher uses Start-Process to create a
  // NORMAL, visible console. EncodedCommand protects each literal argv value;
  // login stdout/stderr remain solely in that console, never in bridge pipes.
  const inner = `Set-Location -LiteralPath ${psQuote(cwd)}; & ${psQuote(executable)} @(${args.map(psQuote).join(',')}); Write-Host 'CLI exited. Return to DSH and refresh login status.'`
  const encoded = Buffer.from(inner, 'utf16le').toString('base64')
  const script = `$p = Start-Process -FilePath powershell.exe -ArgumentList @('-NoLogo','-NoProfile','-NoExit','-EncodedCommand','${encoded}') -WorkingDirectory ${psQuote(cwd)} -WindowStyle Normal -PassThru; @{pid=$p.Id;startTime=$p.StartTime.ToString('o')} | ConvertTo-Json -Compress`
  const { stdout } = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000, maxBuffer: 4096 })
  return JSON.parse(stdout.trim())
}
