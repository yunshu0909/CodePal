/**
 * DSH 用量扫描 worker 入口（运行在 Electron utilityProcess 中）
 *
 * 为什么需要独立进程：本机真实主进程实测发现，在一次重日重算之后紧接着做 DSH 扫描，
 * Electron 原生层会以 SIGTRAP 终止（JS 无法捕获、无 V8 报错）。把解压放到独立进程后，
 * 即使该进程崩溃，主进程也能存活并降级为「本次没有 DSH 数据」。
 *
 * 协议：父进程 postMessage({ id, start, end, homeDir })；
 * 本进程回 { id, ok: true, records } 或 { id, ok: false, error }。
 * 时间戳以 ISO 字符串跨进程，由客户端还原为 Date。
 *
 * @module electron/services/dshUsageWorker
 */

const { scanDshLogsInProcess } = require('./usageLogScanService')

/**
 * 处理一条扫描请求
 * @param {{id: number, start: string, end: string, homeDir: string}} message - 请求
 * @returns {Promise<{id: number, ok: boolean, records?: Array, error?: string}>} 响应
 */
async function handleDshScanRequest(message) {
  try {
    const records = await scanDshLogsInProcess(new Date(message.start), new Date(message.end), {
      homeDir: message.homeDir,
      ...(message.strictScan ? {strictScan:true} : {}),
      ...(message.strictScan ? {pathExistsFn:async path=>{
        try {await require('fs/promises').access(path);return true}
        catch(error){if(error.code==='ENOENT')return false;throw error}
      }} : {}),
    })

    return {
      id: message.id,
      ok: true,
      records: records.map((record) => ({ ...record, timestamp: record.timestamp.toISOString() })),
    }
  } catch (error) {
    return { id: message.id, ok: false, error: error?.message || 'DSH_WORKER_FAILED' }
  }
}

/**
 * 绑定父进程消息通道
 * @param {object} parentPort - Electron utilityProcess 的 parentPort
 */
function attachDshWorker(parentPort) {
  parentPort.on('message', async (event) => {
    const message = event?.data
    if (!message || typeof message.id === 'undefined') return

    const response = await handleDshScanRequest(message)

    try {
      parentPort.postMessage(response)
    } catch {
      // 父进程已退出：丢弃结果即可
    }
  })
}

if (process.parentPort) {
  attachDshWorker(process.parentPort)
}

module.exports = { handleDshScanRequest, attachDshWorker }
