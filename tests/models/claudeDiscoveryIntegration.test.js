/** @vitest-environment node */
import { expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { REPO, CLI } from './helpers'

it('TC-004 installation and removal refresh both consumers and the CLI uses the same discovery', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-consumers-'))
  try {
    // A preload isolates system locations and shell startup, but leaves the production locator intact.
    const preload = path.join(home, 'isolate.cjs')
    fs.writeFileSync(preload, `
      const fs = require('fs');
      const originalStat = fs.statSync;
      fs.statSync = function(file, ...args) {
        if (['/opt/homebrew/bin/claude', '/usr/local/bin/claude'].includes(file)) throw new Error('isolated');
        return originalStat.call(this, file, ...args);
      };
      const cp = require('child_process');
      const originalSpawn = cp.spawnSync;
      cp.spawnSync = function(file, args, opts) {
        if (args && (args[0] === '-lc' || args[0] === '-ilc')) return { status: 1, stdout: '' };
        return originalSpawn(file, args, opts);
      };
    `)
    const script = `
      const fs = require('fs');
      const path = require('path');
      const { registerModelsHandlers } = require('./electron/modules/models/ipc');
      const { discoverSubscriptions } = require('./electron/modules/models/subscriptions');
      const handlers = {};
      const lifecycle = registerModelsHandlers({
        ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
        getMainWindow: () => null,
        loginPath: () => '',
        hubOptions: { homeDir: process.env.HOME, locateCodex: () => null }
      });
      (async () => {
        const before = (await handlers['models:list']()).data.claudeCode;
        const subBefore = discoverSubscriptions({ locateCodex: () => null })[0].blocked;
        const bin = path.join(process.env.HOME, '.local/bin/claude');
        fs.mkdirSync(path.dirname(bin), { recursive: true });
        fs.writeFileSync(bin, '#!/bin/sh\\nprintf "2.1.310 (Claude Code)\\\\n"\\n', { mode: 0o755 });
        const after = handlers['models:recheckClaude']().data;
        const subAfter = discoverSubscriptions({ locateCodex: () => null })[0].blocked;
        const cli = require('child_process').spawnSync(process.execPath,
          ['--require', process.env.TEST_PRELOAD, ${JSON.stringify(CLI)}, 'launch', 'deepseek', '@first', '--', '--version'],
          { env: process.env, encoding: 'utf8', timeout: 10000 });
        fs.unlinkSync(bin);
        const removed = handlers['models:recheckClaude']().data;
        const subRemoved = discoverSubscriptions({ locateCodex: () => null })[0].blocked;
        lifecycle.stop();
        console.log(JSON.stringify({ before, subBefore, after, subAfter, removed, subRemoved, cliStatus: cli.status, cliOut: cli.stdout }));
      })().catch(e => { lifecycle.stop(); console.error(e.message); process.exitCode = 1; });
    `
    const result = spawnSync(process.execPath, ['--require', preload, '-e', script], {
      cwd: REPO,
      env: { HOME: home, PATH: '/usr/bin:/bin', CODEPAL_MODELS_HOME: path.join(home, 'models'), CODEPAL_BIN_DIR: path.join(home, 'commands'), TEST_PRELOAD: preload },
      encoding: 'utf8', timeout: 15000,
    })
    expect(result.status, result.stderr).toBe(0)
    const data = JSON.parse(result.stdout.trim().split('\n').pop())
    expect(data.before.found).toBe(false)
    expect(data.subBefore).toBe('notInstalled')
    expect(data.after).toMatchObject({ found: true, version: '2.1.310', tooOld: false })
    expect(data.subAfter).toBe('notLoggedIn')
    expect(data.cliStatus).toBe(0)
    expect(data.cliOut).toContain('2.1.310')
    expect(data.removed.found).toBe(false)
    expect(data.subRemoved).toBe('notInstalled')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
