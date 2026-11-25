import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {openStore} from '../server/store';
import {createTasks} from '../server/tasks';
import {remoteTaskRequest} from '../server/remote-task';
import {remoteRequestAllowed} from '../server/remote-policy';
import type {Config} from '../shared/types';

const homes:string[]=[];
afterEach(()=>{for(const home of homes.splice(0))rmSync(home,{recursive:true,force:true});});
const empty:Config={version:2,agents:[],projects:[]};
it('recovers a lost creation reply after restart and isolates receipts by paired identity',async()=>{
 const home=mkdtempSync(join(tmpdir(),'remote-task-'));homes.push(home);
 let store=openStore(home),tasks=createTasks(store);
 let paired:string|undefined='first';
 const request=(method:string,path:string,body?:unknown,load=async()=>empty)=>
  remoteTaskRequest({method,path,body:new TextEncoder().encode(JSON.stringify(body))},()=>paired,new AbortController().signal,store,tasks,load);
 const path='/api/remote/tasks',input={goal:'Write notes',commandKey:'draft-1'};
 try{
  const created=await request('POST',path,input);
  expect(created.status).toBe(201);
  const {task}=await created.json();
  expect(task).toEqual({id:expect.any(String),goal:input.goal,projectId:null,assigneeAgentId:null,state:'todo',revision:1});
  store.close();store=openStore(home);tasks=createTasks(store);
  expect(await (await request('GET',path+'/draft-1')).json()).toEqual({task});
  expect(await (await request('POST',path,input)).json()).toEqual({task});
  expect((await request('POST',path,{...input,goal:'Changed'})).status).toBe(409);
  paired='second';
  expect(await (await request('GET',path+'/draft-1')).json()).toEqual({task:null});
  expect((await (await request('POST',path,input)).json()).task.id).not.toBe(task.id);
  expect(store.database.prepare('SELECT COUNT(*) n FROM task_runs').get()?.n).toBe(0);
  expect(store.listConversations()).toEqual([]);
  expect((await request('POST',path,{...input,commandKey:'stale'},async()=>{paired=undefined;return empty;})).status).toBe(403);
  paired='second';expect(await (await request('GET',path+'/stale')).json()).toEqual({task:null});
  expect((await request('POST',path,{...input,projectId:'missing',commandKey:'missing'})).status).toBe(409);
  expect(await (await request('GET',path+'/missing')).json()).toEqual({task:null});
  store.database.exec("CREATE TRIGGER reject_remote_receipt BEFORE INSERT ON task_command_dedup BEGIN SELECT RAISE(ABORT,'receipt write failed'); END");
  expect((await request('POST',path,{...input,commandKey:'recover'})).status).toBe(500);
  expect(await (await request('GET',path+'/recover')).json()).toEqual({task:null});
  expect(tasks.listTasks({userId:store.ownerUserId})).toHaveLength(2);
  store.database.exec('DROP TRIGGER reject_remote_receipt');
  expect((await request('POST',path,{...input,commandKey:'recover'})).status).toBe(201);
  expect(tasks.listTasks({userId:store.ownerUserId})).toHaveLength(3);
 }finally{store.close();}
});
it('limits remote task commands to creation and a scoped receipt read',()=>{
 const path='/api/remote/tasks',input={goal:'Write notes',commandKey:'draft-1'};
 expect(remoteRequestAllowed('POST',path,input)).toBe(true);
 expect(remoteRequestAllowed('GET',path+'/draft-1')).toBe(true);
 for(const body of [{...input,automaticProgress:true},{...input,originConversationId:'x'},{...input,goal:''},{...input,commandKey:'a/b'}])
  expect(remoteRequestAllowed('POST',path,body)).toBe(false);
 for(const target of [path,path+'/draft-1?agent=other',path+'/draft-1/start'])
  expect(remoteRequestAllowed('GET',target)).toBe(false);
});
