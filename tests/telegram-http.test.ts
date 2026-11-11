import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openAccountStore } from '../server/account-store';
import { createHttpServer } from '../server/http';
import { readConfig } from '../server/config';
import { createSessionManager } from '../server/sessions';
import { openStore } from '../server/store';
import { createTelegramService } from '../server/telegram';
import { createTelegramWorkspace } from '../server/telegram-workspace';
import { remoteRequestAllowed } from '../server/remote-policy';

let home:string, base:string, origin:string, pollSignal:AbortSignal|undefined;
let store:ReturnType<typeof openStore>, manager:ReturnType<typeof createSessionManager>;
let server:ReturnType<typeof createHttpServer>, service:ReturnType<typeof createTelegramService>;
const token='123456:fixture_local_telegram_token';
beforeEach(async()=>{
  home=await mkdtemp(join(tmpdir(),'telegram-http-'));
  store=openStore(home);
  manager=createSessionManager(store,async()=>(await readConfig(home)).config,undefined,undefined,home);
  pollSignal=undefined;
  service=createTelegramService({home,store,workspace:createTelegramWorkspace(home,store,manager),
    fetch:async(url,init)=>{
      const method=String(url).split('/').at(-1);
      const ok=(result:unknown)=>Response.json({ok:true,result});
      if(method==='getMe')return ok({id:123456,username:'fixture_bot',first_name:'Fixture',is_bot:true});
      if(method==='getWebhookInfo')return ok({url:'',has_custom_certificate:false,pending_update_count:0});
      if(method==='setMyCommands')return ok(true);
      if(method==='getUpdates'){
        pollSignal=init?.signal??undefined;
        return await new Promise<Response>((_resolve,reject)=>pollSignal?.addEventListener('abort',()=>reject(new Error('fake abort')),{once:true}));
      }
      throw new Error('Unexpected fake endpoint');
    },
  });
  const accounts=openAccountStore(home);
  await accounts.createUser('fixture','local-password-fixture');
  accounts.close();
  server=createHttpServer({home,store,manager,telegram:service});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  base=origin+'/api/mandala/telegram';
});
afterEach(async()=>{
  if(server?.listening){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  service.stop();await manager.close();store.close();await rm(home,{recursive:true,force:true});
});
const post=(url:string,body:unknown,headers:Record<string,string>={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
async function login(){
  const response=await post(origin+'/auth/login',{username:'fixture',password:'local-password-fixture'});
  const session=await response.json();
  return {cookie:response.headers.getSetCookie()[0].split(';')[0],'x-csrf-token':session.csrfToken as string};
}

it('requires a local owner session and verifies CSRF before persisting a private credential',async()=>{
  expect((await fetch(base)).status).toBe(401);
  const headers=await login();
  expect((await post(base+'/configure',{token},{cookie:headers.cookie})).status).toBe(403);
  expect((await post(base+'/configure',{token,unknown:true},headers)).status).toBe(422);
  const response=await post(base+'/configure',{token},headers);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({configured:true,bot:{id:123456},attention:true});
  const credential=join(home,'telegram-credential.json');
  expect((await stat(credential)).mode&0o777).toBe(0o600);
  expect(JSON.parse(await readFile(credential,'utf8')).token).toBe(token);
  expect(await (await fetch(base,{headers})).text()).not.toContain(token);
  expect((await fetch(base+'/tasks/ordinary',{headers})).status).toBe(404);
  expect(remoteRequestAllowed('GET','/api/mandala/telegram')).toBe(false);
  expect(remoteRequestAllowed('POST','/api/mandala/telegram/configure',{token})).toBe(false);
  expect((await fetch(base,{method:'DELETE',headers})).status).toBe(200);
  await expect(stat(credential)).rejects.toMatchObject({code:'ENOENT'});
});

it('starts polling on a configured listener and aborts the outstanding request on close',async()=>{
  const headers=await login();
  await post(base+'/configure',{token},headers);
  await vi.waitFor(()=>expect(pollSignal).toBeDefined());
  server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  expect(pollSignal?.aborted).toBe(true);
});

it('returns current status on local changes and rejects stale candidates and the retired task preference',async()=>{
  const headers=await login();
  await post(base+'/configure',{token},headers);
  const pair=await post(base+'/pair',{},headers);
  expect(await pair.json()).toMatchObject({pairing:{url:expect.stringMatching(/^https:\/\/t\.me\/fixture_bot\?start=/)}});
  expect((await post(base+'/confirm',{userId:42},headers)).status).toBe(409);
  expect((await post(base+'/test',{},headers)).status).toBe(422);
  const patch=await fetch(base+'/notifications',{method:'PATCH',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({attention:false})});
  expect(await patch.json()).toMatchObject({attention:false,configured:true});
  const put=await fetch(base+'/tasks/ordinary',{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({enabled:true})});
  expect(put.status).toBe(404);
  expect((await fetch(base+'/unknown',{headers})).status).toBe(404);
  expect((await fetch(base+'?token='+token,{headers})).status).toBe(422);
});
