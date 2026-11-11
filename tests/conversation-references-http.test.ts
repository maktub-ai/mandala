import {createTaskWithExecutions} from './helpers/task-executions';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHttpServer } from '../server/http';
import { createSessionManager } from '../server/sessions';
import { openStore } from '../server/store';
import { readConfig,writeConfig } from '../server/config';
import { workspacePrincipal } from '../server/workspace-identity';
let home:string,base:string,id:string,store:ReturnType<typeof openStore>,manager:ReturnType<typeof createSessionManager>,server:ReturnType<typeof createHttpServer>;
beforeEach(async()=>{
 home=mkdtempSync(join(tmpdir(),'references-http-'));const initial=await readConfig(home);await writeConfig(home,{...initial.config,agents:[...initial.config.agents,{id:'a',name:'Execution Agent',defaultCli:'codex',models:{},instructions:'',mcp:[],skills:[]}]},initial.revision);store=openStore(home);
 manager=createSessionManager(store,async()=>(await readConfig(home)).config,async()=>{throw new Error('No native execution expected');},undefined,home);
 id=store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null}).id;
 server=createHttpServer({requireIdentity:false,home,store,manager});server.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+(server.address() as {port:number}).port;
});
afterEach(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await manager.close();store.close();rmSync(home,{recursive:true,force:true});});
test('summary is conversation-scoped and remains separate from the composer reference catalog',async()=>{
 const root=workspacePrincipal(store),other=store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null});
 const linked=createTaskWithExecutions(store,manager.taskService,root,{goal:'Linked work'},[id],'linked');createTaskWithExecutions(store,manager.taskService,root,{goal:'Other work'},[other.id],'other');
 const response=await fetch(base+'/api/conversations/'+id+'/reference-summary');expect(response.status).toBe(200);
 expect(await response.json()).toEqual({tasks:[{id:linked.id,goal:'Linked work',state:'todo'}],documents:[],memories:[],truncated:false});
 const outputs=await fetch(base+'/api/conversations/'+id+'/reference-summary?view=outputs');expect(outputs.status).toBe(200);expect(await outputs.json()).toEqual({tasks:[],documents:[],memories:[],truncated:false});
 expect(Array.isArray((await (await fetch(base+'/api/conversations/'+id+'/references')).json()).items)).toBe(true);
 expect((await fetch(base+'/api/conversations/'+id+'/reference-summary',{headers:{Origin:'https://other.example'}})).status).toBe(403);
});
