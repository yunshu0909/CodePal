/** Permission-aware transcript index. File versions are verified on every query, including a process restart. */
const fs = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const readline = require('readline')
const { Readable } = require('stream')
const { parseTranscript, PARSER_VERSION } = require('./usageEvidence')

/**
 * @param {string} file - 主进程解析的私有元数据路径。
 * @param {*} fallback - 文件缺失或 JSON 损坏时的返回值。
 * @returns {Promise<*>} 只读结果；权限等真实读取错误继续抛出。
 */
async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return fallback
    throw error
  }
}
/**
 * @param {string} file - 新统计存储中的目标路径。
 * @param {object} value - 只含元数据的可序列化对象。
 * @returns {Promise<void>} 私有临时文件写入、同步后原子替换；失败保留原文件。
 */
async function writeAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await fs.chmod(path.dirname(file), 0o700)
  const temp = file + '.' + crypto.randomUUID() + '.tmp'
  let handle
  try {
    handle = await fs.open(temp, 'wx', 0o600)
    await handle.writeFile(JSON.stringify(value) + '\n')
    await handle.sync()
    await handle.close()
    handle = null
    await fs.rename(temp, file)
    const directory = await fs.open(path.dirname(file), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } finally {
    if (handle) await handle.close().catch(() => {})
    await fs.rm(temp, { force: true }).catch(() => {})
  }
}
/**
 * @param {string} file - 主进程发现的日志路径。
 * @returns {Promise<object|null>} 路径/身份/大小/时间/权限版本；非文件返回 null。
 * 每次实际检查权限，不读取正文；不可读时抛出。
 */
async function fileVersion(file) {
  const [stat, realPath] = await Promise.all([fs.stat(file, { bigint: true }), fs.realpath(file)])
  if (!stat.isFile()) return null
  if ((stat.mode & 0o444n) === 0n) throw Object.assign(new Error('UNREADABLE'), { code: 'EACCES' })
  await fs.access(file, fs.constants.R_OK)
  return {
    realPath,
    size: Number(stat.size),
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: String(stat.mode),
    signature: [
      realPath,
      stat.dev,
      stat.ino,
      stat.size,
      stat.mtimeNs,
      stat.ctimeNs,
      stat.mode,
    ].join(':'),
  }
}
/** Verify a finite appended suffix is outside this query window; never chase subsequent growth. */
async function verifyAppend(file, after, proof, endTime, scanMeta) {
  if (
    !after ||
    after.realPath !== file.realPath ||
    after.device !== file.device ||
    after.inode !== file.inode ||
    after.mode !== file.mode ||
    after.size <= file.size ||
    !Number.isFinite(Date.parse(endTime))
  )
    return false
  // The entire bounded prefix must match: unchanged tail bytes alone cannot exclude an earlier rewrite.
  const prefixHash = crypto.createHash('sha256')
  const buffer = Buffer.alloc(256 * 1024)
  let offset = 0
  while (offset < file.size) {
    const length = Math.min(buffer.length, file.size - offset)
    const { bytesRead } = await proof.openHandle.read(buffer, 0, length, offset)
    scanMeta.bodyBytes += bytesRead
    if (bytesRead !== length) return false
    prefixHash.update(buffer.subarray(0, bytesRead))
    offset += bytesRead
  }
  if (prefixHash.digest('hex') !== proof.snapshotHash) return false
  const appended = proof.openHandle.createReadStream({
    start: file.size,
    end: after.size - 1,
    autoClose: false,
  })
  appended.on('data', (chunk) => {
    scanMeta.bodyBytes += chunk.length
  })
  async function* chunks() {
    if (proof.unfinishedText) yield Buffer.from(proof.unfinishedText)
    for await (const chunk of appended) yield chunk
  }
  const input = Readable.from(chunks())
  const reader = readline.createInterface({ input, crlfDelay: Infinity })
  let valid = true
  try {
    for await (const text of reader) {
      if (!text.trim()) continue
      let row
      try {
        row = JSON.parse(text)
      } catch {
        valid = false
        break
      }
      const at = row.timestamp || row.created_at || row.at
      if (!Number.isFinite(Date.parse(at)) || Date.parse(at) <= Date.parse(endTime)) {
        valid = false
        break
      }
    }
  } finally {
    reader.close()
    input.destroy()
    appended.destroy()
  }
  const finalVersion = await fileVersion(file.path)
  return valid && finalVersion?.signature === after.signature
}
async function enumerate(root, tool, meta) {
  const files = []
  const errors = []
  const walk = async (directory) => {
    let names
    meta.directoryChecks += 1
    try {
      const stat = await fs.stat(directory)
      if ((stat.mode & 0o444) === 0)
        throw Object.assign(new Error('UNREADABLE'), { code: 'EACCES' })
      names = await fs.readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error.code !== 'ENOENT')
        errors.push({ tool, relativePath: path.relative(root, directory), directory: true })
      return
    }
    for (const name of names) {
      const file = path.join(directory, name.name)
      if (name.isDirectory()) await walk(file)
      else if (name.name.endsWith('.jsonl')) {
        const relativePath = path.relative(root, file).split(path.sep).join('/')
        meta.metadataChecks += 1
        meta.accessChecks += 1
        try {
          const version = await fileVersion(file)
          if (version) files.push({ tool, path: file, relativePath, ...version })
        } catch {
          errors.push({ tool, relativePath, directory: false })
        }
      }
    }
  }
  await walk(root)
  return { files, errors }
}
/**
 * @param {object} registry - 当前资产及工具日志根。
 * @param {object} deps - 有界解析依赖。
 * @param {object} options - 规则版本、快照终点和候选存储预算。
 * @returns {Promise<object>} 当前完整解析、不可读范围和真实 I/O 计数。
 * 每次重新枚举并核对权限/版本；预算与活跃文件只影响持久化，不截断结果。
 */
async function readIndexedFiles(registry, deps, options) {
  const meta = {
    bodyOpens: 0,
    bodyBytes: 0,
    directoryChecks: 0,
    metadataChecks: 0,
    accessChecks: 0,
    unpersistedFiles: 0,
    unstableFiles: 0,
    historyWrites: 0,
    indexWrites: 0,
    indexCoverage: 1,
  }
  const version = options.parserVersion || PARSER_VERSION
  const indexPath = path.join(registry.storeDir, 'index.json')
  let previous = { version, entries: {} }
  try {
    const index = await readJson(indexPath, null)
    if (index?.version === version && index.entries && typeof index.entries === 'object')
      previous = index
  } catch {
    /* index is expendable: full current parsing remains authoritative */
  }
  const enumerated = await Promise.all(
    Object.entries(registry.roots).map(([tool, root]) => enumerate(root, tool, meta))
  )
  const files = enumerated
    .flatMap((entry) => entry.files)
    .sort((a, b) => (a.tool + a.relativePath).localeCompare(b.tool + b.relativePath))
  const errors = enumerated.flatMap((entry) => entry.errors)
  const entries = {}
  const parsed = []
  const perFileBudget = options.maxCandidatesPerFile ?? 10000
  const globalBudget = options.maxCandidatesTotal ?? 250000
  let storedCandidates = 0
  for (const file of files) {
    const key = file.tool + ':' + file.relativePath
    const hit = previous.entries[key]
    let proof
    let stable = true
    let change = null
    const validHit =
      hit?.proof?.meta &&
      Array.isArray(hit?.proof?.candidates) &&
      hit.proofDigest ===
        crypto.createHash('sha256').update(JSON.stringify(hit.proof)).digest('hex')
    if (!options.indexDisabled && hit?.signature === file.signature && validHit) proof = hit.proof
    else {
      meta.bodyOpens += 1
      meta.bodyBytes += file.size
      try {
        proof = await parseTranscript(file, deps)
      } catch {
        errors.push({ tool: file.tool, relativePath: file.relativePath, directory: false })
        continue
      }
      try {
        const after = await fileVersion(file.path)
        stable = after?.signature === file.signature
        if (!stable && (await verifyAppend(file, after, proof, options.snapshotEndTime, meta))) {
          change = 'append-after-window'
          if (proof.unfinishedText) proof.invalidLines -= 1
        }
      } catch {
        stable = false
      } finally {
        await proof.openHandle.close().catch(() => {})
        delete proof.openHandle
        delete proof.unfinishedText
      }
      if (!stable) meta.unstableFiles += 1
    }
    parsed.push({ ...file, proof, stable, change, meta: proof.meta })
    const count = proof.candidates.length
    if (stable && count <= perFileBudget && storedCandidates + count <= globalBudget) {
      entries[key] = {
        signature: file.signature,
        proof,
        proofDigest: crypto.createHash('sha256').update(JSON.stringify(proof)).digest('hex'),
      }
      storedCandidates += count
    } else meta.unpersistedFiles += 1
  }
  meta.indexCoverage = files.length ? (files.length - meta.unpersistedFiles) / files.length : 1
  if (!options.indexDisabled && JSON.stringify(entries) !== JSON.stringify(previous.entries)) {
    try {
      await writeAtomic(indexPath, { version, entries })
      meta.indexWrites = 1
    } catch {
      meta.indexWriteFailed = true
    }
  }
  const unavailable = errors.map((error) => ({
    ...error,
    cached: previous.entries[error.tool + ':' + error.relativePath]?.proof || null,
  }))
  return { files: parsed, unavailable, scanMeta: meta, version }
}
module.exports = { readIndexedFiles, readJson, writeAtomic, fileVersion }
