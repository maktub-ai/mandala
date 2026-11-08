import type { WorkbenchSnapshot, WorkbenchExecutionState, WorkbenchExecution, WorkbenchPending } from '../shared/workbench';
import type { Config } from '../shared/types';
import { workspacePrincipal } from './workspace-identity';
import { nativeQuestions, hasBlockingApprovals } from '../shared/questions';
import type { Store } from './store';
import type { SessionManager } from './sessions';
import type { MemoryRuntime } from './memory-runtime';
import { readKnowledge } from './knowledge';
const chatHref=(id:string,projectId:string|null)=>'/?'+new URLSearchParams({conversation:id,...projectId?{project:projectId}:{}});
const taskHref=(id:string)=>'/tasks/'+encodeURIComponent(id);
const runState=(state:string):WorkbenchExecutionState|null=>state==='starting'||state==='running'?'running':state==='approval'?'approval':state==='queued'?'queued':state==='unknown'?'unknown':null;
export async function getWorkbench({home,store,manager,config,memoryRuntime,projectId,agentId}:{home:string;store:Store;manager:SessionManager;config:Config;memoryRuntime?:MemoryRuntime;projectId?:string;agentId?:string}):Promise<WorkbenchSnapshot> {
 const user=workspacePrincipal(store);
 const result:WorkbenchSnapshot={generatedAt:new Date().toISOString(),projectId:projectId||null,agents:[],agentOptions:[],pending:[],recentConversations:[],recentKnowledge:[],errors:[]};
 const inScope=(id:string|null|undefined)=>!projectId||id===projectId;
 const canRead=(id:string)=>{try{manager.authorizeConversationRead(id);return true;}catch{return false;}};
 const agents=new Map<string|null,WorkbenchSnapshot['agents'][number]>();
 const agent=(id:string|null)=>{let row=agents.get(id);if(!row){row={id,name:config.agents.find(a=>a.id===id)?.name??id??'',executions:[],counts:{running:0,approval:0,queued:0,unknown:0}};agents.set(id,row);}return row;};
 for(const a of config.agents)if(!projectId||config.projects.find(p=>p.id===projectId)?.agentIds.includes(a.id))agent(a.id);
 const addExecution=(execution:WorkbenchExecution)=>{const row=agent(execution.agentId);row.executions.push(execution);row.counts[execution.state]++;};
 const pendingKeys=new Set<string>();
 const pending=(item:WorkbenchPending)=>{const key=item.kind+':'+item.id;if(!pendingKeys.has(key)){pendingKeys.add(key);result.pending.push(item);}};
 const routed=new Set<string>(),approvalChats=new Set<string>();
 const addApprovals=(id:string,title:string,project:string|null,agentId:string|null,time:string)=>{
  if(approvalChats.has(id)||!canRead(id))return;approvalChats.add(id);
  for(const approval of manager.getApprovals(id))pending({kind:nativeQuestions(approval).length?'input':'approval',id:approval.id,title,href:chatHref(id,project),time,projectId:project,agentId});
 };
 try {
  for(const task of manager.taskService.listTasks(user)){
   const controls=manager.taskService.listRunControls(user,task.id);
   for(const run of controls)if(run.routing&&(run.routing.mode==='dedicated'||runState(run.state)))routed.add(run.routing.executionConversationId);
   const latest=controls.at(-1),conversationId=latest?.routing?.executionConversationId;
   const readable=!conversationId||canRead(conversationId);
   for(const run of controls){
    const state=runState(run.state);if(!state)continue;
    const id=run.routing?.executionConversationId??null,accessible=id?canRead(id):true;
    const executionChat=id?store.getConversation(id):undefined,executionProject=executionChat?executionChat.projectId||null:task.projectId,executionAgent=executionChat?executionChat.agentId||null:task.assigneeAgentId;
    if(!inScope(executionProject))continue;
    addExecution({id:run.id,kind:'run',conversationId:id,taskId:task.id,projectId:executionProject,agentId:executionAgent,state,title:accessible?task.goal:null,href:accessible?id?chatHref(id,executionProject):taskHref(task.id):null,time:run.createdAt,accessible});
    if(id&&accessible)addApprovals(id,task.goal,executionProject,executionAgent,run.createdAt);
   }
   if(!inScope(task.projectId)||!readable||task.state==='completed'||task.state==='cancelled')continue;
   const base={id:task.id,title:task.goal,href:taskHref(task.id),time:latest?.createdAt??task.createdAt,projectId:task.projectId,agentId:task.assigneeAgentId};
   if(task.state==='review')pending({...base,kind:'review'});
   else if(task.state==='waiting'&&task.waitingReason==='input'&&(!conversationId||!manager.getApprovals(conversationId).some(a=>nativeQuestions(a).length)))pending({...base,kind:'input'});
   else if(task.state==='waiting'&&['run_failed','interrupted','delivery_missing','check_failed'].includes(task.waitingReason??''))pending({...base,kind:'error'});
  }
 }catch{result.errors.push('tasks');}
 for(const chat of store.listConversations()){
  if(!inScope(chat.projectId)||chat.archivedAt||manager.isDedicatedConversation(chat.id)||!canRead(chat.id))continue;
  const project=chat.projectId||null,agentId=chat.agentId||null,title=chat.title??chat.id,time=chat.updatedAt??chat.createdAt,href=chatHref(chat.id,project);
  agent(agentId);
  const approvals=manager.getApprovals(chat.id);
  const inputs=manager.listUserInputs(chat.id).filter(input=>['queued','running','unknown'].includes(input.state));
  for(const input of inputs){
   const state=input.state==='running'&&hasBlockingApprovals(approvals)?'approval':input.state as WorkbenchExecutionState;
   addExecution({id:input.id,kind:'input',conversationId:chat.id,taskId:null,projectId:project,agentId,state,title,href,time:input.createdAt,accessible:true});
  }
  if(routed.has(chat.id))continue;
  const state=hasBlockingApprovals(approvals)?'approval':chat.status==='running'?'running':chat.status==='approval'?'unknown':null;
  if(state&&!inputs.some(input=>input.state==='running'))addExecution({id:chat.id,kind:'conversation',conversationId:chat.id,taskId:null,projectId:project,agentId,state,title,href,time,accessible:true});
  addApprovals(chat.id,title,project,agentId,time);
  if(chat.status==='error'||chat.status==='interrupted')pending({kind:'error',id:chat.id,title,href,time,projectId:project,agentId});
  result.recentConversations.push({id:chat.id,title,href,time,projectId:project,agentId});
 }
 try {
  const entries=await readKnowledge(home,store);
  for(const entry of entries){
   if(entry.kind!=='skill'||!inScope(entry.projectId)||entry.sourceConversationId&&!canRead(entry.sourceConversationId))continue;
   const href='/mana?'+new URLSearchParams({tab:'skill',knowledgeId:entry.id,...entry.projectId?{project:entry.projectId}:{}});
   result.recentKnowledge.push({kind:'skill',id:entry.id,title:entry.title,href,time:entry.updatedAt,projectId:entry.projectId??null,agentId:entry.agentId??(entry.sourceConversationId?store.getConversation(entry.sourceConversationId)?.agentId:null)??null,sourceHref:entry.sourceConversationId?chatHref(entry.sourceConversationId,entry.projectId??null):null});
   if(entry.status==='candidate')pending({kind:'skill',id:entry.id,title:entry.title,href,time:entry.updatedAt,projectId:entry.projectId??null,agentId:entry.agentId??null});
  }
 }catch{result.errors.push('knowledge');}
 try {
  if(memoryRuntime)for(const record of memoryRuntime.memory.listAll(user,{status:'active'})){
   const collection=memoryRuntime.memory.collection(user,record.collectionId);if(!inScope(collection.projectId)||record.conversationId&&!canRead(record.conversationId))continue;
   result.recentKnowledge.push({kind:'memory',id:record.recordId,title:record.legacy?.title??record.text.slice(0,100),href:'/mana?'+new URLSearchParams({tab:'memory',recordId:record.recordId,...collection.projectId?{project:collection.projectId}:{}}),time:record.extractedAt,projectId:collection.projectId,agentId:record.conversationId?store.getConversation(record.conversationId)?.agentId||null:collection.agentId,sourceHref:record.conversationId?chatHref(record.conversationId,collection.projectId):record.taskId?taskHref(record.taskId):null});
  }
 }catch{result.errors.push('memory');}
 const newest=<T extends {time:string;id:string}>(a:T,b:T)=>b.time.localeCompare(a.time)||a.id.localeCompare(b.id);
 for(const item of [...result.pending,...result.recentKnowledge])if(item.agentId)agent(item.agentId);
 result.agentOptions=[...agents.values()].map(({id,name})=>({id,name}));
 const matchesAgent=(id:string|null)=>agentId===undefined||id===(agentId||null);
 result.agents=[...agents.values()].filter(row=>matchesAgent(row.id));
 result.pending=result.pending.filter(item=>matchesAgent(item.agentId));
 result.recentConversations=result.recentConversations.filter(item=>matchesAgent(item.agentId));
 result.recentKnowledge=result.recentKnowledge.filter(item=>matchesAgent(item.agentId));for(const row of result.agents)row.executions.sort(newest);
 result.pending.sort(newest);result.recentConversations.sort(newest);result.recentConversations=result.recentConversations.slice(0,6);
 result.recentKnowledge.sort(newest);result.recentKnowledge=result.recentKnowledge.slice(0,6);
 return result;
}
