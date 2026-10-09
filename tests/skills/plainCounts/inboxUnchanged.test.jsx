/**
 * v2.1.21 TC-007：恢复在用 / 没用时，「要处理」和「只读」两组不受影响。
 * 要处理的成员和顺序由主进程 inboxScan 决定（按与资产库的关系，再按名字），前端原样排在第一组、不重排；
 * 本任务不改 inboxScan，这里守住前端这一侧。
 */
import { describe, expect, it } from 'vitest'
import { buildGroups, tabIdsOf, visibleTabsOf } from '../../../src/pages/skills/skillsModel'

const asset = (name, loaded) => ({ name, displayName: name, managed: true, description: '', origins: [], locations: [{ toolId: 'central', path: '/library/' + name }],
  tools: { codex: { enabled: loaded, state: loaded ? 'synced' : 'disabled', mutable: true }, 'claude-code': { enabled: false, state: 'disabled', mutable: true } } })
const skills = [asset('alpha', true), asset('beta', false)]
// claude.ai 同步来的只读 Skill：不计次数，永远排在最后一组
const synced = { name: 'synced-one', displayName: 'synced-one', managed: false, description: '', origins: [{ origin: 'synced', toolId: 'claude-code', mutable: false }],
  locations: [], tools: { 'claude-code': { enabled: true, state: 'synced', mutable: false } } }
// 主进程已排好的要处理清单：故意不是字母序
const inbox = [{ name: 'zeta', relation: 'differs' }, { name: 'mu', relation: 'differs' }, { name: 'kappa', relation: 'new' }]
const usage = (name, total, extra = {}) => ({ name, total, confirmedTotal: total, completeness: 'complete', availability: 'available', ...extra })

describe('v2.1.21 TC-007 要处理不受影响', () => {
  it('TC-007 有没有证据不全，要处理都排第一组，成员和顺序与主进程给的一致', () => {
    for (const completeness of ['complete', 'pending']) {
      const usageMap = new Map([['alpha', usage('alpha', 2, { completeness })], ['beta', usage('beta', 0, { completeness })]])
      const groups = buildGroups(skills, { usageMap, inbox })
      expect(groups[0].id).toBe('inbox')
      expect(groups[0].skills.map((item) => item.name)).toEqual(['zeta', 'mu', 'kappa'])
    }
  })

  it('TC-007 来源读不出退回资产库时，要处理照样第一组、顺序不变', () => {
    const usageMap = new Map([['alpha', usage('alpha', 2, { availability: 'error' })], ['beta', usage('beta', 0)]])
    const groups = buildGroups(skills, { usageMap, inbox })
    expect(groups.map((group) => group.id)).toEqual(['inbox', 'library'])
    expect(groups[0].skills.map((item) => item.name)).toEqual(['zeta', 'mu', 'kappa'])
    expect(visibleTabsOf(groups, true)).toEqual(tabIdsOf(true))
  })

  it('TC-007 只读 Skill 不进在用 / 没用 / 资产库，始终是最后一组', () => {
    const readable = new Map([['alpha', usage('alpha', 2)], ['beta', usage('beta', 0)]])
    const failed = new Map([['alpha', usage('alpha', 2, { availability: 'error' })], ['beta', usage('beta', 0)]])
    for (const [usageMap, ids] of [[readable, ['inbox', 'used', 'unused', 'readonly']], [failed, ['inbox', 'library', 'readonly']]]) {
      const groups = buildGroups([...skills, synced], { usageMap, inbox })
      expect(groups.map((group) => group.id)).toEqual(ids)
      expect(groups.at(-1).skills.map((skill) => skill.name)).toEqual(['synced-one'])
      expect(groups.slice(0, -1).flatMap((group) => group.skills.map((skill) => skill.name))).not.toContain('synced-one')
    }
  })
})
