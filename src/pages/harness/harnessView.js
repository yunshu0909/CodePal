/**
 * Harness 管理页视图模型
 *
 * 负责：
 * - 把主进程快照 + 页面本地状态（选中通道、进行中的按钮）归一成页面要渲染的结构
 * - 所有「显示什么、能不能点」的分支集中在这里，面板组件只负责渲染与事件
 *
 * 页面按快照里两条正交的轴组织：
 * - 运行卡 = 此刻谁在跑、能不能停
 * - 安装卡 = 装在哪、什么版本、怎么更新
 *
 * 行的值由片段组成：{ type: 'text'|'muted'|'mono'|'monoMuted'|'monoKeep'|'path'|'tag'|'channels', ... }
 * 动作：{ type: 'button', key, label, variant, loading, disabled } 或 { type: 'toggle', key, checked, disabled }
 *
 * @module pages/harness/harnessView
 */

/** 更新通道 → 中文短名 */
export const CHANNEL_LABEL = { latest: '稳定', next: '预览' }

/** install.runtimeDir 恒为 <home>/Documents/SkillManager/runtimes/dsh，据此推出主目录 */
const RUNTIME_SUFFIX = '/Documents/SkillManager/runtimes/dsh'

const PLATFORM_NAME = { win32: 'Windows' }

const text = (value) => ({ type: 'text', value })
const muted = (value) => ({ type: 'muted', value })
const mono = (value) => ({ type: 'mono', value: String(value) })
const tag = (value, variant = 'default') => ({ type: 'tag', value, variant })
const row = (id, label, value = [], options = {}) => ({ id, label, value, action: [], note: null, setting: false, ...options })
const actionButton = (key, label, { variant = 'secondary', pendingKeys, disabled = false, pendingKey = key } = {}) => ({
  type: 'button', key, label, variant, loading: pendingKeys.has(pendingKey), disabled,
})

/** 主目录前缀替换成 ~；推不出主目录时原样返回 */
export function displayPath(full, runtimeDir) {
  if (typeof full !== 'string' || full === '') return ''
  if (typeof runtimeDir !== 'string' || !runtimeDir.endsWith(RUNTIME_SUFFIX)) return full
  const home = runtimeDir.slice(0, -RUNTIME_SUFFIX.length)
  if (home && (full === home || full.startsWith(`${home}/`))) return `~${full.slice(home.length)}`
  return full
}

/** 地址只显示到端口；带一次性 token 的完整链接只用于打开与复制 */
export function displayOrigin(url) {
  if (typeof url !== 'string' || url === '') return null
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return null
  }
}

/**
 * @param {object} snapshot 主进程 harness:get-snapshot 的 data
 * @param {{ channel: 'latest'|'next', pendingKeys: Set<string>, copied: boolean }} ui
 */
export function buildHarnessView(snapshot, { channel = 'latest', pendingKeys = new Set(), copied = false } = {}) {
  const install = snapshot?.install || {}
  const runtime = snapshot?.runtime || {}
  const supervisor = snapshot?.supervisor || {}
  const source = snapshot?.source || {}
  const registry = snapshot?.registry || {}
  const node = snapshot?.node || {}
  const kind = install.kind || 'none'
  const running = Boolean(runtime.running)
  const platformOk = snapshot?.supportedPlatform !== false
  const underLaunchd = supervisor.kind === 'launchd'
  const notInstalled = kind === 'none' && !running
  const external = running && runtime.mode === 'external'
  const controllable = running && !external && (underLaunchd || runtime.mode === 'sidecar')
  /** A-026：只有 PATH 上的 dsh，没有源码 checkout 也没有系统服务，CodePal 启动它必然失败 */
  const pathOnly = kind === 'path' && !install.sourceVersion && !underLaunchd
  /** A-028：源码版由终端手动运行时只能打开 */
  const sourceExternal = kind === 'source' && external
  const installKey = `install:${channel}`
  const channelVersion = registry.ok !== false ? registry.channels?.[channel] || null : null

  // ── 页头主动词 ──
  let primary = null
  if (notInstalled) {
    primary = { action: 'install', label: '安装', loading: pendingKeys.has(installKey), disabled: !install.canInstall || !platformOk }
  } else if (running) {
    primary = { action: 'open', label: '打开界面', loading: false, disabled: !runtime.url }
  } else if (!pathOnly) {
    primary = { action: 'start', label: '启动', loading: pendingKeys.has('start'), disabled: !install.canInstall || !platformOk }
  }

  // ── 运行卡 ──
  const run = { tone: 'stopped', title: '已停止', hint: null, actions: [], rows: [] }
  if (notInstalled) {
    run.tone = 'none'
    run.title = '未安装'
    run.hint = '装好后在这里启动、停止和打开界面'
    if (!platformOk) {
      run.hint = `暂不支持 ${PLATFORM_NAME[snapshot?.platform] || snapshot?.platform || '当前系统'}，目前只支持 macOS 和 Linux`
    } else if (pendingKeys.has(installKey)) {
      run.hint = `正在安装${CHANNEL_LABEL[channel]}通道${channelVersion ? ` ${channelVersion}` : ''}`
    }
  } else if (running) {
    run.tone = 'running'
    run.title = '运行中'
  } else if (pendingKeys.has('start')) {
    run.hint = '正在启动，就绪后自动打开界面'
  }

  if (controllable) {
    run.actions = [
      actionButton('restart', '重启', { pendingKeys }),
      actionButton('stop', '停止', { pendingKeys }),
    ]
  }

  if (!notInstalled) {
    const origin = running ? displayOrigin(runtime.url) : null
    if (origin) {
      run.rows.push(row('address', '访问地址', [mono(origin)], {
        action: [{ type: 'button', key: 'copy', label: copied ? '已复制' : '复制', variant: 'ghost', loading: false, disabled: false }],
      }))
    }
    if (running && runtime.pid) run.rows.push(row('pid', 'PID', [mono(runtime.pid)]))

    if (external) {
      run.rows.push(row('mode', '运行方式', [text('终端手动启动')], { note: [text('CodePal 只能打开它，不能停止或重启')] }))
    } else if (!running && pathOnly) {
      run.rows.push(row('mode', '运行方式', [text('由你自己启动')], {
        note: [text('CodePal 不能启动 PATH 上的 dsh，用你原来的方式启动后回到这里点「刷新」')],
      }))
    } else if (underLaunchd) {
      run.rows.push(row('mode', '运行方式', [text('系统服务'), { type: 'monoMuted', value: supervisor.label || '' }]))
    } else {
      run.rows.push(row('mode', '运行方式', [text('由 CodePal 启动')]))
    }

    if (underLaunchd && !external) {
      run.rows.push(row('keepAlive', '崩溃后自动重启', [], {
        setting: true,
        action: [{ type: 'toggle', key: 'setKeepAlive', checked: supervisor.keepAlive === true, disabled: pendingKeys.has('setKeepAlive') }],
        note: [text('进程意外退出时，由系统服务自动拉起')],
      }))
    } else if (!external && !pathOnly) {
      run.rows.push(row('stopOnQuit', '退出 CodePal 时一并停止', [], {
        setting: true,
        action: [{ type: 'toggle', key: 'setStopOnQuit', checked: snapshot?.stopOnQuit !== false, disabled: pendingKeys.has('setStopOnQuit') }],
        note: [text('关掉后 dsh 留在后台，下次打开 CodePal 会自动接上')],
      }))
    }
  }

  // ── 安装卡 ──
  const runtimeDir = install.runtimeDir
  const pathSegment = (full) => ({ type: 'path', value: displayPath(full, runtimeDir) })
  const channelsRow = () => row('channel', '更新通道', [{
    type: 'channels',
    active: channel,
    options: ['latest', 'next'].map((key) => ({
      key,
      label: CHANNEL_LABEL[key],
      version: registry.ok !== false ? registry.channels?.[key] || null : null,
    })),
  }])
  const panel = { meta: null, rows: [], foot: null }

  if (kind === 'none') {
    if (platformOk) panel.rows.push(row('target', '安装到', [pathSegment(runtimeDir)]))
    panel.rows.push(channelsRow())
    if (platformOk) {
      if (!node.available) {
        panel.rows.push(row('node', 'Node', [text('未检测到'), tag('未满足', 'warning')], {
          note: [text('先安装 Node 22.19 以上或 24 以上，再回到这里点「刷新」')],
        }))
      } else if (!node.supported) {
        panel.rows.push(row('node', 'Node', [mono(node.version), tag('未满足', 'warning')], {
          note: [text('需要 '), mono(node.required), text('，升级 Node 后回到这里点「刷新」')],
        }))
      } else {
        panel.rows.push(row('node', 'Node', [mono(node.version), muted('满足要求')]))
      }
      panel.foot = '不写全局 npm，不需要管理员权限；卸载时默认保留 ~/.dsh 里的会话数据'
    }
  } else if (kind === 'managed') {
    panel.meta = install.version || null
    panel.rows.push(row('location', '位置', [pathSegment(runtimeDir), tag('CodePal 托管')]))
    panel.rows.push(channelsRow())
    const upgradeTarget = install.version ? registry.upgradeTargets?.[channel] || null : null
    if (registry.ok === false) {
      panel.rows.push(row('update', '更新', [text('暂时查不到新版本')], { note: [text('连不上 npm，点「刷新」重试；启动和停止不受影响')] }))
    } else if (upgradeTarget) {
      panel.rows.push(row('update', '更新', [mono(upgradeTarget), tag('新版本', 'info')], {
        action: [actionButton('upgrade', '升级', { pendingKeys, pendingKey: installKey })],
      }))
    } else if (channelVersion && install.version && channelVersion !== install.version) {
      panel.rows.push(row('update', '更新', [text('已是最新')], {
        note: [text(`${CHANNEL_LABEL[channel]}通道目前是 `), mono(channelVersion), text('，比当前版本旧，不提供降级')],
      }))
    } else {
      panel.rows.push(row('update', '更新', [text('已是最新')]))
    }
    if (install.canUninstall) panel.rows.push(row('uninstall', '卸载', [muted('删除托管副本，~/.dsh 默认保留')], { action: [actionButton('uninstall', '卸载', { variant: 'danger', pendingKeys })] }))
  } else if (kind === 'source') {
    panel.meta = install.version || install.sourceVersion || null
    panel.rows.push(row('location', '位置', [pathSegment(install.sourceDir), tag('源码目录')]))
    if (source.branch || source.commit) {
      panel.rows.push(row('branch', '分支', [
        ...(source.branch ? [mono(source.branch)] : []),
        ...(source.commit ? [{ type: 'monoKeep', value: source.commit }] : []),
      ]))
    }
    const dirty = Number(source.dirty) || 0
    const canTakeOver = Boolean(install.canTakeOver) && platformOk && !sourceExternal && (!source.updatable || dirty > 0)
    const takeover = canTakeOver ? [actionButton('takeover', '转为托管', { pendingKeys, pendingKey: 'update' })] : []
    if (!source.updatable) {
      panel.rows.push(row('update', '更新', [text('无法自动更新')], {
        action: takeover,
        note: source.upstream
          ? [text('本地分支在远端没有对应分支，'), mono(source.upstream), text(` 已领先 ${source.behind ?? '未知'} 个提交`)]
          : [text('这个仓库没有可用的远端分支')],
      }))
    } else if (typeof source.behind !== 'number') {
      panel.rows.push(row('update', '更新', [text('暂时无法检查远端')], {
        action: takeover,
        note: [text('拉取远端失败，网络恢复后点「刷新」重试')],
      }))
    } else if (source.behind > 0) {
      const note = dirty > 0
        ? `${dirty} 个文件有未提交的改动，先提交或暂存才能更新${canTakeOver ? '；也可以转为托管，源码保持原样' : ''}`
        : '快进合并后重新构建，失败会自动回滚'
      panel.rows.push(row('update', '更新', [text(`有 ${source.behind} 个新提交`)], {
        action: [actionButton('update', '更新', { pendingKeys, disabled: dirty > 0 }), ...takeover],
        note: [text(note)],
      }))
    } else {
      panel.rows.push(row('update', '更新', [text('已是最新')], { action: takeover }))
    }
    if (install.canUninstall && !sourceExternal) {
      panel.rows.push(row('uninstall', '卸载', [muted('只移除启动项，不删源码目录')], { action: [actionButton('uninstall', '卸载', { variant: 'danger', pendingKeys })] }))
    }
  } else {
    panel.rows.push(row('location', '位置', [pathSegment(install.pathBinary), tag('PATH')]))
    panel.rows.push(row('update', '更新', [text('用你原来的安装方式更新')], { note: [text('更新后回到这里点「刷新」')] }))
  }

  return {
    primary,
    run,
    install: panel,
    takeoverVersion: install.sourceVersion || install.version || null,
    uninstallKind: kind === 'source' ? 'source' : 'managed',
  }
}
