import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Store} from '../../server/store';
import type {SessionManager} from '../../server/sessions';
import type {Automations} from '../../server/automations';
import {ensureMandalaConfig,writeConfig} from '../../server/config';
import {ensureMandalaConversation} from '../../server/mandala';
let saved:Record<string,string>|undefined;
export async function executionResultsFixture(req:IncomingMessage,res:ServerResponse,home:string,store:Store,manager:SessionManager,automations:Automations){
 if(req.method!=='POST'||req.url!=='/__test__/execution-results')return false;
 if(saved){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(saved));return true;}
 const {config,revision}=await ensureMandalaConfig(home),main=ensureMandalaConversation(store,config),prefix=crypto.randomUUID();
 const worker={id:prefix+'-worker',name:'报告执行者',instructions:'Synthetic worker',defaultCli:'codex' as const,models:{},mcp:[],skills:[]};
 await writeConfig(home,{...config,agents:[...config.agents,worker]},revision);
 const rule=await automations.create({name:'委派的自动化检查',instructions:'Check state',projectId:'',agentId:worker.id,cli:'codex',enabled:false,schedule:{kind:'interval',minutes:5,anchor:new Date().toISOString()}},prefix+'-rule',undefined,{agentId:main.agentId,projectId:'',conversationId:main.id});
 const execution=store.createConversation({projectId:'',agentId:main.agentId,cli:'codex',model:null,purpose:'mandala-background'});
 const event=store.appendEvent(main.id,'user',{text:'跟进每日检查',invocationId:prefix},new Date(Date.now()-7200000).toISOString());
 const goal=await manager.coordination.create({agentId:main.agentId,conversationId:main.id,invocationId:prefix,humanEventId:event.id},{goal:'跟进每日检查',criteria:[{id:'checked',text:'完成每日检查',checkRef:null}],projectId:null},prefix+'-goal');
 const task=goal;
 const taskExecution=manager.taskService.createExecution({userId:store.ownerUserId},task.id,{conversationId:execution.id,agentId:main.agentId,projectId:null,request:'每日自动化检查'},prefix+'-execution');
 const runs=[prefix+'-first',prefix+'-second'];
 // Synthetic examples: meaningful outcomes, with uniqueness kept in internal IDs only.
 const summaries=['发现两项配置差异：备份保留期和重试次数与预期不一致，需要确认是否更新。','复查完成，两项配置差异仍然存在。未修改配置，等待你的确认。'];
 for(const [index,runId] of runs.entries()){
  const at=new Date(Date.now()-(1-index)*3600000).toISOString();
  store.database.prepare("INSERT INTO task_runs(id,task_id,execution_id,attempt,state,routing,summary,created_at) VALUES (?,?,?,?,'succeeded',?,?,?)").run(runId,task.id,taskExecution.id,index+1,JSON.stringify({executionConversationId:execution.id,destinationConversationId:main.id,mode:'existing'}),summaries[index],at);
  store.appendEvent(execution.id,'user',{text:'第 '+(index+1)+' 次检查',runId,invocationId:runId});
  store.appendEvent(execution.id,'text',{text:('检查详情 '+(index+1)+'。\n\n').repeat(50),phase:'final_answer',itemId:runId,runId});
  store.appendEvent(execution.id,'status',{status:'idle',runId});
  store.database.prepare("INSERT INTO task_receipts(id,task_id,source_run_id,destination_conversation_id,execution_id,policy,delivery_state,summary,artifact_versions,created_at) VALUES (?,?,?,?,?,'notify',?,?,'[]',?)").run(runId+'-receipt',task.id,runId,main.id,taskExecution.id,index?'pending':'consumed',summaries[index],at);
 }
 const coordinatedAt=new Date(Date.now()-1800000).toISOString();
 store.appendEvent(main.id,'user',{text:'Synthetic receipt evidence',source:{kind:'coordination',receiptIds:[runs[0]+'-receipt']},runId:prefix},coordinatedAt);
 store.appendEvent(main.id,'text',{text:'检查已结束，发现两处差异，需要确认。',phase:'final_answer',itemId:prefix,runId:prefix},coordinatedAt);
 store.appendEvent(main.id,'status',{status:'idle',runId:prefix},coordinatedAt);
 store.renameConversation(execution.id,'每日自动化检查');
 saved={mainId:main.id,executionId:execution.id,runId:runs[0],title:'每日自动化检查',ruleId:rule.id,taskId:task.id,goalId:goal.id};
 res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(saved));return true;
}
