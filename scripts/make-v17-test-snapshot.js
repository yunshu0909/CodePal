#!/usr/bin/env node
/**
 * V1.7 测试快照生成器
 *
 * 用途：为 TC-100（V1.6→V1.7 完整迁移演练）准备脱敏 fixture。
 * - 默认生成 10 个 fake 账号副本（account_id = fake-acct-{i}、refresh_token = fake-rt-snap-{i}、access_token = fake JWT）
 * - 真 refresh_token 只通过 TEST_CODEX_REFRESH_TOKEN 环境变量为 **唯一 1 个**账号注入（默认槽 0），其他保持脱敏
 * - 真 token 绝不写入仓库；脚本本身只读 env，不打印 token 真值
 *
 * 用法：
 *   node scripts/make-v17-test-snapshot.js --out /tmp/codepal-test-snapshot/ [--count 10] [--inject-real-into 0]
 *
 * 输出目录结构（V1.6 旧布局，给 codexMigrator 演练）：
 *   <out>/.codex/auth.json                     ← live（默认与 slot 0 同 account_id，演示"匹配 slot 用 live 覆盖"）
 *   <out>/.codex/config.toml
 *   <out>/.codex/skills/demo-skill/SKILL.md
 *   <out>/.codex-switcher/current
 *   <out>/.codex-switcher/accounts/snap-{i}.json
 *
 * 设计依据：
 * - PRD-V1.7 测试用例 TC-100 前置条件
 * - 安全约束（CLAUDE.md）：不输出 token / refresh_token / 任何敏感真值
 *
 * @module scripts/make-v17-test-snapshot
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')

const args = parseArgs(process.argv.slice(2))
const outRoot = path.resolve(args.out)
const count = Number.isFinite(+args.count) ? +args.count : 10
const injectIdx = Number.isFinite(+args['inject-real-into']) ? +args['inject-real-into'] : 0
const realToken = process.env.TEST_CODEX_REFRESH_TOKEN || ''
const includeMcp = args.mcp === 'true' || args.mcp === '1'

main().catch((err) => {
  console.error('snapshot failed:', err.message)
  process.exit(1)
})

async function main() {
  if (count < 1 || count > 100) throw new Error(`count out of range (1-100): ${count}`)
  if (injectIdx < 0 || injectIdx >= count) throw new Error(`inject-real-into out of range (0-${count - 1}): ${injectIdx}`)

  if (fs.existsSync(outRoot)) {
    if (!args.force) throw new Error(`output exists, pass --force to overwrite: ${outRoot}`)
    await fsp.rm(outRoot, { recursive: true, force: true })
  }
  await fsp.mkdir(outRoot, { recursive: true })

  const codexDir = path.join(outRoot, '.codex')
  const switcherAccounts = path.join(outRoot, '.codex-switcher', 'accounts')
  await fsp.mkdir(codexDir, { recursive: true })
  await fsp.mkdir(switcherAccounts, { recursive: true })

  // shared 非 auth 资产
  await fsp.writeFile(path.join(codexDir, 'config.toml'), '[profile]\nmodel = "gpt-5-mini"\n')
  const demoSkill = path.join(codexDir, 'skills', 'demo-skill')
  await fsp.mkdir(demoSkill, { recursive: true })
  await fsp.writeFile(
    path.join(demoSkill, 'SKILL.md'),
    '---\nname: demo-skill\ndescription: snapshot fixture\n---\n# demo\n',
  )
  if (includeMcp) {
    await fsp.writeFile(path.join(codexDir, 'mcp_config.json'), JSON.stringify({ servers: {} }, null, 2))
  }

  // 副本 + live auth
  const liveSlotIdx = 0 // live ~/.codex/auth.json 与 slot 0 同 account_id（演示 P0-1 "live 覆盖 slot"）
  const slots = []
  for (let i = 0; i < count; i += 1) {
    const accountId = `fake-acct-${String(i).padStart(4, '0')}`
    const email = `snap-${i}@example.test`
    const slotName = `snap-${i}`
    const slotRefreshToken = `fake-rt-snap-${i}` // 副本里的"旧票"
    const auth = buildFakeAuth({ accountId, email, refreshToken: slotRefreshToken, iatSecondsAgo: 86400 + i * 60 })
    await fsp.writeFile(path.join(switcherAccounts, `${slotName}.json`), JSON.stringify(auth, null, 2))
    slots.push({ idx: i, slotName, accountId, email })
  }
  await fsp.writeFile(path.join(outRoot, '.codex-switcher', 'current'), slots[liveSlotIdx].slotName)

  // live ~/.codex/auth.json：和 slot 0 同 account_id，但 refresh_token 不同（"live-rt-new"），用来演示覆盖语义
  // 若 injectIdx===0 且 env 提供真 token，则把真 token 写入 live（演示真 Key 路径）
  const liveAccountId = slots[liveSlotIdx].accountId
  const liveEmail = slots[liveSlotIdx].email
  let liveRefreshToken = 'fake-rt-live-new'
  let liveUsesRealToken = false
  if (injectIdx === liveSlotIdx && realToken) {
    liveRefreshToken = realToken
    liveUsesRealToken = true
  }
  const liveAuth = buildFakeAuth({
    accountId: liveAccountId,
    email: liveEmail,
    refreshToken: liveRefreshToken,
    iatSecondsAgo: 1800, // live 是最新的，1800s 之前
  })
  await fsp.writeFile(path.join(codexDir, 'auth.json'), JSON.stringify(liveAuth, null, 2))

  // 若 inject 落在非 0 槽，把真 token 单独写入该槽 auth.json
  if (realToken && injectIdx !== liveSlotIdx) {
    const target = slots[injectIdx]
    const realAuth = buildFakeAuth({
      accountId: target.accountId,
      email: target.email,
      refreshToken: realToken,
      iatSecondsAgo: 600,
    })
    await fsp.writeFile(path.join(switcherAccounts, `${target.slotName}.json`), JSON.stringify(realAuth, null, 2))
    liveUsesRealToken = true
  }

  // README（人话说明，不含 token）
  const readme = [
    '# V1.7 测试快照',
    '',
    '由 scripts/make-v17-test-snapshot.js 生成，仅供 TC-100 等迁移演练用。',
    '',
    `- 副本数：${count}`,
    `- live auth 槽位：snap-${liveSlotIdx}（与 slot 0 同 account_id，演示"匹配 slot 用 live 覆盖"）`,
    `- live refresh_token：${liveUsesRealToken ? '【已用 TEST_CODEX_REFRESH_TOKEN 注入真值，不展示】' : 'fake-rt-live-new'}`,
    `- 真 token 来源：${realToken ? '环境变量 TEST_CODEX_REFRESH_TOKEN（已脱敏）' : '未注入（演练只跑 mock 路径）'}`,
    '- 所有 access_token / id_token 均为 fake JWT（fake-signature）',
    '',
    '## 安全约束',
    '',
    '- 真 refresh_token 仅通过 env 注入，绝不写入 git 仓库',
    '- 任何 fixture 文件提交前必须确认 refresh_token 字段以 `fake-` 开头',
    '',
  ].join('\n')
  await fsp.writeFile(path.join(outRoot, 'README.md'), readme)

  // 安全自检：扫一遍所有 auth.json，确认非 inject 路径下 refresh_token 全部以 fake- 开头
  await selfCheckRedaction(outRoot, realToken)

  console.log(`snapshot ready: ${outRoot}`)
  console.log(`  - ${count} fake slots in .codex-switcher/accounts/`)
  console.log(`  - live auth in .codex/auth.json (matches slot ${liveSlotIdx})`)
  if (liveUsesRealToken) {
    console.log('  - real refresh_token injected (env-only, not logged)')
  } else {
    console.log('  - all refresh_token values are fake (fake-rt-* prefix)')
  }
}

function buildFakeAuth({ accountId, email, refreshToken, iatSecondsAgo, plan = 'plus' }) {
  return {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: makeFakeJwt({ iatSecondsAgo, accountId, email, plan }),
      access_token: makeFakeJwt({ iatSecondsAgo, accountId, email, plan }),
      refresh_token: refreshToken,
      account_id: accountId,
    },
    last_refresh: new Date(Date.now() - iatSecondsAgo * 1000).toISOString(),
  }
}

function makeFakeJwt({ iatSecondsAgo, accountId, email, plan }) {
  const now = Math.floor(Date.now() / 1000)
  const iat = now - iatSecondsAgo
  const header = { alg: 'RS256', typ: 'JWT', kid: 'fake-kid' }
  const payload = {
    iat,
    exp: iat + 1800,
    iss: 'https://auth.openai.com',
    aud: 'codex-cli-fake',
    sub: accountId,
    email,
    'https://api.openai.com/auth': {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: plan,
    },
  }
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64(header)}.${b64(payload)}.fake-signature`
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = 'true'
    } else {
      out[key] = next
      i += 1
    }
  }
  if (!out.out) {
    console.error('usage: node scripts/make-v17-test-snapshot.js --out <dir> [--count 10] [--inject-real-into 0] [--mcp true] [--force]')
    process.exit(2)
  }
  return out
}

async function selfCheckRedaction(root, realToken) {
  // 遍历所有 .json，对每个 refresh_token 字段检查：
  // - 若 realToken 已设置，refresh_token 只允许等于 realToken 或以 fake- 开头
  // - 若 realToken 未设置，refresh_token 必须以 fake- 开头
  const violations = []
  await walk(root, async (file) => {
    if (!file.endsWith('.json')) return
    let data
    try { data = JSON.parse(await fsp.readFile(file, 'utf8')) } catch { return }
    const rt = data?.tokens?.refresh_token
    if (typeof rt !== 'string') return
    if (rt.startsWith('fake-')) return
    if (realToken && rt === realToken) return
    violations.push(file.replace(root, ''))
  })
  if (violations.length > 0) {
    throw new Error(
      `redaction self-check failed: ${violations.length} file(s) contain unexpected refresh_token values: ${violations.join(', ')}`,
    )
  }
}

async function walk(dir, visit) {
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  for (const ent of entries) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) await walk(full, visit)
    else if (ent.isFile()) await visit(full)
  }
}
