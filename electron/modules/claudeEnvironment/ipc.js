/** Claude environment IPC accepts only settings, never paths or executable names. */
const { createClaudeEnvironmentService } = require('./service')

function registerClaudeEnvironmentHandlers({ ipcMain, store, getWindow, notify, service: suppliedService }) {
  const service = suppliedService || createClaudeEnvironmentService({ store, notify, isWindowFocused: () => {
    const window = getWindow()
    return Boolean(window && !window.isDestroyed() && window.isFocused())
  } })
  const ok = data => ({ success: true, data, error: null })
  const fail = code => ({ success: false, data: null, error: { code, message: code === 'ENVIRONMENT_UNAVAILABLE' ? '需先接入受支持的 Claude 专用环境' : code === 'PREFERENCES_FAILED' ? '监测设置没有保存，原设置保持不变' : '暂时无法读取环境状态，请重试' } })
  const handle = (channel, action) => ipcMain.handle(channel, async (_event, value) => {
    try { return ok(await action(value)) } catch (error) {
      return fail(['ENVIRONMENT_UNAVAILABLE', 'PREFERENCES_FAILED', 'INVALID_INPUT'].includes(error.message) ? error.message : 'ENVIRONMENT_READ_FAILED')
    }
  })
  handle('claude-environment:read', () => service.readState())
  handle('claude-environment:probe', () => service.sampleOnce())
  handle('claude-environment:set-monitoring', value => service.setMonitoring(value))
  handle('claude-environment:set-foreground', value => { service.setForeground(value); return null })
  const unsubscribe = service.subscribe(state => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send('claude-environment:state', state)
  })
  return { ...service, dispose: async () => { unsubscribe(); await service.dispose() } }
}

module.exports = { registerClaudeEnvironmentHandlers }
