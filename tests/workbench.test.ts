import {afterEach,expect,test} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store';
import {createTasks} from '../server/tasks';
import {getWorkbench} from '../server/workbench';
import {createKnowledge} from '../server/knowledge';
import {memoryServices} from '../server/memory-runtime';
import {LOCAL_USER_ID} from '../shared/workspace-contracts';
import type {Config,Conversation,Approval} from '../shared/types';
import {createSessionManager,type SessionManager} from '../server/sessions';
import type {MemoryRuntime} from '../server/memory-runtime';
const p={userId:LOCAL_USER_ID},resources:{home:string;store:ReturnType<typeof openStore>}[]=[];
afterEach(()=>{for(const r of resources.splice(0)){r.store.close();rmSync(r.home,{recursive:true,force:true});}});
function setup(){
 const home=mkdtempSync(join(tmpdir(),'workbench-')),store=openStore(home);resources.push({home,store});
 const config:Config={version:2,projects:[{id:'p',name:'Project',cwd:home,agentIds:['a'],resources:[],mcp:[],skills:[]}],agents:[{id:'a',name:'Agent',instructions:'',defaultCli:'codex',models:{},mcp:[],skills:[]}]};
 const tasks=createTasks(store,{resolve:(_p,t)=>({agentId:t.assigneeAgentId!,projectId:t.projectId,hostId:'local',input:t.goal,sourceVersions:[],requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial'})});
 const denied=new Set<string>(),approvals=new Map<string,Approval[]>(),dedicated=new Set<string>();
 const manager={listUserInputs:()=>[],taskService:tasks,authorizeConversationRead:(id:string)=>{if(denied.has(id))throw new Error('denied');},getApprovals:(id:string)=>approvals.get(id)??[],isDedicatedConversation:(id:string)=>dedicated.has(id)} as unknown as SessionManager;
 const memoryRuntime=memoryServices(home,store,(_p,id)=>manager.authorizeConversationRead(id)) as MemoryRuntime;
 const chat=(id:string,status:Conversation['status']='running',projectId='p',agentId='a')=>{const c:Conversation={id,projectId,agentId,title:'Chat '+id,cli:'codex',model:null,nativeId:null,turnId:null,status,createdAt:'2026-10-09T00:00:00Z'};store.database.prepare("INSERT INTO conversations(id,data) VALUES (?,?)").run(c.id,JSON.stringify(c));return c;};
 const run=(id:string,state='running',projectId:string|null='p')=>{chat(id,'running',projectId??'');dedicated.add(id);const t=tasks.createTask(p,{goal:'Task '+id,projectId,assigneeAgentId:'a'},'create-'+id),prepared=tasks.prepareStart(p,t.id,1,'start-'+id),r=store.transaction(()=>prepared.commit({executionConversationId:id,mode:'dedicated',destinationConversationId:null}));store.database.prepare('UPDATE task_runs SET state=? WHERE id=?').run(state,r.id);return {t,r};};
 return {home,store,config,manager,memoryRuntime,chat,run,denied,approvals,tasks,snapshot:()=>getWorkbench({home,store,config,manager,memoryRuntime})};
}
test('deduplicates routed executions and retains concurrent ordinary and dedicated work',async()=>{
 const s=setup();s.chat('ordinary');const {r}=s.run('dedicated');const x=await s.snapshot(),a=x.agents.find(a=>a.id==='a')!;
 expect(a.counts.running).toBe(2);expect(a.executions.map(e=>e.id).sort()).toEqual(['ordinary',r.id].sort());expect(x.recentConversations.map(c=>c.id)).toEqual(['ordinary']);
});
test('uses Run state rather than task progress and separates queued and unknown without human to-dos',async()=>{
 const s=setup();s.run('unknown','unknown');s.run('queued','queued');const progress=s.tasks.createTask(p,{goal:'progress only'},'progress');s.store.database.prepare("UPDATE work_tasks SET state='running' WHERE id=?").run(progress.id);
 const x=await s.snapshot();expect(x.agents.find(a=>a.id==='a')?.counts).toEqual({running:0,approval:0,queued:1,unknown:1});expect(x.pending).toEqual([]);
});
test('cancelled task excludes its terminal legacy and interrupted runs without deleting history',async()=>{
 const s=setup(),{t,r}=s.run('legacy-history','legacy_unverified');
 s.store.database.prepare("UPDATE work_tasks SET state='cancelled' WHERE id=?").run(t.id);
 s.store.database.prepare("INSERT INTO task_runs(id,task_id,execution_id,attempt,state,created_at) VALUES (?,?,?,2,'interrupted',?)").run('later-interrupted',t.id,r.executionId,'2026-10-10T00:00:00Z');
 const x=await s.snapshot(),scoped=await getWorkbench({...s,projectId:'p',agentId:'a'});
 for(const snapshot of [x,scoped]){
  expect(snapshot.agents.find(a=>a.id==='a')?.counts).toEqual({running:0,approval:0,queued:0,unknown:0});
  expect(snapshot.agents.flatMap(a=>a.executions)).toEqual([]);
  expect(snapshot.pending).toEqual([]);
 }
 expect(s.tasks.listRunControls(p,t.id).map(run=>({id:run.id,state:run.state}))).toEqual([{id:r.id,state:'legacy_unverified'},{id:'later-interrupted',state:'interrupted'}]);
});
test.each(['cancelled','completed'])('terminal %s task retains genuinely live or unknown execution controls',async state=>{
 const s=setup();
 for(const runState of ['running','queued','approval','unknown']){
  const {t}=s.run('orphan-'+runState,runState);
  s.store.database.prepare('UPDATE work_tasks SET state=? WHERE id=?').run(state,t.id);
 }
 const x=await s.snapshot();
 expect(x.agents.find(a=>a.id==='a')?.counts).toEqual({running:1,approval:1,queued:1,unknown:1});
 expect(x.pending).toEqual([]);
});
test('filters project scope across executions pending and recent objects including unassigned Agent',async()=>{
 const s=setup();s.chat('outside','running','other');s.chat('inside','error','p','');s.run('outside-run','running','other');
 const x=await getWorkbench({...s,projectId:'p'});expect(x.agents.flatMap(a=>a.executions).map(e=>e.id)).toEqual([]);expect(x.agents.find(a=>a.id===null)).toBeDefined();expect(x.pending.map(i=>i.id)).toEqual(['inside']);expect(x.recentConversations.map(i=>i.id)).toEqual(['inside']);
});
test('deduplicates approvals and distinguishes input review and actual failure from queued execution',async()=>{
 const s=setup(),{t}=s.run('approval','approval');s.approvals.set('approval',[{id:'q',conversationId:'approval',nativeRequestId:1,method:'item/tool/requestUserInput',params:{questions:[{id:'q1',header:'Pick',question:'What?'}]}},{id:'approve',conversationId:'approval',nativeRequestId:2,method:'item/commandExecution/requestApproval',params:{secret:'do not expose'}}]);
 s.store.database.prepare("UPDATE work_tasks SET state='waiting',waiting_reason='approval' WHERE id=?").run(t.id);
 const review=s.tasks.createTask(p,{goal:'Review result',projectId:'p'},'review');s.store.database.prepare("UPDATE work_tasks SET state='review' WHERE id=?").run(review.id);
 s.run('queued-background','queued');
 const fail=s.tasks.createTask(p,{goal:'Fix run',projectId:'p'},'fail');s.store.database.prepare("UPDATE work_tasks SET state='waiting',waiting_reason='run_failed' WHERE id=?").run(fail.id);
 const x=await s.snapshot();expect(x.pending.map(i=>i.kind).sort()).toEqual(['approval','error','input','review']);expect(JSON.stringify(x)).not.toContain('secret');
});
test('retains inaccessible run control without leaking content or human actions',async()=>{
 const s=setup(),{r}=s.run('protected');s.denied.add('protected');s.chat('private');s.denied.add('private');
 const x=await s.snapshot();expect(x.agents.flatMap(a=>a.executions)).toEqual([expect.objectContaining({id:r.id,state:'running',accessible:false,title:null,href:null})]);expect(x.recentConversations).toEqual([]);expect(x.pending).toEqual([]);expect(JSON.stringify(x)).not.toContain('Chat protected');
});
test('projects real candidate Skills and active memories with exact object and source links',async()=>{
 const s=setup();s.chat('source','idle');const skill=await createKnowledge(s.home,{kind:'skill',title:'Release checks',content:'# Checks',scope:'project',projectId:'p',status:'candidate',sourceConversationId:'source'},s.config,false,s.store);
 s.memoryRuntime.memory.importLegacy(p,[{id:'legacy',kind:'memory',title:'Convention',content:'Use Chinese',scope:'project',projectId:'p',status:'active',createdAt:'2026-10-08T00:00:00Z',updatedAt:'2026-10-08T00:00:00Z'}]);
 const x=await s.snapshot();expect(x.pending).toContainEqual(expect.objectContaining({kind:'skill',id:skill.id,href:expect.stringContaining('knowledgeId=')}));expect(x.recentKnowledge.map(i=>i.kind).sort()).toEqual(['memory','skill']);expect(x.recentKnowledge.find(i=>i.kind==='skill')?.sourceHref).toContain('conversation=source');
});

test('existing conversation resumes its own identity after a terminal task run',async()=>{
 const s=setup(),{r}=s.run('existing');s.manager.isDedicatedConversation=()=>false;
 s.store.database.prepare('UPDATE task_runs SET state=?,routing=? WHERE id=?').run('succeeded',JSON.stringify({executionConversationId:'existing',mode:'existing',destinationConversationId:null}),r.id);
 const x=await s.snapshot();expect(x.agents.flatMap(a=>a.executions).map(e=>e.id)).toEqual(['existing']);expect(x.recentConversations.map(c=>c.id)).toEqual(['existing']);
});
test('revoked Skill source is absent and knowledge failures remain explicit',async()=>{
 const s=setup();s.chat('source','idle');await createKnowledge(s.home,{kind:'skill',title:'Private draft',content:'# Checks',scope:'project',projectId:'p',status:'candidate',sourceConversationId:'source'},s.config,false,s.store);s.denied.add('source');
 const x=await s.snapshot();expect(x.pending).toEqual([]);expect(x.recentKnowledge).toEqual([]);
 s.memoryRuntime.memory.listAll=()=>{throw new Error('storage unavailable');};const partial=await s.snapshot();expect(partial.errors).toContain('memory');
});

test('ordinary restored inputs retain unknown execution controls after recovery',async()=>{
 const s=setup(),chat=s.chat('recovered','running');let manager=createSessionManager(s.store,async()=>s.config,undefined,undefined,s.home);
 try{
  const input=manager.enqueueUserInput(chat.id,'unproven input','recover-input');s.store.database.prepare("UPDATE task_user_inputs SET state='running' WHERE id=?").run(input.id);
  await manager.close();s.store.updateConversation(chat.id,{status:'idle'});manager=createSessionManager(s.store,async()=>s.config,undefined,undefined,s.home);await manager.reconcileRuns('local');
  expect(manager.listUserInputs(chat.id)[0].state).toBe('unknown');expect(s.store.getConversation(chat.id)?.status).toBe('interrupted');
  const x=await getWorkbench({...s,manager});expect(x.agents.find(a=>a.id==='a')?.counts).toEqual({running:0,approval:0,queued:0,unknown:1});expect(x.agents.flatMap(a=>a.executions)).toEqual([expect.objectContaining({conversationId:'recovered',state:'unknown',href:'/?conversation=recovered&project=p'})]);
 }finally{await manager.close();}
});
test('ordinary queued inputs appear separately without duplicating the active input invocation',async()=>{
 const s=setup(),chat=s.chat('queue','running'),manager=createSessionManager(s.store,async()=>s.config,undefined,undefined,s.home);
 try{
  s.store.updateConversation(chat.id,{status:'running'});
  const active=manager.enqueueUserInput(chat.id,'active input','active');s.store.database.prepare("UPDATE task_user_inputs SET state='running' WHERE id=?").run(active.id);manager.enqueueUserInput(chat.id,'next input','next');
  const x=await getWorkbench({...s,manager});expect(x.agents.find(a=>a.id==='a')?.counts).toEqual({running:1,approval:0,queued:1,unknown:0});expect(x.agents.flatMap(a=>a.executions)).toHaveLength(2);expect(x.pending).toEqual([]);
 }finally{await manager.close();}
});
test('active execution scope and Agent retain execution conversation provenance after task moves',async()=>{
 const s=setup(),{t,r}=s.run('moved');const current=s.tasks.getTask(p,t.id);s.tasks.updateTask(p,t.id,current.revision,{projectId:'q'},'move-project');
 const original=s.store.getConversation('moved')!;s.store.database.prepare('UPDATE conversations SET data=? WHERE id=?').run(JSON.stringify({...original,agentId:'actual-agent'}),'moved');
 const originalScope=await getWorkbench({...s,projectId:'p'}),newScope=await getWorkbench({...s,projectId:'q'});
 expect(originalScope.agents.flatMap(a=>a.executions)).toEqual([expect.objectContaining({id:r.id,projectId:'p',agentId:'actual-agent',href:'/?conversation=moved&project=p'})]);expect(newScope.agents.flatMap(a=>a.executions)).toEqual([]);
 s.store.database.prepare("UPDATE work_tasks SET state='review' WHERE id=?").run(t.id);const attention=await getWorkbench({...s,projectId:'q'});expect(attention.pending).toContainEqual(expect.objectContaining({kind:'review',id:t.id,projectId:'q'}));
});
test('existing-conversation Run retains a distinct queued ordinary follow-up without a duplicate Conversation',async()=>{
 const s=setup(),chat=s.chat('existing-follow-up','idle'),manager=createSessionManager(s.store,async()=>s.config,undefined,undefined,s.home);
 try{
  const task=s.tasks.createTask(p,{goal:'Existing conversation work',projectId:'p',assigneeAgentId:'a'},'existing-follow-up-task');
  const prepared=s.tasks.prepareStart(p,task.id,task.revision,'existing-follow-up-run'),run=s.store.transaction(()=>prepared.commit({executionConversationId:chat.id,mode:'existing',destinationConversationId:null}));
  s.store.database.prepare("UPDATE task_runs SET state='running' WHERE id=?").run(run.id);s.store.updateConversation(chat.id,{status:'running'});
  const input=manager.enqueueUserInput(chat.id,'queued private follow-up','existing-follow-up-input');expect(manager.listUserInputs(chat.id)[0].state).toBe('queued');
  const x=await getWorkbench({...s,manager}),executions=x.agents.flatMap(a=>a.executions);
  expect(x.agents.find(a=>a.id==='a')?.counts).toEqual({running:1,approval:0,queued:1,unknown:0});expect(executions).toHaveLength(2);
  expect(executions).toContainEqual(expect.objectContaining({id:run.id,kind:'run',state:'running'}));expect(executions).toContainEqual(expect.objectContaining({id:input.id,kind:'input',state:'queued',conversationId:chat.id,href:'/?conversation=existing-follow-up&project=p'}));
  expect(x.pending).toEqual([]);expect(JSON.stringify(x)).not.toContain('queued private follow-up');
 }finally{await manager.close();}
});

test('Agent browsing keeps scope choices and filters before limiting recent conversations',async()=>{
 const s=setup();s.config.agents.push({...s.config.agents[0],id:'b',name:'Other'});s.chat('old-a','error','p','old');
 for(let n=0;n<7;n++)s.chat('new-b-'+n,'idle','p','b');
 const snapshot=await getWorkbench({...s,projectId:'p',agentId:'old'});
 expect(snapshot.recentConversations.map(c=>c.id)).toEqual(['old-a']);expect(snapshot.pending.map(c=>c.id)).toEqual(['old-a']);
 expect(snapshot.agents.map(a=>a.id)).toEqual(['old']);
 expect(snapshot.agentOptions.map(a=>a.id).sort()).toEqual(['a','b','old']);
 const outside=await getWorkbench({...s,projectId:'q',agentId:'old'});expect(outside.agents).toEqual([]);expect(outside.recentConversations).toEqual([]);
});
