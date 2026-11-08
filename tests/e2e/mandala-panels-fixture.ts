import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Store} from '../../server/store';
import type {Automations} from '../../server/automations';
import type {SessionManager} from '../../server/sessions';
import {ensureMandalaConfig,writeConfig} from '../../server/config';
import {ensureMandalaConversation} from '../../server/mandala';
import {createConversationProgress} from '../../server/conversation-progress';
let savedFixture:Record<string,unknown>|undefined;
export async function mandalaPanelsFixture(req:IncomingMessage,res:ServerResponse,home:string,store:Store,manager:SessionManager,automations:Automations){
 if(req.method!=='POST'||req.url!=='/__test__/mandala-panels')return false;
 if(savedFixture){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(savedFixture));return true;}
 const current=await ensureMandalaConfig(home),prefix='panel-'+Date.now(),a=prefix+'-a',b=prefix+'-b',p=prefix+'-p',q=prefix+'-q';
 const agent=(id:string,name:string)=>({id,name,instructions:'Synthetic test Agent',defaultCli:'codex' as const,models:{},skills:[],mcp:[]});
 const project=(id:string,name:string,agentIds:string[])=>({id,name,cwd:home,agentIds,resources:[],skills:[],mcp:[]});
 const config={...current.config,agents:[...current.config.agents,agent(a,'共享测试 Agent'),agent(b,'独立测试 Agent'),{...agent(prefix+'-temp','临时测试 Agent'),temporary:true}],projects:[...current.config.projects,project(p,'跨项目中文产品设计与实现验证', [a]),project(q,'API 服务',[a])]};
 await writeConfig(home,config,current.revision);const main=ensureMandalaConversation(store,config);
 const event=store.appendEvent(main.id,'user',{text:'创建浏览器验收目标',invocationId:prefix});
 const goal=await manager.coordination.create({agentId:main.agentId,conversationId:main.id,invocationId:prefix,humanEventId:event.id},{goal:'接通跨项目登录流程，并验证很长的中英文标题 Long operational goal',criteria:[{id:'done',text:'检查登录',checkRef:null}],projectId:p},prefix);
 const chat=store.createConversation({projectId:p,agentId:a,cli:'codex',model:null});store.renameConversation(chat.id,'登录接口实现');
 const message=store.appendEvent(chat.id,'text',{text:'Public opening. 精确选择这一句。 Public ending.',itemId:'answer',phase:'final_answer'});store.appendEvent(chat.id,'status',{status:'idle'});
 manager.taskService.createExecution({userId:store.ownerUserId},goal.id,{conversationId:chat.id,agentId:a,projectId:p,request:'实现登录接口'},prefix+'execution');
 store.updateConversation(chat.id,{status:'running'});createConversationProgress(store,manager).update(chat.id,{action:'complete'});
 const currentTask=manager.taskService.getTask({userId:store.ownerUserId},goal.id);
 manager.taskService.updateTask({userId:store.ownerUserId},goal.id,currentTask.revision,{assigneeAgentId:a},prefix+'assignee');
 const rule=await automations.create({taskId:goal.id,name:'每日任务简报',instructions:'汇总明确上报的进展和结果',projectId:p,agentId:a,cli:'codex',enabled:false,schedule:{kind:'daily',time:'18:00',timeZone:'Asia/Singapore'}},prefix+'schedule');
 const at=new Date().toISOString();store.database.prepare("INSERT INTO automation_occurrences VALUES (?,?,NULL,?,?,'completed',?)").run(prefix+'occurrence',rule.id,prefix+'occurrence',goal.id,JSON.stringify({id:prefix+'occurrence',automationId:rule.id,name:rule.name,projectId:p,agentId:a,cli:'codex',instructions:rule.instructions,createdAt:at,scheduledAt:at,conversationId:chat.id}));
 savedFixture={mainId:main.id,goalId:goal.id,chatId:chat.id,eventId:message.id,agentId:a,projectId:p};res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(savedFixture));return true;
}
