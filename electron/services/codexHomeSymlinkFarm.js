/**
 * V1.7.1 · ~/.codex/ symlink farm 改造
 *
 * 解决 V1.7 的关键设计 bug：
 * - 设计稿 §3.2 Step 9 说"~/.codex/ 非 auth 内容搬到 backup"，但 quarantine 后终端 codex 找不到 auth 会自动重登把 ~/.codex/auth.json 写回来 → V1.7 的"消除多份可自动刷新 auth"承诺被破坏
 * - 同时 ~/.codex/sessions/ 和 shared/.codex/sessions/ 两套数据分叉，用户感受为"取出的数据有问题"
 *
 * V1.7.1 修正：
 * - `~/.codex/` 整个变成 symlink → `~/.codex-switcher/shared/.codex/`
 *   → 终端 codex 和 CodePal 启动的 codex 看的是 **同一份** sessions/skills/config
 * - `shared/.codex/auth.json` 是 symlink → `accounts/{active}/.codex/auth.json`
 *   → 切换账号 = 改 active.json + 原子重建这一个 symlink；不再覆盖文件内容
 *
 * 模块职责：
 * - installHomeSymlinkFarm(opts)：一次性把 ~/.codex/ 改造成 symlink farm（首次启动 V1.7.1 时跑）
 * - repointActiveAuthSymlink(accountName)：切换账号时原子重建 shared/.codex/auth.json
 * - verifyHomeSymlinkFarm()：启动完整性检查；不符合规范则补建
 *
 * @module electron/services/codexHomeSymlinkFarm
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')

const accountService = require('./codexAccountService')

/**
 * V1.7.1.1 P0-3：检测 ~/.codex/ 是否被进程占用（macOS: lsof / Linux: lsof）
 * 用于 install 前防止"运行中 codex 进程对 ~/.codex/ 的写入"导致数据不一致
 *
 * @returns {Promise<{ busy: boolean, pids?: number[], reason?: string }>}
 */
function detectCodexBusy(codexDir) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      // Windows 没装 lsof，跳过——这条 P0 主要影响 macOS/Linux
      resolve({ busy: false, reason: 'skipped-on-win32' })
      return
    }
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      // V1.7.1.2 P0-2 修复：超时不再静默判 not-busy，明确报 unknown 让调用方决定
      resolve({ busy: false, reason: 'lsof-timeout', confidence: 'unknown' })
    }, 5000) // 5s（原 3s 用户机器 ~/.codex/ 几十子目录可能不够）

    execFile('lsof', ['+D', codexDir], { timeout: 5000 }, (err, stdout, stderr) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // V1.7.1.2 P0-2：区分三种结果
      // 1) ENOENT：lsof 未安装 → confidence: unknown
      // 2) timeout / 其他 err 但无 stdout → confidence: unknown
      // 3) 有 stdout → 解析占用 pid
      if (err && err.code === 'ENOENT') {
        resolve({ busy: false, reason: 'lsof-not-installed', confidence: 'unknown' })
        return
      }
      if (!stdout && err) {
        // lsof 跑出错（permission / killed 等）但没有 stdout
        resolve({ busy: false, reason: `lsof-error:${err.message || err.code}`, confidence: 'unknown' })
        return
      }
      if (!stdout) {
        // lsof exit code 非 0 但 stdout 空——通常表示无占用（lsof +D 对没占用的目录返 exit code 1）
        resolve({ busy: false, reason: 'no-handles', confidence: 'high' })
        return
      }
      const lines = stdout.split('\n').filter((l) => l && !l.startsWith('COMMAND'))
      // 排除 lsof 自己（lsof 本身可能在 cwd 时被列）
      const others = lines.filter((l) => !/^lsof\s/.test(l))
      if (others.length === 0) { resolve({ busy: false, reason: 'no-handles', confidence: 'high' }); return }
      const pids = Array.from(new Set(others.map((l) => {
        const m = l.match(/^\S+\s+(\d+)/)
        return m ? parseInt(m[1], 10) : null
      }).filter(Boolean)))
      resolve({ busy: true, pids, confidence: 'high' })
    })
  })
}

/**
 * 把 ~/.codex/ 改造成 symlink farm
 *
 * 步骤：
 *   1. 检查 ~/.codex/ 是否已经是预期的 symlink → shared/.codex/，若是直接返
 *   2. 合并：把 ~/.codex/ 现有内容 merge 到 shared/.codex/（mtime 较新者保留；auth.json 不合并、由 active 管）
 *   3. 备份：~/.codex/ → ~/.codex.pre-symlink-farm-<ts>/（保险）
 *   4. 建 symlink：~/.codex → ~/.codex-switcher/shared/.codex/
 *   5. 在 shared/.codex/auth.json 建 symlink → accounts/{active}/.codex/auth.json（active 非空时）
 *
 * 幂等：已 farm 状态再调返 noop。
 *
 * @param {{
 *   activeAccountName?: string | null,  // 默认从 active.json 读
 *   logger?: object,
 *   now?: number,
 * }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   action: 'noop' | 'installed' | 'failed',
 *   error?: string,
 *   backupPath?: string,
 *   merged?: string[],
 *   activeAuthLinked?: string | null,
 * }>}
 */
async function installHomeSymlinkFarm(opts = {}) {
  const I = accountService.__INTERNAL__
  const logger = opts.logger ?? console
  const now = opts.now ?? Date.now()
  const codexDir = I.getCodexDir()
  const sharedCodexDir = I.getSharedCodexDir()

  // Step 1: 已 farm？
  try {
    const lst = await fsp.lstat(codexDir)
    if (lst.isSymbolicLink()) {
      const target = await fsp.readlink(codexDir)
      const resolved = path.resolve(path.dirname(codexDir), target)
      if (resolved === sharedCodexDir) {
        return { ok: true, action: 'noop' }
      }
      // 是 symlink 但指向别处 → 不动它（可能用户自定义过），保守返错
      return { ok: false, action: 'failed', error: `~/.codex is symlink but points to ${resolved}, not ${sharedCodexDir}` }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      return { ok: false, action: 'failed', error: `lstat ~/.codex failed: ${err.message}` }
    }
    // ENOENT：~/.codex 不存在，直接进 Step 4
  }

  // V1.7.1.1 P0-3 + V1.7.1.2：检测 codex 进程是否正在使用 ~/.codex/
  // 区分 3 种结果：busy（确认占用）/ not-busy high confidence（确认未占用）/ unknown（lsof 跑挂）
  if (opts.skipBusyCheck !== true && fs.existsSync(codexDir)) {
    const busy = await detectCodexBusy(codexDir)
    if (busy.busy) {
      return {
        ok: false,
        action: 'failed',
        error: `~/.codex is being used by ${busy.pids?.length ?? '?'} process(es) (pids=${busy.pids?.join(',')}). 请先退出所有 codex 进程后重新启动 CodePal。`,
        busyDetail: busy,
      }
    }
    if (busy.confidence === 'unknown') {
      // lsof 不可用/超时 → 显式 warn，让用户在 UI 看到这条信息
      // 不阻塞 install（否则没装 lsof 的容器 / 无权限场景永远跑不起来）
      logger.warn?.(`[codexHomeSymlinkFarm] busy-check unavailable: ${busy.reason}. 继续 install——若你刚才在终端跑过 codex 请先关掉，否则可能数据不一致。`)
    }
  }

  // Step 2: 合并 ~/.codex/ → shared/.codex/（如果 ~/.codex/ 存在）
  const merged = []
  if (fs.existsSync(codexDir)) {
    await fsp.mkdir(sharedCodexDir, { recursive: true })
    await mergeDirNewerWins(codexDir, sharedCodexDir, { skipAuthJson: true, logger, merged })
  }

  // Step 3: 备份原 ~/.codex/（保险——这次 farm 失败也能回滚）
  const backupPath = `${codexDir}.pre-symlink-farm-${now}`
  if (fs.existsSync(codexDir)) {
    try {
      await fsp.rename(codexDir, backupPath)
    } catch (err) {
      return { ok: false, action: 'failed', error: `backup rename ~/.codex failed: ${err.message}` }
    }
  }

  // Step 4: 建 ~/.codex → shared/.codex/
  // V1.7.1.1 P0-7：保持绝对路径（~/.codex/ 在 ~/ 下，shared 在 ~/.codex-switcher/ 下，
  // 相对路径 = "../.codex-switcher/shared/.codex" 不直观；绝对路径明确不可便携，
  // 但 ~/.codex-switcher/ 本就和当前用户绑定，跨机迁移本就需要重新 bootstrap）
  try {
    await fsp.symlink(sharedCodexDir, codexDir)
  } catch (err) {
    // 回滚 backup
    try { await fsp.rename(backupPath, codexDir) } catch {}
    return { ok: false, action: 'failed', error: `symlink ~/.codex failed: ${err.message}` }
  }

  // Step 5: 重建 shared/.codex/auth.json → accounts/{active}/.codex/auth.json
  let activeAuthLinked = null
  const active = opts.activeAccountName === undefined
    ? (await accountService.readActiveJsonV17())?.currentAccount ?? null
    : opts.activeAccountName
  if (active) {
    const result = await repointActiveAuthSymlink(active, { logger })
    if (!result.ok) {
      logger.warn?.(`[codexHomeSymlinkFarm] active auth symlink failed (continuing): ${result.error}`)
    } else {
      activeAuthLinked = active
    }
  }

  logger.info?.(`[codexHomeSymlinkFarm] installed: backup=${backupPath} merged=${merged.length} activeAuth=${activeAuthLinked || 'none'}`)
  return { ok: true, action: 'installed', backupPath, merged, activeAuthLinked }
}

/**
 * 原子重建 shared/.codex/auth.json symlink → accounts/{name}/.codex/auth.json
 *
 * 用临时 symlink + rename 实现原子切换：
 *   1. 建 shared/.codex/auth.json.tmp-<rand> → ../../accounts/{name}/.codex/auth.json
 *   2. rename(.tmp, auth.json) 原子覆盖（POSIX rename 对 symlink 也是 atomic）
 *
 * @param {string} accountName
 * @param {{ logger?: object }} [opts]
 * @returns {Promise<{ ok: boolean, target?: string, error?: string }>}
 */
async function repointActiveAuthSymlink(accountName, opts = {}) {
  const I = accountService.__INTERNAL__
  const logger = opts.logger ?? console
  if (typeof accountName !== 'string' || !accountName) {
    return { ok: false, error: 'INVALID_ACCOUNT_NAME' }
  }
  const sharedCodexDir = I.getSharedCodexDir()
  const accountHomeDir = I.getAccountHomeDir(accountName)
  const accountAuthFile = path.join(accountHomeDir, 'auth.json')

  if (!fs.existsSync(accountAuthFile)) {
    return { ok: false, error: `account auth.json missing: ${accountAuthFile}` }
  }

  await fsp.mkdir(sharedCodexDir, { recursive: true })
  const authLinkPath = path.join(sharedCodexDir, 'auth.json')
  // shared/.codex/ 与 accounts/{name}/.codex/ 同祖父于 ~/.codex-switcher/，
  // 从 shared/.codex/ 出发：../ → shared/ → ../ → ~/.codex-switcher/ → accounts/{name}/.codex/auth.json
  // 共 2 层 `../`（注释修正 V1.7.1.1：之前误称"兄弟"，实际是堂兄弟需上溯两层）
  const relTarget = path.posix.join('..', '..', 'accounts', accountName, '.codex', 'auth.json')
  const tmpLink = path.join(sharedCodexDir, `auth.json.tmp-${crypto.randomBytes(6).toString('hex')}`)

  try {
    await fsp.symlink(relTarget, tmpLink)
    await fsp.rename(tmpLink, authLinkPath)
    logger.info?.(`[codexHomeSymlinkFarm] auth symlink repointed → ${accountName}`)
    return { ok: true, target: relTarget }
  } catch (err) {
    try { await fsp.unlink(tmpLink) } catch {}
    return { ok: false, error: err.message }
  }
}

/**
 * 启动时验证 ~/.codex/ 和 shared/.codex/auth.json 处于预期状态；不符则修复
 *
 * @param {{ logger?: object }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   homeStatus: 'symlink-ok' | 'symlink-wrong-target' | 'real-dir' | 'missing' | 'error',
 *   authSymlinkStatus: 'symlink-ok' | 'dangling' | 'missing' | 'wrong-target' | 'real-file' | 'no-active' | 'error',
 *   repaired?: string[],
 * }>}
 */
async function verifyHomeSymlinkFarm(opts = {}) {
  const I = accountService.__INTERNAL__
  const logger = opts.logger ?? console
  const codexDir = I.getCodexDir()
  const sharedCodexDir = I.getSharedCodexDir()
  const repaired = []

  // 检查 ~/.codex/
  let homeStatus
  try {
    const lst = await fsp.lstat(codexDir)
    if (lst.isSymbolicLink()) {
      const target = await fsp.readlink(codexDir)
      const resolved = path.resolve(path.dirname(codexDir), target)
      homeStatus = resolved === sharedCodexDir ? 'symlink-ok' : 'symlink-wrong-target'
    } else {
      homeStatus = 'real-dir'
    }
  } catch (err) {
    homeStatus = err.code === 'ENOENT' ? 'missing' : 'error'
  }

  // V1.7.1.1 P1：wrong-target 也自愈（unlink 错的 symlink 后重新 install）
  if (homeStatus === 'real-dir' || homeStatus === 'missing') {
    const r = await installHomeSymlinkFarm({ logger })
    if (r.ok) {
      repaired.push(`home:${r.action}`)
      homeStatus = 'symlink-ok'
    } else {
      logger.warn?.(`[codexHomeSymlinkFarm] verify install failed: ${r.error}`)
    }
  } else if (homeStatus === 'symlink-wrong-target') {
    // V1.7.1.2 P1：保留旧 symlink 到 backup 路径（用户可能故意自定义了，不能强拆）
    const backupPath = `${codexDir}.pre-farm-wrong-target-${Date.now()}`
    logger.warn?.(`[codexHomeSymlinkFarm] ~/.codex is symlink pointing to unexpected target, backing up to ${backupPath} before repair`)
    try {
      await fsp.rename(codexDir, backupPath)
      const r = await installHomeSymlinkFarm({ logger })
      if (r.ok) {
        repaired.push(`home:wrong-target-repaired (old symlink saved to ${backupPath})`)
        homeStatus = 'symlink-ok'
      } else {
        // 回滚：把 backup symlink 改回去
        try { await fsp.rename(backupPath, codexDir) } catch {}
        logger.warn?.(`[codexHomeSymlinkFarm] wrong-target repair install failed: ${r.error}`)
      }
    } catch (err) {
      logger.warn?.(`[codexHomeSymlinkFarm] wrong-target backup failed: ${err.message}`)
    }
  }

  // 检查 shared/.codex/auth.json symlink
  const authLinkPath = path.join(sharedCodexDir, 'auth.json')
  let authSymlinkStatus = 'missing'
  const active = (await accountService.readActiveJsonV17())?.currentAccount ?? null
  try {
    const lst = await fsp.lstat(authLinkPath)
    if (!lst.isSymbolicLink()) {
      authSymlinkStatus = 'real-file'
    } else {
      // 验 target 是否指向 accounts/{active}/.codex/auth.json
      const target = await fsp.readlink(authLinkPath)
      const resolved = path.resolve(path.dirname(authLinkPath), target)
      const expected = active ? path.join(I.getAccountHomeDir(active), 'auth.json') : null
      if (expected && resolved === expected) {
        // 验它能解析（非 dangling）
        try { await fsp.stat(authLinkPath); authSymlinkStatus = 'symlink-ok' } catch { authSymlinkStatus = 'dangling' }
      } else {
        authSymlinkStatus = 'wrong-target'
      }
    }
  } catch (err) {
    authSymlinkStatus = err.code === 'ENOENT' ? 'missing' : 'error'
  }

  if (active && authSymlinkStatus !== 'symlink-ok') {
    if (authSymlinkStatus === 'real-file') {
      // 备份后重建
      const backup = `${authLinkPath}.pre-farm-${Date.now()}`
      try { await fsp.rename(authLinkPath, backup); logger.warn?.(`[codexHomeSymlinkFarm] backed up real auth.json to ${backup}`) } catch {}
    } else if (authSymlinkStatus === 'wrong-target' || authSymlinkStatus === 'dangling') {
      try { await fsp.unlink(authLinkPath) } catch {}
    }
    const r = await repointActiveAuthSymlink(active, { logger })
    if (r.ok) {
      repaired.push(`auth:repointed-to-${active}`)
      authSymlinkStatus = 'symlink-ok'
    }
  } else if (!active) {
    authSymlinkStatus = 'no-active'
  }

  return { ok: true, homeStatus, authSymlinkStatus, repaired }
}

// ---------- 内部 ----------

/**
 * 递归把 src 合并到 dst：
 *  - dst 已存在的文件 → 比较 mtime，较新者保留
 *  - dst 不存在的文件/目录 → 直接复制（src 不动）
 *  - skipAuthJson=true 时跳过顶层 auth.json（由账户机制管理）
 */
async function mergeDirNewerWins(srcDir, dstDir, opts = {}) {
  // V1.7.1.1 P1：skipAuthJson 改为只匹配最顶层 srcDir/auth.json，递归子目录默认 false
  const { logger, merged } = opts
  const topLevelSkipAuth = opts.skipAuthJson === true
  let entries
  try { entries = await fsp.readdir(srcDir, { withFileTypes: true }) } catch { return }
  for (const ent of entries) {
    if (topLevelSkipAuth && ent.name === 'auth.json') continue
    const src = path.join(srcDir, ent.name)
    const dst = path.join(dstDir, ent.name)
    try {
      if (ent.isDirectory()) {
        await fsp.mkdir(dst, { recursive: true })
        await mergeDirNewerWins(src, dst, { ...opts, skipAuthJson: false })
      } else if (ent.isFile()) {
        let dstStat = null
        try { dstStat = await fsp.stat(dst) } catch {}
        const srcStat = await fsp.stat(src)
        if (!dstStat || srcStat.mtimeMs > dstStat.mtimeMs) {
          try {
            await fsp.copyFile(src, dst)
            merged?.push(path.relative(srcDir, src))
          } catch (err) {
            // V1.7.1.1 P1：dst 已存在且 readonly（如 git pack 0444）+ size 相同 → 静默 skip 不 warn
            if (err.code === 'EACCES' && dstStat && dstStat.size === srcStat.size) {
              continue
            }
            // 其他 copy 错误才打 warn
            logger?.warn?.(`[codexHomeSymlinkFarm] merge ${src} failed: ${err.message}`)
          }
        }
      } else if (ent.isSymbolicLink()) {
        // V1.7.1.1 P1：dst 已是 symlink 但 target 不同 → 按 src lstat mtime 判定是否更新
        if (!fs.existsSync(dst)) {
          const linkTarget = await fsp.readlink(src)
          await fsp.symlink(linkTarget, dst)
        } else {
          try {
            const dstLst = await fsp.lstat(dst)
            const srcLst = await fsp.lstat(src)
            if (dstLst.isSymbolicLink() && srcLst.mtimeMs > dstLst.mtimeMs) {
              const linkTarget = await fsp.readlink(src)
              await fsp.unlink(dst)
              await fsp.symlink(linkTarget, dst)
            }
          } catch { /* 保留旧 symlink */ }
        }
      }
    } catch (err) {
      logger?.warn?.(`[codexHomeSymlinkFarm] merge ${src} failed: ${err.message}`)
    }
  }
}

module.exports = {
  installHomeSymlinkFarm,
  repointActiveAuthSymlink,
  verifyHomeSymlinkFarm,
  // 测试 helper
  __INTERNAL__: {
    mergeDirNewerWins,
  },
}
