/**
 * Independent Plan snapshots and selected-cycle queries.
 * - Version and request guards prevent stale responses after saves/navigation.
 * - Read cached snapshots on entry and shared revisions; an unset card never requests a cycle.
 * - Ended-cycle price edits go through the same per-plan write queue; model prices are global, so both cards re-query.
 * - 切回时先显示上次读到的两张卡（本次运行内存里，#100），后台照常重读；同一周期的旧用量在重读、统计还在算时先留着；
 *   后台读到新周期 / 新账本版本时，新数字出来之前整张卡照上次的显示（不出骨架），出来了整张换；
 *   重读失败、卡上已有内容：数字留着，Toast 说明显示的是上次读到的结果。页里一动手（改设置、翻周期）就不再垫上次的。
 * @module pages/plan/usePlanData
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { pageMemory, useRemember } from '../../store/pageMemory';
const IDS = ['claude', 'codex'],
  NAMES = {
    claude: 'Claude Code',
    codex: 'Codex'
  };
const empty = planId => ({
  planId,
  name: NAMES[planId],
  plan: {
    version: 0,
    cycles: [],
    stopped: false
  },
  metadata: {
    type: '未知'
  },
  today: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
  cycle: null,
  usage: null,
  loading: false,
  error: null,
  acting: false
});
const STALE_SUFFIX = '，显示的是上次读到的结果';
/** 上次的卡只带读到的数据回来；进行中这类一次性状态不带（上次还没读到数字的照旧算读取中） */
const recall = card => ({
  ...card,
  loading: Boolean(card.loading && card.cycle && !card.usage),
  acting: false
});
/** 一张卡是不是读完整了：没设订阅，或设了且有数字 */
const complete = card => !card.loading && (!card.cycle || Boolean(card.usage));
/** @param {Function} notify Existing Toast callback. @returns {object} Ordered cards with trusted IPC callbacks. */
export default function usePlanData(notify) {
  const memory = pageMemory('plan');
  const [cards, setCards] = useState(() => memory.value ? memory.value.map(recall) : IDS.map(empty));
  // 切回时上次读完整的卡：这次的新数字出来之前先照它显示；出来了、或页里动手了就放掉
  const held = useRef(memory.value ? Object.fromEntries(memory.value.map(recall).filter(complete).map(c => [c.planId, c])) : {});
  const release = id => {
    delete held.current[id];
  };
  const state = useRef(cards),
    alive = useRef(false),
    seq = useRef({
      claude: 0,
      codex: 0
    }),
    reads = useRef({
      claude: 0,
      codex: 0
    }),
    writes = useRef({
      claude: Promise.resolve(),
      codex: Promise.resolve()
    });
  const refreshRef = useRef(null);
  const metadataReady = useRef({ claude: false, codex: false });
  const toast = useRef(notify);
  toast.current = notify;
  const patch = useCallback((id, fn) => {
    if (!alive.current) return;
    state.current = state.current.map(c => c.planId === id ? {
      ...c,
      ...fn(c)
    } : c);
    setCards(state.current);
  }, []);
  const current = id => state.current.find(c => c.planId === id);
  const query = useCallback(async id => {
    const c = current(id);
    const ticket = ++seq.current[id];
    if (!c.cycle) {
      release(id);
      patch(id, () => ({
        loading: false,
        usage: null,
        error: null
      }));
      return;
    }
    const version = c.plan.version,
      cycleId = c.cycle.id;
    patch(id, () => ({
      loading: !c.usage,
      error: null,
      usage: c.usage
    }));
    try {
      const result = await window.electronAPI.queryPlan({
        planId: id,
        cycleId
      });
      const active = current(id);
      if (!alive.current || ticket !== seq.current[id] || active.plan.version !== version || active.cycle?.id !== cycleId) return;
      if (result?.success && result.data.version > version) {
        void refreshRef.current?.(id);
        return;
      }
      if (!result?.success || result.data.version !== version || result.data.cycleId !== cycleId) throw new Error('query');
      // 统计还在算：这一周期已经有数字（切回时上次的）就先留着，算完由统计变化事件重读；没有才出骨架
      if(result.data.pending){patch(id,c=>c.usage?{loading:false,error:null}:{loading:true,error:null,usage:null});return}
      release(id);
      patch(id, () => ({
        loading: false,
        error: null,
        usage: result.data
      }));
    } catch {
      if (ticket !== seq.current[id] || !alive.current) return;
      // 这一周期已经有数字：留着；切回时垫着上次的整张卡：照原来记失败，显示仍是垫着的那张。两种都提示显示的是上次的
      const own = Boolean(current(id).usage);
      const kept = own || Boolean(held.current[id]);
      patch(id, () => own ? {
        loading: false
      } : {
        loading: false,
        error: 'PLAN_QUERY_FAILED',
        usage: null
      });
      toast.current?.({
        message: `${NAMES[id]} 用量读取失败${kept ? STALE_SUFFIX : ''}`,
        type: 'error'
      });
    }
  }, [patch]);
  const apply = useCallback((id, data, latest = false) => {
    const old = current(id);
    if (data.plan.version < old.plan.version) return false;
    // Follow renewal when viewing the latest cycle; keep an explicit history selection.
    const wasLatest = old.cycle?.id === old.plan.cycles.at(-1)?.id;
    const cycle = !latest && !wasLatest && data.plan.cycles.find(c => c.id === old.cycle?.id) || data.plan.cycles.at(-1) || null;
    patch(id, () => ({
      ...data,
      cycle,
      usage: old.cycle?.id===cycle?.id&&old.plan.version===data.plan.version?old.usage:null,
      error: null
    }));
    return true;
  }, [patch]);
  const refresh = useCallback(async (id, ledgerOnly = false) => {
    const ticket = ++reads.current[id],
      version = current(id).plan.version;
    try {
      const result = await window.electronAPI.readPlan({
        planId: id,
        ...(ledgerOnly && metadataReady.current[id] ? { includeMetadata: false } : {})
      });
      if (!alive.current || ticket !== reads.current[id] || version !== current(id).plan.version) return;
      if (!result?.success) throw new Error('read');
      if (apply(id, result.data)) {
        if (result.data.metadata) metadataReady.current[id] = true;
        void query(id);
      }
    } catch {
      if (!alive.current || ticket !== reads.current[id]) return;
      // 卡上已经有读到的订阅（切回时上次的）：留着，提示显示的是上次的；没有才照原来出失败
      const kept = current(id).plan.version > 0 || Boolean(current(id).usage) || Boolean(held.current[id]);
      patch(id, () => kept ? {
        loading: false
      } : {
        error: 'PLAN_READ_FAILED',
        loading: false
      });
      toast.current?.({
        message: `${NAMES[id]} 订阅读取失败${kept ? STALE_SUFFIX : ''}`,
        type: 'error'
      });
    }
  }, [apply, query, patch]);
  refreshRef.current = refresh;
  useEffect(() => {
    alive.current = true;
    IDS.forEach(id => void refresh(id));
    const remove = window.electronAPI?.onUsageStatisticsChanged?.(() => IDS.forEach(id => void refresh(id, true)));
    return () => {
      alive.current = false;
      IDS.forEach(id => {
        ++seq.current[id];
        ++reads.current[id];
      });
      if (typeof remove === 'function') remove();
    };
  }, [refresh]);
  // seenVersion：用户看着的那张卡的账本版本。切回时垫着上次的卡，它可能比刚读到的旧；
  // 按用户看到的版本提交，账本已经变了主进程就拒绝，不会把旧设置配上新版本存进去
  const mutate = useCallback((id, kind, value, operationId, seenVersion) => {
    const run = async () => {
      ++reads.current[id];
      ++seq.current[id];
      release(id);
      if (kind === 'action') patch(id, () => ({
        acting: true
      }));
      try {
        const c = current(id);
        const payload = {
          planId: id,
          operationId,
          expectedVersion: seenVersion ?? c.plan.version,
          ...(kind === 'action' ? {
            action: value,
            cycleId: c.plan.cycles.at(-1)?.id
          } : value)
        };
        const method = kind === 'save' ? 'savePlan' : kind === 'cycle-price' ? 'setPlanCyclePrice' : 'actPlan';
        const result = await window.electronAPI[method](payload);
        if (!result?.success) throw new Error('write');
        const changed = result.data.changed !== false && !result.data.duplicate;
        if (apply(id, result.data, kind === 'action')) void query(id);
        if (changed && kind !== 'action') toast.current?.({
          message: `${NAMES[id]} 订阅已更新`,
          type: 'success'
        });
        return result;
      } catch {
        patch(id, () => ({
          loading: false
        }));
        toast.current?.({
          message: `${NAMES[id]} 订阅更新失败`,
          type: 'error'
        });
        return {
          success: false
        };
      } finally {
        if (kind === 'action') patch(id, () => ({
          acting: false
        }));
      }
    };
    const result = writes.current[id].then(run, run);
    writes.current[id] = result.catch(() => {});
    return result;
  }, [apply, query, patch]);
  const requeryAll = useCallback(() => IDS.forEach(id => void query(id)), [query]);
  // 价格是全局的：刷新 / 自填 / 清除成功后两张卡都重算
  const priceAction = useCallback(async (call, success) => {
    let result = null;
    try {
      result = await call();
    } catch {}
    if (!result?.success) return {
      success: false
    };
    if (success(result.data)) requeryAll();
    return {
      success: true,
      ...result.data
    };
  }, [requeryAll]);
  const onRefreshPrice = useCallback(model => priceAction(() => window.electronAPI.refreshPlanPrice({
    model
  }), data => {
    if (data?.found) toast.current?.({
      message: '价格已更新',
      type: 'success'
    });
    return data?.found === true;
  }), [priceAction]);
  const onSaveLocalPrice = useCallback(async (model, rates) => {
    const result = await priceAction(() => window.electronAPI.setPlanLocalPrice({
      model,
      ...rates
    }), () => true);
    toast.current?.(result.success ? {
      message: '价格已保存',
      type: 'success'
    } : {
      message: '价格保存失败',
      type: 'error'
    });
    return result;
  }, [priceAction]);
  const onClearLocalPrice = useCallback(async model => {
    const result = await priceAction(() => window.electronAPI.clearPlanLocalPrice({
      model
    }), () => true);
    if (!result.success) toast.current?.({
      message: '价格保存失败',
      type: 'error'
    });
    return result;
  }, [priceAction]);
  // 切回时垫着的上次整张卡：这次还在读（或没读到）就照它显示
  const shown = cards.map(c => {
    const h = held.current[c.planId];
    return h && (c.loading || c.error) ? {
      ...c,
      plan: h.plan,
      cycle: h.cycle,
      usage: h.usage,
      today: h.today,
      metadata: h.metadata,
      loading: false,
      error: null
    } : c;
  });
  useRemember(memory, shown);
  return {
    cards: shown.map(c => ({
      ...c,
      onSave: (draft, id) => mutate(c.planId, 'save', draft, id, c.plan.version),
      onAction: action => mutate(c.planId, 'action', action, globalThis.crypto.randomUUID(), c.plan.version),
      onSaveCyclePrice: (cycleId, price) => mutate(c.planId, 'cycle-price', {
        cycleId,
        price
      }, globalThis.crypto.randomUUID(), c.plan.version),
      onRefreshPrice,
      onSaveLocalPrice,
      onClearLocalPrice,
      onNavigate: cycleId => {
        const cycle = current(c.planId).plan.cycles.find(item => item.id === cycleId);
        if (cycle) {
          release(c.planId);
          patch(c.planId, () => ({
            cycle,usage:null
          }));
          void query(c.planId);
        }
      }
    }))
  };
}
