/** Read the existing Claude-only installation; private configuration never crosses IPC. */
const fs = require('fs/promises')
const path = require('path')
const os = require('os')
const net = require('net')
const crypto = require('crypto')

async function readSmall(file) {
  const stat = await fs.stat(file)
  if (!stat.isFile() || stat.size > 262144) throw Error('INVALID_CONFIGURATION')
  return fs.readFile(file, 'utf8')
}

/** Paths are derived from a trusted home, never accepted from the renderer. */
async function inspectEnvironment({ homeDir = os.homedir(), platform = process.platform } = {}) {
  if (platform !== 'darwin') return { supported: false, available: false, reason: 'unsupported' }
  const root = path.join(homeDir, 'Library/Application Support/Claude-US')
  const paths = { root, profile: path.join(root, 'network.sb'), launcher: path.join(root, 'launcher.py') }
  try {
    const [metaText, profile, launcher] = await Promise.all([
      readSmall(path.join(root, 'installation.json')), readSmall(paths.profile), readSmall(paths.launcher),
    ])
    const metadata = JSON.parse(metaText)
    const proxyPort = metadata.http_proxy_port
    const dnsPort = metadata.dns_port
    if (![proxyPort, dnsPort].every(value => Number.isInteger(value) && value > 0 && value < 65536)) throw Error('INVALID_CONFIGURATION')
    if (!net.isIP(metadata.expected_exit_ip) || metadata.expected_country !== 'US') throw Error('INVALID_CONFIGURATION')
    if (!profile.includes('(deny network*)') || !launcher.includes('sandbox-exec')) throw Error('INVALID_CONFIGURATION')
    let entryManaged = false
    try {
      entryManaged = await fs.realpath(path.join(homeDir, '.local/bin/claude')) === await fs.realpath(paths.launcher)
    } catch { /* A missing or replaced ordinary entry remains a visible warning. */ }
    return {
      supported: true, available: true, reason: null, paths, profile, homeDir,
      proxyPort, dnsPort, expectedIp: metadata.expected_exit_ip, entryManaged,
      fingerprint: crypto.createHash('sha256').update(metaText).update(profile).update(launcher).update(String(entryManaged)).digest('hex'),
    }
  } catch (error) {
    return { supported: true, available: false, reason: error.code === 'ENOENT' ? 'missing' : 'configuration' }
  }
}

module.exports = { inspectEnvironment }
