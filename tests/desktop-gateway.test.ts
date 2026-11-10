import { test,expect } from 'vitest';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDesktopGateway } from '../server/desktop-gateway';
import { openDesktopAccounts } from '../server/desktop-accounts';

test('gateway locks anonymous access and separates two accounts across logout and restart',async()=>{
 const root=mkdtempSync(join(tmpdir(),'mandala-gateway-')),setupToken=randomBytes(32).toString('base64url');let identity='alice',closed=0;
 let releaseEnrollment!:()=>void,enteredEnrollment!:()=>void,revoked=false;
 const enrollmentGate=new Promise<void>(r=>{releaseEnrollment=r;}),enrollmentStarted=new Promise<void>(r=>{enteredEnrollment=r;});
 const homes:string[]=[];
 const gateway=createDesktopGateway({root,setupToken,controlOrigin:'http://127.0.0.1:9999',fetch:async(input)=>{
  const path=new URL(String(input)).pathname;
  if(path==='/connect/enroll'){enteredEnrollment();await enrollmentGate;return Response.json({device:{id:'late-device'},credential:'late-credential'});}
  if(path==='/connector/disconnect'){revoked=true;return Response.json({ok:true});}
  if(path==='/auth/desktop/start')return Response.json({deviceCode:'private-request',verificationUri:'http://127.0.0.1:9999/?device=ABC'});
  if(path==='/auth/desktop/poll')return Response.json({user:{id:identity,username:identity,createdAt:new Date().toISOString()},token:'cloud-'+identity,csrfToken:'csrf-'+identity,expiresAt:Date.now()+60000});
  return Response.json({ok:true});
 },async startWorkspace(home,lease){
  homes.push(home);mkdirSync(home,{recursive:true});const file=join(home,'task.json');
  if(!existsSync(file))writeFileSync(file,JSON.stringify({owner:lease.user.id,task:lease.user.id+' private task'}));
  const server=createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(req.url==='/auth/session'?JSON.stringify({connection:null}):readFileSync(file));});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  return {origin:`http://127.0.0.1:${(server.address() as any).port}`,cookie:'internal',csrfToken:'internal-csrf',key:'secret',async close(){closed++;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}};
 }});
 await new Promise<void>(r=>gateway.server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(gateway.server.address() as any).port}`;
 const post=(path:string,data:any={},cookie=`mandala_setup=${setupToken}`,csrf='')=>fetch(origin+path,{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(data)});
 const bootstrap=()=>fetch(origin+'/auth/desktop/bootstrap',{headers:{'X-Mandala-Launcher':setupToken}}).then(r=>r.json());
 const signIn=async()=>{expect((await post('/auth/desktop/start')).status).toBe(200);expect((await post('/auth/desktop/poll')).status).toBe(200);expect((await post('/auth/desktop/activate',{claimLegacy:false})).status).toBe(200);return bootstrap();};
 try{
  expect((await fetch(origin+'/api/tasks')).status).toBe(401);
  expect((await fetch(origin+'/auth/avatar')).status).toBe(401);
  expect((await fetch(origin+'/auth/desktop/bootstrap')).status).toBe(403);
  const a=await signIn(),cookieA=`mandala_desktop=${a.token}`;
  const avatar='data:image/jpeg;base64,/9j/4AAEAAH/2Q==';
  const getAvatar=(cookie:string)=>fetch(origin+'/auth/avatar',{headers:{Cookie:cookie}}).then(r=>r.json());
  expect((await post('/auth/avatar',{avatar},cookieA,'wrong')).status).toBe(403);
  expect((await post('/auth/avatar',{avatar:'data:image/svg+xml,invalid'},cookieA,'csrf-alice')).status).toBe(422);
  expect((await post('/auth/avatar',{avatar},cookieA,'csrf-alice')).status).toBe(200);
  expect(await getAvatar(cookieA)).toEqual({avatar});
  expect((await fetch(origin+'/api/tasks',{headers:{Cookie:cookieA}}).then(r=>r.json())).task).toBe('alice private task');
  expect((await post('/auth/logout',{},cookieA,'wrong')).status).toBe(403);
  expect((await post('/auth/logout',{},cookieA,'csrf-alice')).status).toBe(200);expect(closed).toBe(1);
  expect((await fetch(origin+'/api/tasks',{headers:{Cookie:cookieA}})).status).toBe(401);
  identity='bob';const b=await signIn();expect(b.partition).not.toBe(a.partition);expect(b.home).not.toBe(a.home);
  expect(await getAvatar(`mandala_desktop=${b.token}`)).toEqual({avatar:null});
  expect(existsSync(join(a.home,'account-avatar.jpg'))).toBe(true);
  expect((await fetch(origin+'/api/tasks',{headers:{Cookie:`mandala_desktop=${b.token}`}}).then(r=>r.json())).task).toBe('bob private task');
  expect((await fetch(origin+'/api/tasks',{headers:{Cookie:cookieA}})).status).toBe(401);
  expect(homes[0]).not.toBe(homes[1]);
  const persisted=openDesktopAccounts(root);expect(persisted.current()?.user.id).toBe('bob');
  const linking=post('/auth/connect',{name:'Bob laptop'},`mandala_desktop=${b.token}`,'csrf-bob');
  await enrollmentStarted;
  expect((await post('/auth/logout',{},`mandala_desktop=${b.token}`,'csrf-bobob')).status).toBe(403);
  expect((await post('/auth/logout',{},`mandala_desktop=${b.token}`,'csrf-bob')).status).toBe(200);
  releaseEnrollment();expect((await linking).status).toBe(401);
  expect(existsSync(join(b.home,'computer-connection.json'))).toBe(false);expect(revoked).toBe(true);
  identity='alice';const returned=await signIn(),returnCookie=`mandala_desktop=${returned.token}`;
  expect(await getAvatar(returnCookie)).toEqual({avatar});
  expect((await post('/auth/avatar',{avatar:null},returnCookie,'csrf-alice')).status).toBe(200);
  expect(await getAvatar(returnCookie)).toEqual({avatar:null});
 }finally{await gateway.close();rmSync(root,{recursive:true,force:true});}
});

test('recovers a terminated workspace once for concurrent authenticated requests',async()=>{
 const {spawn}=await import('node:child_process');
 const root=mkdtempSync(join(tmpdir(),'mandala-recovery-')),setupToken=randomBytes(32).toString('base64url');
 const children:import('node:child_process').ChildProcess[]=[];const homes:string[]=[];
 let fail=false,failClose=false,gate:Promise<void>|undefined,entered:(()=>void)|undefined;
 const gateway=createDesktopGateway({root,setupToken,controlOrigin:'http://127.0.0.1:9999',fetch:async(input)=>{
  const path=new URL(String(input)).pathname;
  if(path==='/auth/desktop/start')return Response.json({deviceCode:'code',verificationUri:'http://127.0.0.1:9999/?device=ABC'});
  if(path==='/auth/desktop/poll')return Response.json({user:{id:'alice',username:'alice',createdAt:new Date().toISOString()},token:'cloud',csrfToken:'csrf',expiresAt:Date.now()+60000});
  return Response.json({ok:true});
 },async startWorkspace(home){
  homes.push(home);if(fail){fail=false;throw Error('startup failed');}if(gate){entered?.();await gate;}mkdirSync(home,{recursive:true});const file=join(home,'saved.json');if(!existsSync(file))writeFileSync(file,JSON.stringify({task:'saved'}));
  const child=spawn(process.execPath,['-e',`const http=require('http'),fs=require('fs');const s=http.createServer((req,res)=>res.end(fs.readFileSync(process.argv[1])));s.listen(0,'127.0.0.1',()=>console.log(s.address().port));`,file],{stdio:['ignore','pipe','inherit']});children.push(child);
  const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
  const port=await new Promise<string>((resolve,reject)=>{child.stdout!.once('data',data=>resolve(String(data).trim()));child.once('error',reject);});
  return {origin:`http://127.0.0.1:${port}`,cookie:'internal',csrfToken:'internal',key:'secret',exited,async close(){if(failClose){failClose=false;throw Error('cleanup failed');}if(child.exitCode===null&&child.signalCode===null)child.kill();await exited;}};
 }});
 await new Promise<void>(r=>gateway.server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(gateway.server.address() as any).port}`;
 const post=(path:string,data:unknown={})=>fetch(origin+path,{method:'POST',headers:{Origin:origin,Cookie:`mandala_setup=${setupToken}`,'Content-Type':'application/json'},body:JSON.stringify(data)});
 try{
  await post('/auth/desktop/start');await post('/auth/desktop/poll');expect((await post('/auth/desktop/activate',{claimLegacy:false})).status).toBe(200);
  const bootstrap=await fetch(origin+'/auth/desktop/bootstrap',{headers:{'X-Mandala-Launcher':setupToken}}).then(r=>r.json());const cookie=`mandala_desktop=${bootstrap.token}`;
  const get=()=>fetch(origin+'/api/conversation-progress?windowMinutes=360',{headers:{Cookie:cookie}});
  expect(await (await get()).json()).toEqual({task:'saved'});
  const exited=new Promise<void>(r=>children[0].once('exit',()=>r()));children[0].kill('SIGKILL');await exited;
  const replies=await Promise.all(Array.from({length:5},get));expect(replies.map(r=>r.status)).toEqual([200,200,200,200,200]);
  expect(await Promise.all(replies.map(r=>r.json()))).toEqual(Array(5).fill({task:'saved'}));expect(homes).toEqual([bootstrap.home,bootstrap.home]);
  const terminate=async()=>{const child=children.at(-1)!;const done=new Promise<void>(r=>child.once('exit',()=>r()));child.kill('SIGKILL');await done;};
  failClose=true;await terminate();expect((await get()).status).toBe(200);
  await terminate();fail=true;expect((await get()).status).toBe(503);expect((await get()).status).toBe(200);
  await terminate();let release!:()=>void,notify!:()=>void;gate=new Promise<void>(r=>{release=r;});const started=new Promise<void>(r=>{notify=r;});entered=notify;
  const recovering=get();await started;
  const logout=fetch(origin+'/auth/logout',{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':'csrf'},body:'{}'});
  while(openDesktopAccounts(root).current())await new Promise(r=>setTimeout(r,5));
  release();expect((await logout).status).toBe(200);expect((await recovering).status).not.toBe(200);expect((await get()).status).toBe(401);
  expect(children.at(-1)!.exitCode!==null||children.at(-1)!.signalCode!==null).toBe(true);
  gate=undefined;await post('/auth/desktop/start');await post('/auth/desktop/poll');expect((await post('/auth/desktop/activate',{claimLegacy:false})).status).toBe(200);
  const second=await fetch(origin+'/auth/desktop/bootstrap',{headers:{'X-Mandala-Launcher':setupToken}}).then(r=>r.json());
  await terminate();gate=new Promise<void>(r=>{release=r;});const startedAgain=new Promise<void>(r=>{notify=r;});entered=notify;
  const duringStop=fetch(origin+'/api/tasks',{headers:{Cookie:`mandala_desktop=${second.token}`}}).catch(()=>undefined);await startedAgain;
  const stopping=gateway.close();release();await stopping;expect((await duringStop)?.status).not.toBe(200);
  expect(children.at(-1)!.exitCode!==null||children.at(-1)!.signalCode!==null).toBe(true);
 }finally{await gateway.close();for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill();rmSync(root,{recursive:true,force:true});}
});

test('production account workspace reports real child exit and restores persisted data',async()=>{
 const {startAccountWorkspace}=await import('../server/account-desktop-workspace');
 const {pathToFileURL}=await import('node:url');
 const root=mkdtempSync(join(tmpdir(),'mandala-real-recovery-')),runtime=mkdtempSync(join(process.cwd(),'.recovery-runtime-'));
 const serverDir=join(runtime,'server');mkdirSync(serverDir);const entry=join(serverDir,'main.mjs');
 writeFileSync(entry,`import ${JSON.stringify(pathToFileURL(join(process.cwd(),'server/main.ts')).href)};`);
 const previousOptions=process.env.NODE_OPTIONS;process.env.NODE_OPTIONS=[previousOptions,'--import tsx'].filter(Boolean).join(' ');
 const setupToken=randomBytes(32).toString('base64url');let starts=0,latestExit:Promise<void>|undefined;
 const gateway=createDesktopGateway({root,setupToken,controlOrigin:'http://127.0.0.1:9999',fetch:async(input)=>{
  const path=new URL(String(input)).pathname;
  if(path==='/auth/desktop/start')return Response.json({deviceCode:'code',verificationUri:'http://127.0.0.1:9999/?device=ABC'});
  if(path==='/auth/desktop/poll')return Response.json({user:{id:'alice',username:'alice',createdAt:new Date().toISOString()},token:'cloud',csrfToken:'csrf',expiresAt:Date.now()+60000});
  return Response.json({ok:true});
 },async startWorkspace(home,lease){starts++;const workspace=await startAccountWorkspace(home,lease,entry);latestExit=workspace.exited;return workspace;}});
 await new Promise<void>(r=>gateway.server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(gateway.server.address() as any).port}`;
 const post=(path:string,data:unknown={})=>fetch(origin+path,{method:'POST',headers:{Origin:origin,Cookie:`mandala_setup=${setupToken}`,'Content-Type':'application/json'},body:JSON.stringify(data)});
 try{
  await post('/auth/desktop/start');await post('/auth/desktop/poll');expect((await post('/auth/desktop/activate',{claimLegacy:false})).status).toBe(200);
  const bootstrap=await fetch(origin+'/auth/desktop/bootstrap',{headers:{'X-Mandala-Launcher':setupToken}}).then(r=>r.json());const headers={Cookie:`mandala_desktop=${bootstrap.token}`,Origin:origin,'Content-Type':'application/json'};
  const config=await fetch(origin+'/api/config',{headers}).then(r=>r.json());
  const saved=await fetch(origin+'/api/config',{method:'PUT',headers,body:JSON.stringify({revision:config.revision,config:{...config.config,agents:[...config.config.agents,{id:'recovery-test',name:'Recovery test',defaultCli:'codex',models:{},instructions:'isolated data',mcp:[],skills:[]}]}})});expect(saved.status).toBe(200);
  const before=await fetch(origin+'/api/conversation-progress?windowMinutes=360',{headers});expect(before.status).toBe(200);await before.json();
  const oldSession=JSON.parse(readFileSync(join(bootstrap.home,'accounts.json'),'utf8')).sessions[0].tokenHash;
  const oldKey=JSON.parse(readFileSync(join(bootstrap.home,'.account-session'),'utf8')).key;
  const pid=JSON.parse(readFileSync(join(bootstrap.home,'.service-home-lock'),'utf8')).pid;const exit=latestExit!;process.kill(pid,'SIGKILL');await exit;
  const responses=await Promise.all(Array.from({length:5},()=>fetch(origin+'/api/conversation-progress?windowMinutes=360',{headers})));expect(responses.map(r=>r.status)).toEqual([200,200,200,200,200]);expect(starts).toBe(2);
  const sessions=JSON.parse(readFileSync(join(bootstrap.home,'accounts.json'),'utf8')).sessions;expect(sessions).toHaveLength(1);expect(sessions[0].tokenHash).not.toBe(oldSession);
  expect(JSON.parse(readFileSync(join(bootstrap.home,'.account-session'),'utf8')).key).not.toBe(oldKey);
  const restored=await fetch(origin+'/api/config',{headers}).then(r=>r.json());expect(restored.config.agents.some((agent:any)=>agent.id==='recovery-test')).toBe(true);
 }finally{await gateway.close();if(previousOptions===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=previousOptions;rmSync(root,{recursive:true,force:true});rmSync(runtime,{recursive:true,force:true});}
},30000);
