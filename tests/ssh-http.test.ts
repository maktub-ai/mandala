import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHttpServer } from '../server/http';
import { createSessionManager } from '../server/sessions';
import { openStore } from '../server/store';
import { readConfig, writeConfig } from '../server/config';
import type { Config } from '../shared/types';
import { createTerminals } from '../server/terminals';
import { SshService } from '../server/ssh-service';

const ssh=vi.hoisted(()=>({request:vi.fn(),connect:vi.fn(),probe:vi.fn(),checkPath:vi.fn(),close:vi.fn()}));
vi.mock('../server/ssh-execution',()=>({connectSshExecution:ssh.connect,probeSshHost:ssh.probe,checkSshPath:ssh.checkPath}));
let home:string,url:string,id:string,store:ReturnType<typeof openStore>,manager:ReturnType<typeof createSessionManager>,server:ReturnType<typeof createHttpServer>,terminals:ReturnType<typeof createTerminals>;
beforeEach(async()=>{
 home=mkdtempSync(join(tmpdir(),'mana-ssh-http-'));store=openStore(home);
 const config:Config={version:2,executionMachines:[{id:'linux',name:'Edited machine',host:'edited-host'}],agents:[],projects:[{
  id:'p',name:'Project',cwd:'/srv/project',resources:[],agentIds:[],mcp:[],skills:[],workspaces:[{id:'remote',name:'Remote',machineId:'linux',cwd:'/srv/project',resources:[]}],
 }]};
 await writeConfig(home,config,(await readConfig(home)).revision);
 manager=createSessionManager(store,async()=>(await readConfig(home)).config,undefined,undefined,home);
 id=store.createConversation({projectId:'p',agentId:'',workspaceId:'remote',cwd:'/srv/project',cli:'omp',model:null,
  executionLocation:{machineId:'linux',machineName:'Pinned machine',host:'pinned-host',cwd:'/srv/project'}}).id;
 store.appendEvent(id,'text',{text:'Read [report](./report.html)'});
 ssh.request.mockReset();ssh.connect.mockReset();ssh.probe.mockReset();ssh.checkPath.mockReset();ssh.close.mockReset();
 ssh.connect.mockResolvedValue({request:ssh.request,close:ssh.close});
 ssh.request.mockImplementation(async(method:string,p:any)=>{
  if(method==='workspace.environment')return {cwd:p.cwd,git:false,worktrees:[]};
  if(method==='workspace.list')return {files:[{path:'report.html'}]};
  if(method==='workspace.read')return {path:p.path,text:'Remote source'};
  if(method==='workspace.preview'||method==='local-files.preview')return {name:'report.html',path:'/srv/project/report.html',text:'<h1>Remote report</h1>'};
  if(method==='local-files.resolve')return {hrefs:['./report.html']};
  if(method==='capabilities.discover')return {mcp:[],skills:[{name:'remote-only',path:'/srv/project/.agents/skills/remote-only/SKILL.md',source:'native'}]};
  if(method==='fs.stat')return {isDirectory:true,realpath:p.path};
  throw new Error('Unexpected remote operation '+method);
 });
 terminals=createTerminals();server=createHttpServer({requireIdentity:false,home,store,manager,terminals});server.listen(0,'127.0.0.1');await once(server,'listening');
 url='http://127.0.0.1:'+(server.address() as {port:number}).port;
});
afterEach(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));terminals.close();await manager.close();store.close();rmSync(home,{recursive:true,force:true});});
const post=(path:string,data:unknown)=>fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
const route=(action:string)=>`/api/conversations/${id}/${action}`;

it('probes SSH targets through the local authenticated endpoint and rejects extra fields',async()=>{
 ssh.probe.mockResolvedValue({platform:'linux',nodeVersion:'22.23.2',runtimes:[{id:'omp',installed:true}]});
 const response=await post('/api/execution-machines/probe',{host:'build-host'});
 expect(response.status).toBe(200);expect((await response.json()).runtimes).toEqual([{id:'omp',installed:true}]);
 expect(ssh.probe).toHaveBeenCalledWith('build-host');
 expect((await post('/api/execution-machines/probe',{host:'build-host',password:'secret'})).status).toBe(422);
 expect((await post('/api/execution-machines/probe',{host:'-oProxyCommand=bad'})).status).toBe(422);
});

it('remembers the last probe per target so settings can show a status without probing again',async()=>{
 expect(await (await fetch(url+'/api/execution-machines/status')).json()).toEqual({});
 ssh.probe.mockResolvedValueOnce({platform:'linux',nodeVersion:'22.23.2',runtimes:[]});
 await post('/api/execution-machines/probe',{host:'good-host'});
 ssh.probe.mockRejectedValueOnce(new Error('SSH failed (255): Host key verification failed.'));
 expect((await post('/api/execution-machines/probe',{host:'bad-host'})).ok).toBe(false);
 const status=await (await fetch(url+'/api/execution-machines/status')).json();
 expect(status['good-host']).toMatchObject({ok:true,probe:{platform:'linux'}});
 expect(status['bad-host']).toMatchObject({ok:false,error:expect.stringContaining('Host key verification failed')});
 expect((await post('/api/execution-machines/status',{})).status).toBe(405);
});

it('checks a remote working directory on a saved machine only',async()=>{
 ssh.checkPath.mockResolvedValue({exists:true,isDirectory:true,realpath:'/srv/project'});
 const response=await post('/api/execution-machines/check-path',{machineId:'linux',path:'/srv/project'});
 expect(response.status).toBe(200);expect(await response.json()).toEqual({exists:true,isDirectory:true,realpath:'/srv/project'});
 expect(ssh.checkPath).toHaveBeenCalledWith('edited-host','/srv/project');
 expect((await post('/api/execution-machines/check-path',{machineId:'missing',path:'/srv/project'})).status).toBe(404);
 expect((await post('/api/execution-machines/check-path',{machineId:'linux',path:'relative/path'})).status).toBe(422);
 expect((await post('/api/execution-machines/check-path',{machineId:'linux',path:'/srv',host:'other'})).status).toBe(422);
 expect(ssh.checkPath).toHaveBeenCalledTimes(1);
});

it('routes remote environment, workspace and file previews to the pinned host',async()=>{
 expect((await (await fetch(url+route('environment'))).json()).cwd).toBe('/srv/project');
 expect(await (await fetch(url+route('workspace'))).json()).toEqual({files:[{path:'report.html'}]});
 expect(await (await post(route('workspace-file'),{path:'report.html'})).json()).toEqual({path:'report.html',text:'Remote source'});
 const preview=await fetch(url+route('workspace-file/preview')+'?path=report.html');
 expect(preview.status).toBe(200);expect(await preview.text()).toBe('<h1>Remote report</h1>');
 expect(ssh.connect).toHaveBeenCalledWith({id:'linux',name:'Pinned machine',host:'pinned-host'},{home,conversationId:id});
 expect(ssh.close).toHaveBeenCalled();
 expect((await post(route('workspace-file/open'),{path:'report.html'})).status).toBe(409);
});

it('resolves and previews transcript links remotely and refuses opening them in a local App',async()=>{
 expect(await (await post(route('local-files/resolve'),{hrefs:['./report.html']})).json()).toEqual({hrefs:['./report.html']});
 expect((await (await post(route('local-file'),{href:'./report.html'})).json()).text).toBe('<h1>Remote report</h1>');
 expect(await (await fetch(url+route('local-file/preview')+'?href=.%2Freport.html')).text()).toBe('<h1>Remote report</h1>');
 expect(ssh.request).toHaveBeenCalledWith('local-files.resolve',expect.objectContaining({cwd:'/srv/project',roots:['/srv/project'],messages:['Read [report](./report.html)']}));
 expect((await post(route('local-file/open'),{href:'./report.html'})).status).toBe(409);
});

it('discovers native Skills on the execution machine and never scans the local remote cwd',async()=>{
 const query=`?projectId=p&agentId=&cli=omp&conversationId=${id}&kind=skills`;
 const response=await fetch(url+'/api/capabilities'+query);
 expect(response.status).toBe(200);expect((await response.json()).skills[0].name).toBe('remote-only');
 expect(ssh.request).toHaveBeenCalledWith('capabilities.discover',{cli:'omp',cwd:'/srv/project',kind:'skills'});
});

it('launches a strict SSH terminal using the pinned host and remotely validated cwd',async()=>{
 const start=vi.spyOn(terminals,'start').mockReturnValue({cwd:'/srv/project'} as never);
 const response=await post(route('terminal'),{cols:80,rows:24});
 expect(response.status).toBe(201);
 expect(start).toHaveBeenCalledWith(id,'/srv/project',{cols:80,rows:24},{command:'ssh',localCwd:home,displayCwd:'/srv/project',args:[
  '-tt','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=15','--','pinned-host',
  'cd -- \'/srv/project\' && exec "${SHELL:-/bin/sh}" -l',
 ]});
 expect(ssh.request).toHaveBeenCalledWith('fs.stat',{path:'/srv/project'});
});

it('only opens remote worktrees belonging to the conversation repository',async()=>{
 const start=vi.spyOn(terminals,'start').mockReturnValue({cwd:'/srv/side'} as never);
 ssh.request.mockImplementation(async(method:string,p:any)=>method==='workspace.environment'?{cwd:'/srv/project',git:true,worktrees:[{path:'/srv/side'}]}:{isDirectory:true,realpath:p.path});
 expect((await post(route('terminal'),{cols:80,rows:24,worktree:'/srv/outside'})).status).toBe(400);
 expect(start).not.toHaveBeenCalled();
 expect((await post(route('terminal'),{cols:80,rows:24,worktree:'/srv/side'})).status).toBe(201);
 expect(start).toHaveBeenCalledWith(id,'/srv/side',expect.anything(),expect.objectContaining({displayCwd:'/srv/side'}));
});

it('returns a remote scope denial without falling back to local files',async()=>{
 ssh.request.mockRejectedValueOnce(Object.assign(new Error('Outside remote workspace'),{code:'file_scope',status:403}));
 const response=await post(route('workspace-file'),{path:'report.html'});
 expect(response.status).toBe(403);expect((await response.json()).error).toBe('Outside remote workspace');
 expect(ssh.close).toHaveBeenCalled();
});

it('round-trips remote workspace and transcript previews through the real service file protections',async()=>{
 const directory=join(home,'remote-fixture');mkdirSync(directory);writeFileSync(join(directory,'report.html'),'<p>Service report</p>');writeFileSync(join(directory,'.env'),'SECRET=fixture');
 const chat=store.createConversation({projectId:'p',agentId:'',cli:'omp',model:null,cwd:directory,executionLocation:{machineId:'linux',machineName:'Pinned machine',host:'pinned-host',cwd:directory}});
 store.appendEvent(chat.id,'text',{text:'Read [report](./report.html) and [secret](./.env)'});
 const service=new SshService(join(home,'remote-service'),'/unused-cli');
 ssh.request.mockImplementation((method:string,params:unknown)=>service.request({id:randomUUID(),method,params}));
 const scoped=(action:string)=>`/api/conversations/${chat.id}/${action}`;
 expect(await (await post(scoped('local-files/resolve'),{hrefs:['./report.html','./.env']})).json()).toEqual({hrefs:['./report.html']});
 expect((await (await post(scoped('local-file'),{href:'./report.html'})).json()).text).toBe('<p>Service report</p>');
 const preview=await fetch(url+scoped('workspace-file/preview')+'?path=report.html');
 expect(await preview.text()).toBe('<p>Service report</p>');expect(preview.headers.get('content-security-policy')).toContain('sandbox');
 expect((await post(scoped('workspace-file'),{path:'.env'})).status).toBe(403);
 expect((await post(scoped('local-file'),{href:'./.env'})).status).toBe(403);
 expect((await post(scoped('local-file'),{href:'./unlinked.html'})).status).toBe(403);
});
