import {accountServiceAvailable,createControlServer} from './helpers/account-service';
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { openStore, type Store } from '../server/store';
import { createSessionManager, type SessionManager } from '../server/sessions';
import { readConfig } from '../server/config';
import { openAccountStore } from '../server/account-store';
import { createHttpServer } from '../server/http';
const homes:string[]=[];const servers:Server[]=[];const stores:Store[]=[];const managers:SessionManager[]=[];
afterEach(async()=>{for(const s of servers){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}for(const m of managers)await m.close();for(const s of stores)s.close();for(const h of homes)rmSync(h,{recursive:true,force:true});servers.length=stores.length=managers.length=homes.length=0;});
it('requires real identity before exposing personal API even on loopback',async()=>{
 const home=mkdtempSync(join(tmpdir(),'mana-auth-test-'));homes.push(home);
 const store=openStore(home);stores.push(store);const manager=createSessionManager(store,async()=>(await readConfig(home)).config);managers.push(manager);
 // Production must opt into the gate; existing protocol fixture servers explicitly omit it.
 const server=createHttpServer({home,store,manager});servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening');
 const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 expect((await fetch(url+'/api/config')).status).toBe(401);
 expect((await fetch(url+'/api/config',{headers:{'x-openmana-owner-id':'forged','x-openmana-bridge-key':'forged'}})).status).toBe(401);
 expect(await fetch(url+'/auth/session').then(r=>r.json())).toMatchObject({mode:'local',user:null});
});

it('admin account claims legacy history; cookies, logout, wrong accounts and local CLI keys retain separate authority',async()=>{
 const home=mkdtempSync(join(tmpdir(),'mana-auth-owner-'));homes.push(home);
 const accounts=openAccountStore(home),owner=await accounts.createUser('owner','personal-example-password');await accounts.createUser('other','another-example-password');
 const store=openStore(home);stores.push(store);const conversation=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});store.appendEvent(conversation.id,'user',{text:'Retained personal history'});
 const manager=createSessionManager(store,async()=>(await readConfig(home)).config);managers.push(manager);const server=createHttpServer({home,store,manager,requireIdentity:true});servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const login=(username:string,password:string)=>fetch(url+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:url},body:JSON.stringify({username,password})});
 expect((await login('owner','wrong-password')).status).toBe(401);expect((await login('other','another-example-password')).status).toBe(403);
 const legacy=accounts.createSession(owner.id);expect((await fetch(url+'/api/config',{headers:{Cookie:'openmana_local_session='+legacy.token}})).status).toBe(200);
 const signed=await login('owner','personal-example-password');expect(signed.status).toBe(200);expect(signed.headers.get('set-cookie')).toContain('mandala_local_session=');expect(signed.headers.get('set-cookie')).toContain('HttpOnly');const cookie=signed.headers.get('set-cookie')!.split(';')[0],data=await signed.json();expect(store.ownerUserId).toBe(owner.id);
 const history=await fetch(url+`/api/conversations/${conversation.id}/history`,{headers:{Cookie:cookie}});expect(await history.json()).toEqual(expect.arrayContaining([expect.objectContaining({data:{text:'Retained personal history'}})]));
 expect((await fetch(url+'/auth/logout',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'}})).status).toBe(403);
 const stream=await fetch(url+`/api/conversations/${conversation.id}/events`,{headers:{Cookie:cookie}}),reader=stream.body!.getReader();await reader.read();
 expect((await fetch(url+'/auth/logout',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':data.csrfToken}})).status).toBe(200);
 expect((await fetch(url+'/api/config',{headers:{Cookie:cookie}})).status).toBe(401);
 let ended=false;for(let i=0;i<4;i++){if((await reader.read()).done){ended=true;break;}}expect(ended).toBe(true);
 const key=readFileSync(join(home,'local-access.key'),'utf8').trim();expect((await fetch(url+'/api/config',{headers:{'X-Mandala-Local-Key':key}})).status).toBe(200);expect((await fetch(url+'/api/config',{headers:{'X-OpenMana-Local-Key':key}})).status).toBe(200);
 expect((await fetch(url+'/api/config',{headers:{'X-OpenMana-CLI':'1'}})).status).toBe(401);
 expect((await fetch(url+'/api/config',{headers:{'X-OpenMana-Local-Key':key,Origin:'https://foreign.example'}})).status).toBe(403);
});
it('local CLI uses a private owner credential without trusting browser headers',async()=>{
 const home=mkdtempSync(join(tmpdir(),'mana-auth-cli-'));homes.push(home);await openAccountStore(home).createUser('owner','synthetic-owner-password');
 const store=openStore(home);stores.push(store);const manager=createSessionManager(store,async()=>(await readConfig(home)).config);managers.push(manager);const server=createHttpServer({home,store,manager,requireIdentity:true});servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const {resolve}=await import('node:path');
 const {stdout}=await promisify(execFile)(process.execPath,[resolve('cli/openmana.mjs'),'config','get','--base-url',url],{env:{...process.env,OPEN_MANA_HOME:home,OPEN_MANA_CONTEXT:''}});
 expect(JSON.parse(stdout)).toMatchObject({ok:true,data:{config:{version:2}}});
});
it('logout closes existing local terminal output streams',async()=>{
 const home=mkdtempSync(join(tmpdir(),'mana-auth-terminal-'));homes.push(home);await openAccountStore(home).createUser('owner','synthetic-owner-password');const store=openStore(home);stores.push(store);const manager=createSessionManager(store,async()=>(await readConfig(home)).config);managers.push(manager);const chat=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});
 const server=createHttpServer({home,store,manager});servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const login=await fetch(url+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:url},body:JSON.stringify({username:'owner',password:'synthetic-owner-password'})}),cookie=login.headers.get('set-cookie')!.split(';')[0],session=await login.json();
 const terminal=await fetch(url+`/api/conversations/${chat.id}/terminal`,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({cols:80,rows:24})}).then(r=>r.json());
 const controller=new AbortController();const stream=await fetch(url+`/api/conversations/${chat.id}/terminal/events?sessionId=${terminal.session.id}`,{headers:{Cookie:cookie},signal:controller.signal}),reader=stream.body!.getReader();await reader.read();
 await fetch(url+'/auth/logout',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':session.csrfToken}});
 let timer:ReturnType<typeof setTimeout>|undefined;try{const ended=await Promise.race([(async()=>{for(;;)if((await reader.read()).done)return true;})(),new Promise<boolean>(r=>{timer=setTimeout(()=>r(false),1000);})]);expect(ended).toBe(true);}finally{clearTimeout(timer);controller.abort();}
});
it.skipIf(!accountServiceAvailable)('restores the outbound computer connection when the service starts before any browser request',async()=>{
 const {writeFileSync}=await import('node:fs');
 const home=mkdtempSync(join(tmpdir(),'mana-auth-reconnect-')),controlHome=mkdtempSync(join(tmpdir(),'mana-auth-control-'));homes.push(home,controlHome);await openAccountStore(home).createUser('owner','synthetic-owner-password');await openAccountStore(controlHome).createUser('owner','synthetic-owner-password');
 const control=createControlServer({home:controlHome});servers.push(control);control.listen(0,'127.0.0.1');await once(control,'listening');const controlUrl=`http://127.0.0.1:${(control.address() as {port:number}).port}`;
 const login=await fetch(controlUrl+'/auth/login',{method:'POST',headers:{Origin:controlUrl,'Content-Type':'application/json'},body:JSON.stringify({username:'owner',password:'synthetic-owner-password'})}),cookie=login.headers.get('set-cookie')!.split(';')[0],session=await login.json();
 const enrolled=await fetch(controlUrl+'/connect/enroll',{method:'POST',headers:{Origin:controlUrl,Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify({name:'Reconnected computer'})}).then(r=>r.json());writeFileSync(join(home,'computer-connection.json'),JSON.stringify({controlUrl,...enrolled}),{mode:0o600});
 const store=openStore(home);stores.push(store);const manager=createSessionManager(store,async()=>(await readConfig(home)).config);managers.push(manager);const local=createHttpServer({home,store,manager});servers.push(local);local.listen(0,'127.0.0.1');await once(local,'listening');
 await expect.poll(async()=>{const state=await fetch(controlUrl+'/auth/session',{headers:{Cookie:cookie}}).then(r=>r.json());return state.devices[0].online;},{timeout:1500}).toBe(true);
});
it('uses legacy-refreshed local identity and revokes both mixed-version session tokens on logout',async()=>{
 const home=mkdtempSync(join(tmpdir(),'mandala-mixed-login-'));homes.push(home);const accounts=openAccountStore(home),owner=await accounts.createUser('owner','synthetic-owner-password');
 const first=accounts.createSession(owner.id),refreshed=accounts.createSession(owner.id),cookie=`mandala_local_session=${first.token}; openmana_local_session=${refreshed.token}`;
 const store=openStore(home);stores.push(store);const manager=createSessionManager(store,async()=>(await readConfig(home)).config);managers.push(manager);const server=createHttpServer({home,store,manager});servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 expect(await fetch(url+'/auth/session',{headers:{Cookie:cookie}}).then(r=>r.json())).toMatchObject({csrfToken:refreshed.csrfToken});
 expect((await fetch(url+'/auth/logout',{method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':refreshed.csrfToken}})).status).toBe(200);
 for(const [name,token] of [['mandala_local_session',first.token],['openmana_local_session',refreshed.token]])expect((await fetch(url+'/api/config',{headers:{Cookie:`${name}=${token}`}})).status).toBe(401);
});

it('revoking a session during a pending JSON request returns a JSON 401 instead of an empty 200',async()=>{
 const {createServer}=await import('node:http');const {createLocalAccess}=await import('../server/local-access');
 const home=mkdtempSync(join(tmpdir(),'mana-auth-pending-'));homes.push(home);const accounts=openAccountStore(home),owner=await accounts.createUser('owner','synthetic-owner-password'),session=accounts.createSession(owner.id);
 const store=openStore(home);stores.push(store);const access=createLocalAccess(home,store);let tracked!:()=>void;const started=new Promise<void>(resolve=>{tracked=resolve;});
 const server=createServer((req,res)=>{access.track(req,res);tracked();});servers.push(server);server.on('close',()=>access.close());server.listen(0,'127.0.0.1');await once(server,'listening');
 const response=fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/api/workbench`,{headers:{Cookie:'mandala_local_session='+session.token}});await started;accounts.deleteSession(session.token);
 const result=await response;expect(result.status).toBe(401);expect(await result.json()).toEqual({error:'Sign in required'});accounts.close();
});

it('pins locally reviewed browser keys independently of relay approval and disconnects before bounded remote revocation',async()=>{
 const {createServer}=await import('node:http');const {writeFileSync,existsSync}=await import('node:fs');
 const {newRemoteKey,sealRemote,openRemote,remoteRequestId}=await import('../shared/remote-crypto');
 const home=mkdtempSync(join(tmpdir(),'mana-remote-local-'));homes.push(home);const accounts=openAccountStore(home),owner=await accounts.createUser('owner','synthetic-owner-password'),session=accounts.createSession(owner.id);
 const phone=newRemoteKey(),attacker=newRemoteKey(),clientId='c'.repeat(32);let offered=phone.publicKey,revocationAvailable=false;
 const relay=createServer((req,res)=>{if(req.url==='/connector/poll')return;if(req.url==='/connector/disconnect'&&!revocationAvailable)return;res.setHeader('Content-Type','application/json');res.end(req.method==='GET'?JSON.stringify([{clientId,status:'approved',publicKey:offered,requestedAt:new Date().toISOString()}]):'{}');});servers.push(relay);relay.listen(0,'127.0.0.1');await once(relay,'listening');
 writeFileSync(join(home,'computer-connection.json'),JSON.stringify({controlUrl:`http://127.0.0.1:${(relay.address() as {port:number}).port}`,device:{id:'computer',name:'Synthetic',ownerId:'relay-owner'},credential:'credential'}));
 const store=openStore(home);stores.push(store);const manager=createSessionManager(store,async()=>(await readConfig(home)).config);managers.push(manager);const server=createHttpServer({home,store,manager});servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const localHeaders={Cookie:'mandala_local_session='+session.token,'X-CSRF-Token':session.csrfToken,'Content-Type':'application/json',Origin:url};
 const state=await fetch(url+'/auth/session',{headers:localHeaders}).then(r=>r.json()),hostKey=state.connection.pairingCode;expect(typeof hostKey).toBe('string');
 const bridge={'x-mandala-bridge-key':readFileSync(join(home,'bridge.key'),'utf8').trim(),'x-mandala-owner-id':'relay-owner','x-mandala-client-id':clientId};
 const send=(key=phone,path='/api/remote/config')=>fetch(url+'/api/remote/transport',{method:'POST',headers:bridge,body:sealRemote({id:remoteRequestId(),timestamp:Date.now(),method:'GET',path,headers:{},body:''},hostKey,key.secretKey)});
 expect((await send()).status).toBe(401);
 const grants=await fetch(url+'/auth/access',{headers:localHeaders}).then(r=>r.json());expect(grants.grants[0]).toMatchObject({status:'pending',publicKey:phone.publicKey});
 offered=attacker.publicKey; // Relay replacement after local review cannot change the key being approved.
 expect((await fetch(url+'/auth/access',{method:'POST',headers:localHeaders,body:JSON.stringify({clientId,state:'approved'})})).status).toBe(200);
 expect((await send(attacker)).status).toBe(403);
 const approved=await send();expect(approved.status).toBe(200);const records=(await approved.text()).trim().split('\n').map((wire:string)=>openRemote(wire,hostKey,phone.secretKey));expect(records[0]).toMatchObject({status:200});expect(records.at(-1).type).toBe('end');
 const denied=await send(phone,'/api/config');expect(openRemote((await denied.text()).split('\n')[0],hostKey,phone.secretKey).status).toBe(403);
 expect((await fetch(url+'/api/config',{headers:bridge})).status).toBe(401);
 const disconnect=fetch(url+'/auth/disconnect',{method:'POST',headers:localHeaders});
 await expect.poll(()=>existsSync(join(home,'computer-connection.json'))).toBe(false);
 expect((await send()).status).toBe(401);
 expect(await disconnect.then(r=>r.json())).toMatchObject({ok:true,revocationPending:true});
 expect(JSON.parse(readFileSync(join(home,'remote-access.json'),'utf8')).grants).toEqual({});
 expect(await fetch(url+'/auth/session',{headers:localHeaders}).then(r=>r.json())).toMatchObject({revocationPending:true});
 expect(existsSync(join(home,'computer-revocations.json'))).toBe(true);
 await new Promise<void>(resolve=>server.close(()=>resolve()));
 revocationAvailable=true;const restarted=createHttpServer({home,store,manager});servers.push(restarted);restarted.listen(0,'127.0.0.1');await once(restarted,'listening');
 await expect.poll(()=>existsSync(join(home,'computer-revocations.json'))).toBe(false);
 const restartedUrl=`http://127.0.0.1:${(restarted.address() as {port:number}).port}`;
 expect(await fetch(restartedUrl+'/auth/session',{headers:{Cookie:localHeaders.Cookie}}).then(r=>r.json())).toMatchObject({connection:null,revocationPending:false});
 expect((await fetch(restartedUrl+'/api/remote/transport',{method:'POST',headers:bridge,body:'ignored'})).status).toBe(401);
});

it('account-worker access ends when its lease is removed, including owner-key requests',async()=>{
 const {writeFileSync,unlinkSync}=await import('node:fs');
 const home=mkdtempSync(join(tmpdir(),'mandala-worker-lease-'));homes.push(home);
 const accounts=openAccountStore(home),user=await accounts.createUser('owner','synthetic-owner-password'),session=accounts.createSession(user.id);
 const file=join(home,'lease.json');writeFileSync(file,JSON.stringify({key:'gateway-secret',expiresAt:Date.now()+60000}));
 const previous={key:process.env.MANDALA_ACCOUNT_WORKER_KEY,file:process.env.MANDALA_ACCOUNT_LEASE_FILE};
 process.env.MANDALA_ACCOUNT_WORKER_KEY='gateway-secret';process.env.MANDALA_ACCOUNT_LEASE_FILE=file;
 try{
  const store=openStore(home);stores.push(store);const manager=createSessionManager(store,async()=>(await readConfig(home)).config);managers.push(manager);
  const server=createHttpServer({home,store,manager,requireIdentity:true});servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${(server.address() as any).port}`;
  const headers={Cookie:`mandala_local_session=${session.token}`,'X-Mandala-Gateway-Key':'gateway-secret'};
  expect((await fetch(url+'/api/config',{headers})).status).toBe(200);
  expect((await fetch(url+'/api/config',{headers:{Cookie:headers.Cookie}})).status).toBe(401);
  unlinkSync(file);
  expect((await fetch(url+'/api/config',{headers})).status).toBe(401);
  const key=readFileSync(join(home,'local-access.key'),'utf8').trim();expect((await fetch(url+'/api/config',{headers:{'X-Mandala-Local-Key':key}})).status).toBe(401);
 }finally{if(previous.key===undefined)delete process.env.MANDALA_ACCOUNT_WORKER_KEY;else process.env.MANDALA_ACCOUNT_WORKER_KEY=previous.key;if(previous.file===undefined)delete process.env.MANDALA_ACCOUNT_LEASE_FILE;else process.env.MANDALA_ACCOUNT_LEASE_FILE=previous.file;}
});
