import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,test} from 'vitest';
import {openStore} from '../server/store';
import {createTasks} from '../server/tasks';
import {backfillConversationProjects} from '../server/project-attribution';
import {DomainError} from '../shared/workspace-contracts';

const cleanup:(()=>void)[]=[];
afterEach(()=>cleanup.splice(0).forEach(close=>close()));

function setup() {
 const home=mkdtempSync(join(tmpdir(),'task-projects-')),store=openStore(home),owner={userId:store.ownerUserId};
 cleanup.push(()=>{store.close();rmSync(home,{recursive:true,force:true});});
 const denied=new Set<string>();
 const tasks=createTasks(store,{authorizeConversation:(_,id)=>{if(denied.has(id))throw new DomainError('forbidden',403,'Restricted');}});
 const chat=(projectId:string,attributedProjectId?:string)=>store.createConversation({projectId,agentId:'a',cli:'codex',model:null,...(attributedProjectId?{attributedProjectId}:{})});
 return {home,store,owner,tasks,chat,denied};
}

test('projects follow visible current executions, deduplicate worktrees and preserve the execution route',()=>{
 const {store,owner,tasks,chat,denied}=setup();
 const task=tasks.createTask(owner,{goal:'Track two repositories'},'create');
 const one=chat('alpha'),two=chat('','beta'),three=chat('','beta');
 let current=task;
 for(const c of [one,two,three])current=tasks.attachExecution(owner,task.id,current.revision,c.id,'attach-'+c.id);
 expect(current.projectIds).toEqual(['alpha','beta']);
 expect(current.projectId).toBeNull();
 expect(current.executions.find(e=>e.conversationId===two.id)?.projectId).toBeNull();
 denied.add(one.id);
 expect(tasks.listTasks(owner)[0].projectIds).toEqual(['beta']);
 expect(tasks.getTask(owner,task.id).projectIds).toEqual(['beta']);
 const [old,replacement]=[two,three].map(c=>current.executions.find(e=>e.conversationId===c.id)!);
 store.database.prepare('UPDATE task_executions SET superseded_by_execution_id=? WHERE id=?').run(replacement.id,old.id);
 store.database.prepare("UPDATE conversations SET data=json_set(data,'$.attributedProjectId','different') WHERE id=?").run(two.id);
 expect(tasks.getTask(owner,task.id).projectIds).toEqual(['beta']);
 denied.add(three.id);
 expect(tasks.getTask(owner,task.id).projectIds).toEqual([]);
});

test('manual project selection is distinct from clearing or resuming inference and survives replay',()=>{
 const {tasks,owner,chat}=setup();
 const moduleRef={projectId:'beta',lane:'Data'};
 let task=tasks.createTask(owner,{goal:'Record',projectIds:['beta'],moduleRef},'create');
 expect(task).toMatchObject({projectIds:['beta'],projectIdsMode:'manual',moduleRef,projectId:null});
 task=tasks.attachExecution(owner,task.id,task.revision,chat('alpha').id,'attach');
 expect(tasks.updateTask(owner,task.id,task.revision,{goal:'Renamed'},'rename')).toMatchObject({projectIds:['beta'],moduleRef});
 const cleared=tasks.updateTask(owner,task.id,task.revision+1,{projectIds:[],moduleRef:null},'clear');
 expect(cleared).toMatchObject({projectIds:[],projectIdsMode:'manual',moduleRef:null});
 const reset=tasks.updateTask(owner,task.id,cleared.revision,{projectIds:null},'reset');
 expect(reset).toMatchObject({projectIds:['alpha'],projectIdsMode:'auto',moduleRef:null});
 expect(tasks.updateTask(owner,task.id,cleared.revision,{projectIds:null},'reset')).toEqual(reset);
 expect(()=>tasks.updateTask(owner,task.id,cleared.revision,{projectIds:[]},'reset')).toThrow(expect.objectContaining({code:'idempotency_conflict'}));
});

test('rejects malformed project sets and modules outside the selected projects',()=>{
 const {tasks,owner}=setup();
 for(const invalid of [{projectIds:'foo'},{projectIds:['']},{projectIds:['p','p']},{moduleRef:{projectId:'p',lane:''}},{projectIds:['a'],moduleRef:{projectId:'b',lane:'Data'}}]){
  expect(()=>tasks.createTask(owner,{goal:'Invalid',...invalid} as any,'bad')).toThrow(expect.objectContaining({code:'invalid_task'}));
 }
 expect(tasks.listTasks(owner)).toEqual([]);
});

test('project module from an inferred hidden execution cannot be read',()=>{
 const {tasks,owner,chat,denied}=setup(),c=chat('','beta');
 let task=tasks.createTask(owner,{goal:'Module'},'create');
 task=tasks.attachExecution(owner,task.id,task.revision,c.id,'attach');
 const moduleRef={projectId:'beta',lane:'Data'};
 task=tasks.updateTask(owner,task.id,task.revision,{moduleRef},'module');
 expect(task.moduleRef).toEqual(moduleRef);
 denied.add(c.id);
 expect(tasks.getTask(owner,task.id)).toMatchObject({projectIds:[],moduleRef:null});
});

test('legacy single-project tasks retain their route and project across repeated migrations',()=>{
 const {tasks,store,owner}=setup(),task=tasks.createTask(owner,{goal:'Before upgrade',projectId:'legacy'},'old');
 store.database.exec("ALTER TABLE work_tasks DROP COLUMN project_ids_override; ALTER TABLE work_tasks DROP COLUMN module_ref; DELETE FROM schema_migrations WHERE key='task_project_attribution_001'");
 for(let iteration=0;iteration<2;iteration++){
  const upgraded=createTasks(store).getTask(owner,task.id);
  expect(upgraded).toMatchObject({projectId:'legacy',projectIds:['legacy'],projectIdsMode:'auto',moduleRef:null,revision:1});
 }
});

test('Agent commands cannot write manual project labels or expose a manual private project',()=>{
 const {tasks,owner,chat,denied}=setup(),agent={...owner,agentId:'a'};
 const moduleRef={projectId:'private',lane:'Private module'};
 const task=tasks.createTask(owner,{goal:'Work',assigneeAgentId:'a',projectId:'route',projectIds:['visible','private','route'],moduleRef},'owner-create');
 const c=chat('visible');
 tasks.attachExecution(owner,task.id,task.revision,c.id,'attach');
 expect(tasks.getTask(agent,task.id)).toMatchObject({projectIds:['visible','route'],moduleRef:null});
 denied.add(c.id);
 const edited=tasks.updateTask(agent,task.id,2,{goal:'Changed'},'agent-edit');
 expect(edited).toMatchObject({projectIds:['route'],moduleRef:null});
 expect(tasks.getTask(owner,task.id)).toMatchObject({projectIds:['visible','private','route'],moduleRef});
 for(const patch of [{projectIds:[]},{projectIds:null},{moduleRef:null}]){
  expect(()=>tasks.updateTask(agent,task.id,edited.revision,patch,'agent-label')).toThrow(expect.objectContaining({code:'forbidden'}));
 }
 expect(()=>tasks.createTask(agent,{goal:'New',projectIds:['private']},'agent-create')).toThrow(expect.objectContaining({code:'forbidden'}));
});

test('executions linked in one millisecond retain their insertion order in the projected labels',()=>{
 const {store,tasks,owner,chat}=setup(),task=tasks.createTask(owner,{goal:'Ordered projects'},'create');
 const first=chat('first'),second=chat('second');
 for(const c of [first,second])tasks.createExecution(owner,task.id,{conversationId:c.id,agentId:'a',projectId:c.projectId,request:'Work'},c.id);
 // Make UUID order differ from insertion order and freeze the creation timestamps.
 const stamp=store.database.prepare("UPDATE task_executions SET id=?,created_at='2026-01-01T00:00:00.000Z' WHERE conversation_id=?");
 stamp.run('z-first',first.id);stamp.run('a-second',second.id);
 expect(tasks.getTask(owner,task.id)).toMatchObject({conversationIds:[first.id,second.id],projectIds:['first','second']});
});

test('historical executions show resolved projects and preserve their original routes',async()=>{
 const {home,store,tasks,owner}=setup(),cwd=join(home,'physical');
 mkdirSync(cwd);
 const projects=['physical','explicit'].map(id=>({id,name:id,agentIds:[],skills:[],mcp:[],resources:[],cwd:id==='physical'?cwd:''}));
 const linked=(route:string)=>{
  const chat=store.createConversation({projectId:route,agentId:'a',cwd,cli:'codex',model:null});
  const task=tasks.createTask(owner,{goal:'History',projectId:route},'create-'+route);
  tasks.attachExecution(owner,task.id,task.revision,chat.id,'attach-'+route);
  store.database.prepare("UPDATE conversations SET data=json_remove(data,'$.attributedProjectId') WHERE id=?").run(chat.id);
  return task.id;
 };
 const moved=linked('removed'),explicit=linked('explicit');
 await backfillConversationProjects(store,{version:2,agents:[],projects});
 expect(tasks.getTask(owner,moved)).toMatchObject({
  projectId:'removed',projectIds:['physical'],executions:[{projectId:'removed',attributedProjectId:'physical'}],
 });
 expect(tasks.getTask(owner,explicit)).toMatchObject({projectId:'explicit',projectIds:['explicit']});
});

test('read-only observation reports project labels within the observer’s own scope',async()=>{
 const {store,tasks,owner,chat}=setup(),observer={...owner,agentId:'a'};
 const visible=chat('','visible');
 const secret=store.createConversation({projectId:'private-execution',agentId:'other',cli:'codex',model:null});
 let task=tasks.createTask(owner,{goal:'Observe',projectId:'route'},'observe');
 for(const c of [visible,secret])task=tasks.attachExecution(owner,task.id,task.revision,c.id,'attach-'+c.id);
 const service=createTasks(store,{authorizeObservation:async()=>{},canReadProject:(_,id)=>id==='visible'});
 const snapshot=async()=>(await service.observeTasks(observer)).find(entry=>entry.id===task.id)!;
 expect(await snapshot()).toMatchObject({projectId:'route',projectIds:['route','visible'],readOnly:true});
 expect(await snapshot()).not.toHaveProperty('executions');
 tasks.updateTask(owner,task.id,task.revision,{projectIds:['secret-manual','visible']},'set');
 expect((await snapshot()).projectIds).toEqual(['visible']);
});

test('inferred projects and modules require both current membership and readable executions',async()=>{
 const {store,tasks,owner,chat}=setup(),agent={...owner,agentId:'a'};
 const c=chat('','private'),moduleRef={projectId:'private',lane:'Confidential module'};
 let task=tasks.createTask(owner,{goal:'Membership',projectId:'route',assigneeAgentId:'a'},'membership');
 task=tasks.attachExecution(owner,task.id,task.revision,c.id,'attach');
 task=tasks.updateTask(owner,task.id,task.revision,{moduleRef},'module');
 const executionId=task.executions[0].id;
 let member=false,readable=true;
 const scoped=createTasks(store,{
  authorizeObservation:async()=>{},canReadProject:(_,id)=>member&&id==='private',
  authorizeConversation:()=>{if(!readable)throw new DomainError('forbidden',403,'Conversation access revoked');},
 });
 const view=()=>scoped.getTask(agent,task.id);
 const observe=async()=>(await scoped.observeTasks(agent))[0];
 const expectHidden=async()=>{
  expect(view()).toMatchObject({projectId:'route',projectIds:['route'],moduleRef:null});
  expect((await observe()).projectIds).toEqual(['route']);
  for(const execution of scoped.listExecutions(agent,task.id))expect(execution).not.toHaveProperty('attributedProjectId');
 };
 await expectHidden();
 expect(scoped.getExecution(agent,executionId)).not.toHaveProperty('attributedProjectId');
 expect(tasks.getTask(agent,task.id)).toMatchObject({projectIds:['route'],moduleRef:null});
 member=true;
 expect(view()).toMatchObject({projectIds:['route','private'],moduleRef,executions:[{projectId:null,attributedProjectId:'private'}]});
 expect((await observe()).projectIds).toEqual(['route','private']);
 expect(scoped.executionForConversation(agent,c.id)).toMatchObject({attributedProjectId:'private'});
 task=tasks.updateTask(owner,task.id,task.revision,{projectIds:['route','private']},'manual');
 member=false;
 await expectHidden();
 member=true;readable=false;
 await expectHidden();
 expect(tasks.getTask(owner,task.id)).toMatchObject({projectIds:['route','private'],moduleRef});
});
