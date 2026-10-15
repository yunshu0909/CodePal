/** @vitest-environment node
 * v2.1.25 · 旧的 dev 插件状态读取（v2.1.17 起服务审核规则页签顶部那一行）随那一行一起下线（后-21、B-012）。
 * 插件状态改由插件管理的 electron/modules/devPlugin/state.js 读，测试见 tests/devPlugin/devPluginState.test.js。
 * 本任务只断开全部引用；模块文件在合并后的收尾提交里删除（dev-workflow 任务内不能删文件，D42，照以往下线模块的先例）。
 */
import { expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** electron/ 与 src/ 下的源码文件（不含旧模块自己） */
function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(full)
    return /\.(c?js|jsx|mjs)$/.test(entry.name) ? [full] : []
  })
}

it('TC-101 旧 devStatus 模块不再被任何生产代码引用，reviewCenter 不再读它', () => {
  const self = path.join(root, 'electron/modules/models/devStatus.js')
  const hits = [...sourceFiles(path.join(root, 'electron')), ...sourceFiles(path.join(root, 'src'))]
    .filter((file) => file !== self && /devStatus|readDevStatus/.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(root, file))
  expect(hits).toEqual([])
})
