import {draftTask,type TaskDraftGenerator} from './task-draft';
import { workspacePrincipal } from './workspace-identity';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionManager } from './sessions';
import type { Store } from './store';
import { validateTaskConfiguration } from './task-input';
import { readConfig } from './config';
import { createAssets } from './assets';
import { createAssetFiles } from './asset-files';
import { DomainError } from '../shared/workspace-contracts';
import type {Task} from '../shared/tasks';
const invalid=()=>{throw new DomainError('invalid_task_request',422,'Invalid task request');};
const fields=(data:any,allowed:string[])=>{if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(k=>!allowed.includes(k)))invalid();};
export function createTaskHttp(home:string,manager:SessionManager,store:Store,draftGenerate?:TaskDraftGenerator,readScope:<T>(read:()=>T)=>T=read=>read()){
 const tasks=manager.taskService,p=workspacePrincipal(store),assets=createAssets(store,createAssetFiles(home));
 const readableTask=(task:Task):Task=>{const executions=task.executions.filter(execution=>{
  try{manager.authorizeConversationRead(execution.conversationId);return true;}
  catch(error){if(error instanceof DomainError&&[403,404].includes(error.status))return false;throw error;}
 });return {...task,executions,conversationIds:executions.filter(execution=>!execution.supersededByExecutionId).map(execution=>execution.conversationId)};};
 return async(req:IncomingMessage,res:ServerResponse,url:URL,body:(req:IncomingMessage)=>Promise<any>)=>{
  if(!url.pathname.startsWith('/api/v2/tasks'))return false;
  const parts=url.pathname.slice('/api/v2/tasks'.length).split('/').filter(Boolean).map(decodeURIComponent),[id,action]=parts;
  let result:unknown,status=200;
  const key=()=>{const value=req.headers['idempotency-key'];if(typeof value!=='string'||!value||value.length>200)return invalid();return value;};
  const configured=async(projectId:string|null,agentId:string|null)=>{const {config}=await readConfig(home);if(projectId!==null&&!config.projects.some(p=>p.id===projectId)||agentId!==null&&!config.agents.some(a=>a.id===agentId))invalid();};
  if(req.method==='POST'&&id==='draft'&&parts.length===1){result=await draftTask(await body(req),draftGenerate);}
  else if(req.method==='GET'&&id==='context'&&parts.length===1){
   if([...url.searchParams.keys()].some(k=>k!=='conversationId'))invalid();
   const conversationId=url.searchParams.get('conversationId');if(!conversationId)invalid();
   manager.authorizeConversationRead(conversationId!);const c=store.getConversation(conversationId!);if(!c)invalid();
   const {config}=await readConfig(home),project=config.projects.find(v=>v.id===c!.projectId),agent=config.agents.find(v=>v.id===c!.agentId);
   result={conversationId:c!.id,project:project?{id:project.id,name:project.name}:null,agent:agent?{id:agent.id,name:agent.name}:null};
  } else if(req.method==='GET'&&id==='source'&&parts.length===1){
   if([...url.searchParams.keys()].some(k=>!['assetId','versionId'].includes(k)))invalid();
   const assetId=url.searchParams.get('assetId'),versionId=url.searchParams.get('versionId');if(!assetId||!versionId)invalid();
   const version=assets.getAuthorizedVersion(p,{assetId:assetId!,versionId:versionId!});
   result=null;
   if(version.provenance.runId){
    try {
     const run=tasks.getRun(p,version.provenance.runId);
     if(run.artifactVersions.some(ref=>ref.assetId===assetId&&ref.versionId===versionId)){
      const task=tasks.getTask(p,run.taskId),latest=tasks.listRunControls(p,task.id).at(-1);
      tasks.getContextSnapshot(p,run.id);
      result={task:{id:task.id,goal:task.goal,state:task.state,revision:task.revision,projectId:task.projectId},run:{id:run.id,state:run.state,routing:run.routing},currentOutput:latest?.id===run.id&&assets.getAuthorizedAsset(p,assetId!).headVersionId===version.id};
     }
    }catch(error){if(!(error instanceof DomainError)||![403,404].includes(error.status))throw error;}
   }
  } else if(req.method==='GET'&&!parts.length){
   if([...url.searchParams.keys()].some(k=>!['projectId','conversationId'].includes(k)))invalid();
   result=readScope(()=>tasks.listTasks(p).map(readableTask).filter(t=>(!url.searchParams.has('projectId')||t.projectId===url.searchParams.get('projectId'))&&(!url.searchParams.has('conversationId')||t.conversationIds.includes(url.searchParams.get('conversationId')!))).map(task=>{
    const conversationId=tasks.listRunControls(p,task.id).at(-1)?.routing?.executionConversationId;
    let executionTitle:string|null=null;
    if(conversationId)try{manager.authorizeConversationRead(conversationId);executionTitle=store.getConversation(conversationId)?.title?.trim()||null;}
    catch(error){if(!(error instanceof DomainError)||![403,404].includes(error.status))throw error;}
    return executionTitle?{...task,executionTitle}:task;
   }));
  } else if(req.method==='GET'&&parts.length===2&&action==='runs'){result=tasks.listRuns(p,id);
  } else if(req.method==='GET'&&parts.length===2&&action==='control') {
   const t=tasks.getTask(p,id);result={taskId:t.id,state:t.state,waitingReason:t.waitingReason,revision:t.revision,runs:tasks.listRunControls(p,id).map(r=>({monitor:r.monitor,id:r.id,state:r.state,waitingForDirectory:r.waitingForDirectory,attempt:r.attempt,routing:r.routing}))};
  } else if(req.method==='GET'&&parts.length===1){
   const task=readableTask(tasks.getTask(p,id)),runs=tasks.listRuns(p,id),contexts=runs.map(r=>tasks.getContextSnapshot(p,r.id)).filter(Boolean);
   const readableAssociatedChats=task.conversationIds.flatMap(conversationId=>{
    try {const chat=store.getConversation(conversationId);if(!chat)return [];manager.authorizeConversationRead(conversationId);const executionId=manager.executionId(conversationId);return [{id:chat.id,title:chat.title,agentId:chat.agentId,projectId:chat.projectId,cli:chat.cli,status:chat.status,updatedAt:chat.updatedAt,...executionId?{executionId}:{}}];}
    catch(error){if(error instanceof DomainError&&[403,404].includes(error.status))return [];throw error;}
   });
   result={task,runs,contexts,readableAssociatedChats,receipts:tasks.listReceipts(p,id),executions:task.executions,planVersions:tasks.planVersions(p,id)};
  } else if(req.method==='PATCH'&&parts.length===1){
   const data=await body(req);fields(data,['expectedRevision','goal','criteria','projectId','assigneeAgentId','participantAgentIds','originConversationId','automaticProgress','state']);
   const {expectedRevision,...patch}=data;validateTaskConfiguration((await readConfig(home)).config,patch);
   result=tasks.updateTask(p,id,expectedRevision,patch,key());
  } else if(req.method==='POST'){
   const data=await body(req);
   if(!parts.length){fields(data,['goal','criteria','acceptance','projectId','assigneeAgentId','participantAgentIds','originConversationId','automaticProgress']);validateTaskConfiguration((await readConfig(home)).config,data);result=tasks.createTask(p,data,key());status=201;}
   else if(parts.length===2&&action==='executions'){
    fields(data,['conversationId','expectedRevision']);if(typeof data.conversationId!=='string'||!data.conversationId.trim()||!Number.isSafeInteger(data.expectedRevision)||data.expectedRevision<1)invalid();manager.authorizeConversationRead(data.conversationId);result=readableTask(tasks.attachExecution(p,id,data.expectedRevision,data.conversationId,key()));status=201;
   } else if(parts.length===4&&action==='executions'&&parts[3]==='remove'){
    fields(data,['expectedRevision']);result=readableTask(tasks.removeExecution(p,id,data.expectedRevision,parts[2],key()));
   }
   else if(id==='adopt-plan'&&parts.length===1){fields(data,['plan','steps']);fields(data.plan,['assetId','versionId']);if(!Array.isArray(data.steps))invalid();for(const step of data.steps)fields(step,['key','taskId','goal']);result=tasks.adoptPlan(p,data.plan,data.steps,key());status=201;}
   else if(parts.length===2&&action==='mark-completed'){fields(data,['expectedRevision']);result=tasks.moveTask(p,id,data.expectedRevision,'completed',null,key());}
   else if(parts.length===2&&action==='move'){fields(data,['expectedRevision','state','reason']);if(data.reason!==undefined&&data.reason!==null&&typeof data.reason!=='string')invalid();result=tasks.moveTask(p,id,data.expectedRevision,data.state,data.reason??null,key());}
   else if(parts.length===2){
    fields(data,['expectedRevision',...(action==='start'?['conversationId']:action==='assign'?['agentId']:action==='reopen'||action==='request_changes'?['reason','expectedOutput']:[])]);
    if(data.expectedOutput!==undefined){fields(data.expectedOutput,['assetId','versionId','runId']);if(['assetId','versionId','runId'].some(k=>typeof data.expectedOutput[k]!=='string'||!data.expectedOutput[k].trim()))invalid();}
    if(!Number.isSafeInteger(data.expectedRevision)||data.expectedRevision<1)invalid();
    if(action==='stop'||action==='cancel')result=await manager.stopDurableTask(id,data.expectedRevision,action==='cancel');
    else if(action==='start'){result=await manager.startDurableTask(id,data.expectedRevision,key(),data.conversationId);status=202;}
    else if(['complete','accept','reopen','request_changes','assign'].includes(action)){
     if(action==='assign')await configured(tasks.getTask(p,id).projectId,data.agentId);
     result=tasks.userCommand(p,id,data.expectedRevision,action as 'complete',action==='assign'?data.agentId:data.reason??null,data.expectedOutput,data.expectedOutput?key():undefined);
    } else invalid();
   } else invalid();
   if(parts.length===2&&['move','mark-completed','accept','cancel'].includes(action))manager.presentTaskDecision(id);
  } else {status=405;result={error:'Method not allowed'};}
  if(Array.isArray(result)&&!(req.method==='GET'&&!parts.length))result=result.map(item=>item&&typeof item==='object'&&'executions' in item&&'goal' in item?readableTask(item as Task):item);
  if(result&&typeof result==='object'&&'executions' in result&&'goal' in result)result=readableTask(result as Task);
  res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(result));return true;
 };
}
