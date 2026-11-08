// Adapted from TencentDB Agent Memory 97f9465 utils/pipeline-manager.ts (MIT).
export type MemoryScheduleState={conversationCount?:number;warmupThreshold?:number;lastActiveAt?:number;l1DueAt?:number;lastL2At?:number;l2DueAt?:number;l2Source?:'delay-after-l1'|'max-interval'};
export function scheduleConversation(state:MemoryScheduleState,nowMS:number):{state:MemoryScheduleState;flush:boolean}{
 const count=(state.conversationCount??0)+1,threshold=state.warmupThreshold??1;
 const flush=count>=(threshold>0?Math.min(threshold,5):5)||Boolean(state.conversationCount&&state.l1DueAt!==undefined&&nowMS>=state.l1DueAt);
 return {state:{...state,conversationCount:count,warmupThreshold:threshold,lastActiveAt:nowMS,l1DueAt:nowMS+600_000},flush};
}
export function l1Completed(state:MemoryScheduleState,nowMS:number):MemoryScheduleState{
 const threshold=state.warmupThreshold??1,next=threshold*2;
 const desired=Math.max(nowMS+10_000,state.lastL2At?state.lastL2At+900_000:0);
 const advance=state.l2DueAt===undefined||desired<state.l2DueAt;
 return {...state,conversationCount:0,l1DueAt:undefined,warmupThreshold:threshold<=0||next>=5?0:next,l2DueAt:advance?desired:state.l2DueAt,l2Source:advance?'delay-after-l1':state.l2Source};
}
export function l2Completed(state:MemoryScheduleState,nowMS:number):MemoryScheduleState{return {...state,lastL2At:nowMS,l2DueAt:nowMS+3_600_000,l2Source:'max-interval'};}
export function l2Due(state:MemoryScheduleState,nowMS:number):boolean{return state.l2DueAt!==undefined&&nowMS>=state.l2DueAt&&(state.l2Source==='delay-after-l1'||nowMS-(state.lastActiveAt??0)<86_400_000);}
