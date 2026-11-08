import {ensureConfiguredMandala} from './configured-mandala';
import {createTaskWithExecutions} from './helpers/task-executions';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,type Store} from '../server/store';
import {readConfig,writeConfig} from '../server/config';
import {ensureMandalaConversation} from '../server/mandala';
import {createMemoryRuntime} from '../server/memory-runtime';
import {createTasks} from '../server/tasks';
import {createMandalaCoordination,type CoordinationSource} from '../server/mandala-coordination';
import {prepareCapabilityRuntime} from '../server/omp';
import {createSessionManager} from '../server/sessions';
import {bindWorkspaceOwner} from '../server/workspace-identity';
import {linkedCapabilities} from '../shared/catalog';
import {mandalaDirectory} from '../server/mandala-directory';
let home:string,store:Store,tasks:ReturnType<typeof createTasks>,service:ReturnType<typeof createMandalaCoordination>,source:CoordinationSource;
it('keeps a capability proposal inert until confirmation, then binds existing MCP and complete external Skill resources',async()=>{
 const path=join(home,'native-skill');await mkdir(join(path,'scripts'),{recursive:true});
 await writeFile(join(path,'SKILL.md'),'---\nname: lineage\ndescription: Trace tables\n---\nUse scripts/read.py');await writeFile(join(path,'scripts/read.py'),'print("fixture")');
 const cfg=await readConfig(home);await writeConfig(home,{...cfg.config,connections:[{id:'warehouse',name:'warehouse',transport:'stdio',command:'fixture-command'}]},cfg.revision);
 const before=await readConfig(home);
 const proposal=await service.configure(source,{kind:'agent',action:'create',values:{id:'data-owner',name:'Data owner',instructions:'Maintain business lineage',defaultCli:'omp',models:{},mcp:[],skills:[{name:'lineage',path}],connectionIds:['warehouse']}},'propose','capabilities',()=>{});
 expect(await readConfig(home)).toEqual(before);
 await service.confirm(proposal.id,proposal.version,'approve');
 const config=(await readConfig(home)).config,agent=config.agents.find(a=>a.id==='data-owner')!,linked=linkedCapabilities(config,agent);
 expect(linked.mcp).toEqual([{name:'warehouse',transport:'stdio',command:'fixture-command'}]);
 const prepared=await prepareCapabilityRuntime(home,'fixture',linked.mcp,linked.skills);
 expect(await readFile(join(prepared,'skills/lineage/scripts/read.py'),'utf8')).toBe('print("fixture")');
 expect(await readFile(join(prepared,'skills/lineage/SKILL.md'),'utf8')).toContain('Use scripts/read.py');
});
beforeEach(async()=>{home=await mkdtemp(join(tmpdir(),'mandala-coordinate-'));store=openStore(home);tasks=createTasks(store);const {config}=await ensureConfiguredMandala(home);const chat=ensureMandalaConversation(store,config);const event=store.appendEvent(chat.id,'user',{text:'Manage this goal',invocationId:'current'});source={agentId:chat.agentId,conversationId:chat.id,invocationId:'current',humanEventId:event.id};service=createMandalaCoordination({home,store,tasks});});
afterEach(async()=>{store.close();await rm(home,{recursive:true,force:true});});
it('marks identical configuration writes without mistaking redacted runtime changes for no change',async()=>{
 await service.configure(source,{kind:'agent',action:'create',values:{id:'diff-agent',name:'Diff agent',instructions:'Review changes',defaultCli:'codex',models:{},mcp:[],skills:[],runtime:{codex:{env:{TOKEN:'${FIRST_TOKEN}'}}}}},'direct','diff-create',()=>{});
 const unchanged=await service.configure(source,{kind:'agent',action:'update',id:'diff-agent',values:{name:'Diff agent'}},'direct','diff-noop',()=>{});
 expect(unchanged).toMatchObject({status:'applied',unchanged:true});
 expect(service.proposals(source.conversationId).find(p=>p.id===unchanged.id)).toMatchObject({unchanged:true});
 const changed=await service.configure(source,{kind:'agent',action:'update',id:'diff-agent',values:{runtime:{codex:{env:{TOKEN:'${SECOND_TOKEN}'}}}}},'direct','diff-runtime',()=>{});
 expect(changed.summary?.before).toEqual(changed.summary?.after);
 expect(changed).not.toHaveProperty('unchanged',true);
});
it('reads back a completed team configuration after external skills normalize into library references',async()=>{
 const original=(await readConfig(home)).config;
 await service.configure(source,{kind:'agent',action:'create',values:{id:'module',name:'Module',instructions:'PRIVATE module purpose and completion criteria',defaultCli:'codex',models:{},mcp:[],skills:[{name:'module-skill',path:join(home,'PRIVATE-package')}]}},'direct','module',()=>{});
 await service.configure(source,{kind:'project',action:'create',values:{id:'business',name:'Business',background:'PRIVATE shared business scope',icon:'workflow',cwd:home,agentIds:['module'],resources:[],mcp:[],skills:[]}},'direct','business',()=>{});
 const config=(await readConfig(home)).config,directory=mandalaDirectory(config),agent=config.agents.find(a=>a.id==='module')!;
 expect(agent.skills).toEqual([]);expect(agent.skillIds).toHaveLength(1);
 expect(directory.projects[0]).toMatchObject({id:'business',icon:'workflow',backgroundConfigured:true,agentIds:['module'],cwd:home});
 expect(directory.agents[0]).toMatchObject({id:'module',instructionsConfigured:true,skillIds:agent.skillIds});
 expect(directory.bindings.find(b=>b.agentId==='module'&&b.projectId==='business')?.skills).toEqual([{name:'module-skill',source:'agent',status:'unverified'}]);
 expect(config.agents.find(a=>a.id===source.agentId)).toEqual(original.agents.find(a=>a.id===source.agentId));
 expect(JSON.stringify(directory)).not.toContain('PRIVATE');
});
const criteria=[{id:'result',text:'Deliver the requested result',checkRef:null}];
it('creates a coordination goal under the authenticated owner claimed after service startup',async()=>{
 const loadConfig=async()=>(await readConfig(home)).config;
 const memoryRuntime=createMemoryRuntime({home,store,loadConfig,schedule:false});
 const manager=createSessionManager(store,loadConfig,undefined,undefined,home,undefined,undefined,memoryRuntime);
 try{
  bindWorkspaceOwner(store,'workspace-owner');
  const goal=await manager.coordination.create(source,{goal:'Delegate a review',criteria,projectId:null},'claimed-goal');
  expect(goal.ownerUserId).toBe('workspace-owner');
  expect(manager.coordination.requireOwned(source,goal.id).id).toBe(goal.id);
  expect(()=>manager.taskService.getTask({userId:'local',agentId:source.agentId},goal.id)).toThrow('forbidden');
 }finally{
  await manager.close();
  await memoryRuntime.close();
 }
});
it('reference gives no participation; explicit takeover persists authority and suppresses side assessment',async()=>{
 const p={userId:store.ownerUserId},agent={...p,agentId:source.agentId};
 const ordinary=store.createConversation({projectId:'',agentId:'worker',cli:'codex',model:null});
 const task=createTaskWithExecutions(store,tasks,p,{goal:'Existing'},[ordinary.id],'existing');
 expect(()=>tasks.getTask(agent,task.id)).toThrow();expect(service.list()).toEqual([]);
 const adopted=await service.takeover(source,{taskId:task.id,expectedRevision:task.revision,criteria},'take');
 expect(adopted.participantAgentIds).toContain(source.agentId);expect(service.list()[0]).toMatchObject({taskId:task.id,relation:'taken-over',sourceEventId:source.humanEventId});
 expect(tasks.snapshotProgress(p,ordinary.id)).toEqual([]);
 const other=store.createConversation({projectId:'',agentId:'worker',cli:'codex',model:null}),ordinaryTask=createTaskWithExecutions(store,tasks,p,{goal:'ordinary'},[other.id],'ordinary');expect(tasks.snapshotProgress(p,other.id).map(s=>s.task.id)).toEqual([ordinaryTask.id]);
});
it('rejects ordinary identities and nonhuman or foreign provenance for takeover',async()=>{
 const task=tasks.createTask({userId:store.ownerUserId},{goal:'private'},'private');
 for(const bad of [{...source,agentId:'other'},{...source,humanEventId:undefined},{...source,invocationId:'old'}])await expect(service.takeover(bad,{taskId:task.id,expectedRevision:1,criteria},'take')).rejects.toMatchObject({status:403});
 const event=store.appendEvent(source.conversationId,'user',{text:'tool suggestion',invocationId:'current',task:{id:'child'}});
 await expect(service.takeover({...source,humanEventId:event.id},{taskId:task.id,expectedRevision:1,criteria},'take')).rejects.toMatchObject({status:403});
});
it('creates explicit goals with criteria, records blocked request, preserves explicit acceptance',async()=>{
 const goal=await service.create(source,{goal:'Organize',criteria,projectId:null},'goal');
 const progressed=tasks.getTask({userId:store.ownerUserId},goal.id);
 expect(progressed).toMatchObject({state:'todo',originConversationId:source.conversationId,completion:null});
 await service.request(source,{taskId:goal.id,expectedRevision:progressed.revision,text:'Need a decision',blocked:true},'blocked');
 expect(service.list()[0]).toMatchObject({taskId:goal.id,blockedReason:'Need a decision'});
 expect(tasks.getTask({userId:store.ownerUserId},goal.id).state).toBe('waiting');
});
it('direct configuration requires bound human provenance; proactive and promotion require exact confirmed proposal',async()=>{
 const change={kind:'agent' as const,action:'create' as const,values:{id:'helper',name:'Helper',instructions:'Help',defaultCli:'codex',models:{},mcp:[],skills:[]}};
 await expect(service.configure({...source,humanEventId:undefined},change,'direct','bad',()=>{})).rejects.toMatchObject({status:403});
 await service.configure(source,change,'direct','create',()=>{});
 expect((await readConfig(home)).config.agents.some(a=>a.id==='helper')).toBe(true);
 const proposal=await service.configure({...source,humanEventId:undefined},{kind:'agent',action:'update',id:'helper',values:{name:'Suggested'}},'propose','proposal',()=>{});
 expect(proposal.summary).toEqual({before:{name:'Helper'},after:{name:'Suggested'}});
 expect((await readConfig(home)).config.agents.find(a=>a.id==='helper')?.name).toBe('Helper');
 await expect(service.confirm(proposal.id,'wrong','approve')).rejects.toMatchObject({status:409});
 await service.confirm(proposal.id,proposal.version,'approve');expect((await readConfig(home)).config.agents.find(a=>a.id==='helper')?.name).toBe('Suggested');
});
it('stale proposals conflict and system identity cannot be modified through management',async()=>{
 const proposal=await service.configure(source,{kind:'project',action:'create',values:{id:'p',name:'P',cwd:'',agentIds:[],resources:[],mcp:[],skills:[]}},'propose','proposal',()=>{});
 const cfg=await readConfig(home);await writeConfig(home,{...cfg.config,responseStyle:'concise'},cfg.revision);
 await expect(service.confirm(proposal.id,proposal.version,'approve')).rejects.toThrow('configuration changed');
 await expect(service.configure(source,{kind:'agent',action:'archive',id:source.agentId},'direct','archive',()=>{})).rejects.toMatchObject({status:403});
});
it('retains a failed configuration attempt beside successes in the same originating request',async()=>{
 const change={kind:'agent' as const,action:'create' as const,values:{id:'batch-helper',name:'Batch helper',instructions:'Help',defaultCli:'codex',models:{},mcp:[],skills:[]}};
 await service.configure(source,change,'direct','batch-ok',()=>{});
 await expect(service.configure(source,change,'direct','batch-conflict',()=>{})).rejects.toMatchObject({status:422});
 const proposals=service.proposals(source.conversationId);
 expect(proposals).toHaveLength(2);expect(proposals[1]).toMatchObject({status:'failed',failure:{code:'invalid_management_change'}});
 const event=store.listEvents(source.conversationId,0).filter(e=>(e.data as {mandalaProposal?:unknown}).mandalaProposal).at(-1);
 expect(event?.data).toMatchObject({sourceEventId:source.humanEventId,mandalaProposal:{status:'failed'}});
 await expect(service.configure(source,{kind:'agent',action:'update',id:'batch-helper',values:{maxParallel:0}},'direct','batch-invalid-value',()=>{})).rejects.toMatchObject({status:422});
 expect(service.proposals(source.conversationId).at(-1)).toMatchObject({status:'failed',failure:{code:'invalid_configuration'}});
});

it('temporary executors retain identity through confirmed promotion and archive preserves readable tasks/history',async()=>{
 const cfg=await readConfig(home);await writeConfig(home,{...cfg.config,agents:[...cfg.config.agents,{id:'template',name:'Template',instructions:'Execute',defaultCli:'codex',models:{},mcp:[],skills:[]}]},cfg.revision);
 const temp=await service.temporary(source,{templateAgentId:'template',name:'Helper',projectId:null},'temp',()=>{});
 expect(temp.temporary).toBe(true);
 expect((await service.temporary(source,{templateAgentId:'template',name:'Helper',projectId:null},'temp',()=>{})).id).toBe(temp.id);
 await expect(service.configure(source,{kind:'agent',action:'promote',id:temp.id},'direct','promotion',()=>{})).rejects.toMatchObject({status:403});
 const proposal=await service.configure(source,{kind:'agent',action:'promote',id:temp.id},'propose','promotion',()=>{});await service.confirm(proposal.id,proposal.version,'approve');
 expect((await readConfig(home)).config.agents.find(a=>a.id===temp.id)?.temporary).toBe(false);
 const goal=tasks.createTask({userId:store.ownerUserId},{goal:'keep record',assigneeAgentId:temp.id},'record');
 const c=store.createConversation({projectId:'',agentId:temp.id,cli:'codex',model:null});store.appendEvent(c.id,'text',{text:'historical result'});
 await service.configure(source,{kind:'agent',action:'archive',id:temp.id},'direct','archive-helper',()=>{});
 expect(tasks.getTask({userId:store.ownerUserId},goal.id).goal).toBe('keep record');expect(store.listEvents(c.id,0)).toHaveLength(1);
 const {assertExecutionAvailable,conversationContext}=await import('../server/conversation-context');const config=(await readConfig(home)).config;
 expect(()=>assertExecutionAvailable(config,c)).toThrow('Archived');expect(conversationContext(config,c,'').agent.id).toBe(temp.id);
});

it('bootstraps a minimal temporary executor without any user Agent or coordinator authority',async()=>{
 const temp=await service.temporary(source,{name:'First executor',projectId:null},'bootstrap',()=>{});
 expect(temp).toMatchObject({temporary:true,defaultCli:'codex',mcp:[],skills:[],models:{}});
 expect(temp.systemRole).toBeUndefined();expect(temp.managedWorkspace).toBeUndefined();
 await expect(service.takeover({...source,agentId:temp.id},{taskId:'anything',expectedRevision:1,criteria},'fake')).rejects.toMatchObject({status:403});
});

it('project goals and takeover keep executor context while archived projects retain records',async()=>{
 const cfg=await readConfig(home);await writeConfig(home,{...cfg.config,projects:[{id:'p',name:'Project',cwd:home,agentIds:[],resources:[],mcp:[],skills:[]}]},cfg.revision);
 const goal=await service.create(source,{goal:'Project goal',criteria,projectId:'p'},'project-goal');expect(goal).toMatchObject({projectId:'p',assigneeAgentId:null});
 const existing=tasks.createTask({userId:store.ownerUserId},{goal:'Other task',projectId:'p',assigneeAgentId:'executor'},'other');
 const adopted=await service.takeover(source,{taskId:existing.id,expectedRevision:existing.revision,criteria},'adopt-project');expect(adopted).toMatchObject({projectId:'p',assigneeAgentId:'executor'});
 await service.configure(source,{kind:'project',action:'archive',id:'p'},'direct','archive-project',()=>{});
 const {assertExecutionAvailable}=await import('../server/conversation-context');
 const archived=(await readConfig(home)).config;expect(archived.projects[0].archivedAt).toBeDefined();expect(()=>assertExecutionAvailable(archived,{projectId:'p'})).toThrow('Archived');
 expect(tasks.getTask({userId:store.ownerUserId},goal.id).projectId).toBe('p');
});

it.each([['approve','reject','applied'],['reject','approve','rejected'],['approve','approve','applied']] as const)('serializes concurrent %s / %s proposal decisions',async(first,second,status)=>{
 const proposal=await service.configure(source,{kind:'agent',action:'create',values:{id:'concurrent-helper',name:'Concurrent helper',instructions:'Help',defaultCli:'codex',models:{},mcp:[],skills:[]}},'propose','concurrent',()=>{});
 const results=await Promise.all([service.confirm(proposal.id,proposal.version,first),service.confirm(proposal.id,proposal.version,second)]);
 expect(results.map(result=>result.status)).toEqual([status,status]);
 expect(service.proposals(source.conversationId)[0].status).toBe(status);
 expect((await readConfig(home)).config.agents.some(a=>a.id==='concurrent-helper')).toBe(status==='applied');
 expect(store.listEvents(source.conversationId,0).filter(e=>e.kind==='metadata'&&(e.data as any).mandalaProposal?.status===status)).toHaveLength(1);
});

it('uses only origin for primary goals and never registers the primary Chat as execution',async()=>{
 const root={userId:store.ownerUserId},goal=await service.create(source,{goal:'Historical goal',criteria,projectId:null},'goal');
 expect(goal.conversationIds).toEqual([]);expect(goal.originConversationId).toBe(source.conversationId);
 const ownership=service.ownership(goal.id),events=store.listEvents(source.conversationId,0);
 expect(()=>tasks.attachExecution(root,goal.id,goal.revision,source.conversationId,'primary')).toThrow(expect.objectContaining({code:'primary_conversation'}));
 expect(tasks.getTask(root,goal.id).conversationIds).toEqual([]);expect(service.ownership(goal.id)).toEqual(ownership);expect(store.listEvents(source.conversationId,0)).toEqual(events);
});
it.each(['queued','starting','running','approval','unknown'] as const)('primary origin stays separate from %s execution and receipt routing survives',async state=>{
 const root={userId:store.ownerUserId},goal=await service.create(source,{goal:'Goal',criteria,projectId:null},'goal'),chat=store.createConversation({projectId:'',agentId:'worker',cli:'codex',model:null});
 const execution=tasks.createExecution(root,goal.id,{conversationId:chat.id,agentId:'worker',projectId:null,request:'Work'},'execution');
 store.database.prepare('INSERT INTO task_runs(id,task_id,execution_id,attempt,state,continuation,created_at) VALUES (?,?,?,?,?,?,?)').run('child-run',goal.id,execution.id,1,state,JSON.stringify({taskId:goal.id,conversationId:source.conversationId,epoch:1,policy:'notify'}),new Date().toISOString());
 expect(tasks.getTask(root,goal.id).conversationIds).toEqual([chat.id]);
 expect(()=>tasks.removeExecution(root,goal.id,goal.revision,execution.id,'remove')).toThrow(expect.objectContaining({code:'execution_has_history'}));
 store.database.prepare("UPDATE task_runs SET state='succeeded' WHERE id='child-run'").run();
 store.database.prepare("INSERT INTO task_receipts(id,task_id,source_run_id,destination_conversation_id,execution_id,captured_epoch,policy,delivery_state,summary,artifact_versions,created_at) VALUES (?,?,?,?,?,?,'notify','consumed','Historical report','[]',?)").run('receipt',goal.id,'child-run',source.conversationId,execution.id,1,new Date().toISOString());
 expect(tasks.authorizeReceipt({...root,agentId:source.agentId},'receipt')).toMatchObject({summary:'Historical report',destinationConversationId:source.conversationId,taskId:goal.id});
 expect(service.ownership(goal.id)?.conversationId).toBe(source.conversationId);
});
