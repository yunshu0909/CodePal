/**
 * launchd 服务适配层（合并方案的核心）
 *
 * 为什么需要它：DSH 装在哪、和「谁在盯着这个进程」是两件独立的事。
 * 用户机器上可能已经有一个 launchd 服务在跑 dsh（笔记本机就是 `com.dsh.web`）。
 * 要「一键启停」就必须跟 launchd 打交道，而不是去 kill 进程——kill 掉它会立刻
 * 被 KeepAlive 拉回来，页面就会显示「停了但还活着」。
 *
 * 因此本层负责：读服务定义与运行状态、启停重启、改 KeepAlive。
 * plist 读写走 macOS 自带 `plutil`（全格式、保留非目标字段），不手写 XML 正则。
 *
 * @module electron/services/launchdService
 */

const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')
const { promisify } = require('util')

const execFileAsync = promisify(execFile)

/** launchd 未找到该服务时的统一错误码。 */
const NOT_FOUND = 'NOT_FOUND'

function codedError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

/**
 * 正式运行使用的无 shell 命令执行器；测试可以通过 deps.runCommand 替换。
 * launchctl 的探测/启停需要保留非零退出码，不能把“服务未加载”误当异常抛穿。
 * @param {string} binary
 * @param {string[]} args
 * @param {object} options
 * @returns {Promise<{stdout:string,stderr:string,exitCode:number}>}
 */
async function defaultRunCommand(binary, args, options = {}) {
  try {
    const result = await execFileAsync(binary, args, {
      cwd: options.cwd,
      timeout: options.timeout || 30_000,
      maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
      encoding: 'utf8',
      shell: false,
      env: options.env,
    })
    return { stdout: result.stdout || '', stderr: result.stderr || '', exitCode: 0 }
  } catch (error) {
    if (!options.allowFailure) throw error
    return {
      stdout: error.stdout || '',
      stderr: error.stderr || error.message || '',
      exitCode: typeof error.code === 'number' ? error.code : 1,
    }
  }
}

/**
 * 解析 `launchctl print` 输出。
 *
 * 取需要的字段而不是整段结构化——launchd 的输出没有稳定 schema，
 * 越少依赖越好。
 * @param {string} text
 * @returns {object}
 */
function parseLaunchctlPrint(text) {
  const source = String(text || '')
  const running = /^\s*state\s*=\s*running\s*$/m.test(source)
  const pidMatch = /^\s*pid\s*=\s*(\d+)\s*$/m.exec(source)
  const exitMatch = /^\s*last exit code\s*=\s*(-?\d+)\s*$/m.exec(source)
  const pathMatch = /^\s*path\s*=\s*(\S+)\s*$/m.exec(source)
  const propsMatch = /^\s*properties\s*=\s*(.+)$/m.exec(source)
  return {
    running,
    pid: pidMatch ? Number(pidMatch[1]) : null,
    lastExitCode: exitMatch ? Number(exitMatch[1]) : null,
    plistPath: pathMatch ? pathMatch[1] : null,
    // KeepAlive 是否生效，以 launchctl 实际解析出的 properties 为准（权威）
    keepAliveByService: propsMatch ? /keepalive/i.test(propsMatch[1]) : false,
    runAtLoadByService: propsMatch ? /runatload/i.test(propsMatch[1]) : false,
  }
}

/**
 * 从 plist 的 JSON 形态里读 KeepAlive。
 * 该键既可能是布尔，也可能是条件字典；只认布尔 `true` 为「崩溃自动重启已开」。
 * @param {object} json
 * @returns {boolean}
 */
function readPlistKeepAlive(json) {
  const value = json?.KeepAlive
  if (value === true) return true
  if (value && typeof value === 'object') return true
  return false
}

/**
 * 从 plist 的 JSON 形态里读程序参数。
 * @param {object} json
 * @returns {string[]}
 */
function readProgramArguments(json) {
  return Array.isArray(json?.ProgramArguments) ? json.ProgramArguments.filter((item) => typeof item === 'string') : []
}

/**
 * 替换 ProgramArguments 里的 CLI 入口。
 *
 * launchd 常见写法是相对路径（配合 WorkingDirectory），所以不能整条替换——
 * 只替换指向 dsh 入口的那一段，保留 node 位置与其余参数。
 * @param {string[]} argv
 * @param {string} nextBin 新的入口路径（绝对路径）
 * @param {string|null} nodeBin 托管运行时使用的 Node；未传时沿用原 argv 第一项
 * @returns {string[]}
 */
function rewriteEntryArgument(argv, nextBin, nodeBin = null) {
  const args = [...argv]
  const index = args.findIndex((item) => /apps[\\/]cli[\\/](src|lib)[\\/]bin\.(ts|js)$/.test(item) || /[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/.test(item))
  const webIndex = args.indexOf('web', Math.max(index + 1, 0))
  const suffix = webIndex >= 0 ? args.slice(webIndex) : ['web']
  const runner = nodeBin || (index > 0 ? args[0] : process.execPath)

  // 源码入口前常带 `--import tsx/esm`。切到已编译 npm 包后这些 loader
  // 必须一起去掉，否则托管运行时仍依赖旧 checkout 的开发依赖。
  return [runner, nextBin, ...suffix]
}

/** 服务标签 → plist 文件路径 */
function resolvePlistPath(homeDir, label) {
  return path.join(homeDir || os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
}

/** gui 域里的服务目标 */
function serviceTarget(uid, label) {
  return `gui/${uid}/${label}`
}

/**
 * 读取一个 launchd 服务的完整状态。
 * @param {object} params
 * @param {object} [deps]
 * @returns {Promise<object>}
 */
async function readLaunchdService(params = {}, deps = {}) {
  const homeDir = params.homeDir || deps.homeDir || os.homedir()
  const label = params.label || deps.label
  const runCommand = deps.runCommand || defaultRunCommand
  const uid = params.uid || deps.uid
  if (!label) throw codedError('LABEL_REQUIRED')
  const plistPath = resolvePlistPath(homeDir, label)
  const stat = deps.statFn || fs.stat
  const plistStat = await stat(plistPath).catch(() => null)
  if (!plistStat) return { available: false, label, plistPath, plistExists: false }

  let service = null
  try {
    const result = await runCommand('launchctl', ['print', serviceTarget(uid, label)], { timeout: 15_000 })
    service = parseLaunchctlPrint(result.stdout)
  } catch {
    service = null
  }

  // plist 内容用于「自动重启」开关的权威值（服务未加载时也要能读）
  let keepAliveInPlist = null
  try {
    const result = await runCommand('plutil', ['-convert', 'json', '-o', '-', plistPath], { timeout: 15_000 })
    keepAliveInPlist = readPlistKeepAlive(JSON.parse(result.stdout || '{}'))
  } catch {
    keepAliveInPlist = null
  }

  return {
    available: true,
    label,
    plistPath,
    plistExists: true,
    loaded: service !== null,
    running: Boolean(service?.running),
    pid: service?.pid ?? null,
    lastExitCode: service?.lastExitCode ?? null,
    keepAlive: keepAliveInPlist ?? (service?.keepAliveByService ?? false),
    keepAliveSource: keepAliveInPlist === null ? 'service' : 'plist',
    runAtLoad: service?.runAtLoadByService ?? false,
  }
}

/**
 * 停止服务：bootout 会让它保持停止，且不删文件。
 * @param {object} params
 * @param {object} [deps]
 * @returns {Promise<{stopped:boolean}>}
 */
async function stopService(params = {}, deps = {}) {
  const runCommand = deps.runCommand || defaultRunCommand
  const uid = params.uid || deps.uid
  const label = params.label || deps.label
  const result = await runCommand('launchctl', ['bootout', serviceTarget(uid, label)], { timeout: 30_000, allowFailure: true })
  // 未加载时 bootout 会报错，这不算失败
  const stopped = result.exitCode === 0 || /could not find|no such process|not find specified service/i.test(`${result.stderr || ''}`)
  if (!stopped) throw codedError('LAUNCHD_STOP_FAILED')
  return { stopped: true }
}

/**
 * 启动服务并等待它真的在跑。
 * @param {object} params
 * @param {object} [deps]
 * @returns {Promise<{pid:number|null}>}
 */
async function startService(params = {}, deps = {}) {
  const runCommand = deps.runCommand || defaultRunCommand
  const uid = params.uid || deps.uid
  const label = params.label || deps.label
  const homeDir = params.homeDir || deps.homeDir || os.homedir()
  const target = serviceTarget(uid, label)

  const kickstart = await runCommand('launchctl', ['kickstart', target], { timeout: 30_000, allowFailure: true })
  if (kickstart.exitCode !== 0) {
    // 没加载过就 bootstrap 一次
    const bootstrap = await runCommand('launchctl', ['bootstrap', `gui/${uid}`, resolvePlistPath(homeDir, label)], { timeout: 30_000, allowFailure: true })
    if (bootstrap.exitCode !== 0 && !/already bootstrapped|service already loaded/i.test(`${bootstrap.stderr || ''}`)) {
      throw codedError('LAUNCHD_START_FAILED')
    }
    await runCommand('launchctl', ['kickstart', target], { timeout: 30_000, allowFailure: true })
  }
  const state = await waitForState(params, deps, (snapshot) => snapshot.running)
  if (!state?.running) throw codedError('LAUNCHD_START_FAILED')
  return { pid: state.pid }
}

/**
 * 重启服务：kickstart -k 先杀后起，是 launchd 自己的重启语义。
 * @param {object} params
 * @param {object} [deps]
 * @returns {Promise<{pid:number|null}>}
 */
async function restartService(params = {}, deps = {}) {
  const runCommand = deps.runCommand || defaultRunCommand
  const uid = params.uid || deps.uid
  const label = params.label || deps.label
  const restarted = await runCommand('launchctl', ['kickstart', '-k', serviceTarget(uid, label)], { timeout: 30_000, allowFailure: true })
  if (restarted.exitCode !== 0) throw codedError('LAUNCHD_START_FAILED')
  const state = await waitForState(params, deps, (snapshot) => snapshot.running)
  if (!state?.running) throw codedError('LAUNCHD_START_FAILED')
  return { pid: state.pid }
}

/**
 * 轮询等服务到达期望状态。launchd 的 kickstart 是异步的。
 * @param {object} params
 * @param {object} deps
 * @param {(snapshot: object) => boolean} predicate
 * @returns {Promise<object>}
 */
async function waitForState(params, deps, predicate) {
  const deadline = Date.now() + (deps.stateTimeoutMs || 20_000)
  let latest = null
  while (Date.now() < deadline) {
    latest = await readLaunchdService(params, deps)
    if (!latest.loaded || predicate(latest)) return latest
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return latest || { running: false, pid: null }
}

/**
 * 写回 plist（经 plutil：先 JSON → XML，再覆盖原文件）。
 *
 * 只改目标键，其余键原样保留——用户的 EnvironmentVariables、日志路径、
 * WorkingDirectory 都不能被顺手改掉。
 * @param {string} plistPath
 * @param {(json: object) => object} mutate
 * @param {object} deps
 * @param {{backup?:boolean}} options
 */
async function writePlist(plistPath, mutate, deps = {}, options = {}) {
  const runCommand = deps.runCommand || defaultRunCommand
  const writeFile = deps.writeFile || fs.writeFile
  const copyFile = deps.copyFile || fs.copyFile

  const convert = await runCommand('plutil', ['-convert', 'json', '-o', '-', plistPath], { timeout: 15_000 })
  const current = JSON.parse(convert.stdout || '{}')
  const next = mutate(current)

  // 写前备份一次，用户随时能手动回退
  const backupPath = `${plistPath}.codepal-backup`
  if (options.backup !== false) {
    try {
      await copyFile(plistPath, backupPath)
    } catch {
      throw codedError('PLIST_WRITE_FAILED')
    }
  }

  const tempPath = `${plistPath}.codepal.tmp`
  await writeFile(tempPath, JSON.stringify(next, null, 2), 'utf8')
  const reconvert = await runCommand('plutil', ['-convert', 'xml1', '-o', plistPath, tempPath], { timeout: 15_000 })
  if (reconvert.exitCode !== 0) throw codedError('PLIST_WRITE_FAILED')
  const fsPromises = require('fs/promises')
  await (deps.rm || fsPromises.rm)(tempPath, { force: true })
  return { backupPath }
}

/**
 * 开关「崩溃自动重启」（KeepAlive）。
 *
 * 启动中的服务必须先 bootout 再改 plist：KeepAlive 为真时改文件后 launchd
 * 不会重读，只有重新 bootstrap 才生效。
 * @param {object} params
 * @param {object} [deps]
 * @returns {Promise<{keepAlive:boolean}>}
 */
async function setKeepAlive(params = {}, deps = {}) {
  const homeDir = params.homeDir || deps.homeDir || os.homedir()
  const label = params.label || deps.label
  const uid = params.uid || deps.uid
  const enabled = params.enabled === true
  const plistPath = resolvePlistPath(homeDir, label)
  const state = await readLaunchdService(params, deps)
  if (!state.plistExists) throw codedError('PLIST_MISSING')

  const wasRunning = state.running
  if (state.loaded) await stopService(params, deps)
  await writePlist(plistPath, (json) => ({ ...json, KeepAlive: enabled }), deps)
  if (wasRunning || enabled) {
    await startService(params, deps)
  }
  return { keepAlive: enabled }
}

/**
 * 切换服务实际运行的 dsh 入口（升级后指向新位置）。
 * @param {object} params
 * @param {object} [deps]
 * @returns {Promise<{argv:string[], backupPath:string|null}>}
 */
async function repointEntry(params = {}, deps = {}) {
  const homeDir = params.homeDir || deps.homeDir || os.homedir()
  const label = params.label || deps.label
  const nextBin = params.nextBin
  if (!nextBin || !path.isAbsolute(nextBin)) throw codedError('INVALID_ENTRY')
  const plistPath = resolvePlistPath(homeDir, label)
  const state = await readLaunchdService(params, deps)
  if (!state.plistExists) throw codedError('PLIST_MISSING')

  const readFile = deps.readFile || fs.readFile
  const writeFile = deps.writeFile || fs.writeFile
  const copyFile = deps.copyFile || fs.copyFile
  const chmod = deps.chmod || fs.chmod
  const originalBytes = await readFile(plistPath)
  const originalStat = await (deps.statFn || fs.stat)(plistPath)
  const backupPath = `${plistPath}.codepal-backup`
  try {
    // 备份必须成功才允许停旧服务；否则失败后没有可审计的恢复点。
    await copyFile(plistPath, backupPath)
  } catch {
    throw codedError('LAUNCHD_REPOINT_FAILED')
  }

  let argv = []
  try {
    if (state.loaded) await stopService(params, deps)
    await writePlist(plistPath, (json) => {
      argv = rewriteEntryArgument(readProgramArguments(json), nextBin, params.nodeBin)
      return {
        ...json,
        ProgramArguments: argv,
        ...(params.workingDirectory ? { WorkingDirectory: params.workingDirectory } : {}),
      }
    }, deps, { backup: false })
    if (state.running) await startService(params, deps)
    return { argv, backupPath }
  } catch {
    // 新定义可能已经被 bootstrap；先卸载，再逐字节恢复原文件与权限。
    try { await stopService(params, deps) } catch { /* 回滚继续 */ }
    try {
      await writeFile(plistPath, originalBytes)
      await chmod(plistPath, originalStat.mode)
      if (state.running) await startService(params, deps)
    } catch {
      // 不暴露 launchctl / plist 原始报错；备份仍留在固定路径供人工恢复。
    }
    throw codedError('LAUNCHD_REPOINT_FAILED')
  }
}

module.exports = {
  NOT_FOUND,
  codedError,
  defaultRunCommand,
  parseLaunchctlPrint,
  readPlistKeepAlive,
  readProgramArguments,
  rewriteEntryArgument,
  resolvePlistPath,
  serviceTarget,
  readLaunchdService,
  startService,
  stopService,
  restartService,
  setKeepAlive,
  repointEntry,
  writePlist,
}
