import type {Store} from './store';
import type {RunControl,RunIdentity} from '../shared/tasks';
export type NativeObservation='running'|'succeeded'|'failed'|'unknown'|'unreachable';
export function createTaskMonitor({store,listRuns,inspect,now=()=>Date.now()}:{store:Store;listRuns:()=>RunControl[];inspect:(identity:RunIdentity,conversationId:string)=>Promise<NativeObservation>;now?:()=>number}){
 const db=store.database,pending=new Set<string>();let closed=false;
 db.exec('CREATE TABLE IF NOT EXISTS task_run_observations(run_id TEXT PRIMARY KEY REFERENCES task_runs(id),checked_at TEXT NOT NULL,native_state TEXT NOT NULL)');
 return {
  async tick(){for(const run of listRuns()){
   if(closed||pending.has(run.id)||!['running','starting','unknown'].includes(run.state)||!run.routing||!run.hostId||!run.nativeSessionId||!run.nativeTurnId)continue;
   const previous=db.prepare('SELECT * FROM task_run_observations WHERE run_id=?').get(run.id),last=run.monitor?.lastProgressAt??run.createdAt;
   if(now()-Date.parse(last)<300000||previous&&now()-Date.parse(previous.checked_at as string)<60000)continue;
   pending.add(run.id);
   try{const state=await inspect({runId:run.id,hostId:run.hostId,nativeSessionId:run.nativeSessionId,nativeTurnId:run.nativeTurnId},run.routing.executionConversationId);
    if(closed)continue;
    store.transaction(()=>{db.prepare('INSERT INTO task_run_observations VALUES (?,?,?) ON CONFLICT(run_id) DO UPDATE SET checked_at=excluded.checked_at,native_state=excluded.native_state').run(run.id,new Date(now()).toISOString(),state);
     if(['failed','unknown','unreachable'].includes(state)&&previous?.native_state!==state)store.enqueueOutbox({type:'task.execution_attention',aggregateId:run.taskId,aggregateRevision:1,causationId:`${run.id}:${state}`,payload:{taskId:run.taskId,runId:run.id,reason:state,state:state==='unreachable'?'unknown':state}});
    });
   }finally{pending.delete(run.id);}
  }},
  hasActiveWork:()=>pending.size>0,
  close(){closed=true;},
 };
}
