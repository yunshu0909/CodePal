/**
 * 第三方模型接入 · Claude Code 版本检查（后台查，不卡主进程）
 *
 * 负责：
 * - 进页面时马上给出「能用的上次结果」或「还没结果」，不等 `claude --version`（#99：本机要 3 秒）
 * - 后台查：找 claude、查版本都在子进程里；同一时间只有一次有效的查，重新检测会让旧的那次作废（子进程一起停）
 * - 上次结果：内存一份；模型接入目录存一小条 claude-check.json（找到的路径、指纹、版本号、时间），
 *   重开 CodePal 后先用它。不含对话和 Key，删了下次重查即可。只存读出了版本号的结果。
 * - 上次结果还能不能用看指纹（claudeCli.claudeFingerprint）：升级、卸载、换安装位置都会变；
 *   重开后第一次用存下的结果时，后台照样再核一次，指纹看不出的变化（比如 shell 里换了路径）几秒内纠正
 *
 * 写方：claude-check.json 只由这里写（主进程）。
 *
 * @module electron/modules/models/claudeCheck
 */

const fs = require('fs')
const path = require('path')
const store = require('./store')
const claudeCli = require('./claudeCli')

const RECORD_SCHEMA = 1
const VERSION_RE = /^\d+\.\d+\.\d+$/

/** @returns {string} 记录文件位置（跟着模型接入目录走，测试可用 CODEPAL_MODELS_HOME 换） */
function recordFile() {
  return path.join(store.resolveModelsHome(), 'claude-check.json')
}

/** 读上次存的记录；没有、读不了、字段不对都当没有 */
function readRecord() {
  try {
    const rec = JSON.parse(fs.readFileSync(recordFile(), 'utf8'))
    if (!rec || rec.schema !== RECORD_SCHEMA) return null
    if (typeof rec.bin !== 'string' || typeof rec.fingerprint !== 'string' || !VERSION_RE.test(String(rec.version))) return null
    return rec
  } catch {
    return null
  }
}

/**
 * 存一条；写不进不影响页面（下次重开再查一遍而已）
 * @param {string} file - 开始查时定下的位置：查到一半环境变了也不写到别处
 */
function writeRecord(file, bin, fingerprint, version) {
  try {
    const rec = { schema: RECORD_SCHEMA, bin, fingerprint, version, at: new Date().toISOString() }
    store.writePrivate(file, `${JSON.stringify(rec, null, 2)}\n`)
  } catch {}
}

/** 页面要的形状：{found, version, tooOld, required} */
function infoFor(bin, version) {
  if (!bin) return { found: false, version: null, tooOld: false, required: claudeCli.MIN_CLAUDE_VERSION }
  const v = claudeCli.judgeVersion(version)
  return { found: true, version: v.current, tooOld: !v.ok, required: v.required }
}

/**
 * 建一个检查器（每次注册 models:* 通道建一个）
 * @param {{env?: () => object, reverifyMs?: number}} [options]
 *   - env：查的时候用的环境（默认当时的 process.env）
 *   - reverifyMs：结果靠登录 shell 才找得到（或没找到）时，进页面隔多久在后台再核一次（默认 5 秒）
 * @returns {{peek: () => {info: object|null, checking: boolean}, status: () => Promise<object>, recheck: () => Promise<object>,
 *   knownBin: (env?: object) => string|null|undefined, stop: () => void}} stop 之后还在跑的那次结果不再记、不再写
 */
function createClaudeCheck({ env = () => process.env, reverifyMs = 5000 } = {}) {
  // memo：本次运行查过的结果 { bin, fingerprint, info, at }
  let memo = null
  // inflight：正在查的那次 { gen, quickFp, abort }；gen 不是最新的那次查完不算数
  let inflight = null
  let gen = 0
  let stopped = false
  // 等结果的人：最新那次查完（或注销）时一起放行，不跟着被作废的旧那次等
  let waiters = []

  const settle = () => {
    const info = memo ? memo.info : infoFor(null)
    const list = waiters
    waiters = []
    for (const resolve of list) resolve(info)
  }

  /** 开一次后台查；之前那次还在跑的作废（连同它起的子进程） */
  const start = () => {
    if (stopped) return
    if (inflight) inflight.abort.abort()
    const e = env()
    const file = recordFile()
    const me = { gen: ++gen, quickFp: claudeCli.claudeFingerprint(claudeCli.locateClaudeQuick(e)), abort: new AbortController() }
    inflight = me
    ;(async () => {
      let next
      try {
        const bin = await claudeCli.locateClaudeAsync(e, { signal: me.abort.signal })
        // 指纹在查版本之前取：查的这份就是指纹对应的那份
        const fingerprint = claudeCli.claudeFingerprint(bin)
        const version = bin ? (await claudeCli.checkClaudeVersionAsync(bin, e, { signal: me.abort.signal })).current : null
        next = { bin, fingerprint, info: infoFor(bin, version), version }
      } catch {
        next = { bin: null, fingerprint: null, info: infoFor(null), version: null }
      }
      if (me.gen !== gen || stopped) return
      memo = { bin: next.bin, fingerprint: next.fingerprint, info: next.info, at: Date.now() }
      if (next.bin && next.fingerprint && next.version) writeRecord(file, next.bin, next.fingerprint, next.version)
      inflight = null
      settle()
    })()
  }

  /**
   * 进页面用：马上返回，不跑任何命令（只看文件状态）
   * - 本次查过且指纹没变：给本次结果；这份结果不是常见位置找到的（靠 shell 找到或没找到），隔一会儿在后台再核一次
   * - 本次还没查过、存下的记录指纹对得上：给记录里的结果，后台再核一次
   * - 都对不上：info 为 null，后台查
   * @returns {{info: object|null, checking: boolean}}
   */
  const peek = () => {
    const e = env()
    const quickBin = claudeCli.locateClaudeQuick(e)
    if (memo) {
      const bin = quickBin || memo.bin
      if (claudeCli.claudeFingerprint(bin) === memo.fingerprint) {
        // 常见位置找不到时，指纹只能看出旧文件没变，看不出 shell 里换了路径、刚装好：后台再问一次 shell
        if (!quickBin && !inflight && Date.now() - memo.at >= reverifyMs) start()
        return { info: memo.info, checking: Boolean(inflight) }
      }
    } else {
      const rec = readRecord()
      if (rec && claudeCli.claudeFingerprint(quickBin || rec.bin) === rec.fingerprint) {
        if (!inflight) start()
        return { info: infoFor(rec.bin, rec.version), checking: true }
      }
    }
    // 对不上：正在跑的那次如果查的不是现在这份（跑到一半升级了），作废重查
    if (!inflight || inflight.quickFp !== claudeCli.claudeFingerprint(quickBin)) start()
    return { info: null, checking: true }
  }

  /** 等到最新那次查完，返回结果；没在查、本次也还没结果就先开一次 */
  const status = () => {
    if (!memo && !inflight) start()
    if (!inflight) return Promise.resolve(memo ? memo.info : infoFor(null))
    return new Promise((resolve) => { waiters.push(resolve) })
  }

  /** 重新检测：不用任何旧结果，重查一次 */
  const recheck = () => {
    start()
    return status()
  }

  /**
   * 不问 shell 就知道的 claude 位置（给审核配置刷新用，免得它在主进程里同步等登录 shell）
   * @param {object} [e]
   * @returns {string|null|undefined} 路径；null = 本次查过、确实没找到；undefined = 不知道，调用方自己找
   */
  const knownBin = (e = env()) => {
    const quick = claudeCli.locateClaudeQuick(e)
    if (quick) return quick
    if (!memo) return undefined
    if (!memo.bin) return null
    return claudeCli.claudeFingerprint(memo.bin) === memo.fingerprint ? memo.bin : undefined
  }

  /** 通道注销时调用：正在跑的那次作废，等着的人拿到现有结果 */
  const stop = () => {
    stopped = true
    gen += 1
    if (inflight) inflight.abort.abort()
    inflight = null
    settle()
  }

  return { peek, status, recheck, knownBin, stop }
}

module.exports = { createClaudeCheck, recordFile }
