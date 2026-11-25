import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {openStore} from '../server/store';
import {createTasks} from '../server/tasks';
import {createBlueprintRuntime} from '../server/blueprint-runtime';
import {DomainError} from '../shared/workspace-contracts';

const homes:string[]=[];
afterEach(()=>{for(const home of homes.splice(0))rmSync(home,{recursive:true,force:true});});
it('publishes accepted task facts once per plan, preserving project boundaries and surviving restarts',async()=>{
 const home=mkdtempSync(join(tmpdir(),'blueprint-queue-'));homes.push(home);
 const store=openStore(home),owner={userId:store.ownerUserId};
 const plans=new Map([['p','shared'],['alias','shared'],['private','private-plan']]);
 const write=vi.fn().mockRejectedValueOnce(new Error('disk unavailable')).mockResolvedValue({id:'note'});
 const runtime=()=>createBlueprintRuntime(store,id=>plans.get(id),write,()=>true);
 let publisher=runtime();
 const tasks=createTasks(store,{onCompleted:task=>publisher.complete(task)});
 const chat=store.createConversation({projectId:'p',agentId:'documentation',cli:'codex',model:null});
 let task=tasks.createTaskFromChat(owner,{goal:'Goal with private cross-project details',projectIds:['p','alias','private']},chat.id,'create');
 const scope={conversationId:chat.id,agentId:'documentation',projectId:'p',planId:'shared',invocationId:'invocation',taskId:task.id};
 publisher.start(scope);
 for(const result of ['projectId: p','agent_id=a','智能体 ID：a','/projects/p/overview']){
  expect(()=>publisher.stage(scope,task,{result,lanes:[]},'reject-'+result)).toThrow();
 }
 const early={result:'Updated documentation for a stable UI',decisions:[],lanes:[]},final={result:'Checked UI',decisions:['Keep current layout'],lanes:['client']};
 publisher.stage(scope,task,early,'early');
 publisher.stage(scope,task,final,'final');
 publisher.stage(scope,task,early,'early');
 expect(()=>publisher.stage(scope,task,{...early,result:'Changed'},'early')).toThrow();
 task=tasks.moveTask(owner,task.id,task.revision,'review',null,'review');
 await publisher.flush();expect(write).not.toHaveBeenCalled();
 task=tasks.moveTask(owner,task.id,task.revision,'completed',null,'accept');
 await publisher.flush();publisher=runtime();await publisher.flush();await publisher.flush();
 const successes=write.mock.calls.slice(1);expect(successes).toHaveLength(2);
 expect(successes.map(call=>call[3]).sort()).toEqual(['private-plan','shared']);
 const shared=successes.find(call=>call[3]==='shared')!;expect(shared[1]).toMatchObject({result:'Checked UI',decisions:['Keep current layout'],lanes:['client']});
 const isolated=JSON.stringify(successes.find(call=>call[3]==='private-plan')![1]);expect(isolated).not.toContain('Checked UI');expect(isolated).not.toContain('private cross-project details');
 expect(JSON.stringify(shared[1])).not.toContain(task.id);
 task=tasks.moveTask(owner,task.id,task.revision,'todo','Follow up','reopen');
 task=tasks.moveTask(owner,task.id,task.revision,'completed',null,'accept-again');await publisher.flush();
 expect(write.mock.calls).toHaveLength(5);expect(JSON.stringify(write.mock.calls.slice(-2).map(call=>call[1]))).not.toContain('Checked UI');
 store.close();
});

it('keeps unsafe module identifiers out of user acceptance and preserves an externally retired module as history',async()=>{
 const home=mkdtempSync(join(tmpdir(),'blueprint-fallback-'));homes.push(home);
 const store=openStore(home),owner={userId:store.ownerUserId},write=vi.fn().mockResolvedValue({id:'record'});
 const publisher=createBlueprintRuntime(store,()=>'plan',write,()=>true,async()=>[]);
 const tasks=createTasks(store,{onCompleted:task=>publisher.complete(task)});
 try{
  const task=tasks.createTask(owner,{goal:'User goal',projectId:'p',moduleRef:{projectId:'p',lane:'agentId=a'}},'unsafe');
  tasks.moveTask(owner,task.id,task.revision,'completed',null,'accept');await publisher.flush();
  expect(write.mock.calls[0][1]).toEqual({result:'用户确认任务已完成。',decisions:[],lanes:[]});
  const clean=tasks.createTask(owner,{goal:'Second goal',projectId:'p',moduleRef:{projectId:'p',lane:'Retired module'}},'clean');
  write.mockRejectedValueOnce(new DomainError('blueprint_lane_missing',422,'Module removed'));
  tasks.moveTask(owner,clean.id,clean.revision,'completed',null,'another-accept');await publisher.flush();
  expect(write.mock.calls.at(-1)![1]).toEqual({result:'用户确认任务已完成。\n历史模块：Retired module',decisions:[],lanes:[]});
 }finally{store.close();}
});

it('does not turn inferred repository membership into plan write access and checks staged authors again at publication',async()=>{
 const home=mkdtempSync(join(tmpdir(),'blueprint-authority-'));homes.push(home);
 const store=openStore(home),owner={userId:store.ownerUserId};let member=false,revokeDuringWrite=true;
 const written:string[]=[];
 const runtime=createBlueprintRuntime(store,()=>'plan',async(_project,input,_key,_plan,assertAuthorized)=>{
  if(revokeDuringWrite){revokeDuringWrite=false;member=false;}
  assertAuthorized();written.push(input.result);return {id:'published'};
 },()=>member);
 const tasks=createTasks(store,{onCompleted:task=>runtime.complete(task)});
 try{
  const chat=store.createConversation({projectId:'',attributedProjectId:'restricted',agentId:'worker',cli:'codex',model:null});
  let task=tasks.createTaskFromChat(owner,{goal:'Inferred route'},chat.id,'create');
  expect(task.projectIds).toEqual(['restricted']);
  task=tasks.moveTask(owner,task.id,task.revision,'completed',null,'unauthorized');
  expect(store.database.prepare('SELECT count(*) n FROM blueprint_publications').get()?.n).toBe(0);
  task=tasks.moveTask(owner,task.id,task.revision,'todo','Another round','reopen');
  member=true;
  const scope={projectId:'restricted',planId:'plan',agentId:'worker',invocationId:'local-run',conversationId:chat.id};
  runtime.start(scope);runtime.stage(scope,task,{result:'Authorized result'},'record');
  tasks.moveTask(owner,task.id,task.revision,'completed',null,'authorized');
  await runtime.flush();expect(written).toEqual([]);
  await runtime.flush();expect(written).toEqual([]);
  member=true;await runtime.flush();expect(written).toEqual(['Authorized result']);
  task=tasks.moveTask(owner,task.id,tasks.getTask(owner,task.id).revision,'todo','New round','reopen-again');
  revokeDuringWrite=true;
  tasks.moveTask(owner,task.id,task.revision,'completed',null,'no-draft');await runtime.flush();
  expect(written).toEqual(['Authorized result']);
  member=true;await runtime.flush();expect(written).toEqual(['Authorized result','用户确认任务已完成。']);
 }finally{store.close();}
});
