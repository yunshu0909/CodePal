/**
 * Independent Plan snapshots and selected-cycle queries.
 * - Version and request guards prevent stale responses after saves/navigation.
 * - Read cached snapshots on entry and shared revisions; an unset card never requests a cycle.
 * @module pages/plan/usePlanData
 */
import { useCallback, useEffect, useRef, useState } from 'react';
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
/** @param {Function} notify Existing Toast callback. @returns {object} Ordered cards with trusted IPC callbacks. */
export default function usePlanData(notify) {
  const [cards, setCards] = useState(() => IDS.map(empty));
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
      if(result.data.pending){patch(id,()=>({loading:true,error:null,usage:null}));return}
      patch(id, () => ({
        loading: false,
        error: null,
        usage: result.data
      }));
    } catch {
      if (ticket !== seq.current[id] || !alive.current) return;
      patch(id, () => ({
        loading: false,
        error: 'PLAN_QUERY_FAILED',
        usage: null
      }));
      toast.current?.({
        message: `${NAMES[id]} 用量读取失败`,
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
  const refresh = useCallback(async id => {
    const ticket = ++reads.current[id],
      version = current(id).plan.version;
    try {
      const result = await window.electronAPI.readPlan({
        planId: id
      });
      if (!alive.current || ticket !== reads.current[id] || version !== current(id).plan.version) return;
      if (!result?.success) throw new Error('read');
      if (apply(id, result.data)) void query(id);
    } catch {
      if (!alive.current || ticket !== reads.current[id]) return;
      patch(id, () => ({
        error: 'PLAN_READ_FAILED',
        loading: false
      }));
      toast.current?.({
        message: `${NAMES[id]} 订阅读取失败`,
        type: 'error'
      });
    }
  }, [apply, query, patch]);
  refreshRef.current = refresh;
  useEffect(() => {
    alive.current = true;
    IDS.forEach(id => void refresh(id));
    const remove = window.electronAPI?.onUsageStatisticsChanged?.(() => IDS.forEach(id => void refresh(id)));
    return () => {
      alive.current = false;
      IDS.forEach(id => {
        ++seq.current[id];
        ++reads.current[id];
      });
      if (typeof remove === 'function') remove();
    };
  }, [refresh]);
  const mutate = useCallback((id, kind, value, operationId) => {
    const run = async () => {
      ++reads.current[id];
      ++seq.current[id];
      if (kind === 'action') patch(id, () => ({
        acting: true
      }));
      try {
        const c = current(id);
        const payload = {
          planId: id,
          operationId,
          expectedVersion: c.plan.version,
          ...(kind === 'save' ? value : {
            action: value,
            cycleId: c.plan.cycles.at(-1)?.id
          })
        };
        const result = await window.electronAPI[kind === 'save' ? 'savePlan' : 'actPlan'](payload);
        if (!result?.success) throw new Error('write');
        const changed = result.data.changed !== false && !result.data.duplicate;
        if (apply(id, result.data, kind === 'action')) void query(id);
        if (changed && kind === 'save') toast.current?.({
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
  return {
    cards: cards.map(c => ({
      ...c,
      onSave: (draft, id) => mutate(c.planId, 'save', draft, id),
      onAction: action => mutate(c.planId, 'action', action, globalThis.crypto.randomUUID()),
      onNavigate: cycleId => {
        const cycle = current(c.planId).plan.cycles.find(item => item.id === cycleId);
        if (cycle) {
          patch(c.planId, () => ({
            cycle,usage:null
          }));
          void query(c.planId);
        }
      }
    }))
  };
}
