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
