import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { openStore } from '../server/store';
import { createSessionManager } from '../server/sessions';
import { createHttpServer } from '../server/http';
import { openLocalFile } from '../server/local-file-open';
import { DomainError } from '../shared/workspace-contracts';
vi.mock('../server/local-file-open',()=>({openLocalFile:vi.fn(async()=>{})}));
afterEach(()=>vi.clearAllMocks());

it('opens only authorized chat or workspace files and serves HTML with an opaque script sandbox',async()=>{
 const home=await realpath(await mkdtemp(join(tmpdir(),'chat-file-open-'))),store=openStore(home);
 const manager=createSessionManager(store,async()=>({runtimes:['codex','omp'],version:2,projects:[],agents:[]}),undefined,undefined,home);
 const server=createHttpServer({requireIdentity:false,home,store,manager});
 const call=(id:string,action:string,data:object={},method='POST',origin='http://127.0.0.1')=>new Promise<{status:number;headers:Record<string,string>;body:string}>(done=>{
  let status=0,headers:Record<string,string>={};
  const req=Object.assign(Readable.from([Buffer.from(JSON.stringify(data))]),{url:`/api/conversations/${id}/${action}`,method,headers:{host:'127.0.0.1',origin,'content-type':'application/json'}});
  server.emit('request',req,{writeHead(code:number,value:Record<string,string>){status=code;headers=value;},end(body:string){done({status,headers,body});}});
 });
 try{
  const chat=await manager.create('','',undefined,'codex',{cwd:home}),other=await manager.create('','');
  const path=join(home,'report one.html'),html='<h1>Report</h1><script>document.title="Ready"</script>';
  await writeFile(path,html);await writeFile(join(home,'.env'),'secret');await symlink(join(home,'.env'),join(home,'shortcut.html'));
  expect((await call(chat.id,'local-file/open',{href:path})).status).toBe(403);
  store.appendEvent(chat.id,'text',{itemId:'report',text:`[Report](<${path}>)`});
  expect((await call(other.id,'local-file/open',{href:path})).status).toBe(403);
  expect((await call(chat.id,'local-file/open',{href:path},'POST','https://foreign.example')).status).toBe(403);
  expect(openLocalFile).not.toHaveBeenCalled();
  expect((await call(chat.id,'local-file/open',{href:path})).status).toBe(200);
  expect(openLocalFile).toHaveBeenLastCalledWith(path);
  expect((await call(chat.id,'workspace-file/open',{path:'report one.html'})).status).toBe(200);
  expect(openLocalFile).toHaveBeenLastCalledWith(path);
  vi.mocked(openLocalFile).mockClear();
  for(const path of ['../outside.html','.env','shortcut.html','missing.html'])expect((await call(chat.id,'workspace-file/open',{path})).status).toBeGreaterThanOrEqual(400);
  expect(openLocalFile).not.toHaveBeenCalled();
  for(const action of ['local-file/preview?href='+encodeURIComponent(path),'workspace-file/preview?path=report%20one.html']){
   const result=await call(chat.id,action,{},'GET');
   expect(result.status).toBe(200);expect(result.body).toBe(html);
   expect(result.headers['Content-Type']).toBe('text/html; charset=utf-8');
   expect(result.headers['Content-Security-Policy']).toContain('sandbox allow-scripts;');
   expect(result.headers['Content-Security-Policy']).toContain("connect-src 'none'");
   expect(result.headers['Content-Security-Policy']).not.toContain('allow-same-origin');
  }
  expect((await call(other.id,'local-file/preview?href='+encodeURIComponent(path),{},'GET')).status).toBe(403);
  const original=manager.authorizeConversationRead.bind(manager);let checks=0;
  const revoke=vi.spyOn(manager,'authorizeConversationRead').mockImplementation(id=>{original(id);if(++checks===2)throw new DomainError('forbidden',403,'Access revoked');});
  expect((await call(chat.id,'local-file/open',{href:path})).status).toBe(403);
  expect(openLocalFile).not.toHaveBeenCalled();revoke.mockRestore();
  vi.mocked(openLocalFile).mockRejectedValueOnce(new DomainError('local_open_failed',503,'Application unavailable'));
  expect((await call(chat.id,'local-file/open',{href:path})).status).toBe(503);
 }finally{await manager.close();store.close();server.close();await rm(home,{recursive:true,force:true});}
});
