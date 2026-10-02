/**
 * 新建项目配置
 *
 * 负责：给主进程一个稳定的引用点——模板目录名、Git 三档与名称规则。
 * Git 三档、名称规则与「会生成什么」的唯一来源是 shared/projectInitManifest.mjs（主进程和页面共用），这里只转出。
 *
 * @module electron/config/projectInitConfig
 */

const manifest = require('../../shared/projectInitManifest.mjs')

/** 模板目录：templates/<这个名字>/ */
const PROJECT_INIT_TEMPLATE_DIR = 'project-init-v4'

const SUPPORTED_GIT_MODES = new Set(manifest.GIT_MODES)
const PROJECT_NAME_INVALID_CHARS = manifest.INVALID_NAME_CHARS

module.exports = {
  PROJECT_INIT_TEMPLATE_DIR,
  SUPPORTED_GIT_MODES,
  PROJECT_NAME_INVALID_CHARS,
}
