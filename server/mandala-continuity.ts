import {isHumanInput,type QueuedInput} from '../shared/tasks';
import type {MandalaContextMaintenance} from '../shared/types';
import type { ExecutionClient } from './execution-client';
import type {RpcMessage} from './rpc';
import type {Store} from './store';
import {DomainError} from '../shared/workspace-contracts';
import {mandalaContextBoundary,mandalaContinuity,type HandoffGoal} from './mandala';

export function isContextRejection(error?:{message?:string;codexErrorInfo?:unknown}):boolean {
 return error?.codexErrorInfo==='contextWindowExceeded' ||
   /context[ _-]?(window|length)[ _-]?exceeded|maximum context length|prompt is too long/i.test(error?.message??'');
}

// Only the correlated turn/completed handler records this native terminal. Local timeout/stop status is insufficient.
export function hasMandalaTerminal(store:Store,id:string,nativeId:string):boolean {
 const row=store.database.prepare(`SELECT 1 FROM events
  WHERE conversationId=? AND superseded=0 AND kind='tool' AND json_extract(data,'$.method')='turn/completed'
  AND json_extract(data,'$.params.threadId')=? AND json_extract(data,'$.params.turn.status') IN ('completed','interrupted','failed')
  AND json_extract(data,'$.runId')=(SELECT json_extract(data,'$.runId') FROM events WHERE conversationId=? AND superseded=0
    AND kind='metadata' AND json_extract(data,'$.execution')='started' ORDER BY id DESC LIMIT 1) LIMIT 1`).get(id,nativeId,id);
 return !!row;
}

// Maintenance has its own durable identity. It never owns a business Run or advances the ACL cutoff.
export function createMandalaContinuity(options:{store:Store;closed:()=>boolean;busy:(id:string)=>boolean;
 lock:(id:string)=>void;unlock:(id:string)=>void;inputs:(id:string)=>QueuedInput[];authorize:(id:string)=>void;
 goals:(id:string)=>HandoffGoal[];client:(id:string,inspectOnly?:boolean)=>Promise<{client:Pick<ExecutionClient,'inspectContext'|'compactThread'>;release:()=>Promise<void>}>;
 retire:(id:string)=>Promise<void>;wake:(id:string)=>void}) {
 const {store}=options;
 const fenced=new Set<string>();
 const active=new Map<string,{record:MandalaContextMaintenance;resolve:(success:boolean)=>void}>();
 const pending=new Set<Promise<unknown>>();
 const latest=(id:string):MandalaContextMaintenance|undefined=>{
  const row=store.database.prepare("SELECT data FROM events WHERE conversationId=? AND superseded=0 AND kind='metadata' AND json_type(data,'$.contextMaintenance')='object' ORDER BY id DESC LIMIT 1").get(id);
  return row?JSON.parse(row.data as string).contextMaintenance:undefined;
 };
 const write=(id:string,record:MandalaContextMaintenance)=>store.appendEvent(id,'metadata',{contextMaintenance:record});
 const watermark=(id:string)=>store.listEvents(id,mandalaContextBoundary(store,id)).filter(e=>e.kind==='user'||e.kind==='metadata'&&(e.data as {receiptContext?:boolean}).receiptContext===true).at(-1)?.id??0;
 const blocked=(id:string)=>{const record=latest(id);return fenced.has(id)||active.has(id)||!!record&&['pending','unknown'].includes(record.status)&&record.nativeId===store.getConversation(id)?.nativeId;};
 const contextLimit=(id:string)=>{
  const row=store.database.prepare("SELECT id,data FROM events WHERE conversationId=? AND kind='metadata' AND json_type(data,'$.contextLimit')='object' ORDER BY id DESC LIMIT 1").get(id);
  const limit=row?JSON.parse(row.data as string).contextLimit:undefined;
  return limit?.nativeId===store.getConversation(id)?.nativeId&&limit.watermark===watermark(id)&&limit.reached===true?Number(row!.id):0;
 };
 const handoff=(id:string,reason:'runtime'|'maintenance',goals:HandoffGoal[],omitEventId?:number,maxBytes?:number,omitInputId?:string)=>{
  const receipts=new Set<string>();
  for(const e of store.listEvents(id,mandalaContextBoundary(store,id))){
   const data=e.data as {source?:QueuedInput['source'];receiptContext?:boolean;receiptIds?:string[]};
   const ids=e.kind==='user'&&data.source?.kind==='coordination'?data.source.receiptIds:e.kind==='metadata'&&data.receiptContext?data.receiptIds??[]:[];
   for(const receiptId of ids)receipts.add(receiptId);
  }
  const inputs=options.inputs(id);
  const unsubmittedInputIds=new Set(inputs.filter(i=>i.unrecorded||['queued','unknown','cancelled'].includes(i.state)).map(i=>i.id));
  const pendingInputs=inputs.filter(i=>i.id!==omitInputId&&['queued','running','unknown'].includes(i.state)).slice(-100);
  return mandalaContinuity(store,id,reason,omitEventId,{maxBytes,goals,receiptIds:[...receipts].slice(-100),pendingInputs,unsubmittedInputIds});
 };
 const capture=(id:string,reason:MandalaContextMaintenance['reason']):MandalaContextMaintenance=>{
  const goals=options.goals(id);
  return {status:'pending',reason,limitEventId:contextLimit(id),nativeId:store.getConversation(id)!.nativeId!,watermark:watermark(id),
   goalIds:goals.map(goal=>goal.id),afterEventId:mandalaContextBoundary(store,id),throughEventId:store.listEvents(id,0).at(-1)?.id??0,
   handoff:handoff(id,'maintenance',goals)};
 };
 const fallback=async(id:string,record:MandalaContextMaintenance)=>{
  store.transaction(()=>{write(id,{...record,status:'fallback'});store.updateConversation(id,{nativeId:null,turnId:null,continuityPending:true,...(store.getConversation(id)?.status==='error'?{status:'idle' as const}:{})});});
  await options.retire(id);
 };
 const complete=(id:string,record:MandalaContextMaintenance)=>{
  store.transaction(()=>{write(id,record);if(record.reason==='manual'&&record.status==='completed')store.updateConversation(id,{continuityPending:true});});
  if(store.getConversation(id)?.status==='error'&&record.reason==='context-limit')store.updateConversation(id,{status:'idle'});
 };
 const event=(id:string,event:RpcMessage):boolean=>{
  const c=store.getConversation(id),p=event.params??{};if(c?.purpose!=='mandala-main'||p.threadId&&p.threadId!==c.nativeId)return false;
  const running=active.get(id);
  if(running){
   const r=running.record;
   if(event.method==='turn/started'&&typeof p.turn?.id==='string'){r.turnId=p.turn.id;write(id,{...r});}
   if(event.method==='item/completed'&&p.item?.type==='contextCompaction'&&p.turnId===r.turnId){r.nativeCompleted=true;write(id,{...r});}
   if(event.method==='thread/compacted'||event.method==='contextCompacted'){r.nativeCompleted=true;write(id,{...r});}
   if(event.method==='turn/completed'&&r.turnId===p.turn?.id)running.resolve(p.turn.status==='completed'&&r.nativeCompleted===true);
   // Includes usage/hook notifications: they belong to maintenance, never the previous user invocation.
   return true;
  }
  const unsettled=latest(id);
  if(unsettled&&['pending','unknown'].includes(unsettled.status)&&unsettled.nativeId===c.nativeId){
   if(event.method==='turn/started'&&typeof p.turn?.id==='string'&&!unsettled.turnId)write(id,{...unsettled,turnId:p.turn.id});
   if(event.method==='item/completed'&&p.item?.type==='contextCompaction'&&p.turnId===unsettled.turnId)write(id,{...unsettled,nativeCompleted:true});
   if(event.method==='turn/completed'&&p.turn?.id===unsettled.turnId&&p.turn.status==='completed'&&unsettled.nativeCompleted){complete(id,{...unsettled,status:'completed'});options.wake(id);}
   return true;
  }
  if(event.method==='item/completed'&&p.item?.type==='contextCompaction'||event.method==='mandala/contextCompacted'||event.method==='thread/compacted'||event.method==='contextCompacted'){
   // Native automatic compression already performed this maintenance for the current input.
   try{options.authorize(id);write(id,{...capture(id,'native-auto'),status:'completed',nativeCompleted:true});}catch{/* Do not preserve an unauthorized summary. */}
  }
  if(event.method==='thread/tokenUsage/updated'&&p.turnId===c.turnId){
   const usage=p.tokenUsage,window=usage?.modelContextWindow,tokens=usage?.last?.totalTokens;
   if(typeof window==='number'&&window>0&&typeof tokens==='number')store.appendEvent(id,'metadata',{contextLimit:{nativeId:c.nativeId,watermark:watermark(id),reached:tokens>=window}});
  }
  if((event.method==='mandala/contextLimitReached'||event.method==='error'&&isContextRejection(p.error))&&p.turnId===c.turnId||event.method==='turn/completed'&&p.turn?.id===c.turnId&&isContextRejection(p.turn?.error)){
   store.transaction(()=>{
    store.appendEvent(id,'metadata',{contextLimit:{nativeId:c.nativeId,watermark:watermark(id),reached:true,rejectedTurnId:c.turnId,cli:c.cli,model:c.model}});
    store.updateConversation(id,{continuityPending:true});
   });
  }
  return false;
 };
 const maintain=async(id:string,manual=false):Promise<'completed'|'noop'|'fallback'|undefined>=>{
  const c=store.getConversation(id);if(!c||c.purpose!=='mandala-main'||!c.nativeId||options.closed()||options.busy(id)||active.has(id))return;
  const previous=latest(id),recover=blocked(id),inputs=options.inputs(id);
  if(!recover&&inputs.some(i=>i.state==='queued'&&isHumanInput(i)))return;
  const users=store.listEvents(id,mandalaContextBoundary(store,id)).filter(e=>e.kind==='user'&&isHumanInput(e.data as any));
  const humanTimes=[...users.map(e=>Date.parse(e.createdAt)),...inputs.filter(isHumanInput).map(i=>Date.parse(i.createdAt))];
  const lastHuman=Math.max(0,...humanTimes),mark=watermark(id);
  if(!recover&&!manual&&(!mark||previous&&previous.watermark>=mark&&previous.afterEventId===mandalaContextBoundary(store,id)&&(previous.limitEventId??0)>=contextLimit(id)))return;
  if(!recover&&!manual&&!contextLimit(id)&&(!lastHuman||Date.now()-lastHuman<6*3600000))return;
  fenced.add(id);options.lock(id);let owned:Awaited<ReturnType<typeof options.client>>|undefined;
  try{
   if(!recover)options.authorize(id);owned=await options.client(id);
   const state=await owned.client.inspectContext?.(c.nativeId);
   // Unsupported ACP has no autonomous async-work protocol; only an observed terminal is safe.
   if(state?.settled!==true)return;
   if(options.closed()||store.getConversation(id)?.nativeId!==c.nativeId)return;
   if(!recover&&options.inputs(id).some(i=>i.state==='queued'&&isHumanInput(i)))return;
   try{options.authorize(id);}catch(error){if(recover){write(id,{...previous!,status:'failed'});return;}throw error;}
   const record=recover?previous!:capture(id,manual?'manual':contextLimit(id)?'context-limit':'idle');
   if(recover){
    if(record.turnId&&state.completedCompactions?.includes(record.turnId)){complete(id,{...record,status:'completed',nativeCompleted:true});return;}
    // A restart/transport failure is never counted as successful compression. Proven idle permits fallback.
    await fallback(id,record);return;
   }
   write(id,record);
   let resolve!:(value:boolean)=>void;
   const completion=new Promise<boolean>(r=>{resolve=r;});
   active.set(id,{record,resolve});
   const timer=setTimeout(()=>resolve(false),60000);timer.unref();
   try{
    const result=await owned.client.compactThread?.(c.nativeId)??'unsupported';
    if((result==='completed'||result==='noop')&&(await owned.client.inspectContext?.(c.nativeId))?.settled===true){complete(id,{...record,status:result==='noop'?'noop':'completed',nativeCompleted:result==='completed'});return result;}
    if(result==='started'&&await completion){complete(id,{...record,status:'completed',nativeCompleted:true});return 'completed';}
    const after=await owned.client.inspectContext?.(c.nativeId);
    if(options.closed())return;
    if(after?.settled===true){options.authorize(id);await fallback(id,record);return 'fallback';}
    else write(id,{...record,status:'unknown'});
   }catch{
    if(!options.closed())write(id,{...record,status:'unknown'});
   }finally{clearTimeout(timer);active.delete(id);}
  }catch(error){if(manual)throw error; /* Automatic maintenance retries on the next eligible tick. */}
  finally{try{await owned?.release();}finally{fenced.delete(id);options.unlock(id);if(!options.closed()&&!blocked(id))options.wake(id);}}
 };
 return {blocked,event,handoff,
  lastTurnOverflowed(id:string,cli:string,model:string|null){
   // An explicit retry after a native rejection gets a history cursor. A later successful turn clears the signal.
   return !!store.database.prepare(`SELECT 1 FROM events WHERE conversationId=? AND superseded=0 AND kind='metadata'
    AND json_type(data,'$.contextLimit.rejectedTurnId')='text' AND json_extract(data,'$.contextLimit.cli')=?
    AND json_extract(data,'$.contextLimit.model') IS ? AND id>COALESCE((SELECT MAX(id) FROM events WHERE conversationId=?
    AND superseded=0 AND kind='tool' AND json_extract(data,'$.method')='turn/completed'
    AND json_extract(data,'$.params.turn.status')='completed'),0) LIMIT 1`).get(id,cli,model,id);
  },
  async assertSwitchable(id:string,nativeId:string){
   let owned:Awaited<ReturnType<typeof options.client>>|undefined;
   try{
    owned=await options.client(id,true);
    const state=await owned.client.inspectContext?.(nativeId);
    if(state?state.settled:hasMandalaTerminal(store,id,nativeId))return;
   }catch{throw new DomainError('native_background_check_failed',409,'The previous runtime could not confirm completion.');}
   finally{await owned?.release();}
   throw new DomainError('native_background_active',409,'The previous runtime still has active work.');
  },
  disconnected(id:string){const entry=active.get(id);if(!entry)return false;write(id,{...entry.record,status:'unknown'});entry.resolve(false);return true;},
  async compact(id:string):Promise<{status:'completed'|'noop'|'fallback'}>{
   const c=store.getConversation(id);
   if(c?.purpose!=='mandala-main')throw new DomainError('primary_conversation_required',422,'Only the primary Mandala chat supports context organization.');
   options.authorize(id);
   const busy=()=>new DomainError('native_context_busy',409,'Wait for the current turn or queued input to settle before organizing context.');
   if(options.closed()||options.busy(id)||blocked(id)||options.inputs(id).some(i=>i.state==='queued'&&isHumanInput(i)))throw busy();
   if(!c.nativeId)return {status:c.continuityPending?'fallback':'noop'};
   const previous=latest(id);
   if(previous?.reason==='manual'&&previous.nativeId===c.nativeId&&previous.watermark===watermark(id)&&
      previous.afterEventId===mandalaContextBoundary(store,id)&&previous.limitEventId===contextLimit(id)&&
      (previous.status==='completed'||previous.status==='noop'))return {status:previous.status};
   const operation=maintain(id,true);pending.add(operation);
   try{const status=await operation;if(!status)throw busy();return {status};}finally{pending.delete(operation);}
  },
  tick(){const promise=(async()=>{for(const c of store.listConversations())if(c.purpose==='mandala-main')await maintain(c.id);})();pending.add(promise);void promise.finally(()=>pending.delete(promise));return promise;},
  hasActiveWork:()=>fenced.size>0||active.size>0,
  async close(){for(const entry of active.values())entry.resolve(false);await Promise.allSettled(pending);},
 };
}
