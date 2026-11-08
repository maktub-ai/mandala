import { productEnv } from '../cli/product-env.mjs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { openAccountStore } from './account-store';
import { bindWorkspaceOwner } from './workspace-identity';
import { createComputerConnector, revokeComputer } from './computer-connector';
import { systemComputerName } from './computer-name';
import type { Store } from './store';
import { newRemoteKey, remotePublicKey, remoteKeyFingerprint, type RemoteKey } from '../shared/remote-crypto';
import { DomainError } from '../shared/workspace-contracts';
// Legacy services refresh only the old cookie, so its value stays canonical.
const cookieNames=['openmana_local_session','mandala_local_session'];
const sessionTokens=(req:IncomingMessage)=>cookieNames.map(name=>req.headers.cookie?.split(';').map(p=>p.trim()).find(p=>p.startsWith(name+'='))?.slice(name.length+1)).filter((token):token is string=>token!==undefined);
const sessionCookies=(token:string,maxAge:number)=>cookieNames.map(name=>`${name}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`);
const json=(res:ServerResponse,status:number,data:unknown)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
const equal=(left:unknown,right:string)=>typeof left==='string'&&Buffer.byteLength(left)===Buffer.byteLength(right)&&timingSafeEqual(Buffer.from(left),Buffer.from(right));
function credential(home:string,name:string){const path=join(home,name);if(!existsSync(path))writeFileSync(path,randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});return readFileSync(path,'utf8').trim();}
function controlOrigin(value:unknown){if(typeof value!=='string')throw new DomainError('invalid_control_url',400,'Invalid connection service URL');const url=new URL(value);if(url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)))throw new DomainError('invalid_control_url',400,'Use HTTPS for the connection service');return url.origin;}
type Enrollment={controlUrl:string;device:{id:string;name:string;ownerId:string};credential:string};
export function createLocalAccess(home:string,store:Store,options:{setupToken?:string}={}){
 let creating=false, renaming=false;
 const computerName=systemComputerName();
 const setupContext=(req:IncomingMessage)=>Boolean(options.setupToken)&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress??'')&&!req.headers['x-openmana-bridge-key']&&!req.headers['x-mandala-bridge-key']&&equal(req.headers.cookie?.split(';').map(p=>p.trim()).find(p=>p.startsWith('mandala_setup='))?.slice(14),options.setupToken!);
 const setupAvailable=(req:IncomingMessage)=>setupContext(req)&&accounts.listUsers().length===0&&store.ownerUserId==='local';
 const accounts=openAccountStore(home),key=credential(home,'local-access.key'),bridgeKey=credential(home,'bridge.key');
 const remotePath=join(home,'remote-access.json');
 const remote: {identity:RemoteKey;grants:Record<string,string>} = existsSync(remotePath)?JSON.parse(readFileSync(remotePath,'utf8')):{identity:newRemoteKey(),grants:{}};
 const saveRemote=()=>{writeFileSync(remotePath+'.tmp',JSON.stringify(remote),{mode:0o600});renameSync(remotePath+'.tmp',remotePath);};
 if(!existsSync(remotePath))saveRemote();
 const candidates=new Map<string,string>();
 const first=accounts.listUsers()[0];if(first)bindWorkspaceOwner(store,first.id);
 const path=join(home,'computer-connection.json');let enrollment:Enrollment|undefined,connector:ReturnType<typeof createComputerConnector>|undefined;
 const pendingPath=join(home,'computer-revocations.json');
 let pending:Enrollment[]=existsSync(pendingPath)?JSON.parse(readFileSync(pendingPath,'utf8')):[];
 const savePending=()=>{if(pending.length){writeFileSync(pendingPath+'.tmp',JSON.stringify(pending),{mode:0o600});renameSync(pendingPath+'.tmp',pendingPath);}else if(existsSync(pendingPath))unlinkSync(pendingPath);};
 let retry:Promise<void>|undefined,retried=false;
 const retryRevocations=()=>retry??=(async()=>{const snapshot=[...pending];await Promise.all(snapshot.map(async item=>{if(!(await revokeComputer(item.controlUrl,item.credential)).revocationPending){pending=pending.filter(value=>value.credential!==item.credential);savePending();}}));})().finally(()=>{retry=undefined;});
 const start=(localUrl:string)=>{if(!retried){retried=true;if(pending.length)void retryRevocations();}if(!enrollment&&existsSync(path))enrollment=JSON.parse(readFileSync(path,'utf8'));if(enrollment&&!connector)connector=createComputerConnector({controlUrl:controlOrigin(enrollment.controlUrl),credential:enrollment.credential,localUrl,bridgeKey});};
 const gatewayKey=process.env.MANDALA_ACCOUNT_WORKER_KEY;
 const leaseValid=()=>{if(!gatewayKey)return true;try{const lease=JSON.parse(readFileSync(process.env.MANDALA_ACCOUNT_LEASE_FILE!,'utf8'));return equal(lease.key,gatewayKey)&&Date.now()<lease.expiresAt;}catch{return false;}};
 const readSession=(req:IncomingMessage)=>{if(!leaseValid()||gatewayKey&&!equal(req.headers['x-mandala-gateway-key'],gatewayKey))return null;const token=sessionTokens(req)[0];return token?accounts.session(token):null;};
 const authenticated=(req:IncomingMessage)=>{const session=readSession(req);return session&&session.user.id===store.ownerUserId?session:null;};
 const csrf=(req:IncomingMessage)=>{const session=authenticated(req);if(!session)throw new DomainError('unauthorized',401,'Sign in required');if(!equal(req.headers['x-csrf-token'],session.csrfToken))throw new DomainError('forbidden',403,'Request verification required');return session;};
 const attempts=new Map<string,{count:number;until:number}>();
 const remotePeer=(req:IncomingMessage)=>{
  const client=req.headers['x-mandala-client-id'];
  if(!enrollment||typeof client!=='string'||!equal(req.headers['x-mandala-bridge-key'],bridgeKey)||!equal(req.headers['x-mandala-owner-id'],enrollment.device.ownerId))return undefined;
  return Object.hasOwn(remote.grants,client)?remote.grants[client]:undefined;
 };
 const authorize=(req:IncomingMessage)=>{
   if(!leaseValid())return false;
   // Native invocation tokens retain their existing narrow per-run authority.
   if(req.url==='/api/cli/invoke'&&req.headers.authorization?.startsWith('Bearer '))return true;
   if(req.url==='/api/remote/transport'&&req.method==='POST'&&remotePeer(req))return true;
   if(store.ownerUserId!=='local'&&equal((req.headers['x-mandala-local-key']??req.headers['x-openmana-local-key']),key))return true;
   return Boolean(authenticated(req));
 };
 const active=new Map<ServerResponse,IncomingMessage>();
 const check=()=>{for(const [response,request]of active)if(!authorize(request)){active.delete(response);if(!response.headersSent)json(response,401,{error:'Sign in required'});else response.end();}};
 const timer=setInterval(check,500);timer.unref();
 return {
  start,
  requireLocalSession(req:IncomingMessage,mutation:boolean){
   if(mutation)csrf(req);else if(!authenticated(req))throw new DomainError('unauthorized',401,'Sign in required');
  },
  remoteIdentity:remote.identity,
  remotePeer,
  remoteLocalHeaders:()=>({'x-mandala-local-key':key}),
  track(req:IncomingMessage,res:ServerResponse){active.set(res,req);res.on('close',()=>active.delete(res));},
  close(){clearInterval(timer);for(const response of active.keys())response.end();active.clear();connector?.close();accounts.close();},
  async handle(req:IncomingMessage,res:ServerResponse,url:URL,body:()=>Promise<any>){
   const route=url.pathname;
   if(gatewayKey&&route.startsWith('/auth/')&&(!leaseValid()||!equal(req.headers['x-mandala-gateway-key'],gatewayKey))){json(res,401,{error:'Desktop account session required'});return true;}
   if(!route.startsWith('/auth/'))return false;
   const session=authenticated(req);
   if(route==='/auth/session'&&req.method==='GET'){json(res,200,{mode:'local',preview:productEnv('ACCEPTANCE_PREVIEW')==='1'||undefined,user:session?.user??null,csrfToken:session?.csrfToken,computerName:session?computerName:undefined,provisioned:accounts.listUsers().length>0,revocationPending:session?pending.length>0:undefined,setup:setupAvailable(req)?{available:true,token:options.setupToken}:{available:false},connection:session&&enrollment?{device:enrollment.device,controlUrl:enrollment.controlUrl,status:connector?.status(),pairingCode:remote.identity.publicKey}:null});return true;}
   if(route==='/auth/setup'&&req.method==='POST'){
    if(!setupContext(req)||req.headers.origin!==url.origin||!equal(req.headers['x-setup-token'],options.setupToken!))throw new DomainError('forbidden',403,'First-use verification required');
    if(creating||accounts.listUsers().length||store.ownerUserId!=='local')throw new DomainError('already_provisioned',409,'Workspace already has an owner');
    creating=true;
    try{
     const b=await body();
     if(typeof b?.username!=='string'||!/^[a-zA-Z0-9_.@-]{1,128}$/.test(b.username)||typeof b.password!=='string'||b.password.length<12||b.password.length>1024)throw new DomainError('invalid_account',422,'Use a valid account name and a password of 12–1024 characters');
     const user=await accounts.createUser(b.username,b.password);bindWorkspaceOwner(store,user.id);const created=accounts.createSession(user.id);
     res.setHeader('Set-Cookie',[...sessionCookies(created.token,604800),'mandala_setup=; HttpOnly; SameSite=Strict; Path=/auth; Max-Age=0']);json(res,201,{user,csrfToken:created.csrfToken});return true;
    }finally{creating=false;}
   }
   if(route==='/auth/login'&&req.method==='POST'){
    const ip=req.socket.remoteAddress??'local',now=Date.now();for(const [id,value]of attempts)if(value.until<=now)attempts.delete(id);const rate=attempts.get(ip)??{count:0,until:now+60000};if(++rate.count>10)throw new DomainError('rate_limit',429,'Try again later');attempts.set(ip,rate);
    const b=await body();const user=await accounts.authenticate(b.username,b.password);if(!user)throw new DomainError('unauthorized',401,'Invalid account or password');
    const owner=accounts.listUsers()[0];if(owner?.id!==user.id)throw new DomainError('forbidden',403,'This personal workspace belongs to another account');
    bindWorkspaceOwner(store,user.id);const created=accounts.createSession(user.id);res.setHeader('Set-Cookie',sessionCookies(created.token,604800));json(res,200,{user,csrfToken:created.csrfToken});return true;
   }
   if(route==='/auth/logout'&&req.method==='POST'){csrf(req);for(const token of sessionTokens(req))accounts.deleteSession(token);check();res.setHeader('Set-Cookie',sessionCookies('',0));json(res,200,{ok:true});return true;}
   if(route==='/auth/connect'&&req.method==='POST'){
    csrf(req);if(pending.length>=32)throw new DomainError('pending_revocations',409,'Retry pending connection revocations before enrolling again');const b=await body(),origin=controlOrigin(b.controlUrl);if(enrollment)throw new DomainError('already_connected',409,'Disconnect this computer before linking another account');
    const login=await fetch(origin+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({username:b.username,password:b.password}),signal:AbortSignal.timeout(10000)});
    if(!login.ok)throw new DomainError('connection_login_failed',401,'Connection service login failed');const data=await login.json() as {csrfToken:string};
    const cookie=login.headers.get('set-cookie')?.split(';')[0];if(!cookie)throw new Error('Connection service did not create session');
    try{
     const enrolled=await fetch(origin+'/connect/enroll',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,Cookie:cookie,'X-CSRF-Token':data.csrfToken},body:JSON.stringify({name:b.name}),signal:AbortSignal.timeout(10000)});if(!enrolled.ok)throw new Error('Computer enrollment failed');
     const result=await enrolled.json() as Omit<Enrollment,'controlUrl'>;enrollment={controlUrl:origin,...result};writeFileSync(path,JSON.stringify(enrollment),{mode:0o600});start(url.origin);
    }finally{await fetch(origin+'/auth/logout',{method:'POST',headers:{Origin:origin,Cookie:cookie,'X-CSRF-Token':data.csrfToken},signal:AbortSignal.timeout(5000)}).catch(()=>{});}
    json(res,200,{device:enrollment?.device});return true;
   }
   if(route==='/auth/connection/name'&&req.method==='POST'){
    csrf(req);
    if(renaming)throw new DomainError('rename_in_progress',409,'A computer rename is already in progress');
    const previous=enrollment, current=connector;
    if(!previous||!current)throw new DomainError('not_connected',409,'Computer is not connected');
    renaming=true;
    try{
     const data=await body();
     const name=typeof data?.name==='string'?data.name.trim():'';
     if(!name||name.length>128)throw new DomainError('invalid_computer_name',422,'Invalid computer name');
     csrf(req);
     if(enrollment!==previous)throw new DomainError('not_connected',409,'Computer is not connected');
     try{await current.rename(name);}catch{throw new DomainError('rename_failed',502,'Could not rename this computer');}
     if(enrollment!==previous)throw new DomainError('not_connected',409,'Computer is not connected');
     const updated={...previous,device:{...previous.device,name}};
     writeFileSync(path+'.tmp',JSON.stringify(updated),{mode:0o600});
     renameSync(path+'.tmp',path);
     enrollment=updated;
     json(res,200,{ok:true});return true;
    }finally{renaming=false;}
   }
   if(route==='/auth/disconnect'&&req.method==='POST'){csrf(req);const previous=connector;previous?.close();connector=undefined;remote.grants={};candidates.clear();saveRemote();if(enrollment&&!pending.some(item=>item.credential===enrollment!.credential)){pending.push(enrollment);savePending();}enrollment=undefined;if(existsSync(path))unlinkSync(path);check();await retryRevocations();json(res,200,{ok:true,revocationPending:pending.length>0});return true;}
   if(route==='/auth/access'&&req.method==='GET'){if(!session)throw new DomainError('unauthorized',401,'Sign in required');const grants=connector?await connector.listAccess():[];if(!Array.isArray(grants)||grants.length>1000||new Set(grants.map(grant=>grant.clientId)).size!==grants.length)throw new Error('Invalid grant list');candidates.clear();const visible=grants.map(grant=>{let publicKey:string|undefined;try{remotePublicKey(grant.publicKey!);if(/^[a-zA-Z0-9_-]{32,64}$/.test(grant.clientId)){publicKey=grant.publicKey;candidates.set(grant.clientId,publicKey!);}}catch{}return {...grant,publicKey,fingerprint:publicKey?remoteKeyFingerprint(publicKey):undefined,status:grant.status==='approved'&&remote.grants[grant.clientId]!==publicKey?'pending':grant.status};});json(res,200,{grants:visible});return true;}
   if(route==='/auth/access'&&req.method==='POST'){csrf(req);const b=await body();if(!connector)throw new DomainError('not_connected',409,'Computer is not connected');if(!['approved','denied','revoked'].includes(b.state)||typeof b.clientId!=='string')throw new DomainError('invalid_grant',400,'Invalid access decision');if(b.state==='approved'){const publicKey=candidates.get(b.clientId);if(!publicKey||b.publicKey!==undefined&&b.publicKey!==publicKey)throw new DomainError('invalid_grant',400,'Review browser key before approval');remote.grants[b.clientId]=publicKey;}else{delete remote.grants[b.clientId];}saveRemote();check();await connector.setAccess(b.clientId,b.state);json(res,200,{ok:true});return true;}
   json(res,404,{error:'Not found'});return true;
  },
  authorize

 };
}
