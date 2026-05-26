#!/usr/bin/env node
/**
 * V1.7 现场修复脚本（一键诊断 / 可选自动修复）
 *
 * 用途：
 *   早期 V1.7 版本在某些升级路径下会留下：
 *     1) accounts/ 顶层的 V1.6 .json 单文件残留（UI 看不见）
 *     2) accounts/ 下没有 auth.json 的半成品（登录中断）
 *     3) ~/.codex/ 还是真目录（不是指向 shared/.codex 的 symlink）
 *     4) ~/.codex/auth.json 是真文件（symlink farm 没装上 → 切账号不生效）
 *     5) active.json / current / auth.json symlink 三处不一致
 *
 *   v1.7.3 起 app 内部 bootstrap 会自动处理 1/3/4，但已经损坏的现场仍需手动一次清理。
 *
 * 用法：
 *   node scripts/repair-v17.js                # 默认 = 只诊断，列问题
 *   node scripts/repair-v17.js --fix          # 备份 + 实际修复（需要 CodePal 关闭）
 *   node scripts/repair-v17.js --fix --yes    # 跳过交互确认
 *
 * 修复前置：
 *   - CodePal 必须关闭（否则 main 进程会与脚本竞争写）
 *   - 自动备份：~/.codex-switcher.metadata-backup-<ts>.tgz（排除 shared/，体积小）
 *   - ~/.codex/ 若需改造，整体改名为 ~/.codex.replaced-by-farm-<ts>/（即原地备份）
 *
 * @module scripts/repair-v17
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

const HOME = os.homedir()
const CODEX_DIR = path.join(HOME, '.codex')
const SWITCHER_DIR = path.join(HOME, '.codex-switcher')
const ACCOUNTS_DIR = path.join(SWITCHER_DIR, 'accounts')
const SHARED_CODEX_DIR = path.join(SWITCHER_DIR, 'shared', '.codex')
const ACTIVE_JSON = path.join(SWITCHER_DIR, 'active.json')
const CURRENT_FILE = path.join(SWITCHER_DIR, 'current')

const args = process.argv.slice(2)
const MODE_FIX = args.includes('--fix')
const SKIP_CONFIRM = args.includes('--yes') || args.includes('-y')

function ts() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function log(kind, msg) {
  const tag = { info: '·', warn: '!', fix: '✓', err: '✗' }[kind] ?? '·'
  console.log(`  ${tag} ${msg}`)
}

function lstatSafe(p) { try { return fs.lstatSync(p) } catch { return null } }
function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }
function readlinkSafe(p) { try { return fs.readlinkSync(p) } catch { return null } }

function diagnose() {
  const issues = []

  if (!fs.existsSync(SWITCHER_DIR)) {
    issues.push({ kind: 'fatal', msg: `~/.codex-switcher/ 不存在；这台机器没跑过 V1.7 bootstrap，无需修复` })
    return issues
  }

  // (a) ~/.codex 顶层 symlink farm
  const codexStat = lstatSafe(CODEX_DIR)
  if (!codexStat) {
    issues.push({ kind: 'home-missing', msg: `~/.codex/ 不存在`, fixable: true })
  } else if (codexStat.isSymbolicLink()) {
    const target = readlinkSafe(CODEX_DIR)
    const resolved = path.resolve(path.dirname(CODEX_DIR), target ?? '')
    if (resolved !== SHARED_CODEX_DIR) {
      issues.push({ kind: 'home-wrong-target', msg: `~/.codex 是 symlink 但指向 ${resolved}（应指向 ${SHARED_CODEX_DIR}）`, fixable: false })
    }
  } else {
    issues.push({ kind: 'home-real-dir', msg: `~/.codex/ 是真目录，symlink farm 未装上`, fixable: true })
  }

  // (b) accounts/*.json 残留
  if (fs.existsSync(ACCOUNTS_DIR)) {
    const entries = fs.readdirSync(ACCOUNTS_DIR, { withFileTypes: true })
    for (const ent of entries) {
      if (ent.isFile() && !ent.name.startsWith('.') && ent.name.endsWith('.json')) {
        issues.push({ kind: 'residue-json', name: ent.name, msg: `accounts/${ent.name} 是 V1.6 单文件账号，UI 看不到`, fixable: true })
      }
      if (ent.isDirectory()) {
        const auth = path.join(ACCOUNTS_DIR, ent.name, '.codex', 'auth.json')
        if (!fs.existsSync(auth) && !ent.name.startsWith('.')) {
          issues.push({ kind: 'incomplete-account', name: ent.name, msg: `accounts/${ent.name}/ 缺 auth.json（半成品账号）`, fixable: true })
        }
      }
    }
  }

  // (c) auth.json symlink
  const sharedAuth = path.join(SHARED_CODEX_DIR, 'auth.json')
  const sharedAuthStat = lstatSafe(sharedAuth)
  if (sharedAuthStat && !sharedAuthStat.isSymbolicLink()) {
    issues.push({ kind: 'auth-real-file', msg: `shared/.codex/auth.json 是真文件（应为 symlink 指向 active 账号）`, fixable: true })
  }

  // (d) active.json vs current 一致性
  const active = readJsonSafe(ACTIVE_JSON)
  let currentName = null
  try { currentName = fs.readFileSync(CURRENT_FILE, 'utf8').trim() } catch { /* may not exist */ }
  if (active?.currentAccount && currentName && active.currentAccount !== currentName) {
    issues.push({ kind: 'active-current-mismatch', activeName: active.currentAccount, currentName, msg: `active.json(${active.currentAccount}) ≠ current(${currentName})`, fixable: true })
  }

  // (e) active 指向的账号目录存在吗
  if (active?.currentAccount) {
    const activeAuth = path.join(ACCOUNTS_DIR, active.currentAccount, '.codex', 'auth.json')
    if (!fs.existsSync(activeAuth)) {
      issues.push({ kind: 'active-target-missing', name: active.currentAccount, msg: `active.json 指向 ${active.currentAccount}，但 accounts/${active.currentAccount}/.codex/auth.json 不存在`, fixable: false })
    }
  }

  return issues
}

function ensureCodepalClosed() {
  const r = spawnSync('pgrep', ['-fl', 'CodePal'], { encoding: 'utf8' })
  const out = (r.stdout || '').trim()
  if (out) {
    console.log('')
    log('err', `检测到 CodePal 进程在跑，请先退出：`)
    out.split('\n').forEach(l => console.log(`      ${l}`))
    process.exit(2)
  }
}

async function backupMetadata() {
  const tag = ts()
  const dest = path.join(HOME, `.codex-switcher.metadata-backup-${tag}.tgz`)
  const r = spawnSync('tar', ['czf', dest, '-C', SWITCHER_DIR, '--exclude=shared', '.'], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`tar 备份失败 (exit ${r.status})`)
  log('fix', `元数据备份 → ${dest}`)
  return tag
}

async function fixResidue(issues, tag) {
  for (const it of issues.filter(x => x.kind === 'residue-json')) {
    const src = path.join(ACCOUNTS_DIR, it.name)
    const name = it.name.slice(0, -5)
    const targetDir = path.join(ACCOUNTS_DIR, name, '.codex')
    if (fs.existsSync(path.join(ACCOUNTS_DIR, name))) {
      const conflictName = `${it.name}.conflict-${tag}`
      await fsp.rename(src, path.join(ACCOUNTS_DIR, conflictName))
      log('warn', `冲突：${it.name} 同名目录已存在，挪到 ${conflictName}`)
    } else {
      await fsp.mkdir(targetDir, { recursive: true })
      await fsp.rename(src, path.join(targetDir, 'auth.json'))
      log('fix', `升级残留：${it.name} → ${name}/.codex/auth.json`)
    }
  }
  for (const it of issues.filter(x => x.kind === 'incomplete-account')) {
    const src = path.join(ACCOUNTS_DIR, it.name)
    const quarantineRoot = path.join(SWITCHER_DIR, 'incomplete-accounts')
    await fsp.mkdir(quarantineRoot, { recursive: true })
    const dst = path.join(quarantineRoot, it.name)
    if (fs.existsSync(dst)) { log('warn', `半成品 ${it.name} 已在 incomplete-accounts/ 下，跳过`); continue }
    await fsp.rename(src, dst)
    log('fix', `隔离半成品：accounts/${it.name} → incomplete-accounts/${it.name}`)
  }
}

async function fixHomeSymlinkFarm(issues, tag) {
  const needHomeFarm = issues.some(i => i.kind === 'home-real-dir' || i.kind === 'home-missing')
  if (!needHomeFarm) return
  if (issues.some(i => i.kind === 'home-real-dir')) {
    await fsp.mkdir(path.join(SHARED_CODEX_DIR, '..'), { recursive: true })
    if (fs.existsSync(SHARED_CODEX_DIR)) {
      const oldShared = `${SHARED_CODEX_DIR}.old-snapshot-${tag}`
      await fsp.rename(SHARED_CODEX_DIR, oldShared)
      log('fix', `旧 shared/.codex → ${path.basename(oldShared)}（保险备份）`)
    }
    await fsp.rename(CODEX_DIR, SHARED_CODEX_DIR)
    log('fix', `~/.codex/ → shared/.codex/（rename，无复制）`)
  } else {
    await fsp.mkdir(SHARED_CODEX_DIR, { recursive: true })
  }
  await fsp.symlink(SHARED_CODEX_DIR, CODEX_DIR)
  log('fix', `~/.codex → symlink → shared/.codex`)
}

async function fixAuthSymlink(issues, tag) {
  const sharedAuth = path.join(SHARED_CODEX_DIR, 'auth.json')
  const active = readJsonSafe(ACTIVE_JSON)
  let activeName = active?.currentAccount
  if (!activeName) {
    const dirs = fs.readdirSync(ACCOUNTS_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name)
    activeName = dirs[0]
    if (!activeName) { log('warn', `没有任何账号目录，跳过 auth symlink`); return }
    log('warn', `active.json 缺 currentAccount，挑第一个账号 ${activeName}`)
  }
  const targetRel = path.posix.join('..', '..', 'accounts', activeName, '.codex', 'auth.json')
  const absTarget = path.join(ACCOUNTS_DIR, activeName, '.codex', 'auth.json')
  if (!fs.existsSync(absTarget)) { log('err', `目标 ${absTarget} 不存在，跳过 symlink 重建`); return }

  const st = lstatSafe(sharedAuth)
  if (st && !st.isSymbolicLink()) {
    const bak = `${sharedAuth}.pre-farm-${tag}`
    await fsp.rename(sharedAuth, bak)
    log('fix', `真文件 auth.json 备份 → ${path.basename(bak)}`)
  } else if (st?.isSymbolicLink()) {
    await fsp.unlink(sharedAuth)
  }
  await fsp.symlink(targetRel, sharedAuth)
  log('fix', `shared/.codex/auth.json → symlink → ${targetRel}`)
}

async function fixActiveCurrentSync() {
  const active = readJsonSafe(ACTIVE_JSON)
  if (!active?.currentAccount) return
  await fsp.writeFile(CURRENT_FILE, `${active.currentAccount}\n`, 'utf8')
  log('fix', `current 同步为 ${active.currentAccount}`)
}

async function main() {
  console.log('')
  console.log(`V1.7 现场修复 · ${MODE_FIX ? '修复模式' : '诊断模式'}`)
  console.log(`HOME = ${HOME}`)
  console.log('')

  const issues = diagnose()
  console.log(`发现 ${issues.length} 个问题：`)
  if (issues.length === 0) {
    log('info', `~/.codex-switcher 状态健康`)
    process.exit(0)
  }
  for (const it of issues) log(it.kind === 'fatal' ? 'err' : 'warn', it.msg)

  if (!MODE_FIX) {
    console.log('')
    console.log('（诊断完毕。要修复请加 --fix；首次建议在不带 --yes 模式下确认）')
    process.exit(0)
  }

  ensureCodepalClosed()

  const fixable = issues.filter(i => i.fixable !== false && i.kind !== 'fatal')
  if (fixable.length === 0) {
    console.log('\n没有可自动修复的问题。')
    process.exit(0)
  }

  if (!SKIP_CONFIRM) {
    console.log('\n即将开始修复。所有变更会先备份 metadata 到 tgz。按 Ctrl+C 取消，或回车继续…')
    await new Promise((resolve) => process.stdin.once('data', resolve))
  }

  console.log('')
  const tag = await backupMetadata()
  await fixResidue(issues, tag)
  await fixHomeSymlinkFarm(issues, tag)
  await fixAuthSymlink(issues, tag)
  await fixActiveCurrentSync()

  console.log('\n复检：')
  const after = diagnose()
  if (after.length === 0) log('info', '全部修复完成 ✓')
  else after.forEach(it => log('warn', `仍存在：${it.msg}`))
  process.exit(after.length === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('\n[repair-v17] 脚本异常：', err)
  process.exit(3)
})
