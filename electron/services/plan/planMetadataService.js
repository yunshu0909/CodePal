/**
 * Read-only local subscription metadata.
 * - Credential bytes stay in the main process; return three safe fields only.
 * - Bounded keychain/file readers and unknown fallback on any failure.
 * @module electron/services/plan/planMetadataService
 */
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path');
const {
  execFile
} = require('node:child_process');
const unknown = () => ({
  type: '未知',
  suggestedPrice: null,
  suggestedBillingDay: null
});
function claudeReader() {
  return new Promise((resolve, reject) => execFile('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
    timeout: 1500,
    maxBuffer: 1024 * 1024
  }, (err, stdout) => err ? reject(err) : resolve(stdout)));
}
async function codexReader() {
  const file = path.join(os.homedir(), '.codex', 'auth.json');
  const stat = await fs.stat(file);
  if (stat.size > 1024 * 1024) throw Error('METADATA_TOO_LARGE');
  return fs.readFile(file, 'utf8');
}
/** @param {'claude'|'codex'} planId CLI vendor. @param {object} deps Fake-reader seam and bounded platform-specific readers. @returns {Promise<object>} Safe display metadata, never credentials. */
async function readPlanMetadata(planId, {
  platform = process.platform,
  readClaudeFn = claudeReader,
  readCodexFn = codexReader,
  timeoutMs = 2000
} = {}) {
  if (planId !== 'claude' && planId !== 'codex') throw Error('INVALID_PLAN');
  if (planId === 'claude' && platform !== 'darwin') return unknown();
  let timer;
  try {
    const raw = await Promise.race([Promise.resolve().then(planId === 'claude' ? readClaudeFn : readCodexFn), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('METADATA_TIMEOUT')), timeoutMs);
    })]);
    if (typeof raw !== 'string' || raw.length > 1024 * 1024) return unknown();
    const data = JSON.parse(raw);
    if (planId === 'claude') {
      const kind = data?.claudeAiOauth?.subscriptionType;
      if (kind === 'pro') return {
        type: 'Pro',
        suggestedPrice: 20,
        suggestedBillingDay: null
      };
      if (kind === 'max') return {
        type: 'Max',
        suggestedPrice: null,
        suggestedBillingDay: null
      };
      return unknown();
    }
    const token = data?.tokens?.id_token;
    if (typeof token !== 'string' || token.length > 64 * 1024) return unknown();
    const part = token.split('.')[1];
    if (!part) return unknown();
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    const account = claims['https://api.openai.com/auth'];
    const kind = account?.chatgpt_plan_type;
    const allowed = new Set(['free', 'plus', 'pro', 'prolite', 'team', 'business', 'enterprise', 'edu']);
    if (!allowed.has(kind)) return unknown();
    const start = account.chatgpt_subscription_active_start;
    let day = null;
    if (typeof start === 'string' && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(start)) {
      const date = start.slice(0, 10);
      const instant = new Date(date + 'T00:00:00Z');
      if (Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === date) day = Number(date.slice(8));
    }
    return {
      type: kind,
      suggestedPrice: null,
      suggestedBillingDay: day
    };
  } catch {
    return unknown();
  } finally {
    clearTimeout(timer);
  }
}
module.exports = {
  readPlanMetadata
};
