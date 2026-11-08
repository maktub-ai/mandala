import type {Store} from './store';
import type {createTasks} from './tasks';
import type {createTaskScheduler} from './task-scheduler';
import type {RunIdentity} from '../shared/tasks';
export type Inspection='running'|'succeeded'|'failed'|'unknown';
export type RecoveryReport={queued:number;terminal:number;unknown:number;inputsUnknown:number};
// Retain the actual claim before a local state change can hide native uncertainty.
// Called inside the caller's existing short Store transaction; no body/native identity is inferred.
export function retainNativeOccupancy(store:Store,kind:'run'|'input',claimId:string,conversationId:string) {
 store.database.prepare('INSERT OR IGNORE INTO task_native_uncertainty VALUES (?,?,?)').run(kind,claimId,conversationId);
}
export function hasUnprovenNativeOccupancy(store:Store,id:string):boolean {
 return Boolean(store.database.prepare('SELECT claim_id FROM task_native_uncertainty WHERE conversation_id=? LIMIT 1').get(id)||
  store.database.prepare("SELECT id FROM task_runs WHERE json_extract(routing,'$.executionConversationId')=? AND state IN ('starting','running','approval','unknown') LIMIT 1").get(id)||
  store.database.prepare("SELECT id FROM task_user_inputs WHERE conversation_id=? AND state IN ('running','unknown') LIMIT 1").get(id));
}
// Terminal evidence for an older invocation cannot release a later uncertain claim.
export function canReleaseNativeOccupancy(store:Store,id:string,confirmedInput?:{invocationId:string;nativeSessionId:string;nativeTurnId:string}):boolean {
 if(hasUnprovenNativeOccupancy(store,id))return false;
 const c=store.getConversation(id);
 const latest=(store.listEvents(id,0).filter(e=>e.kind==='metadata'&&(e.data as {execution?:string}).execution==='started').at(-1)?.data as {runId?:string}|undefined)?.runId;
 if(!c?.nativeId||!c.turnId||!latest)return false;
 if(confirmedInput?.invocationId===latest&&confirmedInput.nativeSessionId===c.nativeId&&confirmedInput.nativeTurnId===c.turnId)return true;
 return Boolean(store.database.prepare("SELECT id FROM task_runs WHERE id=? AND native_session_id=? AND native_turn_id=? AND state IN ('succeeded','failed') AND terminal_event_key IS NOT NULL").get(latest,c.nativeId,c.turnId));
}
// History can prove terminal, but cannot prove a live subscription. Adapters without
// reattachment support must return unknown rather than historical inProgress.
export function createTaskRecovery({store,tasks,scheduler,inspect,wake,onInputReconciled}: {
 store:Store;tasks:ReturnType<typeof createTasks>;scheduler:ReturnType<typeof createTaskScheduler>;
 onInputReconciled?:(inputId:string,outcome:Inspection,invocationId:string)=>void;
 inspect:(identity:RunIdentity,conversationId:string)=>Promise<Inspection>;wake:(id:string)=>void|Promise<void>;
}) {
 return async function reconcileRuns(hostId:string):Promise<RecoveryReport>{
  const db=store.database,report:RecoveryReport={queued:0,terminal:0,unknown:0,inputsUnknown:0};
  const conversations=new Set<string>(),terminalInputs=new Map<string,{invocationId:string;nativeSessionId:string;nativeTurnId:string}>();
  for(const row of db.prepare("SELECT * FROM task_runs WHERE host_id=? AND (state IN ('queued','starting','running','approval','unknown') OR id IN (SELECT claim_id FROM task_native_uncertainty WHERE kind='run')) ORDER BY rowid").all(hostId)){
   const route=row.routing?JSON.parse(row.routing as string):null;
   if(!route)continue;
   const id=route.executionConversationId as string;conversations.add(id);
   if(row.state==='queued'){report.queued++;continue;}
   const identity={runId:row.id as string,hostId,nativeSessionId:row.native_session_id as string,nativeTurnId:row.native_turn_id as string};
   let status:Inspection='unknown';
   if(identity.nativeSessionId&&identity.nativeTurnId)try{status=await inspect(identity,id);}catch{}
   if(status==='succeeded'||status==='failed'){
    // Only exact Run-associated native messages and published versions count as delivery.
    const messages=new Map<string,string>();
    for(const e of store.listEvents(id,0)){
     const d=e.data as {runId?:string;method?:string;params?:{item?:{id:string;type:string;phase?:string;text?:string}}};
     const item=d.params?.item;
     if(d.runId===row.id&&e.kind==='tool'&&d.method==='item/completed'&&item?.type==='agentMessage'&&item.phase==='final_answer')messages.set(item.id,item.text??'');
    }
    const artifactVersions=db.prepare("SELECT id,asset_id FROM asset_versions WHERE json_extract(data,'$.provenance.runId')=?").all(row.id as string).map(v=>({assetId:v.asset_id as string,versionId:v.id as string}));
    // Inquiry replies can execute inside a resumed Task Run. Consume the exact correlated
    // input before goal assessment so recovery does not mistake this reply for a dependency.
    for(const input of db.prepare("SELECT i.id FROM task_user_inputs i JOIN task_input_invocations n ON n.input_id=i.id WHERE i.conversation_id=? AND n.invocation_id=? AND n.native_session_id=? AND n.native_turn_id=? AND i.state IN ('running','unknown')").all(id,row.id as string,identity.nativeSessionId,identity.nativeTurnId)){
      scheduler.reconcileInput(input.id as string,true);
      onInputReconciled?.(input.id as string,status,row.id as string);
    }
    if(tasks.applyRunEvent({...identity,eventKey:`terminal:${row.id}`,outcome:status,summary:[...messages.values()].join('\n\n'),artifactVersions})==='applied')report.terminal++;
    db.prepare("DELETE FROM task_native_uncertainty WHERE kind='run' AND claim_id=?").run(row.id as string);
   }else{tasks.markUnknown(row.id as string);report.unknown++;}
  }
  for(const input of db.prepare("SELECT i.*,n.invocation_id,n.host_id,n.native_session_id,n.native_turn_id FROM task_user_inputs i LEFT JOIN task_input_invocations n ON n.input_id=i.id WHERE i.state IN ('running','unknown') OR i.id IN (SELECT claim_id FROM task_native_uncertainty WHERE kind='input')").all()){
   let status:Inspection='unknown';
   if(input.host_id===hostId&&input.native_session_id&&input.native_turn_id)try{status=await inspect({runId:input.invocation_id as string,hostId,nativeSessionId:input.native_session_id as string,nativeTurnId:input.native_turn_id as string},input.conversation_id as string);}catch{}
   const current=store.getConversation(input.conversation_id as string);
   const terminal=status==='succeeded'||status==='failed';if(terminal&&current?.nativeId===input.native_session_id&&current?.turnId===input.native_turn_id)terminalInputs.set(input.conversation_id as string,{invocationId:input.invocation_id as string,nativeSessionId:input.native_session_id as string,nativeTurnId:input.native_turn_id as string});scheduler.reconcileInput(input.id as string,terminal);
   onInputReconciled?.(input.id as string,status,input.invocation_id as string);
   if(!terminal)report.inputsUnknown++;
   conversations.add(input.conversation_id as string);
  }
  for(const row of db.prepare("SELECT DISTINCT conversation_id FROM task_user_inputs WHERE state='queued'").all())conversations.add(row.conversation_id as string);
  for(const row of db.prepare("SELECT DISTINCT destination_conversation_id FROM task_receipts WHERE delivery_state IN ('pending','presented') AND destination_conversation_id IS NOT NULL").all())conversations.add(row.destination_conversation_id as string);
  for(const id of conversations){
   const uncertain=hasUnprovenNativeOccupancy(store,id);
   // A plain interrupted conversation has no correlated terminal proof and stays interrupted.
   const c=store.getConversation(id);
   if(uncertain&&c&&['idle','error'].includes(c.status))store.updateConversation(id,{status:'interrupted'});
   if(!uncertain&&canReleaseNativeOccupancy(store,id,terminalInputs.get(id))&&c?.status==='interrupted')store.updateConversation(id,{status:'idle',turnId:null});
   if(!uncertain)await wake(id);
  }
  return report;
 };
}
