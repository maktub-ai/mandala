import {isHumanInput,type QueuedInput} from '../shared/tasks';
import type {MandalaContextMaintenance} from '../shared/types';
import type {CodexClient} from './codex';
import type {RpcMessage} from './rpc';
import type {Store} from './store';
import {mandalaContextBoundary,mandalaContinuity} from './mandala';

// Maintenance has its own durable identity. It never owns a business Run or advances the ACL cutoff.
export function createMandalaContinuity(options:{store:Store;closed:()=>boolean;busy:(id:string)=>boolean;
 lock:(id:string)=>void;unlock:(id:string)=>void;inputs:(id:string)=>QueuedInput[];authorize:(id:string)=>void;
 goals:(id:string)=>{id:string;goal:string;state:string}[];client:(id:string)=>Promise<{client:Pick<CodexClient,'inspectContext'|'compactThread'>;release:()=>Promise<void>}>;
 retire:(id:string)=>Promise<void>;wake:(id:string)=>void}) {
 const {store}=options;
 const fenced=new Set<string>();
 const active=new Map<string,{record:MandalaContextMaintenance;resolve:(success:boolean)=>void}>();
 const pending=new Set<Promise<void>>();
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
 const capture=(id:string,reason:MandalaContextMaintenance['reason']):MandalaContextMaintenance=>{const goals=options.goals(id),receipts=[...new Set(store.listEvents(id,mandalaContextBoundary(store,id)).flatMap(e=>{const data=e.data as {source?:QueuedInput['source'];receiptContext?:boolean;receiptIds?:string[]};return e.kind==='user'&&data.source?.kind==='coordination'?data.source.receiptIds:e.kind==='metadata'&&data.receiptContext?data.receiptIds??[]:[];}))];return {
  status:'pending',reason,limitEventId:contextLimit(id),nativeId:store.getConversation(id)!.nativeId!,watermark:watermark(id),
  goalIds:goals.map(goal=>goal.id),afterEventId:mandalaContextBoundary(store,id),throughEventId:store.listEvents(id,0).at(-1)?.id??0,
  handoff:mandalaContinuity(store,id,'maintenance')+'\nExplicitly linked goals (association only):\n'+JSON.stringify(goals)+'\nReceipt dependencies (latest 100 identifiers only; re-read under current authorization):\n'+JSON.stringify(receipts.slice(-100))+
   '\nPending inputs (latest 100 identifiers and state only; resolve under current authorization):\n'+JSON.stringify(options.inputs(id).filter(i=>['queued','running','unknown'].includes(i.state)).slice(-100).map(i=>({id:i.id,state:i.state,source:i.source??(i.agentMessage?{kind:'agent'}:{kind:'human'})}))),
 };};
 const fallback=async(id:string,record:MandalaContextMaintenance)=>{
  store.transaction(()=>{write(id,{...record,status:'fallback'});store.updateConversation(id,{nativeId:null,turnId:null,continuityPending:true,...(store.getConversation(id)?.status==='error'?{status:'idle' as const}:{})});});
  await options.retire(id);
 };
 const complete=(id:string,record:MandalaContextMaintenance)=>{
  write(id,record);if(store.getConversation(id)?.status==='error'&&record.reason==='context-limit')store.updateConversation(id,{status:'idle'});
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
  if((event.method==='mandala/contextLimitReached'||event.method==='error'&&p.error?.codexErrorInfo==='contextWindowExceeded')&&p.turnId===c.turnId||event.method==='turn/completed'&&p.turn?.id===c.turnId&&p.turn?.error?.codexErrorInfo==='contextWindowExceeded')store.appendEvent(id,'metadata',{contextLimit:{nativeId:c.nativeId,watermark:watermark(id),reached:true}});
  return false;
 };
 const maintain=async(id:string)=>{
  const c=store.getConversation(id);if(!c||c.purpose!=='mandala-main'||!c.nativeId||options.closed()||options.busy(id)||active.has(id))return;
  const previous=latest(id),recover=blocked(id),inputs=options.inputs(id);
  if(!recover&&inputs.some(i=>i.state==='queued'&&isHumanInput(i)))return;
  const users=store.listEvents(id,mandalaContextBoundary(store,id)).filter(e=>e.kind==='user'&&isHumanInput(e.data as any));
  const humanTimes=[...users.map(e=>Date.parse(e.createdAt)),...inputs.filter(isHumanInput).map(i=>Date.parse(i.createdAt))];
  const lastHuman=Math.max(0,...humanTimes),mark=watermark(id);
  if(!recover&&(!mark||previous&&previous.watermark>=mark&&previous.afterEventId===mandalaContextBoundary(store,id)&&(previous.limitEventId??0)>=contextLimit(id)))return;
  if(!recover&&!contextLimit(id)&&(!lastHuman||Date.now()-lastHuman<6*3600000))return;
  fenced.add(id);options.lock(id);let owned:Awaited<ReturnType<typeof options.client>>|undefined;
  try{
   if(!recover)options.authorize(id);owned=await options.client(id);
   const state=await owned.client.inspectContext?.(c.nativeId);
   // Unsupported ACP has no autonomous async-work protocol; only an observed terminal is safe.
   if(state?.settled!==true)return;
   if(options.closed()||store.getConversation(id)?.nativeId!==c.nativeId)return;
   if(!recover&&options.inputs(id).some(i=>i.state==='queued'&&isHumanInput(i)))return;
   try{options.authorize(id);}catch(error){if(recover){write(id,{...previous!,status:'failed'});return;}throw error;}
   const record=recover?previous!:capture(id,contextLimit(id)?'context-limit':'idle');
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
    if((result==='completed'||result==='noop')&&(await owned.client.inspectContext?.(c.nativeId))?.settled===true){complete(id,{...record,status:result==='noop'?'noop':'completed',nativeCompleted:result==='completed'});return;}
    if(result==='started'&&await completion){complete(id,{...record,status:'completed',nativeCompleted:true});return;}
    const after=await owned.client.inspectContext?.(c.nativeId);
    if(options.closed())return;
    if(after?.settled===true){options.authorize(id);await fallback(id,record);}
    else write(id,{...record,status:'unknown'});
   }catch{
    if(!options.closed())write(id,{...record,status:'unknown'});
   }finally{clearTimeout(timer);active.delete(id);}
  }catch{/* Authorization or native inspection failure keeps the original context intact. */}
  finally{try{await owned?.release();}finally{fenced.delete(id);options.unlock(id);if(!options.closed()&&!blocked(id))options.wake(id);}}
 };
 return {blocked,event,latest,disconnected(id:string){const entry=active.get(id);if(!entry)return false;write(id,{...entry.record,status:'unknown'});entry.resolve(false);return true;},
  tick(){const promise=(async()=>{for(const c of store.listConversations())if(c.purpose==='mandala-main')await maintain(c.id);})();pending.add(promise);void promise.finally(()=>pending.delete(promise));return promise;},
  hasActiveWork:()=>fenced.size>0||active.size>0,
  async close(){for(const entry of active.values())entry.resolve(false);await Promise.allSettled(pending);},
 };
}
