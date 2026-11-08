import {managedChangeFields,managedValueText} from '../shared/mandala-coordination';
import {enabledRuntimes} from '../shared/runtimes';
import {randomUUID,createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {Store} from './store';
import type {createTasks} from './tasks';
import {readConfig,writeConfig,validateConfig} from './config';
import type {Config} from '../shared/types';
import {isHumanInput,type Criterion,type Task} from '../shared/tasks';
import type {MandalaOwnership,ManagedChange,ManagementProposal} from '../shared/mandala-coordination';
import {DomainError} from '../shared/workspace-contracts';
import {workspacePrincipal} from './workspace-identity';
// This source is constructed by SessionManager from its current live invocation, never from tool arguments.
export type CoordinationSource={agentId:string;conversationId:string;invocationId:string;humanEventId?:number;assertActive?:()=>void};
const fail=(code:string,status=403):never=>{throw new DomainError(code,status,code);};
export function createMandalaCoordination({home,store,tasks}:{home:string;store:Store;tasks:ReturnType<typeof createTasks>}) {
 const db=store.database,root=workspacePrincipal(store);
 db.exec(`CREATE TABLE IF NOT EXISTS mandala_ownership(task_id TEXT PRIMARY KEY REFERENCES work_tasks(id),data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS mandala_temporary_agents(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS mandala_management(id TEXT PRIMARY KEY,command_key TEXT UNIQUE NOT NULL,payload TEXT NOT NULL,data TEXT NOT NULL);`);
 db.exec('CREATE TABLE IF NOT EXISTS mandala_delivery_pause(conversation_id TEXT PRIMARY KEY)');
 const ownership=(id:string):MandalaOwnership|undefined=>{const r=db.prepare('SELECT data FROM mandala_ownership WHERE task_id=?').get(id);return r?JSON.parse(r.data as string):undefined;};
 const list=()=>db.prepare('SELECT data FROM mandala_ownership ORDER BY rowid DESC').all().map(r=>JSON.parse(r.data as string) as MandalaOwnership);
 const verify=async(source:CoordinationSource,human=false)=>{
  const {config}=await readConfig(home),agent=config.agents.find(a=>a.id===source.agentId),chat=store.getConversation(source.conversationId);
  if(agent?.systemRole!=='mandala'||config.mandala?.agentId!==agent.id||chat?.agentId!==agent.id)fail('forbidden');
  if(human){const event=store.listEvents(chat!.id,0).find(e=>e.id===source.humanEventId),data=event?.data as {invocationId?:string;task?:unknown;agentMessage?:unknown;source?:unknown}|undefined;
   if(!event||event.kind!=='user'||data?.invocationId!==source.invocationId||!isHumanInput(data))fail('human_request_required');}
  source.assertActive?.();return config;
 };
 const requireOwned=(source:CoordinationSource,id:string)=>{const own=ownership(id);if(!own||own.agentId!==source.agentId)fail('goal_not_owned');return tasks.getTask({...root,agentId:source.agentId},id);};
 const record=(source:CoordinationSource,task:Task,relation:MandalaOwnership['relation'])=>{
  if(!ownership(task.id))db.prepare('INSERT INTO mandala_ownership VALUES (?,?)').run(task.id,JSON.stringify({taskId:task.id,agentId:source.agentId,relation,conversationId:source.conversationId,sourceEventId:source.humanEventId??null,invocationId:source.invocationId,createdAt:new Date().toISOString(),blockedReason:null} satisfies MandalaOwnership));
  return task;
 };
 const applyChange=(config:Config,change:ManagedChange):Config=>{
  if(!change||!['agent','project'].includes(change.kind)||!['create','update','archive','promote'].includes(change.action)||Object.keys(change).some(k=>!['kind','action','id','values'].includes(k)))fail('invalid_management_change',422);
  const collection=change.kind==='agent'?'agents':'projects',items=config[collection],old=items.find(a=>a.id===change.id);
  if(old&&('systemRole'in old&&old.systemRole||old.id===config.mandala?.agentId))fail('system_identity_protected');
  if(change.action!=='create'&&!old)fail('managed_object_not_found',404);
  const values=structuredClone(change.values??{}),allowed=managedChangeFields[change.kind];
  if(!values||typeof values!=='object'||Array.isArray(values)||Object.keys(values).some(k=>!allowed.includes(k))||change.action!=='create'&&Object.hasOwn(values,'id'))fail('invalid_management_change',422);
  if(['archive','promote'].includes(change.action)&&Object.keys(values).length)fail('invalid_management_change',422);
  if(change.action==='create'&&(!values.id||items.some(a=>a.id===values.id)))fail('invalid_management_change',422);
  if(change.action==='promote'&&(change.kind!=='agent'||!(old as Config['agents'][number]).temporary))fail('temporary_agent_required',422);
  const updated=change.action==='archive'?{...old,archivedAt:new Date().toISOString()}:change.action==='promote'?{...old,temporary:false}:{...old,...values};
  const result={...config,[collection]:change.action==='create'?[...items,updated]:items.map(a=>a.id===change.id?updated:a)} as Config;
  validateConfig(result);return result;
 };
 const decisions=new Map<string,Promise<ManagementProposal>>();
 const proposal=(id:string):ManagementProposal=>{const r=db.prepare('SELECT data FROM mandala_management WHERE id=?').get(id);return r?JSON.parse(r.data as string):fail('proposal_not_found',404);};
 return {
  ownership,list,verify,requireOwned,
  managedTaskIds():Set<string>{return new Set(list().map(item=>item.taskId));},
  pauseDelivery(id:string){db.prepare('INSERT OR IGNORE INTO mandala_delivery_pause VALUES (?)').run(id);},
  resumeDelivery(id:string){db.prepare('DELETE FROM mandala_delivery_pause WHERE conversation_id=?').run(id);},
  deliveryPaused(id:string){return !!db.prepare('SELECT conversation_id FROM mandala_delivery_pause WHERE conversation_id=?').get(id);},

  async create(source:CoordinationSource,input:{goal:string;criteria:Criterion[];projectId:string|null},key:string){
   const config=await verify(source);if(!Array.isArray(input.criteria)||!input.criteria.length||!Object.hasOwn(input,'projectId')||input.projectId!==null&&!config.projects.some(p=>p.id===input.projectId&&!p.archivedAt))fail('invalid_goal',422);
   return store.transaction(()=>record(source,tasks.prepareCreate({...root,agentId:source.agentId},{goal:input.goal,criteria:input.criteria,projectId:input.projectId,participantAgentIds:[source.agentId],originConversationId:source.conversationId,acceptance:'human'},key).commit(),'created'));
  },
  async takeover(source:CoordinationSource,input:{taskId:string;expectedRevision:number;criteria:Criterion[]},key:string){
   await verify(source,true);if(!Array.isArray(input.criteria)||!input.criteria.length)fail('criteria_required',422);
   return store.transaction(()=>{const task=tasks.getTask(root,input.taskId);const result=tasks.prepareUpdate(root,task.id,input.expectedRevision,{criteria:input.criteria,originConversationId:source.conversationId,participantAgentIds:[...new Set([...task.participantAgentIds,source.agentId])]},key).commit();return record(source,result,'taken-over');});
  },
  async request(source:CoordinationSource,input:{taskId:string;expectedRevision:number;text:string;blocked?:boolean},key:string){
   await verify(source);const task=requireOwned(source,input.taskId);if(typeof input.text!=='string'||!input.text.trim()||input.text.length>4000||input.blocked!==undefined&&typeof input.blocked!=='boolean')fail('invalid_request',422);
   return store.transaction(()=>{const previous=store.listEvents(source.conversationId,0).find(e=>e.kind==='metadata'&&(e.data as {mandalaRequestKey?:string}).mandalaRequestKey===key);if(previous){const data=previous.data as {mandalaRequest:unknown};if(JSON.stringify(data.mandalaRequest)!==JSON.stringify({taskId:task.id,text:input.text,blocked:input.blocked??false}))fail('idempotency_conflict',409);return task;}const updated=tasks.prepareUpdate({...root,agentId:source.agentId},task.id,input.expectedRevision,{state:'waiting'},key).commit();const own=ownership(task.id)!;db.prepare('UPDATE mandala_ownership SET data=? WHERE task_id=?').run(JSON.stringify({...own,blockedReason:input.blocked?input.text:null}),task.id);store.appendEvent(source.conversationId,'metadata',{mandalaRequestKey:key,mandalaRequest:{taskId:task.id,text:input.text,blocked:input.blocked??false},mandalaRequestRevision:updated.revision,invocationId:source.invocationId});return updated;});
  },
  async configure(source:CoordinationSource,change:ManagedChange,mode:'direct'|'propose',key:string,assertActive:()=>void):Promise<ManagementProposal>{
   await verify(source,mode==='direct');assertActive();if(!['direct','propose'].includes(mode)||!key?.trim()||key.length>200)fail('invalid_management_change',422);
   if(!change||typeof change!=='object')fail('invalid_management_change',422);
   if(change.action==='promote'&&mode!=='propose')fail('promotion_confirmation_required');
   const payload=JSON.stringify({change,mode}),commandKey=source.conversationId+':'+key,prior=db.prepare('SELECT data,payload FROM mandala_management WHERE command_key=?').get(commandKey);
   if(prior){if(prior.payload!==payload)fail('idempotency_conflict',409);const previous=JSON.parse(prior.data as string) as ManagementProposal;if(previous.status==='failed')throw new DomainError(previous.failure?.code??'invalid_management_change',422,'Configuration change was not applied; review the existing result');return previous;}
   const {config,revision}=await readConfig(home);let next:Config;
   try{next=applyChange(config,change);}catch(cause){
    const error=cause instanceof Error&&cause.message==='invalid configuration'?new DomainError('invalid_configuration',422,'invalid configuration; check the field values'):cause;
    if(error instanceof DomainError&&[404,409,422].includes(error.status)&&['agent','project'].includes(change.kind)&&['create','update','archive','promote'].includes(change.action)){
     const objectName=typeof change.values?.name==='string'?change.values.name:'';
     const failed:ManagementProposal={id:randomUUID(),version:randomUUID(),conversationId:source.conversationId,change:{kind:change.kind,action:change.action,...(typeof change.id==='string'?{id:change.id}:{}),values:{name:objectName,...(typeof change.values?.id==='string'?{id:change.values.id}:{})}},objectName,configRevision:revision,status:'failed',createdAt:new Date().toISOString(),failure:{code:error.code}};
     db.prepare('INSERT INTO mandala_management VALUES (?,?,?,?)').run(failed.id,commandKey,payload,JSON.stringify(failed));store.appendEvent(source.conversationId,'metadata',{mandalaProposal:failed,sourceEventId:source.humanEventId??null,invocationId:source.invocationId});
    }
    throw error;
   }
   assertActive();
   const previous=(change.kind==='agent'?config.agents:config.projects).find(item=>item.id===change.id) as Record<string,unknown>|undefined;
   const keys=Object.keys(change.values??{}).filter(key=>key!=='id');
   const summary={before:Object.fromEntries(keys.map(key=>[key,managedValueText(key,previous?.[key])])),after:Object.fromEntries(keys.map(key=>[key,managedValueText(key,change.values?.[key])]))};
   const item:ManagementProposal={id:randomUUID(),version:randomUUID(),conversationId:source.conversationId,change,configRevision:revision,status:'pending',createdAt:new Date().toISOString(),objectName:String(change.values?.name??previous?.name??''),summary,...(isDeepStrictEqual(config,next)?{unchanged:true}:{})};
   db.prepare('INSERT INTO mandala_management VALUES (?,?,?,?)').run(item.id,commandKey,payload,JSON.stringify(item));
   if(mode==='direct'){try{await writeConfig(home,next,revision,assertActive);item.status='applied';db.prepare('UPDATE mandala_management SET data=? WHERE id=?').run(JSON.stringify(item),item.id);}catch(error){item.failure={code:error instanceof DomainError?error.code:'result_unconfirmed'};db.prepare('UPDATE mandala_management SET data=? WHERE id=?').run(JSON.stringify(item),item.id);store.appendEvent(source.conversationId,'metadata',{mandalaProposal:item,sourceEventId:source.humanEventId??null,invocationId:source.invocationId});throw error;}}
   store.appendEvent(source.conversationId,'metadata',{mandalaProposal:item,sourceEventId:source.humanEventId??null,invocationId:source.invocationId});return item;
  },
  proposals:(conversationId:string)=>db.prepare('SELECT data FROM mandala_management').all().map(r=>JSON.parse(r.data as string) as ManagementProposal).filter(p=>p.conversationId===conversationId),
  async confirm(id:string,version:string,decision:'approve'|'reject',assertActive?:()=>void){
   const operation=(decisions.get(id)??Promise.resolve()).catch(()=>{}).then(async()=>{
   assertActive?.();
   const item=proposal(id);if(item.version!==version||!['approve','reject'].includes(decision))fail('proposal_conflict',409);if(item.status!=='pending')return item;
   if(decision==='approve'){const {config,revision}=await readConfig(home);if(revision!==item.configRevision)throw new DomainError('configuration_changed',409,'configuration changed; create a new proposal');await writeConfig(home,applyChange(config,item.change),item.configRevision,assertActive);item.status='applied';}else item.status='rejected';
   db.prepare('UPDATE mandala_management SET data=? WHERE id=?').run(JSON.stringify(item),id);store.appendEvent(item.conversationId,'metadata',{mandalaProposal:item});return item;
   });
   decisions.set(id,operation);
   try{return await operation;}finally{if(decisions.get(id)===operation)decisions.delete(id);}
  },
  async temporary(source:CoordinationSource,input:{templateAgentId?:string;name:string;projectId:string|null},key:string,assertActive:()=>void){
   await verify(source);if(!key?.trim()||key.length>200)fail('invalid_command_key',422);const {config,revision}=await readConfig(home),template=config.agents.find(a=>a.id===input.templateAgentId&&!a.systemRole&&!a.archivedAt);
   if(input.templateAgentId!==undefined&&!template||typeof input.name!=='string'||!input.name.trim())fail('invalid_temporary_agent',422);
   if(!Object.hasOwn(input,'projectId')||input.projectId!==null&&!config.projects.some(p=>p.id===input.projectId&&!p.archivedAt&&(!template||p.agentIds.includes(template.id))))fail('invalid_temporary_project',422);
   const id='temporary-'+createHash('sha256').update(source.conversationId+':'+key).digest('hex').slice(0,32),previous=config.agents.find(a=>a.id===id);
   const payload=JSON.stringify(input),record=db.prepare('SELECT payload FROM mandala_temporary_agents WHERE id=?').get(id);
   if(record&&record.payload!==payload)fail('idempotency_conflict',409);
   if(previous){if(!record)fail('idempotency_conflict',409);return previous;}
   db.prepare('INSERT OR IGNORE INTO mandala_temporary_agents VALUES (?,?)').run(id,payload);
   const available=enabledRuntimes(config),preferred=config.agents.find(a=>a.id===source.agentId)!.defaultCli,cli=template?.defaultCli??(available.includes(preferred)?preferred:available[0]);
   if(!cli||!available.includes(cli))fail('runtime_disabled',422);
   const agent:Config['agents'][number]={...(template??{instructions:'Execute the assigned task and report explicit results, blockers and remaining questions. Do not claim coordinator authority.',defaultCli:cli,models:{},mcp:[],skills:[]}),id,name:input.name,temporary:true};
   assertActive();await writeConfig(home,{...config,agents:[...config.agents,agent],projects:config.projects.map(p=>p.id===input.projectId?{...p,agentIds:[...p.agentIds,id]}:p)},revision,assertActive);return agent;
  },
 };
}
