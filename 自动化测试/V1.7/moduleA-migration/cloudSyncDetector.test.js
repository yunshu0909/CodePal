/**
 * 模块 A · 云盘检测 单元测试
 *
 * 覆盖：
 * - TC-010 macOS Library/CloudStorage 命中 + vendor 抽取
 * - TC-011 macOS Mobile Documents iCloud 命中
 * - TC-012 Windows OneDrive 命中（env 注入）
 * - TC-013 普通路径不命中
 * - 边界：跨平台、目录边界（不把 LibraryFoo 错认为 Library 子目录）
 *
 * @module 自动化测试/V1.7/moduleA-migration/cloudSyncDetector.test
 */

const { detectCloudSync } = require('../../../electron/services/cloudSyncDetector')

describe('模块 A · cloudSyncDetector.detectCloudSync', () => {
  // TC-010
  test('TC-010 macOS Library/CloudStorage/Dropbox 命中 vendor=Dropbox', () => {
    const result = detectCloudSync(
      '/Users/test/Library/CloudStorage/Dropbox-Personal/codex-switcher',
      { platform: 'darwin', home: '/Users/test' },
    )
    expect(result).toEqual({ sync: true, vendor: 'Dropbox' })
  })

  test('TC-010+ Library/CloudStorage/GoogleDrive-foo 命中 vendor=GoogleDrive', () => {
    const result = detectCloudSync(
      '/Users/test/Library/CloudStorage/GoogleDrive-foo/codex-switcher',
      { platform: 'darwin', home: '/Users/test' },
    )
    expect(result).toEqual({ sync: true, vendor: 'GoogleDrive' })
  })

  // TC-011
  test('TC-011 macOS Mobile Documents iCloud 命中 vendor=iCloud', () => {
    const result = detectCloudSync(
      '/Users/test/Library/Mobile Documents/com~apple~CloudDocs/codex-switcher',
      { platform: 'darwin', home: '/Users/test' },
    )
    expect(result).toEqual({ sync: true, vendor: 'iCloud' })
  })

  test('macOS 旧 Dropbox 客户端 ~/Dropbox 命中', () => {
    const result = detectCloudSync(
      '/Users/test/Dropbox/codex-switcher',
      { platform: 'darwin', home: '/Users/test' },
    )
    expect(result).toEqual({ sync: true, vendor: 'Dropbox' })
  })

  // TC-012
  test('TC-012 Windows OneDrive env 注入命中', () => {
    const result = detectCloudSync(
      'C:\\Users\\test\\OneDrive\\codex-switcher',
      { platform: 'win32', env: { OneDrive: 'C:\\Users\\test\\OneDrive' } },
    )
    expect(result).toEqual({ sync: true, vendor: 'OneDrive' })
  })

  test('Windows OneDriveCommercial（企业版）env 注入命中', () => {
    const result = detectCloudSync(
      'C:\\Users\\test\\OneDrive - ACME\\codex-switcher',
      { platform: 'win32', env: { OneDriveCommercial: 'C:\\Users\\test\\OneDrive - ACME' } },
    )
    expect(result.sync).toBe(true)
    expect(result.vendor).toBe('OneDrive')
  })

  test('Windows OneDrive 大小写不敏感', () => {
    const result = detectCloudSync(
      'c:\\Users\\test\\onedrive\\codex-switcher',
      { platform: 'win32', env: { OneDrive: 'C:\\Users\\test\\OneDrive' } },
    )
    expect(result.sync).toBe(true)
  })

  // TC-013
  test('TC-013 macOS 普通 ~/.codex-switcher 不命中', () => {
    const result = detectCloudSync(
      '/Users/test/.codex-switcher',
      { platform: 'darwin', home: '/Users/test' },
    )
    expect(result).toEqual({ sync: false })
  })

  test('macOS Library 但不是云盘子目录不命中', () => {
    const result = detectCloudSync(
      '/Users/test/Library/Application Support/codex-switcher',
      { platform: 'darwin', home: '/Users/test' },
    )
    expect(result).toEqual({ sync: false })
  })

  test('目录边界严格：/Users/test/Dropbox-Personal 不被 ~/Dropbox 误匹配', () => {
    // ~/Dropbox-Personal 不应该被 ~/Dropbox 前缀误匹配（不同目录）
    const result = detectCloudSync(
      '/Users/test/DropboxPersonal/codex-switcher',
      { platform: 'darwin', home: '/Users/test' },
    )
    expect(result).toEqual({ sync: false })
  })

  test('Linux 平台无规则一律不命中', () => {
    const result = detectCloudSync(
      '/home/test/Dropbox/codex-switcher',
      { platform: 'linux', home: '/home/test' },
    )
    expect(result).toEqual({ sync: false })
  })

  test('空路径返 sync=false（不抛）', () => {
    expect(detectCloudSync('')).toEqual({ sync: false })
    expect(detectCloudSync(null)).toEqual({ sync: false })
  })
})
