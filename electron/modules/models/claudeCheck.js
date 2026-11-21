/**
 * 第三方模型接入 · Claude Code 版本检查（后台查，不卡主进程）
 *
 * 负责：
 * - 进页面时马上给出「能用的上次结果」或「还没结果」，不等 `claude --version`（#99：本机要 3 秒）
 * - 后台查：找 claude、查版本都在子进程里；同一时间只有一次有效的查，重新检测会让旧的那次作废
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

/** 存一条；写不进不影响页面（下次重开再查一遍而已） */
function writeRecord(bin, fingerprint, version) {
  try {
    const rec = { schema: RECORD_SCHEMA, bin, fingerprint, version, at: new Date().toISOString() }
    store.writePrivate(recordFile(), `${JSON.stringify(rec, null, 2)}\n`)
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
 * @param {{env?: () => object}} [options] - env：查的时候用的环境（默认当时的 process.env）
 * @returns {{peek: () => {info: object|null, checking: boolean}, status: () => Promise<object>, recheck: () => Promise<object>}}
 */
function createClaudeCheck({ env = () => process.env } = {}) {
  // memo：本次运行查过的结果 { bin, fingerprint, info }
  let memo = null
  // inflight：正在查的那次 { gen, quickFp, promise }；gen 不是最新的那次查完不算数
  let inflight = null
  let gen = 0

  const quickFingerprint = (e) => claudeCli.claudeFingerprint(claudeCli.locateClaudeQuick(e))

  /** 开一次后台查；之前那次还在跑的作废 */
  const start = () => {
    const e = env()
    const me = { gen: ++gen, quickFp: quickFingerprint(e) }
    me.promise = (async () => {
      let next
      try {
        const bin = await claudeCli.locateClaudeAsync(e)
        // 指纹在查版本之前取：查的这份就是指纹对应的那份
        const fingerprint = claudeCli.claudeFingerprint(bin)
        const version = bin ? (await claudeCli.checkClaudeVersionAsync(bin, e)).current : null
        next = { bin, fingerprint, info: infoFor(bin, version), version }
      } catch {
        next = { bin: null, fingerprint: null, info: infoFor(null), version: null }
      }
      if (me.gen !== gen) return
      memo = { bin: next.bin, fingerprint: next.fingerprint, info: next.info }
      if (next.bin && next.fingerprint && next.version) writeRecord(next.bin, next.fingerprint, next.version)
      inflight = null
    })()
    inflight = me
  }

  /**
   * 进页面用：马上返回，不跑任何命令（只看文件状态）
   * - 本次查过且指纹没变：给本次结果
   * - 本次还没查过、存下的记录指纹对得上：给记录里的结果，后台再核一次
   * - 都对不上：info 为 null，后台查
   * @returns {{info: object|null, checking: boolean}}
   */
  const peek = () => {
    const e = env()
    const quickBin = claudeCli.locateClaudeQuick(e)
    if (memo) {
      const bin = quickBin || memo.bin
      if (claudeCli.claudeFingerprint(bin) === memo.fingerprint) return { info: memo.info, checking: Boolean(inflight) }
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

  /** 等到最新那次查完，返回结果 */
  const status = async () => {
    if (!memo && !inflight) start()
    while (inflight) await inflight.promise
    return memo ? memo.info : infoFor(null)
  }

  /** 重新检测：不用任何旧结果，重查一次 */
  const recheck = () => {
    start()
    return status()
  }

  return { peek, status, recheck }
}

module.exports = { createClaudeCheck, recordFile }
