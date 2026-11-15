/** One short-lived, read-only process inside the existing Claude network restrictions. */
const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const net = require('net')
const { spawn } = require('child_process')

function proxyReady(port, signal) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    let done = false
    const finish = value => {
      if (done) return
      done = true
      signal?.removeEventListener('abort', abort)
      socket.destroy()
      resolve(value)
    }
    const abort = () => finish(false)
    signal?.addEventListener('abort', abort, { once: true })
    socket.setTimeout(1200, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    if (signal?.aborted) finish(false)
  })
}

async function findPython() {
  for (const file of ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3']) {
    try { await fs.access(file, fs.constants.X_OK); return file } catch { /* Try the next installed Python. */ }
  }
  throw Error('PYTHON_UNAVAILABLE')
}

async function runProbe({ metadata, signal }) {
  const empty = { proxyReady: false, isolationActive: false, egress: {}, dns: {} }
  if (!await proxyReady(metadata.proxyPort, signal)) return empty
  if (signal?.aborted) throw Error('PROBE_CANCELLED')
  const python = await findPython()
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'codepal-claude-probe-'))
  try {
    const profile = path.join(temporary, 'readonly.sb')
    await fs.writeFile(profile, `${metadata.profile}\n(deny file-write* (subpath ${JSON.stringify(metadata.homeDir)}))\n`, { mode: 0o600 })
    const script = path.join(__dirname.replace(/app\.asar(?=[/\\])/, 'app.asar.unpacked'), 'network_probe.py')
    const proxy = `http://127.0.0.1:${metadata.proxyPort}`
    // Credentials from the Electron environment are deliberately not inherited.
    const env = { PATH: '/usr/bin:/bin:/opt/homebrew/bin', LANG: 'en_US.UTF-8', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PYTHONIOENCODING: 'utf-8', HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, all_proxy: proxy, NO_PROXY: '', no_proxy: '' }
    return await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/sandbox-exec', ['-f', profile, python, script, '--dns-port', String(metadata.dnsPort)], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      let diagnostics = ''
      let failure = null
      const timeout = setTimeout(() => { failure = 'PROBE_TIMEOUT'; child.kill('SIGTERM') }, 45000)
      const abort = () => { failure = 'PROBE_CANCELLED'; child.kill('SIGTERM') }
      signal?.addEventListener('abort', abort, { once: true })
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(0, 2048) })
      child.stdout.on('data', chunk => {
        output += chunk
        if (output.length > 65536) { failure = 'PROBE_OUTPUT_INVALID'; child.kill('SIGTERM') }
      })
      child.once('error', () => { failure = 'PROBE_UNAVAILABLE' })
      child.once('close', code => {
        clearTimeout(timeout)
        signal?.removeEventListener('abort', abort)
        if (failure || code !== 0) {
          const error = Error(failure || `PROBE_EXIT_${Number.isInteger(code) ? code : 'UNKNOWN'}`)
          // For local diagnostics only; IPC exposes fixed public errors, never this text.
          error.diagnostics = diagnostics.replaceAll(metadata.homeDir, '~')
          return reject(error)
        }
        try { resolve({ ...JSON.parse(output), proxyReady: true }) } catch { reject(Error('PROBE_OUTPUT_INVALID')) }
      })
      if (signal?.aborted) abort()
    })
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
}

module.exports = { runProbe, proxyReady }
