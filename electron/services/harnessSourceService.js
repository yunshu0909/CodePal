/**
 * 源码 checkout 服务
 *
 * 为什么单独成文件：harnessLifecycleService 已经承担「托管安装生命周期 + 进程/launchd 监管」
 * 两类职责，源码目录的 git 语义（拉取、构建、回滚）是第三类，混进去只会让改一处炸三处。
 *
 * 职责：
 * - 读源码目录的 git 状态（分支、提交、有无未提交改动、落后远端几个提交）
 * - 执行更新：fetch → ff-only merge → 依赖变了才 install → build，失败自动回滚
 *
 * 安全取向：
 * - **有未提交改动就拒绝更新**，绝不动用户的本地改动
 * - 失败时回到更新前的提交（更新开始前已确认工作区干净，所以 reset --hard 不会丢东西）
 *
 * @module electron/services/harnessSourceService
 */

const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')
const { promisify } = require('util')

const execFileAsync = promisify(execFile)

/** git 网络类命令超时。 */
const GIT_TIMEOUT = 120_000
/** 依赖安装超时（monorepo 首次安装可能很久）。 */
const INSTALL_TIMEOUT = 900_000
/** 构建超时。 */
const BUILD_TIMEOUT = 900_000

function codedError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

/**
 * 默认执行器：把非零退出码也当成结果返回，便于按码分支；不向调用方抛。
 * @param {string} binary
 * @param {string[]} args
 * @param {object} [options]
 * @returns {Promise<{stdout:string,stderr:string,exitCode:number}>}
 */
async function defaultRun(binary, args, options = {}) {
  try {
    const result = await execFileAsync(binary, args, {
      cwd: options.cwd,
      timeout: options.timeout || GIT_TIMEOUT,
      maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
      encoding: 'utf8',
      shell: false,
      env: options.env,
    })
    return { stdout: result.stdout || '', stderr: result.stderr || '', exitCode: 0 }
  } catch (error) {
    return {
      stdout: error?.stdout || '',
      stderr: error?.stderr || error?.message || '',
      exitCode: typeof error?.code === 'number' ? error.code : 1,
    }
  }
}

/**
 * 统一执行入口：同时兼容「注入的执行器抛异常」与「返回带 exitCode 的结果」两种约定。
 * @param {object} deps
 * @param {string} binary
 * @param {string[]} args
 * @param {object} [options]
 * @returns {Promise<{ok:boolean,stdout:string,stderr:string,exitCode:number}>}
 */
async function run(deps, binary, args, options = {}) {
  const runner = deps.runCommand || defaultRun
  try {
    const result = await runner(binary, args, options)
    const exitCode = typeof result?.exitCode === 'number' ? result.exitCode : 0
    return { ok: exitCode === 0, stdout: String(result?.stdout || ''), stderr: String(result?.stderr || ''), exitCode }
  } catch (error) {
    return {
      ok: false,
      stdout: String(error?.stdout || ''),
      stderr: String(error?.stderr || error?.message || ''),
      exitCode: typeof error?.code === 'number' ? error.code : 1,
    }
  }
}

/** 目录是否是 git 工作区。 */
async function isGitRepo(dir, deps = {}) {
  if (!dir) return false
  const stat = await (deps.statFn || fs.stat)(path.join(dir, '.git')).catch(() => null)
  return Boolean(stat)
}

/** 解析 pnpm 可执行文件；源码版构建必须用它。 */
async function resolvePnpm(deps = {}) {
  if (deps.pnpmBin) return deps.pnpmBin
  const candidates = [path.join(os.homedir(), '.local/bin/pnpm'), '/opt/homebrew/bin/pnpm', '/usr/local/bin/pnpm']
  for (const candidate of candidates) {
    const stat = await (deps.statFn || fs.stat)(candidate).catch(() => null)
    if (stat) return candidate
  }
  // 最后问一次登录 shell（nvm / volta 之类）
  const shell = process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/zsh'
  const probe = await run(deps, shell, ['-lc', 'command -v pnpm'], { timeout: 10_000 })
  const resolved = probe.stdout.trim().split('\n')[0]
  return probe.ok && resolved && path.isAbsolute(resolved) ? resolved : null
}

/**
 * 解析「拿什么跟本地比」。
 *
 * 回退链：显式 upstream → origin/<同名分支> → origin/HEAD（远端默认分支）。
 * 前两种是同一线可比、可 ff-only 合并；第三种只是参考信息（本地分支在远端
 * 没有对应分支时，把默认分支合进来是另一回事，不能算更新）。
 * @returns {Promise<{ref:string|null,source:'tracking'|'same-name'|'default-branch'|null}>}
 */
async function resolveUpstream(dir, branch, deps) {
  const explicit = await run(deps, 'git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: dir })
  if (explicit.ok && explicit.stdout.trim()) return { ref: explicit.stdout.trim(), source: 'tracking' }

  if (branch) {
    const same = await run(deps, 'git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { cwd: dir })
    if (same.ok) return { ref: `origin/${branch}`, source: 'same-name' }
  }

  const head = await run(deps, 'git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: dir })
  if (head.ok && head.stdout.trim()) return { ref: head.stdout.trim(), source: 'default-branch' }
  return { ref: null, source: null }
}

/**
 * 读源码目录的 git 状态。behind 需要一次 fetch，失败时留 null（未知）而不是报错。
 * @param {object} params
 * @param {object} [deps]
 * @returns {Promise<object>}
 */
async function readSourceState(params = {}, deps = {}) {
  const dir = params.sourceDir || deps.sourceDir
  if (!(await isGitRepo(dir, deps))) return { isRepo: false, dir: dir || null }

  const branch = (await run(deps, 'git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })).stdout.trim() || null
  const commit = (await run(deps, 'git', ['rev-parse', '--short', 'HEAD'], { cwd: dir })).stdout.trim() || null
  // 只把「已跟踪文件的修改」算脏：未跟踪文件（构建产物、node_modules、草稿）不会与
  // ff-only 合并冲突，把它们算脏会让构建过一次的仓库永远无法更新。
  // 真的路径撞车时 git 自己会拒绝合并，我们按合并失败处理。
  const statusOut = (await run(deps, 'git', ['status', '--porcelain'], { cwd: dir })).stdout
  const statusLines = statusOut.split('\n').filter((line) => line.trim() !== '')
  const untracked = statusLines.filter((line) => line.startsWith('??')).length
  const dirty = statusLines.length - untracked

  const { ref: upstream, source: upstreamSource } = await resolveUpstream(dir, branch, deps)
  // 只有「同一线」的远端引用才谈更新；默认分支只是参考
  const updatable = upstreamSource === 'tracking' || upstreamSource === 'same-name'

  let behind = null
  let ahead = null
  let fetched = false
  if (upstream) {
    const fetch = await run(deps, 'git', ['fetch', '--quiet', '--prune'], { cwd: dir, timeout: 60_000 })
    fetched = fetch.ok
    const counts = await run(deps, 'git', ['rev-list', '--left-right', '--count', `HEAD...${upstream}`], { cwd: dir })
    if (counts.ok) {
      const [aheadCount, behindCount] = counts.stdout.trim().split(/\s+/).map(Number)
      ahead = Number.isFinite(aheadCount) ? aheadCount : null
      behind = Number.isFinite(behindCount) ? behindCount : null
    }
  }

  return { isRepo: true, dir, branch, commit, dirty, untracked, upstream, upstreamSource, updatable, behind, ahead, fetched }
}

/** 列出两个提交之间变化的文件。 */
async function changedFiles(from, to, dir, deps) {
  const result = await run(deps, 'git', ['diff', '--name-only', from, to], { cwd: dir })
  return result.ok ? result.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : []
}

/** 更新失败后的恢复：先退回可能的合并中状态，再硬回到更新前的提交。 */
async function recover(dir, commit, deps) {
  await run(deps, 'git', ['merge', '--abort'], { cwd: dir })
  await run(deps, 'git', ['reset', '--hard', commit], { cwd: dir })
}

/**
 * 更新源码版：fetch → ff-only 合并 → 依赖变了才装 → 构建。
 *
 * 有未提交改动直接拒绝（不动用户的活），失败回滚到更新前的提交。
 * @param {object} params
 * @param {object} [deps]
 * @returns {Promise<{changed:boolean,before:string|null,after:string|null,steps:string[]}>}
 */
async function updateSource(params = {}, deps = {}) {
  const dir = params.sourceDir || deps.sourceDir
  const state = await readSourceState({ sourceDir: dir }, deps)
  if (!state.isRepo) throw codedError('SOURCE_NOT_A_REPO')
  if (state.dirty > 0) throw codedError('SOURCE_DIRTY')
  if (!state.upstream) throw codedError('SOURCE_NO_UPSTREAM')
  // 本地分支在远端没有对应分支（例如本地 release 分支）：把默认分支合进来不是「更新」
  if (!state.updatable) throw codedError('SOURCE_BRANCH_NOT_TRACKED')

  const before = state.commit
  const steps = []
  try {
    const fetch = await run(deps, 'git', ['fetch', '--prune'], { cwd: dir, timeout: GIT_TIMEOUT })
    if (!fetch.ok) throw codedError('SOURCE_FETCH_FAILED')

    const merge = await run(deps, 'git', ['merge', '--ff-only', state.upstream], { cwd: dir, timeout: GIT_TIMEOUT })
    if (!merge.ok) throw codedError('SOURCE_PULL_FAILED')
    steps.push('pull')

    // 依赖清单变了才装：无脑 install 会让「点一下更新」变成几分钟的等待
    const changed = await changedFiles(before, 'HEAD', dir, deps)
    const dependencyChanged = changed.some((file) => file === 'pnpm-lock.yaml' || file.endsWith('/package.json') || file === 'package.json')
    const pnpm = await resolvePnpm(deps)
    if (dependencyChanged) {
      if (!pnpm) throw codedError('SOURCE_PNPM_MISSING')
      const install = await run(deps, pnpm, ['install', '--frozen-lockfile'], { cwd: dir, timeout: INSTALL_TIMEOUT })
      if (!install.ok) throw codedError('SOURCE_INSTALL_FAILED')
      steps.push('install')
    }

    // 构建总是跑：源码模式虽然用 tsx 直跑服务端，但客户端 bundle 走的是已构建产物，
    // 不重建会出现「服务端新、浏览器旧」的错配。
    if (!pnpm) throw codedError('SOURCE_PNPM_MISSING')
    const build = await run(deps, pnpm, ['run', 'build'], { cwd: dir, timeout: BUILD_TIMEOUT })
    if (!build.ok) throw codedError('SOURCE_BUILD_FAILED')
    steps.push('build')
  } catch (error) {
    await recover(dir, before, deps)
    throw error?.code ? error : codedError('SOURCE_UPDATE_FAILED')
  }

  const after = (await run(deps, 'git', ['rev-parse', '--short', 'HEAD'], { cwd: dir })).stdout.trim() || null
  return { changed: true, before, after, steps }
}

module.exports = {
  resolveUpstream,
  GIT_TIMEOUT,
  INSTALL_TIMEOUT,
  BUILD_TIMEOUT,
  codedError,
  defaultRun,
  run,
  isGitRepo,
  resolvePnpm,
  readSourceState,
  updateSource,
}
