/**
 * V1.7 测试地基（M0）
 *
 * 提供：
 * - 每个用例独立的隔离 root：/tmp/codepal-test-<ts>-<rnd>/
 *   - <root>/.codex/                  ← 模拟 V1.6 legacy ~/.codex
 *   - <root>/.codex-switcher/         ← V1.7 主目录（含 shared/accounts/active.json）
 * - 通过 CODEX_SWITCHER_HOME 环境变量注入到 codexAccountService.getStoreDir() 等
 * - mock codex 二进制（记录 spawn env 到 <root>/codex-spawn-log.json）
 * - 标准 fixture 构造器（V1.6 旧目录 / V1.7 staging / V1.7 完整结构）
 *
 * 设计约束：
 * - 测试代码绝不打印 token 真值，敏感字段一律占位（fake-rt-xxx / fake-acct-xxx / fake JWT）
 * - 真 Key 通过环境变量 TEST_CODEX_REFRESH_TOKEN 注入，仅模块 C/E 使用
 * - 每个用例 afterEach 清理 root，runner 退出兜底
 *
 * @module 自动化测试/V1.7/setup/testEnv
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')

const TMP_BASE = os.tmpdir()
const PREFIX = 'codepal-test-'

/**
 * 创建新的隔离 root，返回路径集 + CODEX_SWITCHER_HOME 注入器
 * @returns {{
 *   root: string,
 *   codexDir: string,           // <root>/.codex
 *   switcherDir: string,         // <root>/.codex-switcher
 *   sharedCodexDir: string,      // <root>/.codex-switcher/shared/.codex
 *   accountsDir: string,         // <root>/.codex-switcher/accounts
 *   activeJsonFile: string,      // <root>/.codex-switcher/active.json
 *   accountHomeDir: (name: string) => string,
 *   apply: () => () => void,     // 调用返回 restore 函数
 *   cleanup: () => Promise<void>
 * }}
 */
function makeIsolatedRoot() {
  const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  const root = path.join(TMP_BASE, `${PREFIX}${id}`)
  const codexDir = path.join(root, '.codex')
  const switcherDir = path.join(root, '.codex-switcher')
  const sharedCodexDir = path.join(switcherDir, 'shared', '.codex')
  const accountsDir = path.join(switcherDir, 'accounts')
  const activeJsonFile = path.join(switcherDir, 'active.json')

  fs.mkdirSync(root, { recursive: true })

  return {
    root,
    codexDir,
    switcherDir,
    sharedCodexDir,
    accountsDir,
    activeJsonFile,
    accountHomeDir: (name) => path.join(accountsDir, name, '.codex'),
    apply() {
      const prev = process.env.CODEX_SWITCHER_HOME
      process.env.CODEX_SWITCHER_HOME = switcherDir
      return () => {
        if (prev === undefined) delete process.env.CODEX_SWITCHER_HOME
        else process.env.CODEX_SWITCHER_HOME = prev
      }
    },
    async cleanup() {
      try { await fsp.rm(root, { recursive: true, force: true }) } catch {}
    },
  }
}

/**
 * 构造 V1.6 legacy 目录结构（用于迁移测试）
 * - <root>/.codex/auth.json
 * - <root>/.codex-switcher/accounts/{name}.json + current
 *
 * @param {ReturnType<makeIsolatedRoot>} env
 * @param {{
 *   liveAuth?: object | null,
 *   slots?: Array<{ name: string, auth: object }>,
 *   current?: string,
 *   shared?: { configToml?: string, skills?: Array<{ name: string }>, mcp?: object }
 * }} spec
 */
async function buildLegacyV16(env, spec = {}) {
  await fsp.mkdir(env.codexDir, { recursive: true })
  if (spec.liveAuth !== null && spec.liveAuth !== undefined) {
    await fsp.writeFile(
      path.join(env.codexDir, 'auth.json'),
      JSON.stringify(spec.liveAuth, null, 2),
      'utf8',
    )
  }
  if (spec.shared?.configToml !== undefined) {
    await fsp.writeFile(path.join(env.codexDir, 'config.toml'), spec.shared.configToml, 'utf8')
  }
  if (Array.isArray(spec.shared?.skills)) {
    const skillsDir = path.join(env.codexDir, 'skills')
    await fsp.mkdir(skillsDir, { recursive: true })
    for (const s of spec.shared.skills) {
      const dir = path.join(skillsDir, s.name)
      await fsp.mkdir(dir, { recursive: true })
      await fsp.writeFile(
        path.join(dir, 'SKILL.md'),
        `# ${s.name}\nfixture skill\n`,
        'utf8',
      )
    }
  }
  if (spec.shared?.mcp) {
    await fsp.writeFile(
      path.join(env.codexDir, 'mcp_config.json'),
      JSON.stringify(spec.shared.mcp, null, 2),
      'utf8',
    )
  }

  await fsp.mkdir(path.join(env.switcherDir, 'accounts'), { recursive: true })
  for (const slot of spec.slots ?? []) {
    await fsp.writeFile(
      path.join(env.switcherDir, 'accounts', `${slot.name}.json`),
      JSON.stringify(slot.auth, null, 2),
      'utf8',
    )
  }
  if (spec.current) {
    await fsp.writeFile(path.join(env.switcherDir, 'current'), spec.current, 'utf8')
  }
}

/**
 * 构造 V1.7 完整目录结构（用于切换/调度等测试，跳过迁移）
 *
 * @param {ReturnType<makeIsolatedRoot>} env
 * @param {{
 *   shared?: { configToml?: string, hasSkillsDir?: boolean, hasSessionsDir?: boolean, hasLogsDir?: boolean, mcp?: object | null },
 *   accounts?: Array<{
 *     name: string,
 *     auth: object,
 *     state?: { status: 'active' | 'paused' | 'invalid', permanentReason?: string, lastForceRefreshAt?: number },
 *     skipSymlinks?: Array<'config.toml' | 'skills' | 'sessions' | 'logs' | 'mcp_config.json'>,
 *   }>,
 *   active?: string | null,
 *   migratedAt?: string,
 * }} spec
 */
async function buildV17(env, spec = {}) {
  await fsp.mkdir(env.sharedCodexDir, { recursive: true })
  if (spec.shared?.configToml !== undefined) {
    await fsp.writeFile(path.join(env.sharedCodexDir, 'config.toml'), spec.shared.configToml, 'utf8')
  }
  if (spec.shared?.hasSkillsDir !== false) {
    await fsp.mkdir(path.join(env.sharedCodexDir, 'skills'), { recursive: true })
  }
  if (spec.shared?.hasSessionsDir !== false) {
    await fsp.mkdir(path.join(env.sharedCodexDir, 'sessions'), { recursive: true })
  }
  if (spec.shared?.hasLogsDir !== false) {
    await fsp.mkdir(path.join(env.sharedCodexDir, 'logs'), { recursive: true })
  }
  if (spec.shared?.mcp) {
    await fsp.writeFile(
      path.join(env.sharedCodexDir, 'mcp_config.json'),
      JSON.stringify(spec.shared.mcp, null, 2),
      'utf8',
    )
  }

  for (const acc of spec.accounts ?? []) {
    const home = env.accountHomeDir(acc.name)
    await fsp.mkdir(home, { recursive: true })
    await fsp.writeFile(
      path.join(home, 'auth.json'),
      JSON.stringify(acc.auth, null, 2),
      'utf8',
    )
    if (acc.state) {
      await fsp.writeFile(
        path.join(home, 'state.json'),
        JSON.stringify(acc.state, null, 2),
        'utf8',
      )
    }
    const skipSet = new Set(acc.skipSymlinks ?? [])
    const links = [
      ['config.toml', 'file', spec.shared?.configToml !== undefined],
      ['skills', 'dir', spec.shared?.hasSkillsDir !== false],
      ['sessions', 'dir', spec.shared?.hasSessionsDir !== false],
      ['logs', 'dir', spec.shared?.hasLogsDir !== false],
      ['mcp_config.json', 'file', !!spec.shared?.mcp],
    ]
    for (const [name, kind, targetExists] of links) {
      if (skipSet.has(name)) continue
      const isMandatory = kind === 'dir'
      if (!targetExists && !isMandatory) continue
      const linkPath = path.join(home, name)
      const target = path.posix.join('..', '..', '..', 'shared', '.codex', name)
      try { await fsp.symlink(target, linkPath) } catch (err) {
        if (err.code !== 'EEXIST') throw err
      }
    }
  }

  if (spec.active !== undefined) {
    await fsp.writeFile(
      env.activeJsonFile,
      JSON.stringify({
        currentAccount: spec.active,
        version: 'v1.7',
        migratedAt: spec.migratedAt || new Date().toISOString(),
      }, null, 2),
      'utf8',
    )
  }
}

/**
 * 生成假 JWT（仅供测试断言 iat 用，不打真 OpenAI）
 * @param {{ iatSecondsAgo?: number, accountId?: string, email?: string }} opts
 * @returns {string} fake JWT string
 */
function makeFakeJwt(opts = {}) {
  const now = Math.floor(Date.now() / 1000)
  const iat = now - (opts.iatSecondsAgo ?? 60)
  const header = { alg: 'RS256', typ: 'JWT', kid: 'fake-kid' }
  const payload = {
    iat,
    exp: iat + 1800,
    iss: 'https://auth.openai.com',
    aud: 'codex-cli-fake',
    sub: opts.accountId ?? 'fake-acct-0001',
    email: opts.email ?? 'fake@example.com',
    'https://api.openai.com/auth': {
      chatgpt_account_id: opts.accountId ?? 'fake-acct-0001',
      chatgpt_plan_type: opts.plan ?? 'plus',
    },
  }
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64(header)}.${b64(payload)}.fake-signature`
}

/**
 * 构造一个 fake auth.json（无真实 token）
 *
 * @param {{
 *   accountId?: string,
 *   email?: string,
 *   plan?: string,
 *   refreshToken?: string,
 *   iatSecondsAgo?: number,
 *   lastRefresh?: string,
 * }} opts
 * @returns {object}
 */
function makeFakeAuth(opts = {}) {
  const iatSecondsAgo = opts.iatSecondsAgo ?? 60
  return {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: makeFakeJwt({
        iatSecondsAgo,
        accountId: opts.accountId,
        email: opts.email,
        plan: opts.plan,
      }),
      access_token: makeFakeJwt({
        iatSecondsAgo,
        accountId: opts.accountId,
        email: opts.email,
        plan: opts.plan,
      }),
      refresh_token: opts.refreshToken ?? `fake-rt-${crypto.randomBytes(4).toString('hex')}`,
      account_id: opts.accountId ?? 'fake-acct-0001',
    },
    // V1.7.1：last_refresh 应当跟 iat 同步（同一次铸票事件的两个表达）
    // 之前默认 new Date() 让 last_refresh 永远是"现在"，污染 codexStatusJudge 取最新证据的判定
    last_refresh: opts.lastRefresh ?? new Date(Date.now() - iatSecondsAgo * 1000).toISOString(),
  }
}

/**
 * 装一个 mock codex 二进制（bash 脚本）到 <root>/mock-bin/codex
 * 调用时把所有 env 写入 <root>/codex-spawn-log.json
 * 返回 spawn 时应当传入的 PATH 前缀
 *
 * @param {ReturnType<makeIsolatedRoot>} env
 * @param {{ exit?: number, stdout?: string, stderr?: string }} opts
 * @returns {Promise<{ mockBinDir: string, logFile: string, prependPath: string }>}
 */
async function installMockCodex(env, opts = {}) {
  const mockBinDir = path.join(env.root, 'mock-bin')
  const logFile = path.join(env.root, 'codex-spawn-log.json')
  await fsp.mkdir(mockBinDir, { recursive: true })
  const exitCode = opts.exit ?? 0
  const stdout = opts.stdout ?? ''
  const stderr = opts.stderr ?? ''
  const script = `#!/usr/bin/env bash
# mock codex (V1.7 testEnv)
LOG="${logFile}"
ARGS=$(printf '%s\\n' "$@" | python3 -c 'import json,sys; print(json.dumps([l.rstrip("\\n") for l in sys.stdin]))' 2>/dev/null || echo "[]")
cat > "$LOG" <<EOF
{"CODEX_HOME": "\${CODEX_HOME:-}", "PWD": "$PWD", "args_json": $ARGS}
EOF
${stdout ? `printf '%s' ${JSON.stringify(stdout)}` : ''}
${stderr ? `printf '%s' ${JSON.stringify(stderr)} >&2` : ''}
exit ${exitCode}
`
  const scriptPath = path.join(mockBinDir, 'codex')
  await fsp.writeFile(scriptPath, script, 'utf8')
  await fsp.chmod(scriptPath, 0o755)
  return {
    mockBinDir,
    logFile,
    prependPath: `${mockBinDir}${path.delimiter}${process.env.PATH ?? ''}`,
  }
}

/**
 * 清理 /tmp 下所有过期 codepal-test-* 目录（保险兜底）
 * 默认清 1 小时前的（avoid 干扰其他正在跑的测试 runner）
 *
 * @param {{ olderThanMs?: number }} opts
 */
async function purgeStaleRoots(opts = {}) {
  const threshold = Date.now() - (opts.olderThanMs ?? 3600_000)
  let entries
  try { entries = await fsp.readdir(TMP_BASE) } catch { return }
  await Promise.all(entries
    .filter((name) => name.startsWith(PREFIX))
    .map(async (name) => {
      const full = path.join(TMP_BASE, name)
      try {
        const st = await fsp.stat(full)
        if (st.mtimeMs < threshold) {
          await fsp.rm(full, { recursive: true, force: true })
        }
      } catch {}
    }))
}

module.exports = {
  makeIsolatedRoot,
  buildLegacyV16,
  buildV17,
  makeFakeAuth,
  makeFakeJwt,
  installMockCodex,
  purgeStaleRoots,
  TMP_BASE,
  PREFIX,
}
