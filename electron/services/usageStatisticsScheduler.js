/** One app-owned five-minute statistics clock, independent of windows. @module services/usageStatisticsScheduler */
/** @param {object} deps Statistics authority and current configured cycles. @returns {object} Start/stop lifecycle. */
function createUsageStatisticsScheduler({statistics,getCycles=async()=>[],nowFn=()=>new Date(),setTimer=setTimeout,clearTimer=clearTimeout,onError=()=>{}}){
  let stopped=true,timer=null,busy=false
  function schedule(delay=300000){if(!stopped)timer=setTimer(async()=>{timer=null;schedule();if(busy)return;busy=true;try{await statistics.tick()}catch{onError()}finally{busy=false}},delay)}
  return {
    async start(){if(!stopped)return;stopped=false;busy=true;try{const state=await statistics.bootstrap(await getCycles());const elapsed=state?.lastRunAt?Math.max(0,nowFn().getTime()-Date.parse(state.lastRunAt)):0;schedule(Math.max(1,300000-elapsed))}catch{onError();schedule()}finally{busy=false}},
    stop(){stopped=true;if(timer!==null)clearTimer(timer);timer=null}
  }
}
module.exports={createUsageStatisticsScheduler}
