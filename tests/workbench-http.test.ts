import { beforeEach, afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Server } from 'node:http';
import { openStore, type Store } from '../server/store';
import { readConfig } from '../server/config';
import { createSessionManager, type SessionManager } from '../server/sessions';
import { createHttpServer } from '../server/http';
import { createUsageRecorder, getUsage } from '../server/usage';
import { findCommand, resolveRequest } from '../cli/commands.mjs';
let home:string,store:Store,manager:SessionManager,server:Server,url:string;
beforeEach(async()=>{home=mkdtempSync(join(tmpdir(),'mana-workbench-http-'));store=openStore(home);manager=createSessionManager(store,async()=>(await readConfig(home)).config);server=createHttpServer({requireIdentity:false,home,store,manager});server.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+(server.address() as {port:number}).port;});
afterEach(async()=>{manager.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));store.close();rmSync(home,{recursive:true,force:true});});
it('exposes the same read-only local-user endpoints through the CLI inventory',async()=>{
 for(const [name,path] of [['workbench overview','/api/workbench'],['workspace search','/api/workspace-search'],['usage summary','/api/usage']]){
  const command=findCommand(name)!;expect(command).toMatchObject({method:'GET',path});expect(command.boundTool).toBeUndefined();
  const request=resolveRequest(command);expect(request.path).toBe(path);
  expect((await fetch(url+path)).status).toBe(200);
  expect((await fetch(url+path,{headers:{Origin:'https://foreign.example'}})).status).toBe(403);
  expect((await fetch(url+path,{headers:{Authorization:'Bearer untrusted-agent'}})).status).toBe(403);
 }
});
it('rejects unknown, duplicate, malformed and nonexistent query scopes',async()=>{
 for(const path of ['/api/workbench?extra=true','/api/workbench?projectId=missing','/api/workbench?projectId=a&projectId=b','/api/workspace-search?query='+ 'x'.repeat(2001),'/api/workspace-search?kind=invalid','/api/usage?period=month','/api/usage?timeZone=NotATimeZone','/api/usage?projectId=missing','/api/usage?period=today&period=week','/api/usage?now=2020-01-01']) expect((await fetch(url+path)).status,path).toBe(422);
});
it('runs real local-user CLI commands and forwards query validation',async()=>{
 const run=promisify(execFile),env={...process.env,OPEN_MANA_HOME:home,OPEN_MANA_CONTEXT:''};
 for(const words of [['workbench','overview'],['workspace','search'],['usage','summary']]) {
  const {stdout}=await run(process.execPath,['cli/openmana.mjs',...words,'--base-url',url],{env});
  expect(JSON.parse(stdout).ok).toBe(true);
 }
 await expect(run(process.execPath,['cli/openmana.mjs','usage','summary','--base-url',url,'--query','{"period":"month"}'],{env})).rejects.toMatchObject({code:1});
});
it('excludes unreadable usage sources from totals, groups, coverage and recent links',async()=>{
 const recorder=createUsageRecorder(store);recorder.begin({executionId:'denied-usage',category:'conversation',cli:'omp',conversationId:'missing-source',model:'private-model'});
 recorder.event({method:'turn/started',params:{threadId:'private-session',turn:{id:'private-turn'}}});
 recorder.event({method:'openmana/usageMessage',params:{threadId:'private-session',turnId:'private-turn',messageId:'private-message',usage:{input:10,output:5,cacheRead:0,cacheWrite:0}}});recorder.finish('completed');
 expect(getUsage(store,{period:'today',timeZone:'UTC'}).coverage.total).toBe(1);
 const summary=await(await fetch(url+'/api/usage?period=today&timeZone=UTC')).json();
 expect(summary.coverage.total).toBe(0);expect(summary.totals.totalTokens).toBeNull();expect(summary.recent).toEqual([]);expect(summary.groups.model).toEqual([]);expect(JSON.stringify(summary)).not.toContain('private-model');
});
it('CLI Agent browsing returns matching records and retains project-local picker choices',async()=>{
 const chat=store.createConversation({projectId:'',agentId:'past-agent',cli:'codex',model:null});
 const run=promisify(execFile),env={...process.env,OPEN_MANA_HOME:home,OPEN_MANA_CONTEXT:''};
 const {stdout}=await run(process.execPath,['cli/openmana.mjs','workbench','overview','--base-url',url,'--query','{"agentId":"past-agent"}'],{env});
 const response=JSON.parse(stdout);expect(response.ok).toBe(true);expect(response.data.recentConversations.map((c:{id:string})=>c.id)).toEqual([chat.id]);expect(response.data.agentOptions).toContainEqual({id:'past-agent',name:'past-agent'});
 expect((await fetch(url+'/api/workbench?agentId=past-agent&agentId=other')).status).toBe(422);
 const unassigned=await(await fetch(url+'/api/workbench?agentId=')).json();expect(unassigned.recentConversations).toEqual([]);
});
it('conversation progress is local-user scoped, validates actions and preserves Task counts',async()=>{
 const c=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});store.appendEvent(c.id,'user',{text:'A standalone goal'});
 expect((await fetch(url+'/api/conversation-progress')).status).toBe(200);
 for(const suffix of ['?windowMinutes=0','?windowMinutes=word','?extra=1','?windowMinutes=60&windowMinutes=60'])expect((await fetch(url+'/api/conversation-progress'+suffix)).status).toBe(422);
 const path='/api/conversation-progress/'+c.id;
 expect((await fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://foreign.example'},body:JSON.stringify({action:'complete'})})).status).toBe(403);
 expect((await fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'complete',taskId:'wrong'})})).status).toBe(422);
 expect((await fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'complete'})})).status).toBe(200);
 expect((await(await fetch(url+'/api/conversation-progress')).json())[0]).toMatchObject({id:c.id,state:'completed'});
 expect(store.database.prepare('SELECT count(*) n FROM work_tasks').get()!.n).toBe(0);
 expect((await fetch(url+'/api/conversation-progress',{headers:{Authorization:'Bearer untrusted-agent'}})).status).toBe(403);
});
