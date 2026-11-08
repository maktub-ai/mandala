import type {Store} from './store';
import type {createTasks} from './tasks';
import {DomainError,type Principal} from '../shared/workspace-contracts';
import type {TaskNotices} from '../shared/task-notifications';

export function taskNotifications(store:Store,tasks:ReturnType<typeof createTasks>,principal:Principal,after?:number,authorizeConversation?:(id:string)=>void):TaskNotices {
 if(after!==undefined&&(!Number.isSafeInteger(after)||after<0))throw new DomainError('invalid_cursor',422,'invalid_cursor');
 const head=Number(store.database.prepare('SELECT COALESCE(MAX(sequence),0) AS head FROM outbox').get()!.head);
 if(after===undefined||after>head)return {cursor:head,items:[]};
 const rows=store.database.prepare('SELECT sequence,id,type,payload,created_at FROM outbox WHERE sequence>? ORDER BY sequence LIMIT 100').all(after);
 const items:TaskNotices['items']=[];
 for(const row of rows){
  if(!['task.run_terminal','task.execution_attention'].includes(row.type as string))continue;
  const payload=JSON.parse(row.payload as string);
  if(typeof payload.taskId!=='string')continue;
  try {
   const task=tasks.getTask(principal,payload.taskId);
   let state=typeof payload.state==='string'?payload.state:'waiting';
   if(row.type==='task.run_terminal'&&state==='todo'&&typeof payload.runId==='string')state=tasks.getRun(principal,payload.runId).state;
   if(!['completed','review','waiting','approval','failed','succeeded','unknown','input'].includes(state))continue;
   let executionConversationId:string|undefined,title=task.goal.split('\n')[0].slice(0,80);
   if(typeof payload.runId==='string'){
    try{const run=tasks.getRunControl(principal,payload.runId);if(run.taskId===task.id&&run.routing){
     const id=run.routing.executionConversationId;authorizeConversation?.(id);
     if(principal.userId===store.ownerUserId||authorizeConversation)title=store.getConversation(id)?.title?.trim()||title;
     if(['approval','input'].includes(state))executionConversationId=id;
    }}
    catch(error){if(!(error instanceof DomainError)||![403,404].includes(error.status))throw error;}
   }
   items.push({...(executionConversationId?{executionConversationId}:{}),id:row.id as string,taskId:task.id,runId:typeof payload.runId==='string'?payload.runId:null,title,goal:task.goal.split('\n')[0].slice(0,160),state,createdAt:row.created_at as string});
  }catch(error){if(!(error instanceof DomainError)||![403,404].includes(error.status))throw error;}
 }
 return {cursor:Number(rows.at(-1)?.sequence??head),items};
}
