import {randomUUID} from 'node:crypto';
import {basename,dirname,join,resolve,posix} from 'node:path';
import {lstat,mkdir,readdir,writeFile,rename,unlink} from 'node:fs/promises';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import type {ExecutionMachine,McpServer,Skill,RuntimeConfig,Cli} from '../shared/types';
import {skillResources} from '../shared/skills';
import {runtimeCatalog,runtimeIds} from '../shared/runtimes';
import {SSH_FRAME_LIMIT,SSH_TRANSFER_LIMIT,SSH_PROTOCOL_VERSION,type SshFrame,type SshEvent,type SshProbe,type SshSkill} from '../shared/ssh-execution';
import type {CodexClient,CodexOptions} from './codex';
import type {OmpOptions} from './omp';
import type {BusinessCliRuntime} from './business-cli-runtime';
import {readBoundedFile,safeRelativePath,safeSshId} from './ssh-service';
import {installSshService,runSsh,shellQuote,spawnSsh} from './ssh-transport';
import {isRemoteAbsolutePath} from '../shared/execution-machines';

type Invoke=(data:{command:string;args:Record<string,unknown>;commandKey:string})=>Promise<unknown>;
export interface SshExecution{
 request<T=any>(method:string,params:any):Promise<T>;
 start(cli:Cli,options:CodexOptions|OmpOptions,runtimePolicy?:RuntimeConfig,attachOnly?:boolean):Promise<CodexClient>;
 prepareBusiness(invocationId:string,onInvoke:Invoke):Promise<BusinessCliRuntime & {outputRoot:string}>;
 prepareCapabilities(conversationId:string,mcp:McpServer[],skills:Skill[],instructions:string):Promise<string>;
 uploadAttachment(path:string,id:string):Promise<string>;
 downloadOutput(invocationId:string,relativePath:string,destination:string):Promise<void>;
 close():void;
}
export type SshConnection={request<T=any>(method:string,params:any):Promise<T>;onEvent?:(event:SshEvent)=>void;onDisconnect?:(reason:string)=>void;close():void};

/** Retries transport requests with their original IDs; remote starts are never recreated. */
export class SshRpcConnection implements SshConnection{
 onEvent?:(event:SshEvent)=>void;onDisconnect?:(reason:string)=>void;
 private instanceId?:string;private fatal?:Error;
 private child?:ChildProcessWithoutNullStreams;private connecting?:Promise<void>;private closed=false;private cursor:number|null=null;private generation=0;
 private pending=new Map<string,{method:string;params:any;resolve:(value:any)=>void;reject:(error:Error)=>void}>();
 constructor(private host:string,private directory:string,private spawnTransport:typeof spawnSsh=spawnSsh,private runtimeId?:string){}
 async request<T=any>(method:string,params:any):Promise<T>{
  if(this.closed)throw new Error('SSH execution detached');
  await this.ensureConnected();
  const id=randomUUID();return new Promise((resolve,reject)=>{this.pending.set(id,{method,params,resolve,reject});this.send({id,method,params});});
 }
 private send(frame:unknown){if(this.child?.stdin.writable)this.child.stdin.write(JSON.stringify(frame)+'\n');}
 private ensureConnected():Promise<void>{
  if(this.closed)return Promise.reject(new Error('SSH execution detached'));
  if(this.fatal)return Promise.reject(this.fatal);
  if(this.connecting)return this.connecting;
  if(this.child&&!this.child.killed&&!this.child.stdin.destroyed)return Promise.resolve();
  const connection=this.open();this.connecting=connection;void connection.finally(()=>{if(this.connecting===connection)this.connecting=undefined;}).catch(()=>{});return connection;
 }
 private open():Promise<void>{
  const generation=++this.generation;
  return new Promise((resolve,reject)=>{
   const child=this.spawnTransport(this.host,`node ${shellQuote(posix.join(this.directory,'ssh-runner.mjs'))} --attach ${shellQuote(posix.join(posix.dirname(this.directory),'service'))}`);this.child=child;
   let buffer='',stderr='',attached=false,settled=false;
   const attachId=randomUUID();const timer=setTimeout(()=>{child.kill();reject(new Error('SSH attach timed out; remote execution may still be running'));},30000);
   const fail=(error:Error)=>{clearTimeout(timer);if(this.child===child)this.child=undefined;if(!settled){settled=true;reject(error);}if(attached&&!this.closed&&generation===this.generation)void this.reconnect();};
   child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
    buffer+=chunk;if(Buffer.byteLength(buffer)>SSH_FRAME_LIMIT){child.kill();fail(new Error('SSH frame too large'));return;}
    let end:number;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let frame:SshFrame;
     try{frame=JSON.parse(line);}catch{child.kill();fail(new Error('Invalid remote service frame'));return;}
     if('checkpoint'in frame){if(attached)this.cursor=Math.max(this.cursor??0,frame.checkpoint);continue;}
     if('event'in frame){if(!attached||this.fatal)continue;if(frame.event.sequence>(this.cursor??0)){this.cursor=frame.event.sequence;this.onEvent?.(frame.event);}continue;}
     if(frame.id===attachId){clearTimeout(timer);if(frame.error){child.kill();fail(new Error(frame.error.message));return;}if(/^[a-f0-9]{24}$/.test(posix.basename(this.directory))&&(frame.result.bundleVersion!==posix.basename(this.directory)||frame.result.protocolVersion!==SSH_PROTOCOL_VERSION)){this.fatal=new Error('Remote service version differs from this App; existing execution was preserved. Stop active work before restarting the remote service.');child.kill();fail(this.fatal);return;}if(this.instanceId&&this.instanceId!==frame.result.instanceId){this.fatal=new Error('Remote service restarted; execution state is unknown and pending requests were not replayed');child.kill();fail(this.fatal);return;}this.instanceId=frame.result.instanceId;attached=true;settled=true;for(const [id,pending]of this.pending)this.send({id,method:pending.method,params:pending.params});resolve();continue;}
     const pending=this.pending.get(frame.id);if(pending){this.pending.delete(frame.id);frame.error?pending.reject(Object.assign(new Error(frame.error.message),frame.error)):pending.resolve(frame.result);}
    }
   });
   child.stderr.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-4096);});child.stdin.on('error',()=>{});
   child.on('error',fail);child.on('close',code=>fail(new Error(`SSH disconnected (${code}): ${stderr.trim()}; remote execution state is unknown`)));
   child.stdin.write(JSON.stringify({id:attachId,method:'attach',params:{cursor:this.cursor,runtimeId:this.runtimeId}})+'\n');
  });
 }
 private async reconnect(){
  let failure:unknown;
  for(let attempt=0;attempt<3&&!this.closed;attempt++){try{await this.ensureConnected();return;}catch(error){failure=error;await new Promise(resolve=>setTimeout(resolve,250*(attempt+1)));}}
  if(!this.closed){for(const pending of this.pending.values())pending.reject(failure instanceof Error?failure:new Error('SSH disconnected; remote execution state is unknown'));this.pending.clear();this.onDisconnect?.(failure instanceof Error?failure.message:'SSH disconnected; remote execution state is unknown');}
 }
 close(){this.closed=true;this.generation++;this.child?.stdin.end();this.child?.kill();this.child=undefined;for(const pending of this.pending.values())pending.reject(new Error('SSH detached; remote execution may still be running'));this.pending.clear();}
}

export function createSshExecution(connection:SshConnection,conversationId:string):SshExecution{
 const listeners=new Map<string,CodexOptions>();const invokes=new Map<string,Invoke>();const businessResults=new Map<string,Promise<{result?:unknown;error?:{message:string;code?:string;status?:number}}>>();
 const unboundBusiness:SshEvent[]=[];const unboundRuntime:SshEvent[]=[];
 const handleBusiness=(event:SshEvent)=>{
  const {callId,invocationId,data}=event.payload;const invoke=invokes.get(invocationId);
  if(!invoke){unboundBusiness.push(event);return;}
  let result=businessResults.get(callId);
  if(!result){result=Promise.resolve().then(()=>invoke(data)).then(result=>({result}),error=>({error:{message:error.message,code:error.code,status:error.status}}));businessResults.set(callId,result);}
  void result.then(value=>connection.request('business.reply',{callId,...value})).catch(()=>{});
 };
 const handleEvent=(event:SshEvent)=>{if(event.kind==='business'){handleBusiness(event);return;}const listener=event.runtimeId?listeners.get(event.runtimeId):undefined;if(!listener){unboundRuntime.push(event);return;}if(event.kind==='event')listener.onEvent(event.payload);else if(event.kind==='approval')listener.onApproval(event.payload);else listener.onExit(event.payload);};
 connection.onEvent=handleEvent;connection.onDisconnect=reason=>{for(const listener of listeners.values())listener.onExit(reason);};
 return {
  request:(method,params)=>connection.request(method,params),
  async start(cli,options,runtimePolicy,attachOnly=false){
   const runtimeId=safeSshId(conversationId);listeners.set(runtimeId,options);for(let i=0;i<unboundRuntime.length;)if(unboundRuntime[i].runtimeId===runtimeId)handleEvent(unboundRuntime.splice(i,1)[0]);else i++;
   const {onEvent,onApproval,onExit,signal,env,validateHandoff,...serializable}=options as OmpOptions;
   if(env&&Object.keys(env).length)throw new Error('Local runtime environment cannot be sent over SSH; pass runtimePolicy references');
   const {methods}=await connection.request<{methods:string[]}>('runtime.start',{runtimeId,cli,options:serializable,runtimePolicy,attachOnly});
   const client:any={async close(){listeners.delete(runtimeId);try{if(runtimeId.startsWith('catalog-'))await connection.request('runtime.release',{runtimeId});}finally{connection.close();}}};
   for(const method of methods)client[method]=(...args:unknown[])=>{
    const result=connection.request('runtime.call',{runtimeId,method,args});if(method==='replyApproval'){void result.catch(error=>onExit(`SSH approval reply failed: ${error.message}`));return;}return result;
   };
   return client as CodexClient;
  },
  async prepareBusiness(invocationId,onInvoke){
   safeSshId(invocationId);invokes.set(invocationId,onInvoke);const runtime=await connection.request<Omit<BusinessCliRuntime,'dispose'> & {outputRoot:string}>('business.prepare',{invocationId,runtimeId:conversationId});
   for(let i=unboundBusiness.length-1;i>=0;i--)if(unboundBusiness[i].payload.invocationId===invocationId)handleBusiness(unboundBusiness.splice(i,1)[0]);
   return {...runtime,dispose(){invokes.delete(invocationId);void connection.request('business.dispose',{invocationId}).catch(()=>{});}};
  },
  async prepareCapabilities(id,mcp,skills,instructions){
   const serialized:SshSkill[]=[];let total=Buffer.byteLength(instructions);
   for(const skill of skills){safeSshId(skill.name);const resources:SshSkill['resources']=[];let content=skill.content;
    if(content===undefined){const rootInfo=await lstat(skill.path);if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory())throw new Error('Invalid Skill directory');content=(await readBoundedFile(skill.path,'SKILL.md')).toString('utf8');
     const walk=async(directory:string,prefix='')=>{for(const name of await readdir(directory)){const path=prefix+name;if(path==='SKILL.md')continue;const info=await lstat(join(directory,name));if(info.isSymbolicLink())throw new Error('Skill symlinks cannot be transferred');if(info.isDirectory())await walk(join(directory,name),path+'/');else{const bytes=await readBoundedFile(skill.path,path);total+=bytes.length;if(total>SSH_TRANSFER_LIMIT)throw new Error('Skills too large');resources.push({path,data:bytes.toString('base64'),executable:!!(info.mode&0o111)});}}};await walk(skill.path);
    }else for(const resource of skill[skillResources]??[]){const path=safeRelativePath(resource.path),bytes=await readBoundedFile(dirname(resource.blobPath),basename(resource.blobPath));total+=bytes.length;if(total>SSH_TRANSFER_LIMIT)throw new Error('Skills too large');resources.push({path,data:bytes.toString('base64'),executable:resource.executable});}
    total+=Buffer.byteLength(content);if(total>SSH_TRANSFER_LIMIT)throw new Error('Skills too large');serialized.push({name:skill.name,content,resources});
   }
   // MCP env values remain references and are resolved by prepareCapabilityRuntime on the host.
   return connection.request('capabilities.prepare',{conversationId:safeSshId(id),mcp,skills:serialized,instructions});
  },
  async uploadAttachment(path,id){const bytes=await readBoundedFile(dirname(path),basename(path));return connection.request('attachment.write',{id:safeSshId(id),name:basename(path),data:bytes.toString('base64')});},
  async downloadOutput(invocationId,path,destination){const result=await connection.request<{data:string}>('output.read',{invocationId:safeSshId(invocationId),path:safeRelativePath(path)});if(typeof result.data!=='string'||result.data.length>Math.ceil(SSH_TRANSFER_LIMIT/3)*4)throw new Error('Output too large');const bytes=Buffer.from(result.data,'base64');if(bytes.length>SSH_TRANSFER_LIMIT)throw new Error('Output too large');let root=resolve(destination);for(const part of path.split('/'))root=dirname(root);let at=root;const rootInfo=await lstat(root).catch(()=>null);if(rootInfo?.isSymbolicLink())throw new Error('Symlink output directory');for(const part of path.split('/').slice(0,-1)){at=join(at,part);const info=await lstat(at).catch(()=>null);if(info?.isSymbolicLink())throw new Error('Symlink output directory');}const current=await lstat(destination).catch(()=>null);if(current?.isSymbolicLink())throw new Error('Symlink output file');await mkdir(dirname(destination),{recursive:true,mode:0o700});const temporary=join(dirname(destination),'.ssh-'+randomUUID());try{await writeFile(temporary,bytes,{mode:0o600,flag:'wx'});await rename(temporary,destination);}finally{await unlink(temporary).catch(()=>{});}},
  close(){connection.close();},
 };
}
export async function connectSshExecution(machine:ExecutionMachine,options:{home:string;conversationId:string}):Promise<SshExecution>{
 const directory=await installSshService(machine.host);return createSshExecution(new SshRpcConnection(machine.host,directory,spawnSsh,options.conversationId),options.conversationId);
}
export async function probeSshHost(host:string):Promise<SshProbe>{
 const commands=runtimeIds.map(id=>({id,command:runtimeCatalog[id].command}));
 const script=`const fs=require('node:fs'),p=require('node:path');const runtimes=${JSON.stringify(commands)}.map(({id,command})=>({id,installed:(process.env.PATH||'').split(':').some(dir=>{try{if(!p.isAbsolute(dir))return false;const path=p.join(dir,command);fs.accessSync(path,fs.constants.X_OK);return fs.statSync(path).isFile()}catch{return false}})}));console.log(JSON.stringify({platform:process.platform,nodeVersion:process.versions.node,runtimes}));`;
 const result=JSON.parse(await runSsh(host,'node',script)) as SshProbe;
 if(result.platform!=='linux')throw new Error('SSH execution currently supports Linux only');const [major,minor,patch]=result.nodeVersion.split('.').map(Number);if(major<22||major===22&&(minor<23||minor===23&&patch<2))throw new Error('Remote Node >=22.23.2 is required');return result;
}

// Checks a directory on the execution machine while the user is still typing its path, so a typo surfaces in settings instead of at the first run.
export async function checkSshPath(host:string,path:string):Promise<{exists:boolean;isDirectory:boolean;realpath?:string}>{
 if(!isRemoteAbsolutePath(path)||path.length>4096)throw new Error('The remote working directory must be an absolute path starting with /');
 const script=`const fs=require('node:fs');const p=${JSON.stringify(path)};try{const r=fs.realpathSync(p);console.log(JSON.stringify({exists:true,isDirectory:fs.statSync(r).isDirectory(),realpath:r}))}catch{console.log(JSON.stringify({exists:false,isDirectory:false}))}`;
 const result=JSON.parse(await runSsh(host,'node',script)) as {exists:unknown;isDirectory:unknown;realpath?:unknown};
 return {exists:result.exists===true,isDirectory:result.isDirectory===true,...(typeof result.realpath==='string'?{realpath:result.realpath}:{})};
}
