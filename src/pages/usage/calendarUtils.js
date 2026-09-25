/** Calendar dates, exact goal tiers and conserved model rows. @module pages/usage/calendarUtils */
import { normalizeClaudeModelName } from '../../../electron/services/modelAlias.mjs'

/** @param {Date} date @returns {string} Beijing YYYY-MM-DD */
export function getBeijingDayKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(date)
}
/** @param {string} month YYYY-MM @returns {number} */
export function getMonthDays(month) { const [y,m]=month.split('-').map(Number);return new Date(Date.UTC(y,m,0)).getUTCDate() }
/** @param {string} month @returns {Array<string|null>} Monday-first full weeks */
export function getMonthCells(month) {
  const [y,m]=month.split('-').map(Number), offset=(new Date(Date.UTC(y,m-1,1)).getUTCDay()+6)%7
  const days=getMonthDays(month), count=Math.ceil((offset+days)/7)*7
  return Array.from({length:count},(_,i)=> i<offset||i>=offset+days?null:`${month}-${String(i-offset+1).padStart(2,'0')}`)
}
/** @param {string} month @param {number} delta @returns {string} */
export function shiftMonth(month,delta) { const [y,m]=month.split('-').map(Number);return new Date(Date.UTC(y,m-1+delta,1)).toISOString().slice(0,7) }
/** @param {number} value @returns {string} */
export function formatToken(value) {
  if (!value) return '0'
  if(value>=1e9)return `${(value/1e9).toFixed(1)}B`
  if(value>=1e6)return `${Math.round(value/1e6)}M`
  // 不到 0.1M 时一位小数会显示成 0.0M，看起来像没用（2026-09-25 用户定）
  if(value<1e5)return '<0.1M'
  return `${(value/1e6).toFixed(1)}M`
}
/** Raw ratio determines tier; rounding is only for the label. @param {number} total @param {number} target @returns {object} */
export function getGoalStatus(total,target) {
  const ratio=target>0?total/target:0,tier=ratio>=2?'over':ratio>=1?'done':'under'
  return {ratio,tier,percent:Math.round(ratio*100),label:tier==='over'?`优秀 · 超出 ${formatToken(total-target)}`:tier==='done'?'已达成':`还差 ${formatToken(Math.max(0,target-total))}`}
}
/** @param {object|Array<object>} models @returns {Array<object>} */
export function getModelRows(models={}) {
  const merged=new Map()
  const input=Array.isArray(models)?models:Object.entries(models).map(([name,v])=>({name,...v}))
  for(const model of input){const name=normalizeClaudeModelName(model.name),total=Number(model.total)||0;if(total>0)merged.set(name,(merged.get(name)||0)+total)}
  const all=[...merged].map(([name,total])=>({name,total})).sort((a,b)=>b.total-a.total||a.name.localeCompare(b.name))
  const visible=all.filter(m=>m.total>=1e6).slice(0,6),names=new Set(visible.map(m=>m.name)),others=all.filter(m=>!names.has(m.name))
  return others.length?[...visible,{name:`其他 ${others.length} 个`,total:others.reduce((s,m)=>s+m.total,0),other:true}]:visible
}
/** @param {string} text @returns {{value:number,unit:string}|null} */
export function parseGoalInput(text) {
  const match=/^\s*(\d+(?:\.\d+)?|\.\d+)\s*([MB])\s*$/i.exec(text)
  if(!match)return null
  const value=Number(match[1]),unit=match[2].toUpperCase(),tokens=value*(unit==='B'?1e9:1e6)
  return Number.isFinite(tokens)&&tokens>0&&tokens<=Number.MAX_SAFE_INTEGER?{value,unit}:null
}
