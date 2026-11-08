import { productEnv } from "../cli/product-env.mjs";
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {readConfig,writeConfig} from '../server/config';
import {openStore} from '../server/store';
import {createAutomations} from '../server/automations';
import type {Automation} from '../shared/automations';
import {createSessionManager} from '../server/sessions';
import {createHttpServer} from '../server/http';
import {connectCodex,type CodexOptions} from '../server/codex';
import {createRpcClient} from '../server/rpc';
import type {Task} from '../shared/tasks';

const runFile=promisify(execFile),nativeCli=productEnv('SMOKE_CLI')==='omp'?'omp':'codex';
const home=await mkdtemp(join(tmpdir(),'mandala-task-cli-smoke-')),root={userId:'local'};
const initial=await readConfig(home);
await writeConfig(home,{...initial.config,system:{cli:nativeCli,memoryCapture:false},projects:[{id:'sample',name:'Synthetic Task sample',cwd:'',agentIds:['sample-agent'],resources:[],mcp:[],skills:[]}],agents:[{id:'sample-agent',name:'Synthetic Task Agent',defaultCli:nativeCli,models:{},instructions:'Use only Mandala CLI and the synthetic sample in this prompt. Do not read personal files or credentials. Task completion requires user acceptance.',mcp:[],skills:[],runtime:{[nativeCli]:{approvalMode:'auto' as const,...(nativeCli==='codex'?{fullAccess:false}:{})}}}]},initial.revision);
const store=openStore(home),load=async()=>(await readConfig(home)).config;
const factory=async(options:CodexOptions)=>{
 const rpc=createRpcClient(spawn('codex',['-c','sandbox_mode="workspace-write"','-c','sandbox_workspace_write.network_access=false','app-server','--stdio'],{cwd:options.cwd,stdio:'pipe',shell:false}),{onNotification:options.onEvent,onRequest:options.onApproval,onExit:options.onExit});
 return connectCodex(rpc,options.cwd,false);
};
const finalAnswers=new Map<string,string>();
const manager=createSessionManager(store,load,factory,undefined,home,(id,round)=>{if(round)finalAnswers.set(id,round.reply);});
const automations=createAutomations({home,store,manager,loadConfig:load}),server=createHttpServer({requireIdentity:false,home,store,manager,automations});
server.listen(0,'127.0.0.1');await once(server,'listening');
const port=(server.address() as {port:number}).port,previousPort=process.env.MANDALA_PORT;
process.env.MANDALA_PORT=String(port);
const cli=async(args:string[])=>{const {stdout}=await runFile(process.execPath,['cli/mandala.mjs','--base-url',`http://127.0.0.1:${port}`,...args],{maxBuffer:1024*1024});const result=JSON.parse(stdout);if(!result.ok)throw Error(JSON.stringify(result));return result.data;};
const boundCalls:{tool:string;key:string;ok:boolean;code?:string}[]=[];
let createdTask:Task|undefined,createdRule:Automation|undefined,referenceId:string|undefined;
const originalBound=manager.callBoundTool.bind(manager);
manager.callBoundTool=async(...args)=>{
 const entry={tool:args[1],key:args[3],ok:false} as (typeof boundCalls)[number];
 try{
  const result=await originalBound(...args);entry.ok=true;
  if(entry.tool==='task_create'){
   createdTask=result as Task;
   if(createdTask.projectId!==null||createdTask.conversationIds.length||createdTask.assigneeAgentId!==null)throw Error('Task creation inherited current context');
  }
  if(entry.tool==='task_runs'&&(!Array.isArray(result)||result.length))throw Error('Saved Task unexpectedly has execution history');
  if(entry.tool==='automation_create'){createdRule=result as Automation;if(createdRule.enabled||createdRule.taskId!==createdTask?.id||createdRule.agentId!==''||createdRule.projectId!=='')throw Error('Optional saved rule unexpectedly enabled or rebound');}
  if(entry.tool==='automation_list'){const state=result as {automations:Automation[];runs:unknown[]};if(state.automations.length!==1||state.runs.length||state.automations[0].enabled)throw Error('Automation readback mismatch');}
  if(entry.tool==='conversation_history'&&(args[2] as {conversationId?:string}).conversationId===referenceId&&!JSON.stringify(result).includes('TASK_HISTORY_OK'))throw Error('Synthetic history readback mismatch');
  return result;
 }catch(error){entry.ok=false;entry.code=(error as {code?:string}).code??'smoke_assertion';throw error;}
 finally{boundCalls.push(entry);console.log('BOUND '+JSON.stringify(entry));}
};
const wait=async(predicate:()=>boolean,label:string)=>{const deadline=Date.now()+(nativeCli==='omp'?300000:180000);while(!predicate()){if(Date.now()>deadline)throw Error('Timed out: '+label);await new Promise(r=>setTimeout(r,100));}};
try{
 console.log((await runFile(nativeCli,['--version'])).stdout.trim());
 const reference=store.createConversation({projectId:'sample',agentId:'sample-agent',cli:nativeCli,model:null});referenceId=reference.id;
 store.renameConversation(reference.id,'Synthetic task reference');store.appendEvent(reference.id,'user',{text:'TASK_HISTORY_OK: synthetic reference only'});store.appendEvent(reference.id,'text',{text:'Synthetic task reference acknowledged'});store.appendEvent(reference.id,'status',{status:'idle'});
 const chat=await cli(['conversations','create','--key','task-smoke-conversation','--data',JSON.stringify({projectId:'sample',agentId:'sample-agent',workspaceId:null})]);
 const prompt=`Perform this synthetic Task CLI acceptance test using the exact absolute Mandala CLI command in your instructions. Execute all steps and check the JSON results. Do not call other tools except native command execution; do not read personal files. Mutations use the given stable --key values.
1. Run tasks context. Remember the actual current conversationId. Context is descriptive only.
2. Run conversations list --data '{"query":"Synthetic task reference"}'. Agent read commands use --data, not --query. Find that reference conversation and run conversations history <its ID>. Verify TASK_HISTORY_OK in its history.
3. Run tasks create --key task-smoke-create --data '{"goal":"TASK_CLI_CREATED","projectId":null,"participantAgentIds":["sample-agent"],"criteria":[],"assigneeAgentId":null,"originConversationId":null}'. Confirm no project or conversation was inherited. Remember returned task ID and revision.
4. Run tasks update <task ID> --key task-smoke-update --data with expectedRevision from step 3, goal TASK_CLI_EDITED and criteria [{"id":"manual","text":"Await explicit user acceptance","checkRef":null}]. Confirm projectId remains null and conversationIds remains [].
5. Run tasks execution-add <task ID> --key task-smoke-link --data with expectedRevision returned in step 4 and conversationId from step 1. This must be the ONLY execution Chat; keep projectId null.
6. Negative permission test authorized for this sample: run tasks update <task ID> --key task-smoke-denied-completion --data with expectedRevision returned in step 5 and state completed. Expect nonzero exit with invalid_task; never retry using a different route, accept or cancel this task.
7. Run tasks get <task ID>. Verify TASK_CLI_EDITED, projectId null, the one explicit execution Chat, unchanged revision after denial, and state todo with completion null.
8. Discover the new commands with tasks runs --help and automations create --help and automations list --help. Run tasks runs <task ID>; its execution history must be [].
9. Save one optional disabled rule with automations create --key task-smoke-rule --data JSON containing taskId from step 3, name TASK_CLI_RULE, instructions TASK_CLI_EDITED, projectId empty string, agentId empty string, cli ${nativeCli}, enabled false, and schedule {kind:daily,time:09:00,timeZone:Asia/Singapore}. Quote every JSON string correctly. Keep the existing Task unassigned; do not change its project or Agent. Save only; never run or enable the rule. Confirm returned taskId and enabled false.
10. Run automations list. Read back the one TASK_CLI_RULE with the same taskId, enabled false, blank project/Agent, plus runs []. Run tasks runs <task ID> again and verify []. Reply TASK_AGENT_CLI_OK and the task ID only after these checks. Leave the goal unfinished; do not start an execution Run.`;
 await cli(['conversations','send',chat.id,'--key','task-smoke-send','--data',JSON.stringify({text:prompt})]);
 await wait(()=>!['running','approval'].includes(store.getConversation(chat.id)!.status),'real Agent Task CLI round');
 const currentChat=store.getConversation(chat.id)!;
 if(currentChat.status!=='idle')throw Error('Native round did not finish successfully: '+currentChat.status);
 const required=['task_context','conversation_list','conversation_history','task_create','task_update','task_execution_add','task_read','task_runs','automation_create','automation_list'];
 for(const tool of required)if(!boundCalls.some(call=>call.tool===tool&&call.ok))throw Error('Real Agent did not invoke '+tool);
 if(!boundCalls.some(call=>call.tool==='task_update'&&call.key==='task-smoke-denied-completion'&&!call.ok&&call.code==='invalid_task'))throw Error('Unsupported completed state patch was not rejected');
 if(!createdTask||createdTask.projectId!==null||createdTask.conversationIds.length)throw Error('Missing independent creation readback');
 const tasks=manager.taskService.listTasks(root);if(tasks.length!==1)throw Error('Expected one synthetic Task, found '+tasks.length);
 const task=tasks[0],linked=store.database.prepare('SELECT conversation_id FROM task_executions WHERE task_id=? AND superseded_by_execution_id IS NULL').all(task.id);
 if(task.id!==createdTask.id||task.goal!=='TASK_CLI_EDITED'||task.projectId!==null||task.state!=='todo'||task.completion!==null||task.assigneeAgentId!==null||task.revision!==3||task.conversationIds.length!==1||task.conversationIds[0]!==chat.id||linked.length!==1||linked[0].conversation_id!==chat.id||task.criteria[0]?.text!=='Await explicit user acceptance')throw Error('SQLite Task readback mismatch: '+JSON.stringify(task));
 const rules=await automations.list();if(!createdRule||rules.automations.length!==1||rules.automations[0].id!==createdRule.id||rules.automations[0].taskId!==task.id||rules.automations[0].enabled||rules.runs.length)throw Error('SQLite rule/read-history mismatch');
 const persistedRule=store.database.prepare('SELECT data FROM automation_rules WHERE id=?').get(createdRule.id);if(!persistedRule||JSON.parse(persistedRule.data as string).enabled!==false)throw Error('Saved rule enabled unexpectedly');
 if(Number(store.database.prepare('SELECT COUNT(*) n FROM automation_occurrences').get()!.n)!==0)throw Error('Saving created an occurrence');
 if(manager.taskService.listRuns(root,task.id).length)throw Error('Task gained an unrequested execution Run');
 if(!finalAnswers.get(chat.id)?.includes('TASK_AGENT_CLI_OK'))throw Error('Real Agent did not confirm final CLI readback in its completed final answer');
 console.log('PASS real '+nativeCli+' Agent Task context/create/update/link/get/runs; disabled optional automation create/list/history; scoped conversation list/history; explicit empty associations; unsupported state-patch rejection; unfinished SQLite readback');
 const closePrompt='I explicitly accept the synthetic goal '+task.id+' now. Use the exact Mandala CLI: tasks get to read its current revision; tasks mark-completed to finalize it; tasks get to verify completed and completedBy agent. Then tasks reopen with the current expectedRevision and reason Synthetic continuation; verify todo without starting work; tasks mark-completed again with its current revision and verify completed. Never start a Task Run, enable the saved schedule, or modify other records. Reply TASK_AGENT_CLOSE_OK only after final readback.';
 await cli(['conversations','send',chat.id,'--key','task-smoke-finalize','--data',JSON.stringify({text:closePrompt})]);
 await wait(()=>!['running','approval'].includes(store.getConversation(chat.id)!.status),'real Agent finalization and reopen');
 if(store.getConversation(chat.id)!.status!=='idle'||!finalAnswers.get(chat.id)?.includes('TASK_AGENT_CLOSE_OK'))throw Error('Agent did not finish completion/reopen round');
 const finished=manager.taskService.getTask(root,task.id);
 if(finished.state!=='completed'||finished.completion?.completedBy!=='agent'||finished.completion.completedByAgentId!=='sample-agent'||manager.taskService.listRuns(root,task.id).length)throw Error('Agent completion readback mismatch');
 for(const tool of ['task_mark_completed','task_reopen'])if(!boundCalls.some(call=>call.tool===tool&&call.ok))throw Error('Real Agent did not invoke '+tool);
 console.log('PASS real Agent mark-completed/reopen/finalize with actor evidence and no Task Run');

 console.log(JSON.stringify({nativeCli,sandbox:nativeCli==='codex'?'workspace-write with network disabled':'native OMP permissions',transport:nativeCli==='codex'?'private file mailbox':'loopback HTTP',home,taskId:task.id,goal:task.goal,projectId:task.projectId,conversationIds:task.conversationIds,state:finished.state,revision:finished.revision,initialState:task.state,runCount:0,automationId:createdRule.id,ruleEnabled:false,occurrenceCount:0,boundCalls}));
}catch(error){
 console.error(JSON.stringify({diagnostics:store.listConversations().map(chat=>({id:chat.id,status:chat.status,errors:store.listEvents(chat.id,0).filter(event=>event.kind==='error').map(event=>event.data),finalAnswer:finalAnswers.get(chat.id),lastText:store.listEvents(chat.id,0).filter(event=>event.kind==='text').at(-1)?.data})),boundCalls,tasks:manager.taskService.listTasks(root)}));throw error;
}finally{
 if(previousPort===undefined)delete process.env.MANDALA_PORT;else process.env.MANDALA_PORT=previousPort;
 automations.close();await manager.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();await rm(home,{recursive:true,force:true});
}
