/** Calendar date, number and conservation contracts. @module tests/calendarUtils */
import { describe, it, expect } from 'vitest'
import { formatToken, getMonthCells, getMonthDays, getBeijingDayKey, getGoalStatus, getModelRows, parseGoalInput } from '../src/pages/usage/calendarUtils'

describe('usage calendar numeric contracts', () => {
  it('TC004/015/026/028: Beijing midnight and actual month lengths', () => {
    expect(getBeijingDayKey(new Date('2026-09-15T15:59:59Z'))).toBe('2026-09-15')
    expect(getBeijingDayKey(new Date('2026-09-15T16:00:00Z'))).toBe('2026-09-16')
    expect(['2026-02', '2028-02', '2026-08'].map(getMonthDays)).toEqual([28, 29, 31])
    expect(getMonthCells('2026-08')).toHaveLength(42)
    expect(getMonthCells('2026-09')).toHaveLength(35)
    expect(getMonthCells('2026-08')[5]).toBe('2026-08-01')
  })
  it.each([[0,'0'],[400000,'0.4M'],[999000,'1.0M'],[320400000,'320M'],[4200000000,'4.2B']])('TC004: formats %s as %s', (n, label) => expect(formatToken(n)).toBe(label))
  it('TC029: raw thresholds precede integer percentage display', () => {
    const result = [999000, 1000000, 1999000, 2000000].map(n => getGoalStatus(n, 1000000))
    expect(result.map(r => r.tier)).toEqual(['under','done','done','over'])
    expect(result.map(r => r.percent)).toEqual([100,100,200,200])
    expect(result[0].label).toBe('还差 0.0M')
    expect(result[1].label).toBe('已达成')
    expect(result[3].label).toBe('优秀 · 超出 1M')
  })
  it('TC008/022: top six plus small models conserves the complete day', () => {
    const values = [250e6,150e6,80e6,40e6,20e6,10e6,5e6,.6e6,.4e6]
    const rows = getModelRows(Object.fromEntries(values.map((total,i) => ['model-'+i,{total}])))
    expect(rows).toHaveLength(7)
    expect(rows[6]).toMatchObject({name:'其他 3 个',total:6e6})
    expect(rows.reduce((sum,r) => sum+r.total,0)).toBe(556e6)
  })
  it('TC009: retains raw non-Claude identifiers and normalizes existing Claude names', () => {
    expect(getModelRows({'provider/long-id':{total:2e6}})[0].name).toBe('provider/long-id')
    expect(getModelRows({'claude-opus-5':{total:2e6}})[0].name).toBe('Claude Opus 5')
  })
  it('TC018: positive finite M/B input only', () => {
    expect(parseGoalInput('0.3B')).toEqual({value:.3,unit:'B'})
    expect(parseGoalInput('300M')).toEqual({value:300,unit:'M'})
    for (const text of ['', '0','-1M','abc','InfinityB','1K','1e999B']) expect(parseGoalInput(text)).toBeNull()
  })
})
