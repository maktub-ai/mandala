import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { readConfig, writeConfig } from '../server/config';
import { openStore, type Store } from '../server/store';
import { createSessionManager, type SessionManager } from '../server/sessions';
import { createHttpServer } from '../server/http';
import { cloneProjectWorkspace } from '../server/clone-workspace';

vi.mock('../server/clone-workspace',()=>({cloneProjectWorkspace:vi.fn()}));
let home:string,store:Store,manager:SessionManager,server:Server,url:string;
beforeEach(async()=>{
  home=mkdtempSync(join(tmpdir(),'mana-clone-http-'));
  const initial=await readConfig(home);
  await writeConfig(home,{version:2,agents:[],projects:[{id:'p',name:'Project',cwd:home,resources:[],agentIds:[],mcp:[],skills:[]}]},initial.revision);
  store=openStore(home);manager=createSessionManager(store,async()=>(await readConfig(home)).config);
  server=createHttpServer({home,store,manager,requireIdentity:false});server.listen(0,'127.0.0.1');await once(server,'listening');
  url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  vi.mocked(cloneProjectWorkspace).mockReset();
  vi.mocked(cloneProjectWorkspace).mockResolvedValue({id:'cloned',name:'Sample',cwd:home,resources:[{id:'origin',label:'Origin',kind:'remote-git',location:'https://example.test/repo.git'}]});
});
afterEach(async()=>{
  await manager.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(home,{recursive:true,force:true});
});
const post=(id:string,data:unknown,origin=url)=>fetch(url+`/api/projects/${id}/workspaces/clone`,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(data)});

it('clones into the saved Project context and returns a Workspace without changing configuration',async()=>{
  const initial=await readConfig(home);
  const response=await post('p',{url:'https://example.test/repo.git'});
  expect(response.status).toBe(201);expect((await response.json()).workspace).toMatchObject({id:'cloned',cwd:home});
  expect(cloneProjectWorkspace).toHaveBeenCalledWith(home,expect.objectContaining({id:'p',cwd:home}),'https://example.test/repo.git');
  expect(await readConfig(home)).toEqual(initial);
});
it('supports a new Project draft with a managed directory and never accepts a client-supplied cwd',async()=>{
  expect((await post('new-draft',{url:'https://example.test/repo.git'})).status).toBe(201);
  expect(cloneProjectWorkspace).toHaveBeenCalledWith(home,{id:'new-draft',cwd:''},'https://example.test/repo.git');
  expect((await post('p',{url:'https://example.test/repo.git',cwd:'/private'})).status).toBe(422);
  expect((await post('p',{url:'https://example.test/repo.git'},'https://foreign.test')).status).toBe(403);
  expect(cloneProjectWorkspace).toHaveBeenCalledTimes(1);
});
