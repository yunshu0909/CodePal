/** Rounding occurs only in the display layer. @module tests/planPresentation */
import {it,expect} from 'vitest'
import {formatMultiplier,formatUSD,describePlan} from '../../src/pages/plan/planPresentation'
it('TC-008 multiplier format chooses branch before rounding',()=>{expect(formatMultiplier(9.96)).toBe('10.0×');expect(formatMultiplier(10.04)).toBe('10×');expect(formatMultiplier(0)).toBe('0.0×');expect(formatMultiplier(null)).toBe('—')})
it('TC-009 savings use precise API minus subscription',()=>{expect(describePlan({plan:{cycles:[{start:'2026-08-20',end:'2026-09-20',price:20}],stopped:false},cycle:{start:'2026-08-20',end:'2026-09-20',price:20},usage:{total:751,models:[]},today:'2026-09-16'})).toMatchObject({multiplier:'38×',subtitle:'省了 $731',remaining:'还剩 4 天',progress:27/31})})
it('TC-012 USD integer grouping retains explicit unknown',()=>{expect(formatUSD(3498.4)).toBe('$3,498');expect(formatUSD(0)).toBe('$0');expect(formatUSD(null)).toBe('—')})
