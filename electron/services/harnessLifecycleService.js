/**
 * DeepSeek Harness（dsh）生命周期领域服务
 *
 * 负责：
 * - 探测 dsh 安装位置与形态（托管 / PATH / 源码 checkout / 系统共享）
 * - 托管式安装、升级、卸载（装进 CodePal 自己的 runtimes 目录，不污染全局 npm）
 * - 拉起与停止 `dsh web` 子进程，解析官方就绪信号拿到可用 URL
 * - 运行状态落盘与探活，Electron 重启后能接管或清理
 *
 * 边界：源码 checkout 本身只读；需要纳管时另装托管运行时并原子切换启动项。
 * 不读 ~/.dsh 内的任何配置或凭证。
 *
 * @module electron/services/harnessLifecycleService
 */

const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const { execFile, spawn } = require('child_process')
const sourceService = require('./harnessSourceService')
const { promisify } = require('util')

const execFileAsync = promisify(execFile)

/** 托管安装目录（相对 home）——CodePal 独占，卸载即整目录删除。 */
const RUNTIME_RELATIVE = path.join('Documents', 'SkillManager', 'runtimes', 'dsh')
/** npm 包名。 */
const PACKAGE_NAME = '@deepseek-ai/dsh'
/** 服务就绪时 stdout 打出的那一行（官方定义的 readiness 信号）。 */
const READY_LINE = /dsh web:\s+(https?:\/\/\S+)/
/** 支持的两个通道。 */
const CHANNELS = Object.freeze({ latest: 'latest', next: 'next' })
/** Node 版本要求（上游根 package.json engines）。 */
const NODE_RANGE_TEXT = '^22.19.0 || >=24.0.0'
/** 停止时等待优雅退出的上限；上游 drain 上限是 5 秒。 */
const STOP_GRACE_MS = 6000
/** 启动就绪等待上限。 */
const START_TIMEOUT_MS = 90_000
/** 安装/升级超时。 */
const INSTALL_TIMEOUT_MS = 300_000
/** 渲染层可见的错误码白名单——绝不放行原始 stderr。 */
const SAFE_ERROR_CODES = new Set([
  'HARNESS_NOT_INSTALLED',
  'HARNESS_NODE_UNSUPPORTED',
  'HARNESS_MANAGED_ONLY',
  'HARNESS_SPAWN_FAILED',
  'HARNESS_START_TIMEOUT',
  'HARNESS_NPM_FAILED',
  'HARNESS_PORT_UNKNOWN',
  'HARNESS_ALREADY_RUNNING',
  'HARNESS_NOT_RUNNING',
  'HARNESS_OP_NOT_ALLOWED',
  'HARNESS_TAKEOVER_VERSION_UNAVAILABLE',
  'HARNESS_TAKEOVER_REQUIRES_STOP',
  'HARNESS_TAKEOVER_FAILED',
  'HARNESS_UNKNOWN_ERROR',
  // 源码目录更新（git 语义）
  'SOURCE_NOT_A_REPO',
  'SOURCE_DIRTY',
  'SOURCE_NO_UPSTREAM',
  'SOURCE_BRANCH_NOT_TRACKED',
  'SOURCE_FETCH_FAILED',
  'SOURCE_PULL_FAILED',
  'SOURCE_INSTALL_FAILED',
  'SOURCE_BUILD_FAILED',
  'SOURCE_PNPM_MISSING',
  'SOURCE_UPDATE_FAILED',
])

/** 已由本服务拉起的子进程句柄（pid → ChildProcess）。 */
const children = new Map()

function codedError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function safeErrorCode(error) {
  if (SAFE_ERROR_CODES.has(error?.code)) return error.code
  return 'HARNESS_UNKNOWN_ERROR'
}

/**
 * 列出机器上所有正在运行的 dsh web 进程。
 *
 * 「谁在跑」和「哪里有 dsh」是两件独立的事：用户可能用 launchd 跑着源码版，
 * 同时 CodePal 目录里躺着一份托管版。只看自己启动的进程会漏报成「没有实例」——
 * 那是个错的显示，会误导用户去点一个注定失败的启动。
 * @param {object} deps
 * @returns {Promise<Array<{pid:number,mode:'source'|'managed',binPath:string|null,command:string}>>}
 */
async function readDshProcesses(deps = {}) {
  const runCommand = deps.runCommand || defaultRunCommand
  let output = ''
  try {
    const result = await runCommand('ps', ['-Ao', 'pid=,command='], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 })
    output = result.stdout || ''
  } catch {
    return []
  }
  const found = []
  for (const line of String(output).split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const command = match[2]
    // 只认跑 web 面的 dsh，排除 headless 之类
    const isSource = /apps[\\/]cli[\\/](?:src[\\/]bin\.ts|lib[\\/]bin\.js)/.test(command)
    const isManaged = new RegExp(`@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\\.js`).test(command)
    if (!isSource && !isManaged) continue
    if (!/\bweb\b/.test(command)) continue
    found.push({
      pid,
      mode: isSource ? 'source' : 'managed',
      binPath: isManaged ? (/[^\s]*@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js/.exec(command) || [null])[0] : null,
      command,
    })
  }
  return found
}

/**
 * 读 launchd 服务的 KeepAlive 开关值（plist 为准，服务解析为兜底）。
 * @param {object} launchd 探测结果
 * @param {object} deps
 * @returns {Promise<boolean>}
 */
async function readLaunchdKeepAlive(launchd, deps = {}) {
  const service = require('./launchdService')
  const uid = deps.uid || process.getuid?.()
  const state = await service.readLaunchdService(
    { homeDir: deps.homeDir, label: launchd.label, uid },
    { runCommand: deps.runCommand || defaultRunCommand, homeDir: deps.homeDir, uid, label: launchd.label },
  ).catch(() => null)
  return state?.keepAlive ?? launchd.keepAlive ?? false
}

/**
 * 从 launchd 的 ProgramArguments 与 WorkingDirectory 反推 dsh 入口的绝对路径。
 *
 * launchd 常见写法是相对路径（配合 WorkingDirectory），所以必须两段一起看。
 * @param {string[]} argv
 * @param {string} workingDirectory
 * @returns {string|null}
 */
function resolveEntryFromArgv(argv, workingDirectory) {
  const args = Array.isArray(argv) ? argv : []
  const index = args.findIndex((item) => /apps[\\/]cli[\\/](?:src[\\/]bin\.ts|lib[\\/]bin\.js)$/.test(item) || /[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/.test(item))
  if (index < 0) return null
  const entry = args[index]
  if (path.isAbsolute(entry)) return entry
  if (!workingDirectory) return null
  return path.join(workingDirectory, entry)
}

/**
 * 从源码版 dsh 的入口文件反推出 checkout 根目录。
 *
 * 这条信息来自持久存在的 launchd plist，所以服务即使已经 bootout、进程表里
 * 什么都没有，CodePal 仍能区分「已安装但已停止」和「未安装」。npm 托管入口
 * 位于 node_modules，不匹配这里的源码目录形状。
 * @param {string|null} entry launchd 的入口文件
 * @param {string|null} workingDirectory launchd 工作目录（用于解析相对入口）
 * @returns {string|null}
 */
function resolveSourceRootFromEntry(entry, workingDirectory = null) {
  if (typeof entry !== 'string' || !entry) return null
  const absolute = path.isAbsolute(entry)
    ? path.normalize(entry)
    : workingDirectory ? path.resolve(workingDirectory, entry) : null
  if (!absolute || !/apps[\\/]cli[\\/](?:src[\\/]bin\.ts|lib[\\/]bin\.js)$/.test(absolute)) return null
  return path.dirname(path.dirname(path.dirname(path.dirname(absolute))))
}

/**
 * 定位现有源码 checkout：显式配置优先，其次读持久化 launchd 入口，最后才看进程。
 * @param {object} params
 * @param {object} deps
 * @param {object|null|undefined} knownLaunchd 已探测的服务；undefined 表示需要在此探测
 * @returns {Promise<string|null>}
 */
async function resolveSourceCheckout(params = {}, deps = {}, knownLaunchd = undefined) {
  const explicit = params.sourceDir || deps.sourceDir || null
  if (explicit) return explicit
  const homeDir = params.homeDir || deps.homeDir || os.homedir()
  const supervise = deps.detectManagedServiceFn || detectManagedService
  const launchd = knownLaunchd === undefined
    ? await supervise({ ...deps, homeDir })
    : knownLaunchd
  const fromService = resolveSourceRootFromEntry(launchd?.entry, launchd?.workingDirectory)
  if (fromService) return fromService
  return detectSourceCheckout({ ...deps, homeDir })
}

/**
 * 探测本机是否已有一个 launchd 服务在托管 dsh。
 *
 * 扫 ~/Library/LaunchAgents 下的 plist，找 ProgramArguments 里带 dsh 入口的那个。
 * 找到就意味着「启停必须走 launchctl」——直接 kill 会被 KeepAlive 拉回来。
 * @param {object} deps
 * @param {string} [deps.homeDir]
 * @param {number} [deps.uid]
 * @returns {Promise<object|null>}
 */
async function detectManagedService(deps = {}) {
  if (process.platform !== 'darwin') return null
  const homeDir = deps.homeDir || os.homedir()
  const uid = deps.uid || process.getuid?.()
  if (!uid) return null
  const dir = path.join(homeDir, 'Library', 'LaunchAgents')
  const readdir = deps.readdir || fs.readdir
  const runCommand = deps.runCommand || defaultRunCommand
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return null
  }
  for (const name of names) {
    if (!name.endsWith('.plist')) continue
    const plistPath = path.join(dir, name)
    let json = null
    try {
      const converted = await runCommand('plutil', ['-convert', 'json', '-o', '-', plistPath], { timeout: 10_000 })
      json = JSON.parse(converted.stdout || '{}')
    } catch {
      continue
    }
    const argv = Array.isArray(json?.ProgramArguments) ? json.ProgramArguments : []
    const entry = resolveEntryFromArgv(argv, json?.WorkingDirectory)
    if (!entry) continue
    const label = typeof json?.Label === 'string' && json.Label ? json.Label : name.replace(/\.plist$/, '')
    const launchd = require('./launchdService')
    const state = await launchd.readLaunchdService({ homeDir, label, uid }, { runCommand, homeDir, uid, label })
    return {
      label,
      plistPath,
      entry,
      workingDirectory: typeof json?.WorkingDirectory === 'string' ? json.WorkingDirectory : null,
      keepAlive: launchd.readPlistKeepAlive(json),
      running: state.running,
      pid: state.pid,
      loaded: state.loaded,
      lastExitCode: state.lastExitCode,
      logPath: typeof json?.StandardOutPath === 'string' ? json.StandardOutPath : null,
    }
  }
  return null
}

/**
 * 解析 `node --version` 输出为可比较的数字段。
 * @param {string} text 例如 `v26.0.0`
 * @returns {{major:number,minor:number,patch:number}|null}
 */
function parseNodeVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text || '').trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/**
 * 判断 Node 版本是否满足 dsh 的 engines 要求。
 * @param {{major:number,minor:number,patch:number}|null} version
 * @returns {boolean}
 */
function nodeSupported(version) {
  if (!version) return false
  if (version.major >= 24) return true
  if (version.major === 22) return version.minor > 19 || (version.minor === 19 && version.patch >= 0)
  return false
}

/**
 * 解析形如 `0.1.5-rc.2` 的版本字符串。
 * @param {string} value
 * @returns {{parts:number[],pre:string[]}|null}
 */
function parseVersion(value) {
  const text = String(value || '').trim()
  if (!/^\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?$/.test(text)) return null
  const [core, pre] = text.split('-')
  return { parts: core.split('.').map(Number), pre: pre ? pre.split('.') : [] }
}

function compareIdentifier(left, right) {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)
  if (leftNumeric && rightNumeric) return Number(left) - Number(right)
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Semver 形状的版本比较，正确处理预发布段。
 *
 * `0.1.5-rc.2` > `0.1.5-rc.1`；`0.1.5-rc.2` < `0.1.5`。无法解析的一侧排前。
 * @param {string} left
 * @param {string} right
 * @returns {number} 负数表示 left 更旧，0 相等，正数表示 left 更新
 */
function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a && !b) return 0
  if (!a) return -1
  if (!b) return 1
  const length = Math.max(a.parts.length, b.parts.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (a.parts[index] || 0) - (b.parts[index] || 0)
    if (difference !== 0) return difference
  }
  // 有预发布段的版本小于同号正式版。
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  const preLength = Math.max(a.pre.length, b.pre.length)
  for (let index = 0; index < preLength; index += 1) {
    if (a.pre[index] === undefined) return -1
    if (b.pre[index] === undefined) return 1
    const difference = compareIdentifier(a.pre[index], b.pre[index])
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * 从一行启动输出里解析可用 URL。
 * @param {string} line
 * @returns {string|null}
 */
function parseReadyUrl(line) {
  const match = READY_LINE.exec(String(line || ''))
  return match ? match[1] : null
}

/**
 * 判断 PID 是否存活。信号 0 只做存在性与权限探测。
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** 托管安装目录绝对路径。 */
function resolveRuntimePath(homeDir) {
  return path.join(homeDir || os.homedir(), RUNTIME_RELATIVE)
}

/** 托管安装的入口文件绝对路径。 */
function resolveManagedBinPath(runtimeDir) {
  return path.join(runtimeDir, 'node_modules', PACKAGE_NAME, 'lib', 'bin.js')
}

/**
 * 解析托管安装当前版本。
 * @param {string} runtimeDir
 * @param {object} deps
 * @param {(file:string,encoding:string)=>Promise<string>} [deps.readFile]
 * @returns {Promise<string|null>}
 */
async function readManagedVersion(runtimeDir, deps = {}) {
  const readFile = deps.readFile || fs.readFile
  const manifestPath = path.join(runtimeDir, 'node_modules', PACKAGE_NAME, 'package.json')
  try {
    const text = await readFile(manifestPath, 'utf8')
    return JSON.parse(text).version || null
  } catch {
    return null
  }
}

/**
 * 从源码 checkout 读取 dsh 版本；只认 name 匹配的 CLI 包。
 * @param {string} sourceDir
 * @param {object} deps
 * @returns {Promise<string|null>}
 */
async function readSourceCheckoutVersion(sourceDir, deps = {}) {
  if (!sourceDir) return null
  const readFile = deps.readFile || fs.readFile
  try {
    const text = await readFile(path.join(sourceDir, 'apps', 'cli', 'package.json'), 'utf8')
    const manifest = JSON.parse(text)
    if (manifest.name !== PACKAGE_NAME) return null
    return manifest.version || null
  } catch {
    return null
  }
}

/**
 * 解析用来跑登录 shell 探测的 shell 路径。
 *
 * 不写死 /bin/bash：用户可能用 zsh/fish，且 `command -v node` 的结果取决于
 * 用户自己的 rc 文件——写死 bash 会漏掉 nvm 之类只在 zsh rc 里配置的 PATH。
 * @returns {string[]} 候选 shell，按优先级排列
 */
function resolveLoginShells() {
  const candidates = []
  if (typeof process.env.SHELL === 'string' && path.isAbsolute(process.env.SHELL)) {
    candidates.push(process.env.SHELL)
  }
  for (const fallback of ['/bin/zsh', '/bin/bash']) {
    if (!candidates.includes(fallback)) candidates.push(fallback)
  }
  return candidates
}

/**
 * 从 `ps` 输出里提炼源码 checkout 候选。
 *
 * 只认命令行里出现 `apps/cli/src/bin.ts` 或 `apps/cli/lib/bin.js` 的 node 进程——
 * 这是从源码跑 dsh 的唯一形态。绝对路径可直接取根；相对路径（launchd 设了
 * WorkingDirectory 时就是这种）必须靠该进程的 cwd 补全，所以带上 pid。
 * @param {string} psOutput
 * @returns {Array<{pid:number|null,root:string|null}>}
 */
function extractCheckoutRoots(psOutput) {
  const entries = []
  const seen = new Set()
  for (const line of String(psOutput || '').split('\n')) {
    const processMatch = /^\s*(\d+)\s+(.*)$/.exec(line)
    const pid = processMatch ? Number(processMatch[1]) : null
    const command = processMatch ? processMatch[2] : line
    const match = /(\S*?)apps\/cli\/(?:src\/bin\.ts|lib\/bin\.js)/.exec(command)
    if (!match) continue
    const prefix = match[1].replace(/\/+$/, '')
    if (prefix.startsWith('/')) {
      if (!seen.has(prefix)) { seen.add(prefix); entries.push({ pid, root: prefix }) }
    } else if (pid !== null && !seen.has(`pid:${pid}`)) {
      seen.add(`pid:${pid}`)
      entries.push({ pid, root: null })
    }
  }
  return entries
}

/**
 * 读取一个进程的工作目录。相对路径形态的源码版只能这样定位。
 * @param {number} pid
 * @param {object} deps
 * @returns {Promise<string|null>}
 */
async function readProcessCwd(pid, deps = {}) {
  if (typeof pid !== 'number' || pid <= 0) return null
  const runCommand = deps.runCommand || defaultRunCommand
  try {
    const result = await runCommand('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 10_000 })
    const line = String(result.stdout || '').split('\n').find((entry) => entry.startsWith('n/'))
    return line ? line.slice(1) : null
  } catch {
    return null
  }
}

/**
 * 探测正在运行的源码版 dsh，返回其 checkout 根目录。
 * @param {object} deps
 * @returns {Promise<string|null>}
 */
async function detectSourceCheckout(deps = {}) {
  const runCommand = deps.runCommand || defaultRunCommand
  let entries
  try {
    const result = await runCommand('ps', ['-Ao', 'pid=,command='], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 })
    entries = extractCheckoutRoots(result.stdout)
  } catch {
    return null
  }
  for (const entry of entries) {
    if (entry.root) return entry.root
    const cwd = await readProcessCwd(entry.pid, deps)
    if (cwd) return cwd
  }
  return null
}

/**
 * 在 PATH 上解析 dsh 可执行文件。
 *
 * 用登录 shell 探测，和 claudeUsageStatusService 同款——GUI 启动的 Electron
 * 继承不到用户 shell 的完整 PATH。
 * @param {object} deps
 * @param {(file:string,args:string[],options:object)=>Promise<object>} [deps.runCommand]
 * @returns {Promise<string|null>}
 */
async function resolveOnPath(deps = {}) {
  const runCommand = deps.runCommand || defaultRunCommand
  if (process.platform === 'win32') return null
  for (const shell of resolveLoginShells()) {
    try {
      const result = await runCommand(shell, ['-lc', 'command -v dsh'], { timeout: 10_000 })
      const resolved = String(result.stdout || '').trim().split('\n')[0]
      if (resolved && path.isAbsolute(resolved)) return resolved
    } catch { /* 试下一个 shell */ }
  }
  return null
}

/**
 * 解析可用的 node 与 npm。二者取同一目录下并存的一对。
 * @param {object} deps
 * @returns {Promise<{nodeBin:string,npmBin:string,version:string|null}|null>}
 */
async function resolveNodeRuntime(deps = {}) {
  const runCommand = deps.runCommand || defaultRunCommand
  const candidates = []
  if (deps.nodeBinFromProcess !== undefined) candidates.push(deps.nodeBinFromProcess)
  if (process.platform !== 'win32') {
    for (const shell of resolveLoginShells()) {
      try {
        const result = await runCommand(shell, ['-lc', 'command -v node'], { timeout: 10_000 })
        const resolved = String(result.stdout || '').trim().split('\n')[0]
        if (resolved) candidates.push(resolved)
      } catch { /* 试下一个 shell */ }
    }
  }
  candidates.push('/opt/homebrew/bin/node', '/usr/local/bin/node')
  for (const nodeBin of candidates) {
    if (!nodeBin) continue
    try {
      const version = (await runCommand(nodeBin, ['--version'], { timeout: 10_000 })).stdout
      const npmBin = path.join(path.dirname(nodeBin), 'npm')
      const npmStat = await (deps.stat || fs.stat)(npmBin).catch(() => null)
      if (npmStat && npmStat.isFile()) {
        return { nodeBin, npmBin, version: String(version || '').trim() }
      }
    } catch { /* 试下一个候选 */ }
  }
  return null
}

async function defaultRunCommand(binary, args, options = {}) {
  const result = await execFileAsync(binary, args, {
    cwd: options.cwd,
    timeout: options.timeout || 30_000,
    maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
    encoding: 'utf8',
    shell: false,
    env: options.env,
  })
  return { stdout: result.stdout || '', stderr: result.stderr || '', exitCode: 0 }
}

/**
 * 读文件尾部（大日志只读尾部，不把整份日志读进内存）。
 * @param {string} filePath
 * @param {object} deps
 * @param {number} [maxBytes]
 * @returns {Promise<string>}
 */
async function readLogTail(filePath, deps = {}, maxBytes = 256 * 1024) {
  const info = await (deps.statFn || fs.stat)(filePath).catch(() => null)
  if (!info || info.size === 0) return ''
  // 测试注入 readFile 时走内存切片
  if (deps.readFile) {
    const text = await deps.readFile(filePath, 'utf8').catch(() => '')
    return typeof text === 'string' ? text.slice(-maxBytes) : ''
  }
  const handle = await fs.open(filePath, 'r').catch(() => null)
  if (!handle) return ''
  try {
    const length = Math.min(info.size, maxBytes)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, Math.max(0, info.size - length))
    return buffer.toString('utf8')
  } catch {
    return ''
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * 找出一个运行中实例的端口与可打开地址。
 *
 * 为什么必须有它：launchd 托管的实例不是 CodePal 拉起的，没有 sidecar 落盘状态，
 * 因此端口无从得知；而「打开界面」非要地址不可。两个权威来源：
 * - **端口**：问内核 —— `lsof` 看该 pid 的 LISTEN 端口，这是唯一不会说谎的来源
 * - **地址**：读守护日志里最后一次就绪行 —— 它带一次性 token，首次访问要用；
 *   只有端口对得上才采用，避免拿到上一次进程的过期 token
 * @param {object} params
 * @param {object} [deps]
 * @returns {Promise<{port:number|null,url:string|null}>}
 */
async function readInstanceEndpoint(params = {}, deps = {}) {
  const runCommand = deps.runCommand || defaultRunCommand
  let port = null

  if (params.pid) {
    const result = await runCommand('lsof', ['-nP', '-a', '-p', String(params.pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { timeout: 10_000 }).catch(() => null)
    const lines = String(result?.stdout || '').split('\n')
    // 优先回环地址，排除 IPv6 形式（同一端口会出现两次）
    const loopback = lines.find((line) => /^n127\.0\.0\.1:\d+$/.test(line))
    const any = loopback || lines.find((line) => /^n[^^]*:\d+$/.test(line))
    if (any) port = Number(any.slice(any.lastIndexOf(':') + 1)) || null
  }

  let url = null
  if (params.logPath) {
    const text = await readLogTail(params.logPath, deps)
    const matches = [...String(text).matchAll(/dsh web:\s+(https?:\/\/\S+)/g)]
    const last = matches.length > 0 ? matches[matches.length - 1][1] : null
    if (last) {
      let lastPort = null
      try { lastPort = Number(new URL(last).port) || null } catch { lastPort = null }
      if (port === null && lastPort !== null) {
        port = lastPort
        url = last
      } else if (lastPort !== null && lastPort === port) {
        url = last
      }
    }
  }

  if (url === null && port !== null) url = `http://127.0.0.1:${port}/`
  return { port, url }
}

/**
 * 读取默认端口上是否已有一个非本服务拉起的 dsh Web 在跑。
 * @param {number} port
 * @param {object} deps
 * @returns {Promise<string|null>} 命中时返回其地址
 */
async function probeExternalInstance(port, deps = {}) {
  const fetchFn = deps.fetchFn || globalThis.fetch
  if (typeof fetchFn !== 'function' || !port) return null
  try {
    const response = await fetchFn(`http://127.0.0.1:${port}/`, { method: 'HEAD', signal: AbortSignal.timeout(1200) })
    return response && response.status ? `http://127.0.0.1:${port}/` : null
  } catch {
    return null
  }
}

/** 主进程注入的状态落盘目录（Electron userData）。 */
let stateDir = null

/**
 * 注入运行状态落盘目录。main.js 在 app ready 后调用一次。
 * @param {string} dir Electron userData 目录
 */
function configureStateDir(dir) {
  stateDir = typeof dir === 'string' && dir ? dir : null
}

/** 运行状态落盘路径；无可用目录时返回 null（状态只存在于内存）。 */
function resolveStateFile(deps = {}) {
  const dir = deps.userDataDir || stateDir
  if (!dir) return null
  return path.join(dir, 'harness-runtime.json')
}

/**
 * 读取并验证落盘的运行状态；进程已死则视为过期。
 * @param {object} deps
 * @param {Map<number, object>} [deps.childrenMap]
 * @returns {Promise<object|null>}
 */
async function readRuntimeState(deps = {}) {
  const stateFile = resolveStateFile(deps)
  if (!stateFile) return null
  const readFile = deps.readFile || fs.readFile
  let parsed
  try {
    parsed = JSON.parse(await readFile(stateFile, 'utf8'))
  } catch {
    return null
  }
  const pid = Number(parsed?.pid)
  if (!Number.isInteger(pid) || pid <= 0) return null
  const owned = (deps.childrenMap || children).has(pid)
  if (!owned && !isProcessAlive(pid)) return null
  return {
    pid,
    port: Number(parsed.port) || null,
    url: typeof parsed.url === 'string' ? parsed.url : null,
    startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : null,
    version: typeof parsed.version === 'string' ? parsed.version : null,
    sourceKind: typeof parsed.sourceKind === 'string' ? parsed.sourceKind : 'managed',
    owned,
  }
}

async function writeRuntimeState(state, deps = {}) {
  const stateFile = resolveStateFile(deps)
  if (!stateFile) return
  const writeFile = deps.writeFile || fs.writeFile
  try {
    await writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 })
  } catch { /* 落盘失败不影响运行 */ }
}

async function clearRuntimeState(deps = {}) {
  const stateFile = resolveStateFile(deps)
  if (!stateFile) return
  const rm = deps.rm || fs.rm
  try {
    await rm(stateFile, { force: true })
  } catch { /* 忽略 */ }
}

/** 读取「退出时是否一并停止 dsh」偏好；默认 true。 */
function getStopOnQuitPreference(deps = {}) {
  return deps.getStopOnQuit ? deps.getStopOnQuit() !== false : true
}

/** 写入「退出时是否一并停止 dsh」偏好。 */
function setStopOnQuitPreference(value, deps = {}) {
  if (deps.setStopOnQuit) deps.setStopOnQuit(value !== false)
  return value !== false
}

/**
 * 读取 npm 上的通道指向与近期版本。失败不抛——探测路径要能容忍 registry 不可达。
 * @param {object} deps
 * @returns {Promise<{latest:string|null,next:string|null,versions:string[],ok:boolean}>}
 */
async function readDistTags(deps = {}) {
  const node = deps.nodeRuntime || await resolveNodeRuntime(deps)
  if (!node) return { latest: null, next: null, versions: [], ok: false }
  try {
    const result = await (deps.runCommand || defaultRunCommand)(node.npmBin, [
      'view', PACKAGE_NAME, 'versions', 'dist-tags', '--json',
    ], { timeout: deps.registryTimeoutMs || 45_000, maxBuffer: 20 * 1024 * 1024 })
    const parsed = JSON.parse(String(result.stdout || '').trim() || '{}')
    const tags = parsed['dist-tags'] || {}
    return {
      latest: tags.latest || null,
      next: tags.next || null,
      versions: (Array.isArray(parsed.versions) ? parsed.versions : []).slice(-12).reverse(),
      ok: true,
    }
  } catch {
    return { latest: null, next: null, versions: [], ok: false }
  }
}

/**
 * 汇总一次完整探测结果——页面的唯一数据源。
 *
 * 升级判定在服务端用同一套 semver 比较算好再回传，渲染层只读结论，
 * 避免两处实现不一致。registry 不可达时 degrade 成「未知」，不影响其余状态。
 * @param {object} [params]
 * @param {object} [deps]
 * @returns {Promise<object>}
 */
async function getHarnessSnapshot(params = {}, deps = {}) {
  const homeDir = params.homeDir || deps.homeDir || os.homedir()
  const runtimeDir = resolveRuntimePath(homeDir)
  const managedBin = resolveManagedBinPath(runtimeDir)
  const sourceMode = { ...deps, homeDir: deps.homeDir || homeDir }
  const node = await resolveNodeRuntime(deps)
  const nodeVersion = parseNodeVersion(node?.version)
  const supported = nodeSupported(nodeVersion)

  // ── 两条正交的轴：哪里有 dsh（托管 / PATH / 源码）与此刻谁在跑 ──────────
  const managedVersion = await readManagedVersion(runtimeDir, deps)
  // 注入优先：测试要能把「全机 launchd 探测」封成空，否则结果依赖跑测试那台机器。
  const supervise = deps.detectManagedServiceFn || detectManagedService
  const launchd = await supervise(sourceMode)
  const pathBinary = await resolveOnPath(deps)
  const explicitSource = params.sourceDir || deps.sourceDir || null
  // plist 是安装身份的持久证据；进程只能说明「此刻是否运行」，不能决定「有没有安装」。
  let sourceDir = explicitSource || null
  if (!sourceDir && !managedVersion) sourceDir = await resolveSourceCheckout(params, sourceMode, launchd)
  const sourceVersion = await readSourceCheckoutVersion(sourceDir, deps)
  if (!sourceVersion) sourceDir = null

  // 谁在跑：托管 sidecar 状态 + 全机 dsh 进程 + launchd 服务
  const sidecar = await readRuntimeState(deps)
  const processes = await readDshProcesses(sourceMode)
  const launchdProcess = launchd?.running && launchd.pid
    ? processes.find((item) => item.pid === launchd.pid)
    : null
  const sidecarProcess = sidecar && isProcessAlive(sidecar.pid) ? processes.find((item) => item.pid === sidecar.pid) : null
  const adoptedProcess = launchdProcess || sidecarProcess || processes[0] || null

  const running = Boolean(adoptedProcess)
  const mode = !running
    ? 'none'
    : adoptedProcess.pid === launchd?.pid ? 'launchd'
      : sidecarProcess ? 'sidecar' : 'external'
  // 端点：优先用 sidecar 落盘状态；launchd 托管的实例没有它，就问内核要端口、读日志要地址
  let endpoint = {
    port: sidecarProcess && sidecar?.port ? sidecar.port : null,
    url: sidecarProcess && sidecar?.url ? sidecar.url : null,
  }
  if (running && (endpoint.port === null || endpoint.url === null)) {
    const discovered = await readInstanceEndpoint({ pid: adoptedProcess?.pid, logPath: launchd?.logPath }, sourceMode)
    endpoint = { port: endpoint.port ?? discovered.port, url: endpoint.url ?? discovered.url }
  }
  const port = endpoint.port
  const url = endpoint.url

  // 自动重启开关：只有被 launchd 托管时才存在这个概念
  const keepAlive = launchd ? await readLaunchdKeepAlive(launchd, sourceMode) : null

  let kind = 'none'
  let version = null
  let location = null
  if (managedVersion) {
    kind = 'managed'
    version = managedVersion
    location = runtimeDir
  } else if (pathBinary) {
    kind = 'path'
    location = pathBinary
  } else if (sourceVersion) {
    kind = 'source'
    version = sourceVersion
    location = sourceDir
  }

  // 源码目录的「有没有新版」要问 git（它走仓库），不能问 npm 通道
  const sourceState = kind === 'source' && sourceDir
    ? await sourceService.readSourceState({ sourceDir }, { ...deps, sourceDir })
    : null
  const registry = sourceState
    ? { ok: true, skipped: true, latest: null, next: null, versions: [] }
    : await readDistTags({ ...deps, nodeRuntime: node })
  const upgradeTargets = {
    latest: registry.latest && managedVersion && compareVersions(registry.latest, managedVersion) > 0 ? registry.latest : null,
    next: registry.next && managedVersion && compareVersions(registry.next, managedVersion) > 0 ? registry.next : null,
  }

  return {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    supportedPlatform: process.platform === 'darwin' || process.platform === 'linux',
    node: {
      available: Boolean(node),
      version: node?.version || null,
      supported,
      required: NODE_RANGE_TEXT,
    },
    install: {
      kind,
      version,
      location,
      runtimeDir,
      managedBinPath: managedBin,
      managedVersion,
      sourceVersion,
      sourceDir,
      pathBinary,
      /** 托管安装可升级；源码目录要 git pull + 重新编译，不叫升级。 */
      canUpgrade: managedVersion !== null && managedVersion !== undefined,
      canInstall: Boolean(node) && supported,
      // 接管会另装托管运行时，不写源码 checkout；真实版本可用性在确认后查询 registry。
      canTakeOver: kind === 'source' && Boolean(node) && supported,
      // 源码版也能「卸」——卸的是 CodePal 的启动项，不是删用户仓库
      canUninstall: Boolean(managedVersion) || kind === 'source',
      canUpdate: Boolean(managedVersion) || Boolean(sourceState?.isRepo),
    },
    registry: {
      ok: registry.ok,
      // 源码形态不问 npm 通道，这里会标记 skipped，页面据此不渲染通道
      skipped: Boolean(registry.skipped),
      channels: { latest: registry.latest, next: registry.next },
      versions: registry.versions,
      upgradeTargets,
    },
    /** 源码目录的 git 状态：更新判定走这里，不走 npm 通道 */
    source: sourceState
      ? {
        isRepo: sourceState.isRepo,
        branch: sourceState.branch,
        commit: sourceState.commit,
        dirty: sourceState.dirty,
        behind: sourceState.behind,
        ahead: sourceState.ahead,
        upstream: sourceState.upstream,
        upstreamSource: sourceState.upstreamSource,
        updatable: sourceState.updatable,
      }
      : null,
    /** 这台机器上有没有 launchd 在托管 dsh —— 决定启停走哪条路。 */
    supervisor: launchd
      ? {
        kind: 'launchd',
        label: launchd.label,
        plistPath: launchd.plistPath,
        entry: launchd.entry,
        keepAlive,
        logPath: launchd.logPath,
      }
      : { kind: 'none', label: null, plistPath: null, entry: null, keepAlive: null, logPath: null },
    runtime: {
      running,
      mode,
      pid: adoptedProcess?.pid ?? null,
      port,
      url,
      startedAt: sidecarProcess && sidecar?.startedAt ? sidecar.startedAt : null,
      version: sidecarProcess && sidecar?.version ? sidecar.version : null,
      processes: processes.length,
    },
    registryReady: registry.ok,
    stopOnQuit: getStopOnQuitPreference(deps),
    channels: { ...CHANNELS },
  }
}

/**
 * 从托管安装解析入口可执行描述。
 * @param {string} runtimeDir
 * @param {object} deps
 * @returns {Promise<{nodeBin:string,binPath:string,version:string}>}
 */
async function requireManagedLauncher(runtimeDir, deps = {}) {
  const stat = deps.statFn || fs.stat
  const version = await readManagedVersion(runtimeDir, deps)
  if (!version) throw codedError('HARNESS_NOT_INSTALLED')
  const binPath = resolveManagedBinPath(runtimeDir)
  const binStat = await stat(binPath).catch(() => null)
  if (!binStat || !binStat.isFile()) throw codedError('HARNESS_NOT_INSTALLED')
  const node = await resolveNodeRuntime(deps)
  if (!node) throw codedError('HARNESS_NODE_UNSUPPORTED')
  if (!nodeSupported(parseNodeVersion(node.version))) throw codedError('HARNESS_NODE_UNSUPPORTED')
  return { nodeBin: node.nodeBin, binPath, version }
}

/**
 * 拉起 `dsh web`，等待官方就绪行并返回可用 URL。
 * @param {object} params
 * @param {object} [deps]
 * @returns {Promise<{pid:number,port:number|null,url:string,version:string}>}
 */
/**
 * 解析「用什么命令、在哪个目录」拉起 dsh。
 *
 * 托管安装与源码目录都能被拉起，差别只在 argv 与 cwd；差异全部收在这里，
 * 页面只需要一个「启动」按钮。
 * @param {object} params
 * @param {object} deps
 * @returns {Promise<{nodeBin:string,argv:string[],cwd:string,version:string|null,sourceKind:string}>}
 */
async function resolveLaunchSpec(params = {}, deps = {}) {
  const homeDir = params.homeDir || deps.homeDir || os.homedir()
  const runtimeDir = resolveRuntimePath(homeDir)
  const node = await resolveNodeRuntime(deps)
  if (!node) throw codedError('HARNESS_NODE_UNSUPPORTED')
  if (!nodeSupported(parseNodeVersion(node.version))) throw codedError('HARNESS_NODE_UNSUPPORTED')

  const managedVersion = await readManagedVersion(runtimeDir, deps)
  if (managedVersion) {
    const binPath = resolveManagedBinPath(runtimeDir)
    const binStat = await (deps.statFn || fs.stat)(binPath).catch(() => null)
    if (!binStat) throw codedError('HARNESS_NOT_INSTALLED')
    return { nodeBin: node.nodeBin, argv: [binPath, 'web', '--port', '0', '--no-open'], cwd: homeDir, version: managedVersion, sourceKind: 'managed' }
  }

  // 没有托管安装就试源码目录：源码模式用 tsx 直跑入口，cwd 必须是仓库根
  const sourceDir = await resolveSourceCheckout(params, { ...deps, homeDir })
  const sourceVersion = await readSourceCheckoutVersion(sourceDir, deps)
  if (sourceVersion) {
    const entry = path.join(sourceDir, 'apps', 'cli', 'src', 'bin.ts')
    return { nodeBin: node.nodeBin, argv: ['--import', 'tsx/esm', entry, 'web', '--port', '0', '--no-open'], cwd: sourceDir, version: sourceVersion, sourceKind: 'source' }
  }
  throw codedError('HARNESS_NOT_INSTALLED')
}

async function startHarness(params = {}, deps = {}) {
  const homeDir = params.homeDir || deps.homeDir || os.homedir()
  const runtimeDir = resolveRuntimePath(homeDir)

  // 本机若有 launchd 服务在托管 dsh，启动必须交给 launchd：
  // 自己再 spawn 一份就是两个 dsh 抢端口，且用户看到「启动成功但页面还是旧的」。
  const supervisors = deps.detectManagedServiceFn || detectManagedService
  const launchd = await supervisors({ ...deps, homeDir })
  if (launchd) {
    const service = require('./launchdService')
    const uid = deps.uid || process.getuid?.()
    const started = await service.startService({ homeDir, label: launchd.label, uid }, { ...deps, homeDir, uid, label: launchd.label })
    return { pid: started.pid, port: launchd.pid ? null : null, url: null, startedAt: new Date().toISOString(), version: null, via: 'launchd' }
  }

  const launcher = await resolveLaunchSpec({ ...params, homeDir, runtimeDir }, deps)
  const existing = await readRuntimeState(deps)
  if (existing && (existing.owned || isProcessAlive(existing.pid))) throw codedError('HARNESS_ALREADY_RUNNING')

  const spawnProcess = deps.spawnProcess || spawn
  const child = spawnProcess(launcher.nodeBin, launcher.argv, {
    cwd: launcher.cwd,
    shell: false,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_HOME: path.join(homeDir, '.dsh') },
  })
  const childrenMap = deps.childrenMap || children
  childrenMap.set(child.pid, child)

  const startedAt = new Date().toISOString()
  const url = await new Promise((resolve, reject) => {
    let settled = false
    let buffer = ''
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGTERM') } catch { /* 已退出 */ }
      childrenMap.delete(child.pid)
      reject(codedError('HARNESS_START_TIMEOUT'))
    }, deps.startTimeoutMs || START_TIMEOUT_MS)
    const onData = (chunk) => {
      if (settled) return
      buffer += String(chunk)
      const matched = parseReadyUrl(buffer)
      if (matched) {
        settled = true
        clearTimeout(timer)
        resolve(matched)
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      childrenMap.delete(child.pid)
      reject(codedError(error?.code === 'ENOENT' ? 'HARNESS_SPAWN_FAILED' : safeErrorCode(error)))
    })
    child.once('exit', () => {
      // 两种情况都要清：就绪前退出 = 启动失败；就绪后退出 = 进程没了，
      // 落盘状态必须一起清掉，否则页面会一直显示一个已死的 PID。
      childrenMap.delete(child.pid)
      void clearRuntimeState(deps)
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(codedError('HARNESS_SPAWN_FAILED'))
    })
  })

  let port = null
  try {
    port = Number(new URL(url).port) || null
  } catch { /* URL 异常时留空 */ }

  const state = {
    pid: child.pid,
    port,
    url,
    startedAt,
    version: launcher.version,
    sourceKind: launcher.sourceKind,
  }
  await writeRuntimeState(state, deps)
  return { ...state }
}

/**
 * 停止由本服务拉起的 dsh 进程。非本服务拉起的实例拒绝操作。
 * @param {object} params
 * @param {object} [deps]
 * @returns {Promise<{stopped:boolean,pid:number|null}>}
 */
async function stopHarness(params = {}, deps = {}) {
  const homeDir = params.homeDir || deps.homeDir || os.homedir()
  const supervisors = deps.detectManagedServiceFn || detectManagedService
  const launchd = await supervisors({ ...deps, homeDir })
  if (launchd) {
    // 直接 kill 会被 KeepAlive 立刻拉回来，页面就会显示「停了但还活着」。
    const service = require('./launchdService')
    const uid = deps.uid || process.getuid?.()
    await service.stopService({ homeDir, label: launchd.label, uid }, { ...deps, homeDir, uid, label: launchd.label })
    return { stopped: true, pid: launchd.pid ?? null, via: 'launchd' }
  }

  const state = await readRuntimeState(deps)
  if (!state) throw codedError('HARNESS_NOT_RUNNING')
  const childrenMap = deps.childrenMap || children
  const ownedChild = childrenMap.get(state.pid)
  if (!ownedChild && !state.owned) throw codedError('HARNESS_MANAGED_ONLY')

  if (ownedChild) {
    try { ownedChild.kill('SIGTERM') } catch { /* 已退出 */ }
  } else {
    try { process.kill(state.pid, 'SIGTERM') } catch { /* 已退出 */ }
  }

  const waitMs = deps.stopGraceMs || STOP_GRACE_MS
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(state.pid)) break
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  if (isProcessAlive(state.pid)) {
    try { process.kill(state.pid, 'SIGKILL') } catch { /* 忽略 */ }
  }
  childrenMap.delete(state.pid)
  await clearRuntimeState(deps)
  return { stopped: true, pid: state.pid }
}

/** 重启：先停（允许未运行）再起。 */
async function restartHarness(params = {}, deps = {}) {
  const homeDir = params.homeDir || deps.homeDir || os.homedir()
  const supervisors = deps.detectManagedServiceFn || detectManagedService
  const launchd = await supervisors({ ...deps, homeDir })
  if (launchd) {
    const service = require('./launchdService')
    const uid = deps.uid || process.getuid?.()
    const restarted = await service.restartService({ homeDir, label: launchd.label, uid }, { ...deps, homeDir, uid, label: launchd.label })
    return { pid: restarted.pid, via: 'launchd' }
  }
  try {
    await stopHarness(params, deps)
  } catch (error) {
    if (safeErrorCode(error) !== 'HARNESS_NOT_RUNNING') throw error
  }
  return startHarness(params, deps)
}

/**
 * 安装或升级托管版 dsh。
 *
 * 走 `npm install --prefix`，装进 CodePal 自己的 runtimes 目录：不碰全局 npm、
 * 不需要管理员权限、卸载即整目录删除。
 * @param {object} params
 * @param {object} [deps]
 * @returns {Promise<{version:string,channel:string,changed:boolean}>}
 */
async function installHarness(params = {}, deps = {}) {
  const homeDir = params.homeDir || deps.homeDir || os.homedir()
  const channel = CHANNELS[params.channel] || CHANNELS.latest
  const runtimeDir = resolveRuntimePath(homeDir)
  const version = await readManagedVersion(runtimeDir, deps)
  if (version && params.targetVersion && compareVersions(params.targetVersion, version) <= 0 && params.force !== true) {
    return { version, channel, changed: false }
  }
  const node = await resolveNodeRuntime(deps)
  if (!node) throw codedError('HARNESS_NODE_UNSUPPORTED')
  if (!nodeSupported(parseNodeVersion(node.version))) throw codedError('HARNESS_NODE_UNSUPPORTED')

  const mkdir = deps.mkdir || fs.mkdir
  await mkdir(runtimeDir, { recursive: true })
  // 安全接管必须安装一个明确且不低于源码版的版本，不能只跟随可能更旧的 dist-tag。
  const spec = `${PACKAGE_NAME}@${params.targetVersion || channel}`
  try {
    await (deps.runCommand || defaultRunCommand)(node.npmBin, [
      'install', '--prefix', runtimeDir, '--no-fund', '--no-audit', '--loglevel', 'error', spec,
    ], { timeout: deps.installTimeoutMs || INSTALL_TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024 })
  } catch (error) {
    throw codedError('HARNESS_NPM_FAILED')
  }
  const installed = await readManagedVersion(runtimeDir, deps)
  if (!installed) throw codedError('HARNESS_NPM_FAILED')
  return { version: installed, channel, changed: installed !== version }
}

/**
 * 从 registry 中选择不低于源码版的最保守托管版本。
 *
 * 同版本优先保留 dist-tag 名称，便于页面继续显示稳定/预览通道；若只有版本列表
 * 命中，则直接安装精确版本。绝不为了“纳管”把用户从 rc.2 降到 rc.1。
 * @param {string} sourceVersion
 * @param {{latest:string|null,next:string|null,versions:string[],ok:boolean}} registry
 * @returns {{version:string,channel:string|null}|null}
 */
function selectTakeoverTarget(sourceVersion, registry) {
  if (!parseVersion(sourceVersion) || !registry?.ok) return null
  const candidates = [
    registry.latest ? { version: registry.latest, channel: 'latest', rank: 0 } : null,
    registry.next ? { version: registry.next, channel: 'next', rank: 1 } : null,
    ...(registry.versions || []).map((version) => ({ version, channel: null, rank: 2 })),
  ]
    .filter((item) => item && parseVersion(item.version) && compareVersions(item.version, sourceVersion) >= 0)
    .sort((left, right) => compareVersions(left.version, right.version) || left.rank - right.rank)

  return candidates.length > 0
    ? { version: candidates[0].version, channel: candidates[0].channel }
    : null
}

/**
 * 把既有源码安装安全交给 CodePal 管理。
 *
 * 源码目录与 ~/.dsh 始终只读：另装 npm runtime，然后让 launchd 从旧源码入口
 * 原子切到托管入口。launchd 层负责恢复原 plist/旧服务；本层负责删除失败的新 runtime。
 * @param {object} params
 * @param {object} [deps]
 * @returns {Promise<object>}
 */
async function takeOverSourceInstallation(params = {}, deps = {}) {
  const homeDir = params.homeDir || deps.homeDir || os.homedir()
  const sourceDir = await resolveSourceCheckout(params, { ...deps, homeDir })
  const sourceVersion = await readSourceCheckoutVersion(sourceDir, deps)
  if (!sourceVersion) throw codedError('HARNESS_NOT_INSTALLED')

  const runtimeDir = resolveRuntimePath(homeDir)
  if (await readManagedVersion(runtimeDir, deps)) throw codedError('HARNESS_OP_NOT_ALLOWED')

  const node = await resolveNodeRuntime(deps)
  if (!node || !nodeSupported(parseNodeVersion(node.version))) {
    throw codedError('HARNESS_NODE_UNSUPPORTED')
  }
  const registry = await readDistTags({ ...deps, nodeRuntime: node })
  const target = selectTakeoverTarget(sourceVersion, registry)
  if (!target) throw codedError('HARNESS_TAKEOVER_VERSION_UNAVAILABLE')

  const supervisors = deps.detectManagedServiceFn || detectManagedService
  const launchd = await supervisors({ ...deps, homeDir })
  if (!launchd && await isAnyInstanceRunning({ ...deps, detectManagedServiceFn: supervisors }, homeDir)) {
    throw codedError('HARNESS_TAKEOVER_REQUIRES_STOP')
  }

  try {
    const installed = await installHarness({
      ...params,
      homeDir,
      channel: target.channel || params.channel || 'latest',
      targetVersion: target.version,
      force: true,
    }, deps)
    if (compareVersions(installed.version, sourceVersion) < 0) {
      throw codedError('HARNESS_TAKEOVER_VERSION_UNAVAILABLE')
    }

    let switched = null
    if (launchd) {
      const repoint = deps.repointManagedServiceFn || require('./launchdService').repointEntry
      const uid = deps.uid || process.getuid?.()
      switched = await repoint({
        homeDir,
        uid,
        label: launchd.label,
        nextBin: resolveManagedBinPath(runtimeDir),
        nodeBin: node.nodeBin,
        workingDirectory: runtimeDir,
      }, { ...deps, homeDir, uid, label: launchd.label })
    }

    return {
      kind: 'managed',
      adopted: true,
      version: installed.version,
      channel: target.channel,
      sourcePreserved: true,
      dataPreserved: true,
      supervisorRepointed: Boolean(launchd),
      backupPath: switched?.backupPath || null,
    }
  } catch (error) {
    await (deps.rm || fs.rm)(runtimeDir, { recursive: true, force: true }).catch(() => {})
    if (safeErrorCode(error) === 'HARNESS_TAKEOVER_VERSION_UNAVAILABLE') throw error
    throw codedError('HARNESS_TAKEOVER_FAILED')
  }
}

/**
 * 卸载托管版 dsh。默认保留 ~/.dsh（会话历史与凭证）。
 * @param {object} params
 * @param {object} [deps]
 * @returns {Promise<{removed:boolean,purgedData:boolean}>}
 */
async function uninstallHarness(params = {}, deps = {}) {
  const homeDir = params.homeDir || deps.homeDir || os.homedir()
  const runtimeDir = resolveRuntimePath(homeDir)
  const version = await readManagedVersion(runtimeDir, deps)
  if (!version) {
    // 源码目录没有「卸载」可言——删用户仓库是破坏。这里只停掉它并摘掉 CodePal 的启动项。
    const sourceDir = await resolveSourceCheckout(params, { ...deps, homeDir })
    const sourceVersion = await readSourceCheckoutVersion(sourceDir, deps)
    if (!sourceVersion) throw codedError('HARNESS_NOT_INSTALLED')
    return removeSourceSupervision({ ...params, homeDir, sourceDir }, deps)
  }
  try {
    await stopHarness(params, deps)
  } catch (error) {
    if (safeErrorCode(error) !== 'HARNESS_NOT_RUNNING') throw error
  }
  const rm = deps.rm || fs.rm
  const purgeData = params.purgeData === true
  await rm(runtimeDir, { recursive: true, force: true })
  if (purgeData) await rm(path.join(homeDir, '.dsh'), { recursive: true, force: true })
  return { removed: true, purgedData: purgeData }
}

/**
 * 源码版的「卸载」= 停止 + 移除 launchd 启动项（原文件先备份），不删源码目录。
 * @param {object} params
 * @param {object} [deps]
 * @returns {Promise<{removed:boolean,kind:string,serviceRemoved:boolean,purgedData:boolean}>}
 */
async function removeSourceSupervision(params = {}, deps = {}) {
  const homeDir = params.homeDir || deps.homeDir || os.homedir()
  const uid = deps.uid || process.getuid?.()
  const supervisors = deps.detectManagedServiceFn || detectManagedService
  const launchd = await supervisors({ ...deps, homeDir })

  let serviceRemoved = false
  if (launchd) {
    const service = require('./launchdService')
    await service.stopService({ homeDir, label: launchd.label, uid }, { ...deps, homeDir, uid, label: launchd.label })
    await (deps.copyFile || fs.copyFile)(launchd.plistPath, `${launchd.plistPath}.codepal-backup`).catch(() => {})
    await (deps.rm || fs.rm)(launchd.plistPath, { force: true })
    serviceRemoved = true
  }
  try {
    await stopHarness(params, deps)
  } catch (error) {
    if (safeErrorCode(error) !== 'HARNESS_NOT_RUNNING') throw error
  }

  const purgeData = params.purgeData === true
  if (purgeData) await (deps.rm || fs.rm)(path.join(homeDir, '.dsh'), { recursive: true, force: true })
  return { removed: true, kind: 'source', serviceRemoved, purgedData: purgeData }
}

/** 现在是否有实例在跑（不管是谁拉起的）。 */
async function isAnyInstanceRunning(deps = {}, homeDir) {
  const state = await readRuntimeState(deps)
  if (state && (state.owned || isProcessAlive(state.pid))) return true
  const supervisors = deps.detectManagedServiceFn || detectManagedService
  const launchd = await supervisors({ ...deps, homeDir })
  return Boolean(launchd?.running)
}

/**
 * 更新 —— 两种安装同一个入口，执行者不同。
 *
 * 托管安装走 npm 换版本；源码目录走 git pull + 构建。页面只需要一个「更新」按钮，
 * 差异全部收在这里；更新前在跑的实例，更新后自动回到运行态。
 * @param {object} params
 * @param {object} [deps]
 * @returns {Promise<object>}
 */
async function updateHarness(params = {}, deps = {}) {
  if (params.takeover === true) return takeOverSourceInstallation(params, deps)

  const homeDir = params.homeDir || deps.homeDir || os.homedir()
  const runtimeDir = resolveRuntimePath(homeDir)
  const managedVersion = await readManagedVersion(runtimeDir, deps)
  const wasRunning = await isAnyInstanceRunning(deps, homeDir)

  if (managedVersion) {
    const installed = await installHarness({ ...params, homeDir, force: true }, deps)
    let restarted = false
    if (wasRunning) {
      try { await restartHarness({ ...params, homeDir }, deps); restarted = true } catch { /* 起不来由页面刷新暴露 */ }
    }
    return { kind: 'managed', changed: installed.changed, after: installed.version, steps: ['npm'], restarted }
  }

  const sourceDir = await resolveSourceCheckout(params, { ...deps, homeDir })
  const sourceVersion = await readSourceCheckoutVersion(sourceDir, deps)
  if (!sourceVersion) throw codedError('HARNESS_NOT_INSTALLED')
  const result = await sourceService.updateSource({ ...params, sourceDir }, { ...deps, sourceDir })
  let restarted = false
  if (wasRunning) {
    try { await restartHarness({ ...params, homeDir, sourceDir }, deps); restarted = true } catch { /* 同上 */ }
  }
  return { kind: 'source', changed: result.changed, before: result.before, after: result.after, steps: result.steps, restarted }
}

/** 读取托管安装可用的版本列表与通道指向。 */
async function listAvailableVersions(params = {}, deps = {}) {
  const tags = await readDistTags(deps)
  if (!tags.ok) throw codedError('HARNESS_NPM_FAILED')
  return { latest: tags.latest, next: tags.next, versions: tags.versions }
}

/** 进程退出时统一清理，避免留下孤儿 dsh。 */
async function shutdownAllHarness(deps = {}) {
  const childrenMap = deps.childrenMap || children
  const pids = [...childrenMap.keys()]
  // 偏好默认关闭 dsh：CodePal 走了却把 dsh 留在后台，用户既看不见也停不掉。
  const stopOnQuit = deps.getStopOnQuit ? deps.getStopOnQuit() !== false : true
  if (!stopOnQuit) return 0
  for (const pid of pids) {
    const child = childrenMap.get(pid)
    try { child.kill('SIGTERM') } catch { /* 已退出 */ }
  }
  await clearRuntimeState(deps)
  childrenMap.clear()
  return pids.length
}

module.exports = {
  PACKAGE_NAME,
  READY_LINE,
  RUNTIME_RELATIVE,
  SAFE_ERROR_CODES,
  children,
  codedError,
  safeErrorCode,
  compareVersions,
  parseNodeVersion,
  parseReadyUrl,
  parseVersion,
  nodeSupported,
  isProcessAlive,
  configureStateDir,
  resolveRuntimePath,
  resolveManagedBinPath,
  readManagedVersion,
  readSourceCheckoutVersion,
  resolveNodeRuntime,
  resolveOnPath,
  extractCheckoutRoots,
  readProcessCwd,
  readDshProcesses,
  readInstanceEndpoint,
  readLogTail,
  resolveEntryFromArgv,
  resolveSourceRootFromEntry,
  resolveSourceCheckout,
  detectManagedService,
  readLaunchdKeepAlive,
  detectSourceCheckout,
  readDistTags,
  readRuntimeState,
  writeRuntimeState,
  clearRuntimeState,
  getStopOnQuitPreference,
  setStopOnQuitPreference,
  defaultRunCommand,
  getHarnessSnapshot,
  startHarness,
  stopHarness,
  restartHarness,
  resolveLaunchSpec,
  removeSourceSupervision,
  isAnyInstanceRunning,
  selectTakeoverTarget,
  takeOverSourceInstallation,
  updateHarness,
  installHarness,
  uninstallHarness,
  listAvailableVersions,
  shutdownAllHarness,
}
