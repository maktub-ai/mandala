import {EventEmitter} from 'node:events';
import {constants} from 'node:fs';
import {lstat,mkdir,open,realpath,writeFile,rm} from 'node:fs/promises';
import {join,dirname,basename,isAbsolute,relative,sep} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {startCodex,type CodexClient,type CodexOptions} from './codex';
import {startOmp,prepareCapabilityRuntime,type OmpOptions} from './omp';
import {startNativeRuntime} from './native-runtime';
import {resolveRuntime} from './runtime';
import {createBusinessCliRuntime,type BusinessCliRuntime} from './business-cli-runtime';
import {conversationEnvironment,listConversationWorkspace,readConversationWorkspaceFile} from './conversation-workspace';
import {readLocalFilePreview,resolveConversationLocalFiles,localFilePath} from './local-files';
import {discoverNative,discoverNativeSkills} from './capabilities';
import {isCli} from '../shared/runtimes';
import {DomainError} from '../shared/workspace-contracts';
import {messageFileLinks,isRelativeLocalFileReference} from '../shared/local-file-links';
import {skillResources} from '../shared/skills';
import type {Cli,Skill} from '../shared/types';
import {SSH_TRANSFER_LIMIT,type SshRequest,type SshEvent,type SshSkill} from '../shared/ssh-execution';

export type RemoteFactory=(cli:Cli,options:OmpOptions)=>Promise<CodexClient>;
export const startSshRuntime:RemoteFactory=(cli,options)=>cli==='codex'?startCodex(options):cli==='omp'?startOmp(options):startNativeRuntime(cli,options);
const allowedMethods=new Set(['inspectContext','compactThread','getStatus','requiresRuntimeReload','assertReloadable','inspectInvocation','listModels','startThread','resumeThread','forkThread','setSkillRoots','listMcpStatus','listSkills','prepareTurn','startTurn','interrupt','replyApproval']);
export function safeSshId(value:unknown):string{if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(value))throw new Error('Invalid remote identifier');return value;}
export function safeRelativePath(value:unknown):string{if(typeof value!=='string'||!value||value.length>4096||isAbsolute(value)||/[\\\x00-\x1f]/.test(value)||value.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('Invalid relative path');return value;}
export async function readBoundedFile(root:string,path:string,limit=SSH_TRANSFER_LIMIT):Promise<Buffer>{
 safeRelativePath(path);if((await lstat(root)).isSymbolicLink())throw new Error('Symlink transfer root is forbidden');const canonical=await realpath(root);let at=canonical;
 for(const part of path.split('/')){at=join(at,part);if((await lstat(at)).isSymbolicLink())throw new Error('Symlink transfers are forbidden');}
 if(!relative(canonical,at)||relative(canonical,at).startsWith('..'+sep))throw new Error('Invalid transfer path');
 const handle=await open(at,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const before=await handle.stat();if(!before.isFile())throw new Error('Only regular files can be transferred');if(before.size>limit)throw new Error('File too large');const bytes=Buffer.alloc(Math.min(before.size+1,limit+1));let size=0;while(size<bytes.length){const chunk=await handle.read(bytes,size,bytes.length-size,size);if(!chunk.bytesRead)break;size+=chunk.bytesRead;}const after=await handle.stat(),current=await lstat(at);if(size>limit)throw new Error('File too large');if(current.isSymbolicLink()||current.ino!==before.ino||current.dev!==before.dev||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||size!==before.size)throw new Error('File changed while transferring');return bytes.subarray(0,size);}finally{await handle.close();}
}
async function privateSubdirectory(root:string,parts:string[],create=false){
 let at=root;for(const part of ['',...parts]){if(part)at=join(at,part);if(create)await mkdir(at,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});const info=await lstat(at);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Symlink execution directory is forbidden');}return at;
}
function decodeData(data:unknown){if(typeof data!=='string'||data.length>Math.ceil(SSH_TRANSFER_LIMIT/3)*4)throw new Error('Transfer too large');if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))throw new Error('Invalid transfer encoding');const bytes=Buffer.from(data,'base64');if(bytes.length>SSH_TRANSFER_LIMIT)throw new Error('Transfer too large');return bytes;}

/** Lives in a detached daemon. A socket going away never closes a native client. */
export class SshService extends EventEmitter{
 private requests=new Map<string,{signature:string;result:Promise<unknown>}>();
 private clients=new Map<string,Promise<CodexClient>>();
 private subscriptions=new Map<string,number>();
 private starts=new Map<string,Promise<any>>();
 private runtimeStates=new Map<string,{signature:string;busy:boolean;nativeId?:string;retired:boolean;startSequence:number;lastActivity:number}>();
 private events:SshEvent[]=[];private sequence=0;
 private approvals=new Map<string,SshEvent>();
 private business=new Map<string,BusinessCliRuntime & {outputRoot:string}>();
 private businessCalls=new Map<string,{resolve:(value:any)=>void;reject:(error:Error)=>void;invocationId:string;event?:SshEvent;timer:NodeJS.Timeout}>();
 constructor(readonly home:string,private cliFile:string,private factory:RemoteFactory=startSshRuntime){super();}
 eventsAfter(cursor?:number,runtimeId?:string){if(cursor!==undefined&&this.events.length&&cursor<this.events[0].sequence-1)throw new Error('Remote event history expired; execution state is unknown');const retained=this.events.filter(event=>cursor!==undefined?event.sequence>cursor:!!event.runtimeId&&!!this.runtimeStates.get(event.runtimeId)&&event.sequence>=this.runtimeStates.get(event.runtimeId)!.startSequence);if(cursor===undefined){for(const event of [...this.approvals.values(),...[...this.businessCalls.values()].flatMap(call=>call.event?[call.event]:[])])if(!retained.some(value=>value.sequence===event.sequence))retained.push(event);retained.sort((a,b)=>a.sequence-b.sequence);}return retained.filter(event=>!runtimeId||event.runtimeId===runtimeId);}
 currentSequence(){return this.sequence;}
 pendingApprovals(){return [...this.approvals.values()];}
 private publish(kind:SshEvent['kind'],payload:any,runtimeId?:string){if(runtimeId){const state=this.runtimeStates.get(runtimeId);if(state)state.lastActivity=Date.now();}const event:SshEvent={sequence:++this.sequence,kind,payload,...(runtimeId?{runtimeId}:{})};this.events.push(event);if(this.events.length>20000)this.events.shift();if(kind==='approval')this.approvals.set(runtimeId+':'+payload.id,event);this.emit('event',event);return event;}
 request(request:SshRequest):Promise<any>{
  if(typeof request.id!=='string'||request.id.length>200) return Promise.reject(new Error('Invalid request ID'));
  if(['fs.stat','workspace.environment','workspace.list','workspace.read','workspace.preview','local-files.resolve','local-files.preview','capabilities.discover','output.read'].includes(request.method))return this.dispatch(request.method,request.params);
  const signature=createHash('sha256').update(JSON.stringify([request.method,request.params])).digest('hex'),cached=this.requests.get(request.id);
  if(cached)return cached.signature===signature?cached.result:Promise.reject(new Error('Request ID reused with different parameters'));
  const result=Promise.resolve().then(()=>this.dispatch(request.method,request.params));this.requests.set(request.id,{signature,result});return result;
 }
 private async dispatch(method:string,p:any):Promise<any>{
  switch(method){
   case 'runtime.start':{
    const id=safeSshId(p.runtimeId),previous=this.starts.get(id)??Promise.resolve();
    const result=previous.catch(()=>{}).then(()=>this.startRuntime(p));this.starts.set(id,result);return result;
   }
   case 'runtime.release':return this.releaseRuntime(safeSshId(p.runtimeId));
   case 'runtime.call':{
    if(!allowedMethods.has(p.method))throw new Error('Unsupported runtime method');const client=await this.clients.get(safeSshId(p.runtimeId));
    if(!client||typeof (client as any)[p.method]!=='function')throw new Error('Runtime method unavailable');
    const state=this.runtimeStates.get(p.runtimeId);if(state?.retired)throw new Error('Remote runtime is being released');if(state)state.lastActivity=Date.now();if(p.method==='startTurn'&&state){if(state.busy)throw new Error('Remote runtime already has an active turn');state.busy=true;}
    let result:any;try{result=await (client as any)[p.method](...(p.args??[]));}catch(error){/* A rejected start can be uncertain; keep the active marker until a terminal event. */throw error;}
    if(state){if(p.method==='startThread')state.nativeId=result;if(p.method==='resumeThread')state.nativeId=p.args[0];}
    if(p.method==='replyApproval')this.approvals.delete(p.runtimeId+':'+p.args[0]);return result??null;
   }
   case 'fs.stat':{if(typeof p.path!=='string'||!isAbsolute(p.path))throw new Error('Absolute remote path required');const path=await realpath(p.path);return {isDirectory:(await lstat(path)).isDirectory(),realpath:path};}
   case 'local-files.resolve':case 'local-files.preview':{
    const linkedPaths=new Set<string>(),absoluteLinkedPaths=new Set<string>();
    for(const text of p.messages??[])for(const link of messageFileLinks(text)){try{const path=localFilePath(link.href,p.cwd);linkedPaths.add(path);if(!isRelativeLocalFileReference(link.href))absoluteLinkedPaths.add(path);}catch{}}
    if(method==='local-files.resolve')return resolveConversationLocalFiles(p.hrefs,{cwd:p.cwd,roots:p.roots,linkedPaths,absoluteLinkedPaths});
    const target=localFilePath(p.href,p.cwd);if(!linkedPaths.has(target))throw new DomainError('file_scope',403,'File is not linked by this conversation');const scoped=isRelativeLocalFileReference(p.href)||!absoluteLinkedPaths.has(target);return readLocalFilePreview(p.href,scoped?[p.cwd]:p.roots,!scoped,p.cwd);
   }
   case 'capabilities.discover':{if(!isCli(p.cli))throw new Error('Unknown CLI runtime');return p.kind==='skills'?{mcp:[],skills:await discoverNativeSkills(p.cli,p.cwd)}:discoverNative(p.cli,p.cwd);}
   case 'workspace.environment':return conversationEnvironment(p.cwd);
   case 'workspace.list':return listConversationWorkspace(p.cwd,p.scope,p.directory,p.base);
   case 'workspace.read':return readConversationWorkspaceFile(p.cwd,p.path,p.scope,p.base);
   case 'workspace.preview':{
    // Existing workspace policy performs traversal, sensitive-path and symlink checks.
    await readConversationWorkspaceFile(p.cwd,p.path);
    const preview=await readLocalFilePreview(join(p.cwd,p.path),[p.cwd]);return {...preview,data:Buffer.from(preview.text).toString('base64')};
   }
   case 'business.prepare':{
    const id=safeSshId(p.invocationId);let runtime=this.business.get(id);
    if(!runtime){
     const outputRoot=await privateSubdirectory(this.home,['outputs',id],true);
     const native=await createBusinessCliRuntime(this.home,id,{baseUrl:'http://127.0.0.1:1',token:randomUUID()},data=>new Promise((resolve,reject)=>{
      const callId=randomUUID(),timer=setTimeout(()=>{this.businessCalls.delete(callId);reject(Object.assign(new Error('Business command response was not confirmed; retry only with its stable command key'),{code:'remote_business_unconfirmed',status:504}));},125000);timer.unref();const call={resolve,reject,invocationId:id,event:undefined as SshEvent|undefined,timer};this.businessCalls.set(callId,call);call.event=this.publish('business',{callId,invocationId:id,data},p.runtimeId);
     }),this.cliFile);runtime={...native,outputRoot};this.business.set(id,runtime);
    }
    const {dispose,...description}=runtime;return description;
   }
   case 'business.reply':{
    const call=this.businessCalls.get(p.callId);if(call){clearTimeout(call.timer);this.businessCalls.delete(p.callId);p.error?call.reject(Object.assign(new Error(p.error.message),p.error)):call.resolve(p.result);}return null;
   }
   case 'business.dispose':{
    const id=safeSshId(p.invocationId);for(const [callId,call]of this.businessCalls)if(call.invocationId===id){clearTimeout(call.timer);call.reject(new Error('Business invocation expired'));this.businessCalls.delete(callId);}this.business.get(id)?.dispose();this.business.delete(id);return null;
   }
   case 'capabilities.prepare':{
    const id=safeSshId(p.conversationId);const staging=join(this.home,'skill-staging',randomUUID());await mkdir(staging,{recursive:true,mode:0o700});
    try{
     let total=0;const skills:Skill[]=[];
     for(const serialized of p.skills as SshSkill[]){safeSshId(serialized.name);total+=Buffer.byteLength(serialized.content);const files=[];
      for(const resource of serialized.resources){const path=safeRelativePath(resource.path),bytes=decodeData(resource.data);total+=bytes.length;if(total>SSH_TRANSFER_LIMIT)throw new Error('Skills too large');const blobPath=join(staging,randomUUID());await writeFile(blobPath,bytes,{mode:0o600,flag:'wx'});files.push({path,blobPath,executable:!!resource.executable});}
      skills.push({name:serialized.name,path:'',content:serialized.content,[skillResources]:files});
     }
     if(total>SSH_TRANSFER_LIMIT)throw new Error('Skills too large');
     return await prepareCapabilityRuntime(this.home,id,p.mcp,skills,p.instructions);
    }finally{await rm(staging,{recursive:true,force:true});}
   }
   case 'attachment.write':{
    const id=safeSshId(p.id),name=safeRelativePath(p.name);if(basename(name)!==name)throw new Error('Invalid attachment filename');const bytes=decodeData(p.data),root=await privateSubdirectory(this.home,['attachments',id],true);const path=join(root,name);try{await writeFile(path,bytes,{mode:0o600,flag:'wx'});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||!(await readBoundedFile(root,name)).equals(bytes))throw error;}return path;
   }
   case 'output.read':{const root=await privateSubdirectory(this.home,['outputs',safeSshId(p.invocationId)]);return {data:(await readBoundedFile(root,p.path)).toString('base64')};}
   default:throw new Error('Unknown remote operation');
  }
 }
 private async startRuntime(p:any){
    const id=safeSshId(p.runtimeId);if(!isCli(p.cli))throw new Error('Unknown CLI runtime');
    if(p.attachOnly){const existing=this.clients.get(id);if(!existing)throw new Error('Remote runtime is unavailable; execution state is unknown');const client=await existing;return {methods:[...allowedMethods].filter(method=>typeof (client as any)[method]==='function')};}
    const signature=JSON.stringify([p.cli,p.options,p.runtimePolicy]),previous=this.runtimeStates.get(id);if(previous?.retired)throw new Error('Remote runtime is being released');
    if(previous&&previous.signature!==signature){
     if(previous.busy||[...this.approvals.values()].some(event=>event.runtimeId===id))throw new Error('Remote runtime is active; cannot change execution settings');
     const client=await this.clients.get(id)!;if(previous.nativeId)await client.assertReloadable?.(previous.nativeId);previous.retired=true;await client.close();this.clients.delete(id);this.runtimeStates.delete(id);
    }
    if(!this.clients.has(id)){
     if(p.options.env&&Object.keys(p.options.env).length)throw new Error('Only remote environment references are allowed');
     const state={signature,busy:false,retired:false,startSequence:this.sequence+1,lastActivity:Date.now(),nativeId:undefined as string|undefined};this.runtimeStates.set(id,state);
     const options:OmpOptions={...p.options,...resolveRuntime(p.cli,p.runtimePolicy),onEvent:event=>{if(state.retired)return;if(event.method==='turn/started')state.busy=true;if(event.method==='serverRequest/resolved')this.approvals.delete(id+':'+event.params?.requestId);if(event.method==='turn/completed'){state.busy=false;for(const [key,approval]of this.approvals)if(approval.runtimeId===id)this.approvals.delete(key);}this.publish('event',event,id);},onApproval:event=>{if(!state.retired)this.publish('approval',event,id);},onExit:reason=>{if(state.retired)return;state.busy=false;for(const [key,approval]of this.approvals)if(approval.runtimeId===id)this.approvals.delete(key);this.clients.delete(id);this.runtimeStates.delete(id);this.publish('exit',reason,id);}};
     const started=Promise.resolve().then(()=>this.factory(p.cli,options));this.clients.set(id,started);void started.catch(()=>{if(this.clients.get(id)===started){this.clients.delete(id);this.runtimeStates.delete(id);}});
    }
    const client=await this.clients.get(id)!;
    return {methods:[...allowedMethods].filter(method=>typeof (client as any)[method]==='function')};
 }
 subscribe(runtimeId?:string){if(runtimeId)this.subscriptions.set(runtimeId,(this.subscriptions.get(runtimeId)??0)+1);return ()=>{if(runtimeId)this.subscriptions.set(runtimeId,Math.max(0,(this.subscriptions.get(runtimeId)??0)-1));};}
 async sweepIdle(now=Date.now(),ttl=15*60*1000){for(const [id,state]of this.runtimeStates)if(!this.subscriptions.get(id)&&now-state.lastActivity>ttl&&![...this.businessCalls.values()].some(call=>call.event?.runtimeId===id))await this.releaseRuntime(id).catch(()=>{});}
 async releaseRuntime(id:string){
  const state=this.runtimeStates.get(id),pending=this.clients.get(id);if(!state||!pending)return false;if(state.busy||[...this.approvals.values()].some(event=>event.runtimeId===id))return false;
  const client=await pending;if(state.nativeId){if(client.inspectContext&&!(await client.inspectContext(state.nativeId)).settled)return false;await client.assertReloadable?.(state.nativeId);}if(state.busy)return false;state.retired=true;await client.close();if(this.runtimeStates.get(id)===state){this.clients.delete(id);this.runtimeStates.delete(id);}return true;
 }
 async shutdown(){for(const call of this.businessCalls.values()){clearTimeout(call.timer);call.reject(new Error('Remote service stopped'));}this.businessCalls.clear();for(const runtime of this.business.values())runtime.dispose();this.business.clear();await Promise.allSettled([...this.clients.values()].map(async promise=>(await promise).close()));}
}
