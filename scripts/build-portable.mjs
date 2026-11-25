import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(__dirname, '..')

const WHITELIST_DIRS = new Set(['lib', 'client', 'locale', 'preset', 'docs'])
const WHITELIST_FILES = new Set([
  'CHANGELOG.md',
  'README.md',
  'LICENSE',
  'icon.svg',
  'cordis.patch.yml',
  'package.json',
])
const SKIP_VCS_OR_BUILD = new Set(['.git', 'dist'])

function matchForbidden(relPosix) {
  const parts = relPosix.split('/')
  const base = parts.at(-1) || ''
  if (parts[0] === 'results') return 'runtime results directory'
  if (parts.includes('node_modules')) return 'node_modules directory'
  if (parts.some((p) => p.startsWith('tmp-'))) return 'temporary directory/file'
  if (base === 'state.json' || base === 'native-sessions.json' || base === 'desktop-target.json' || base === 'machine.json') {
    return 'runtime state/identity file'
  }
  if (/\.foreign-/i.test(base) || /\.corrupt-/i.test(base)) return 'quarantined/corrupt state file'
  if (/\.tmp($|[.-])/i.test(base)) return 'temporary file'
  if (base.includes('.bak')) return 'backup file'
  if (base.endsWith('.log')) return 'log file'
  if (base === '.env' || base.startsWith('.env.')) return 'env secret file'
  if (/\.(pem|key|sqlite|db)$/i.test(base)) return 'secret/database file'
  return null
}

function collectFiles(rootDir) {
  const entries = []
  const forbidden = []

  function walkWhitelistDir(absDir) {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const absPath = join(absDir, entry.name)
      const relPosix = relative(rootDir, absPath).replace(/\\/g, '/')
      const reason = matchForbidden(relPosix)
      if (reason) {
        forbidden.push({ path: relPosix, reason })
        if (entry.isDirectory()) continue
        continue
      }
      if (entry.isDirectory()) {
        walkWhitelistDir(absPath)
      } else if (entry.isFile()) {
        entries.push({ absPath, relPosix })
      }
    }
  }

  for (const top of readdirSync(rootDir, { withFileTypes: true })) {
    if (SKIP_VCS_OR_BUILD.has(top.name)) continue
    const absTop = join(rootDir, top.name)
    const relPosix = top.name
    if (top.isDirectory()) {
      if (WHITELIST_DIRS.has(top.name)) {
        walkWhitelistDir(absTop)
      } else {
        // 非白名单顶层目录（如 scripts、tmp-*、node_modules、results）永远不进包，只记 SKIP
        console.log(`SKIP_NOT_PACKAGED ${top.name}（不打包）`)
      }
      continue
    }
    const reason = matchForbidden(relPosix)
    if (reason) {
      forbidden.push({ path: relPosix, reason })
      continue
    }
    if (top.isFile() && WHITELIST_FILES.has(top.name)) {
      entries.push({ absPath: absTop, relPosix })
    }
  }

  for (const reqFile of WHITELIST_FILES) {
    if (!existsSync(join(rootDir, reqFile)) && reqFile === 'LICENSE') {
      console.log('NOTE LICENSE not present, skipped')
    }
  }

  return { entries: entries.sort((a, b) => a.relPosix.localeCompare(b.relPosix)), forbidden }
}

function parseArgs(argv) {
  let verifyOnly = false
  let root = DEFAULT_ROOT
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--verify-only') verifyOnly = true
    else if (argv[i] === '--root' && argv[i + 1]) {
      root = resolve(argv[i + 1])
      i += 1
    }
  }
  return { verifyOnly, root }
}

const { verifyOnly, root } = parseArgs(process.argv.slice(2))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = String(pkg.version || '0.0.0')
const { entries, forbidden } = collectFiles(root)

if (forbidden.length > 0) {
  for (const item of forbidden) {
    console.log(`FORBIDDEN ${item.path} ${item.reason}`)
  }
  process.exitCode = 1
} else if (verifyOnly) {
  console.log(`PORTABLE_VERIFY_OK ENTRIES=${entries.length} VERSION=${version}`)
} else {
  const distDir = join(root, 'dist')
  mkdirSync(distDir, { recursive: true })
  const zipPath = join(distDir, `dsh-agy-bridge-${version}.zip`)
  const stageRoot = mkdtempSync(join(tmpdir(), 'dsh-agy-portable-'))
  const innerRoot = join(stageRoot, 'dsh-agy-bridge')
  try {
    mkdirSync(innerRoot, { recursive: true })
    for (const item of entries) {
      const dest = join(innerRoot, item.relPosix)
      mkdirSync(dirname(dest), { recursive: true })
      cpSync(item.absPath, dest)
    }
    if (existsSync(zipPath)) rmSync(zipPath, { force: true })
    execFileSync(
      'pwsh',
      [
        '-NoProfile',
        '-Command',
        `Compress-Archive -Path '${innerRoot.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
      ],
      { stdio: 'pipe' },
    )
    const sha256 = createHash('sha256').update(readFileSync(zipPath)).digest('hex')
    console.log(`ENTRIES=${entries.length}`)
    console.log(`SHA256=${sha256}`)
    console.log(`PATH=${zipPath}`)
  } finally {
    rmSync(stageRoot, { recursive: true, force: true })
  }
}
