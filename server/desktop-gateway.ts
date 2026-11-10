import { createServer, request as httpRequest, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { writeFileSync, renameSync, existsSync, unlinkSync, mkdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve, sep, extname } from 'node:path';
import { readJsonBody } from './http-body';
import { validateControlUrl } from './computer-connector';
import { systemComputerName } from './computer-name';
import { openDesktopAccounts, desktopPartition, validateDesktopLease, type DesktopLease } from './desktop-accounts';

export type AccountWorkspace={origin:string;cookie:string;csrfToken:string;key:string;close:()=>Promise<void>;exited?:Promise<void>};
export function createDesktopGateway(options:{root:string;setupToken:string;controlOrigin:string;dist?:string;startWorkspace:(home:string,lease:DesktopLease)=>Promise<AccountWorkspace>;fetch?:typeof fetch}){
 const cloudOrigin=validateControlUrl(options.controlOrigin), accounts=openDesktopAccounts(options.root,cloudOrigin), request=options.fetch??fetch;
 const computerName=systemComputerName();
 const equal=(a:unknown,b:string)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
 const cookies=(value:string)=>Object.fromEntries(value.split(';').map(c=>c.trim().split('=')).filter(c=>c.length===2));
 const json=(res:ServerResponse,status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
 let worker:AccountWorkspace|undefined,starting:Promise<AccountWorkspace>|undefined,changing=false,linking=false,stopped=false,epoch=0;
 const cleanupQueue:AccountWorkspace[]=[];let cleanup:Promise<void>|undefined;
 let pending:{deviceCode:string;verificationUri:string;expires:number;grant?:Omit<DesktopLease,'localToken'>}|undefined;
 const streams=new Set<ServerResponse>();
 const cloud=async(path:string,data?:unknown,lease?:DesktopLease)=>request(cloudOrigin+path,{method:data===undefined?'GET':'POST',headers:{Origin:cloudOrigin,'Content-Type':'application/json',...(lease?{Cookie:`mandala_session=${lease.token}`,'X-CSRF-Token':lease.csrfToken}:{})},...(data===undefined?{}:{body:JSON.stringify(data)}),redirect:'error',signal:AbortSignal.timeout(10000)});
 const drainCleanup=()=>{
  if(cleanup)return cleanup;
  const operation=(async()=>{while(cleanupQueue.length){await cleanupQueue[0].close();cleanupQueue.shift();}})();
  cleanup=operation;
  void operation.finally(()=>{if(cleanup===operation)cleanup=undefined;}).catch(()=>{});
  return operation;
 };
 const dispose=(value:AccountWorkspace)=>{cleanupQueue.push(value);return drainCleanup();};
 const launch=(home:string,lease:DesktopLease,valid:()=>boolean)=>{
  const generation=epoch;
  const operation=(async()=>{
   await drainCleanup();
   if(stopped||generation!==epoch||!valid())throw Error('Workspace start cancelled');
   const value=await options.startWorkspace(home,lease);
   if(stopped||generation!==epoch||!valid()){await dispose(value);throw Error('Workspace start cancelled');}
   worker=value;
   void value.exited?.then(()=>{
    if(worker!==value)return;
    worker=undefined;
    for(const response of streams)response.destroy();streams.clear();
    void dispose(value).catch(()=>{});
   });
   return value;
  })();
  starting=operation;
  void operation.finally(()=>{if(starting===operation)starting=undefined;}).catch(()=>{});
  return operation;
 };
 const start=()=>{
  if(stopped||changing)return Promise.reject(Error('Workspace unavailable'));
  if(worker)return Promise.resolve(worker);
  const lease=accounts.current();if(!lease)return Promise.reject(Error('Sign in required'));
  return starting??launch(accounts.home(lease.user.id),lease,()=>!changing&&accounts.current()?.localToken===lease.localToken);
 };
 const closeWorker=async()=>{
  epoch++;for(const response of streams)response.destroy();streams.clear();
  const previous=worker;worker=undefined;
  if(previous)void dispose(previous).catch(()=>{});
  await starting?.catch(()=>undefined);await drainCleanup();
 };
 const expire=async()=>{if(changing)return;changing=true;try{const current=accounts.current();if(current){const file=join(accounts.home(current.user.id),'.account-session');if(existsSync(file))unlinkSync(file);}accounts.logout();await closeWorker();}finally{changing=false;}};
 const timer=setInterval(()=>{if(!accounts.current()&&(worker||starting))void expire().catch(()=>{});},1000);timer.unref();
 const server=createServer(async(req,res)=>{
  try{
   const host=req.headers.host??'';if(!/^127\.0\.0\.1:\d+$/.test(host))return json(res,403,{error:'Invalid host'});
   const origin='http://'+host,url=new URL(req.url??'/',origin),path=url.pathname;
   if(req.headers.origin&&req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site')return json(res,403,{error:'Foreign origin'});
   const c=cookies(req.headers.cookie??''),lease=accounts.current();
   const native=!req.headers.origin&&equal(req.headers['x-mandala-launcher'],options.setupToken);
   const setup=equal(c.mandala_setup,options.setupToken);
   const signed=lease&&equal(c.mandala_desktop,lease.localToken)?lease:undefined;
   const stillSigned=()=>signed&&!changing&&accounts.current()?.localToken===signed.localToken;
   const body=()=>readJsonBody(req,{maxBytes:8192,contentTypeError:'JSON required',sizeError:'Request too large'});
   if(path==='/auth/desktop/bootstrap'&&req.method==='GET'){
    if(!native)return json(res,403,{error:'Desktop launcher required'});
    return json(res,200,lease?{partition:desktopPartition(lease.user.id),home:accounts.home(lease.user.id),token:lease.localToken}:{partition:'signin',home:join(options.root,'account-gateway')});
   }
   if(path==='/auth/session'&&req.method==='GET'){
    if(changing)return json(res,409,{error:'Account transition in progress'});
    if(!signed)return json(res,200,{mode:'desktop',user:null,partition:'signin',setupAvailable:setup});
    let connection=null;try{const w=await start();const r=await request(w.origin+'/auth/session',{headers:{Cookie:w.cookie,'X-Mandala-Gateway-Key':w.key},signal:AbortSignal.timeout(5000)});connection=(await r.json()).connection;}catch{return json(res,503,{error:'Account workspace could not start. Existing work may still be running; stop it before claiming its data.'});}
    if(!stillSigned())return json(res,401,{error:'Sign in required'});
    return json(res,200,{mode:'desktop',user:signed.user,partition:desktopPartition(signed.user.id),csrfToken:signed.csrfToken,expiresAt:signed.expiresAt,computerName,connection});
   }
   if(path.startsWith('/auth/desktop/')&&req.method==='POST'){
    if(!setup||req.headers.origin!==origin)return json(res,403,{error:'Open the desktop app to sign in'});
    if(changing||!lease&&worker)return json(res,409,{error:'Account transition in progress; finish stopping the previous workspace first'});
    if(lease)return json(res,409,{error:'Sign out before changing accounts'});
    changing=true;
    try {
    if(path==='/auth/desktop/start'){
     const r=await cloud('/auth/desktop/start',{name:computerName});if(!r.ok)return json(res,503,{error:'Account service unavailable; retry later'});
     const data=await r.json();if(typeof data.deviceCode!=='string'||!data.verificationUri?.startsWith(cloudOrigin+'/?device='))throw Error('Invalid service reply');
     pending={deviceCode:data.deviceCode,verificationUri:data.verificationUri,expires:Date.now()+600000};return json(res,200,{verificationUri:data.verificationUri});
    }
    if(path==='/auth/desktop/poll'){
     if(!pending||pending.expires<=Date.now())return json(res,410,{error:'Sign-in expired; start again'});
     if(!pending.grant){const r=await cloud('/auth/desktop/poll',{deviceCode:pending.deviceCode});if(r.status===202||r.status===429)return json(res,202,{pending:true});if(!r.ok)return json(res,401,{error:'Sign-in expired; start again'});const grant=await r.json();validateDesktopLease(grant);pending.grant=grant;}
     return json(res,200,{user:pending.grant!.user,legacyAvailable:accounts.legacyAvailable()});
    }
    if(path==='/auth/desktop/activate'){
     if(!pending?.grant||pending.expires<=Date.now()||lease)return json(res,409,{error:'Complete sign-in first'});
     const b=await body();if(typeof b.claimLegacy!=='boolean')return json(res,422,{error:'Confirm local data ownership'});
     try{const grant=pending.grant;validateDesktopLease(grant);await launch(accounts.plannedHome(grant.user.id,b.claimLegacy),{...grant,localToken:''},()=>changing&&!stopped);if(stopped)throw Error('Gateway stopped');accounts.activate(grant,b.claimLegacy);pending=undefined;json(res,200,{restart:true});}catch{await expireAfterFailure();json(res,409,{error:'Could not open this workspace. Stop its existing runtime before claiming old data, or use a new workspace.'});}
     return;
    }
    return json(res,404,{error:'Not found'});
    } finally {changing=false;}
   }
   if(path.startsWith('/auth/')||path.startsWith('/api/')){
    if(!signed||changing)return json(res,401,{error:'Sign in required'});
    const mutation=!['GET','HEAD'].includes(req.method??'GET');
    if(mutation&&(req.headers.origin!==origin||path.startsWith('/auth/')&&!equal(req.headers['x-csrf-token'],signed.csrfToken)))return json(res,403,{error:'Request verification required'});
    if(path==='/auth/logout'&&req.method==='POST'){
     pending=undefined;await expire();void cloud('/auth/logout',{},signed).catch(()=>{});
     res.setHeader('Set-Cookie','mandala_desktop=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return json(res,200,{restart:true});
    }
    if (path === '/auth/avatar' && (req.method === 'GET' || req.method === 'POST')) {
     const profile = accounts.home(signed.user.id), file = join(profile, 'account-avatar.jpg');
     const maximumBytes = 48 * 1024;
     if (req.method === 'GET') {
      const info = statSync(file, {throwIfNoEntry:false});
      const avatar = info?.isFile() && info.size <= maximumBytes
        ? 'data:image/jpeg;base64,' + readFileSync(file).toString('base64')
        : null;
      return json(res, 200, {avatar});
     }
     const {avatar} = await readJsonBody(req, {maxBytes:66*1024, contentTypeError:'JSON required', sizeError:'Avatar too large'});
     if (!stillSigned()) return json(res, 401, {error:'Sign in required'});
     if (avatar === null) {
      if (existsSync(file)) unlinkSync(file);
     } else {
      if (typeof avatar !== 'string' || avatar.length > 66*1024 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(avatar)) return json(res, 422, {error:'Invalid avatar'});
      const bytes = Buffer.from(avatar.slice('data:image/jpeg;base64,'.length), 'base64');
      if (bytes.length < 5 || bytes.length > maximumBytes || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) return json(res, 422, {error:'Invalid avatar'});
      mkdirSync(profile, {recursive:true, mode:0o700});
      writeFileSync(file+'.tmp', bytes, {mode:0o600});
      renameSync(file+'.tmp',file);
     }
     return json(res, 200, {ok:true});
    }
    if(path==='/auth/connect'&&req.method==='POST'){
     if(linking)return json(res,409,{error:'Computer connection in progress'});
     linking=true;try {
     const w=await start(),current=await request(w.origin+'/auth/session',{headers:{Cookie:w.cookie,'X-Mandala-Gateway-Key':w.key}}).then(r=>r.json());
     if(!stillSigned())return json(res,401,{error:'Sign in required'});
     if(current.connection)return json(res,409,{error:'This account is already connected'});
     const b=await body();if(!stillSigned())return json(res,401,{error:'Sign in required'});
     const r=await cloud('/connect/enroll',{name:typeof b.name==='string'?b.name:computerName},signed);
     if(!r.ok)return json(res,r.status,{error:'Connect online and sign in again to link this computer'});
     const enrollment=await r.json();
     if(!stillSigned()){
      void request(cloudOrigin+'/connector/disconnect',{method:'POST',headers:{Authorization:`Bearer ${enrollment.credential}`},signal:AbortSignal.timeout(10000)}).catch(()=>{});
      return json(res,401,{error:'Sign in required'});
     }
     const file=join(accounts.home(signed.user.id),'computer-connection.json');
     writeFileSync(file+'.tmp',JSON.stringify({controlUrl:cloudOrigin,...enrollment}),{mode:0o600});renameSync(file+'.tmp',file);return json(res,200,{ok:true});
     }finally{linking=false;}
    }
    if(path.startsWith('/auth/')&&!['/auth/access','/auth/disconnect','/auth/connection/name'].includes(path))return json(res,404,{error:'Not found'});
    const w=await start();if(!stillSigned())return json(res,401,{error:'Sign in required'});
    const headers: import('node:http').OutgoingHttpHeaders={...req.headers,host:new URL(w.origin).host,origin:w.origin,cookie:w.cookie,'x-csrf-token':w.csrfToken,'x-mandala-gateway-key':w.key};
    for(const name of ['x-mandala-local-key','x-openmana-local-key','x-mandala-bridge-key','x-openmana-bridge-key','x-mandala-owner-id','x-mandala-client-id','authorization'])delete headers[name];
    const upstream=httpRequest(w.origin+(req.url??'/'),{method:req.method,headers},reply=>{const h={...reply.headers};delete h['set-cookie'];res.writeHead(reply.statusCode??502,h);reply.pipe(res);});
    streams.add(res);res.on('close',()=>{streams.delete(res);upstream.destroy();});upstream.on('error',()=>{if(!res.headersSent)json(res,502,{error:'Workspace unavailable'});else res.destroy();});req.pipe(upstream);return;
   }
   if(options.dist&&['GET','HEAD'].includes(req.method??'GET')){
    const root=resolve(options.dist),file=resolve(root,'.'+decodeURIComponent(path));if(file!==root&&!file.startsWith(root+sep))return json(res,403,{error:'Invalid path'});
    let target=file;try{if(!(await stat(file)).isFile())target=join(root,'index.html');}catch{target=join(root,'index.html');}
    const types:Record<string,string>={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.ico':'image/x-icon'};
    res.writeHead(200,{'Content-Type':types[extname(target)]??'application/octet-stream','Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:await readFile(target));return;
   }
   json(res,404,{error:'Not found'});
  }catch{if(!res.headersSent)json(res,503,{error:'Service unavailable; retry later'});else res.destroy();}
 });
 async function expireAfterFailure(){accounts.logout();await closeWorker();}
 server.on('close',()=>{stopped=true;clearInterval(timer);void closeWorker().catch(()=>{});});
 return {server,close:async()=>{stopped=true;clearInterval(timer);await closeWorker();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}};
}
