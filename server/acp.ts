import {openClawNativeSettings} from './gateway-native';
import { canApproveAcpLocally } from './approval-policy';
import type { TurnOptions } from "../shared/chat-input";
import { ClientSideConnection, ndJsonStream, type Stream, type SessionConfigOption, type SessionNotification, type RequestPermissionResponse, type McpServer as AcpMcpServer, type ContentBlock } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import {join} from 'node:path';
import {claudeNativeEnv} from './runtime-credentials';
import { spawn,resolveNativeCli } from './native-spawn';
import type { CodexClient, CodexOptions } from './codex';
import type { Cli, McpServer, ApprovalMode, ModelChoice } from '../shared/types';
import { runtimeCatalog,runtimeLabel,supportsSystemTasks } from '../shared/runtimes';
import { runtimeError, validateRuntimeArgs } from './runtime';

const bounded = async <T>(promise: Promise<T>,timeout=15000): Promise<T> => {
 let timer: ReturnType<typeof setTimeout>;
 try { return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('ACP setup timed out')),timeout);})]); }
 finally {clearTimeout(timer!);}
};
export async function connectAcp(stream: Stream, options: CodexOptions & {nativeModel?:ModelChoice;runtimeCli?:Cli}, stop: ()=>void|Promise<void>): Promise<CodexClient> {
 // Older agents still return `models`; the current SDK strips that legacy field.
 // Carry it in protocol metadata before SDK validation, without weakening validation.
 stream={...stream,readable:stream.readable.pipeThrough(new TransformStream({transform(message,controller){
  if(options.runtimeCli==='codebuddy'&&'method' in message&&message.method==='session/request_permission'){
   const params=message.params as {options?:{optionId:string;kind:string}[]}|undefined;
   if(params?.options)params.options=params.options.map(option=>({...option,kind:option.kind==='allow'&&option.optionId==='allow_once'?'allow_once':option.kind==='allow'&&option.optionId==='allow_session'?'allow_always':option.kind==='reject'&&option.optionId==='deny'?'reject_once':option.kind}));
  }
  if('result' in message&&message.result&&typeof message.result==='object'&&!Array.isArray(message.result)){
   const result=message.result as Record<string,unknown>;
   if(result.models)result._meta={...(result._meta as object??{}),mandalaLegacyModels:result.models};
  }
  controller.enqueue(message);
 }}))};
 const restrictedMeta=options.safeSystem?{_meta:{claudeCode:{options:{tools:[],settingSources:[],persistSession:false,settings:{disableAllHooks:true},mcpServers:{}}}}}:{};
 let sessionId='', instructions='', active: {id:string;mode:ApprovalMode;cancelled:boolean;promptStarted?:boolean;wholeTurnApproved?:boolean;sawOutput?:boolean;gatewayFailure?:string}|undefined, closed=false;
 let configuration: SessionConfigOption[]=[];
 let legacyModels:ModelChoice[]=[];
 const configure=(result:{configOptions?:SessionConfigOption[]|null;_meta?:Record<string,unknown>|null})=>{
  configuration=result.configOptions??[];
  const models=result._meta?.mandalaLegacyModels as {currentModelId?:string;availableModels?:{modelId:string;name?:string}[]}|undefined;
  legacyModels=Array.isArray(models?.availableModels)?models.availableModels.filter(m=>typeof m.modelId==='string').map(m=>({id:m.modelId,label:m.name??m.modelId,isDefault:m.modelId===models.currentModelId})):[];
 };
 let messageId='', message='', thought='';
 const calls=new Map<string,Record<string,unknown>>();
 const permissions=new Map<string,{resolve:(value:RequestPermissionResponse)=>void;allowed:Set<string>}>();
 const emit=(method:string,params:Record<string,unknown>)=>options.onEvent({method,params:{threadId:sessionId,turnId:active?.id,...params}});
 const finishMessage=()=>{
  if(messageId&&message)emit('item/completed',{item:{id:messageId,type:'agentMessage',text:message}});
  if(messageId&&thought)emit('item/completed',{item:{id:messageId+':thought',type:'reasoning',content:[thought],summary:[]}});
  messageId='';message='';thought='';
 };
 const cancelPermissions=()=>{for(const [id,p] of permissions){p.resolve({outcome:{outcome:'cancelled'}});emit('serverRequest/resolved',{requestId:id});}permissions.clear();};
 const update=({sessionId:id,update:u}:SessionNotification)=>{
  if(closed||!active||id!==sessionId)return;
  if(u.sessionUpdate==='config_option_update'){configuration=u.configOptions;return;}
  if(u.sessionUpdate==='agent_message_chunk'||u.sessionUpdate==='agent_thought_chunk'){
   if(u.content.type!=='text')return;
   if(!messageId)messageId=randomUUID();
   if(u.sessionUpdate==='agent_message_chunk'){
    if(!message)emit('item/started',{item:{id:messageId,type:'agentMessage',text:''}});
    active.sawOutput ||= !!u.content.text.trim();
    message+=u.content.text;
    if(options.runtimeCli==='openclaw'&&message.includes('[OpenClaw interruption]'))active.gatewayFailure='OpenClaw Gateway interrupted this turn; outcome may be unknown. Check the native session before retrying.';
    emit('item/agentMessage/delta',{itemId:messageId,delta:u.content.text});
   }else{thought+=u.content.text;emit('item/reasoning/textDelta',{itemId:messageId+':thought',delta:u.content.text});}
  }else if(u.sessionUpdate==='plan'){
   emit('turn/plan/updated',{plan:u.entries.map(entry=>({step:entry.content,status:entry.status}))});
  }else if(u.sessionUpdate==='tool_call'||u.sessionUpdate==='tool_call_update'){
   active.sawOutput=true;finishMessage();
   const old=calls.get(u.toolCallId)??{id:u.toolCallId,type:'mcpToolCall',server:'ACP',tool:'Tool'};
   const item={...old,...(u.title?{tool:u.title}:{}),...(u.kind?{kind:u.kind}:{}),...(u.locations?{locations:u.locations}:{}),...(u.rawInput!==undefined?{arguments:u.rawInput}:{}),
    ...(u.rawOutput!==undefined?{result:u.rawOutput}:u.content?{result:u.content}:{}),
    status:u.status==='completed'?'completed':u.status==='failed'?'failed':'inProgress'};
   calls.set(u.toolCallId,item);emit(item.status==='inProgress'?'item/started':'item/completed',{item});
  }
 };
 const connection=new ClientSideConnection(()=>({sessionUpdate:update,requestPermission:async request=>{
  if(closed||!active||active.cancelled||request.sessionId!==sessionId)return {outcome:{outcome:'cancelled'}};
  if(options.safeSystem){options.onApproval({id:randomUUID(),method:'acp/permission',params:{threadId:sessionId,toolCall:request.toolCall}});return {outcome:{outcome:'cancelled'}};}
  const once=request.options.find(option=>option.kind==='allow_once');
  if(once&&(active.wholeTurnApproved||active.mode==='auto'||active.mode==='default'&&canApproveAcpLocally(request.toolCall,options.cwd)))return {outcome:{outcome:'selected',optionId:once.optionId}};
  const id=randomUUID();
  return new Promise<RequestPermissionResponse>(resolve=>{
   permissions.set(id,{resolve,allowed:new Set(request.options.filter(o=>o.kind==='allow_once'||o.kind==='allow_always'||o.kind==='reject_once').map(o=>o.optionId))});
   options.onApproval({id,method:'acp/permission',params:{threadId:sessionId,turnId:active!.id,title:request.toolCall.title??'ACP tool',itemId:request.toolCall.toolCallId,toolCall:request.toolCall,options:request.options}});
  });
 }}),stream);
 let closing:Promise<void>|undefined;
 const close=()=>{if(closing)return closing;closed=true;cancelPermissions();return closing=Promise.resolve().then(stop);};
 let initialized;
 try {initialized=await bounded(connection.initialize({protocolVersion:1,clientInfo:{name:'mandala',version:'0.1.0'},clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false}}));}
 catch(error){await close();throw error;}
 if(options.runtimeCli==='grok'){
  const method=initialized.authMethods?.find(method=>/api.?key|cached.?token/i.test(method.id));
  if(method)try{await bounded(connection.authenticate({methodId:method.id,_meta:{headless:true}}));}catch(error){await close();throw error;}
 }
 const capabilities=initialized.agentCapabilities;
 void connection.closed.then(()=>{cancelPermissions();if(!closed)options.onExit('ACP connection closed');});
 const mcpServers=(servers:McpServer[]=[]):AcpMcpServer[]=>{
  if(servers.length&&(options.runtimeCli==='hermes'||options.runtimeCli==='openclaw'))throw new Error(`${runtimeLabel(options.runtimeCli)} session MCP bindings are unavailable in Mandala. ${options.runtimeCli==='hermes'?'The native Gateway cannot reliably revoke an empty binding set on resume.':'OpenClaw ACP does not support per-session MCP.'} Remove the session bindings and manage MCP in the native Gateway.`);
  return servers.map(server=>{
  if(server.transport==='http'){
   if(!capabilities?.mcpCapabilities?.http)throw new Error('ACP agent does not support HTTP MCP');
   return {type:'http',name:server.name,url:server.url!,headers:[]};
  }
  return {name:server.name,command:options.runtimeCli==='dsh'&&!/^(?:\/|[A-Za-z]:[\\/])/.test(server.command!)?resolveNativeCli(server.command!,{...process.env,...options.env}):server.command!,args:server.args??[],env:Object.entries(server.env??{}).map(([name,ref])=>{
   const source=ref.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/)?.[1];
   if(!source||process.env[source]===undefined)throw new Error(`Missing MCP environment reference: ${name}`);
   return {name,value:process.env[source]!};
  })};
 });
 };
 const setModel=async(model?:string)=>{
  if(!model)return;
  if(options.runtimeCli==='openclaw'){if(model!==options.nativeModel?.id)throw new Error('OpenClaw ACP cannot switch models. Select the native default, or change the model in the native Gateway and start a new chat.');return;}
  const setting=configuration.find(option=>option.category==='model');
  if(!setting&&legacyModels.length){
   if(!legacyModels.some(choice=>choice.id===model))throw new Error('ACP model is not in the native catalog');
   if(!legacyModels.some(choice=>choice.id===model&&choice.isDefault))await bounded(connection.extMethod('session/set_model',{sessionId,modelId:model}));
   legacyModels=legacyModels.map(choice=>({...choice,isDefault:choice.id===model}));return;
  }
  if(!setting)throw new Error('ACP agent does not advertise model selection; use its native default');
  if(setting.currentValue===model)return;
  configuration=(await bounded(connection.setSessionConfigOption({sessionId,configId:setting.id,value:model}))).configOptions;
 };
 let prepared: {id:string;input:TurnOptions;images:ContentBlock[]}|undefined;
 const gatewayBacked=options.runtimeCli==='hermes'||options.runtimeCli==='openclaw';
 const setup=async<T>(request:Promise<T>):Promise<T>=>{try{return await bounded(request,gatewayBacked?45000:15000);}catch(error){if(!gatewayBacked)throw error;throw new Error(`${runtimeLabel(options.runtimeCli!)} Gateway setup failed. Check the native installation, Gateway startup and provider login in the selected profile. No task was sent.`,{cause:error});}};
 const ensureSession=async()=>{if(!sessionId){const result=await setup(connection.newSession({cwd:options.cwd,mcpServers:[],...restrictedMeta}));sessionId=result.sessionId;configure(result);}};
 const prepareTurn=async(id:string,input:TurnOptions={})=>{
  if(closed||id!==sessionId||active)throw new Error('ACP session is unavailable or busy');
  if(input.effort)throw new Error('ACP reasoning effort selection is not supported');
  if(input.images?.length&&!capabilities?.promptCapabilities?.image)throw new Error('ACP agent does not support images');
  await setModel(input.model);
  const images:ContentBlock[]=[];
  for(const image of input.images??[])images.push({type:'image',mimeType:image.mimeType,data:(await readFile(image.path)).toString('base64')});
  prepared={id,input,images};
 };
 return {
  prepareTurn,
  async getStatus(){if(gatewayBacked)await ensureSession();return {status:'ready',version:initialized.agentInfo?.version??null};},
  async listModels(){
   if(options.runtimeCli==='openclaw'){await ensureSession();return options.nativeModel?[options.nativeModel]:[];}
   await ensureSession();
   const setting=configuration.find(option=>option.category==='model');
   if(!setting||setting.type!=='select')return legacyModels;
   return setting.options.flatMap(option=>'options' in option?option.options:[option]).map(option=>({id:option.value,label:option.name,isDefault:option.value===setting.currentValue}));
  },
  async startThread(input){
   if(input.safeSystem&&!options.safeSystem)throw new Error('Restricted ACP must be configured before launch');
   if(!options.safeSystem&&!capabilities?.loadSession&&!capabilities?.sessionCapabilities?.resume)throw new Error('ACP agent must support session resume for durable chats');
   const result=await setup(connection.newSession({cwd:input.cwd,mcpServers:options.safeSystem?[]:mcpServers(input.mcp),...restrictedMeta}));
   sessionId=result.sessionId;instructions=input.instructions;configure(result);
   await setModel(input.model);return sessionId;
  },
  async resumeThread(id,mcp,nextInstructions,model){
   if(active)throw new Error('ACP turn is still running');
   const servers=mcpServers(mcp);
   if(id!==sessionId){
    if(!capabilities?.loadSession&&!capabilities?.sessionCapabilities?.resume)throw new Error('ACP agent cannot resume this session; start a new chat');
    const openclaw=options.runtimeCli==='openclaw';
    if(openclaw&&!capabilities?.sessionCapabilities?.resume)throw new Error('OpenClaw must support strict session resume; upgrade the native CLI.');
    const request={sessionId:id,cwd:options.cwd,mcpServers:servers,...(openclaw?{_meta:{sessionKey:/^[a-f0-9-]{36}$/i.test(id)?'acp-bridge:'+id:id,requireExisting:true}}:{})};
    const result=await bounded(openclaw||!capabilities?.loadSession?connection.resumeSession(request):connection.loadSession(request));
    sessionId=id;configure(result);
   }
   instructions=nextInstructions??instructions;await setModel(model);
  },
  async startTurn(id,text,mode='default',_roots,input={}){
   if(prepared?.id!==id||prepared.input!==input)await prepareTurn(id,input);
   const prompt:ContentBlock[]=[{type:'text',text:instructions?`<mandala-context>\n${instructions}\n</mandala-context>\n\n${text}`:text},...prepared!.images];
   prepared=undefined;
   const turn={id:randomUUID(),mode,cancelled:false,promptStarted:false,wholeTurnApproved:false,sawOutput:false,gatewayFailure:undefined as string|undefined};active=turn;calls.clear();
   emit('turn/started',{turn:{id:turn.id,status:'inProgress'}});
   // Prompt lasts until the agent finishes; setup timeouts must not truncate a coding turn.
   void (async()=>{
    // These runtimes can execute tools outside ACP permission mediation.
    // Gate the entire turn before sending any prompt rather than imply per-tool control.
    if(['dsh','hermes','openclaw'].includes(options.runtimeCli??'')&&mode!=='auto'){
     const permissionId=randomUUID();
     const result=await new Promise<RequestPermissionResponse>(resolve=>{
      permissions.set(permissionId,{resolve,allowed:new Set(['allow-turn','reject-turn'])});
      options.onApproval({id:permissionId,method:'acp/permission',params:{threadId:sessionId,turnId:turn.id,wholeTurnApproval:true,title:`Allow ${runtimeLabel(options.runtimeCli!)} tools for this entire turn`,itemId:turn.id+':grant',toolCall:{toolCallId:turn.id+':grant',title:'This entire turn may execute commands and read or change files, including native configured tools. Approval applies to all tools in this turn; individual tools will not prompt again.',kind:'execute'},options:[{optionId:'allow-turn',name:'Allow entire turn',kind:'allow_once'},{optionId:'reject-turn',name:'Reject turn',kind:'reject_once'}]}});
     });
     if(closed||active!==turn||turn.cancelled||result.outcome.outcome!=='selected'||result.outcome.optionId!=='allow-turn')return {stopReason:'cancelled' as const};
     turn.wholeTurnApproved=true;
    }
    if(closed||active!==turn||turn.cancelled)return {stopReason:'cancelled' as const};
    turn.promptStarted=true;
    return connection.prompt({sessionId,prompt});
   })().then(result=>{
    if(closed||active!==turn)return;finishMessage();cancelPermissions();
    if(options.runtimeCli==='openclaw'&&result.stopReason==='end_turn'&&!turn.sawOutput)turn.gatewayFailure='OpenClaw Gateway ended without a response or tool result. Check native model authentication and Gateway logs; the task was not resent.';
    const status=turn.cancelled||result.stopReason==='cancelled'?'interrupted':!turn.gatewayFailure&&result.stopReason==='end_turn'?'completed':'failed';
    emit('turn/completed',{turn:{id:turn.id,status,...(status==='failed'?{error:{message:turn.gatewayFailure??`ACP stopped: ${result.stopReason}`}}:{})}});active=undefined;
   }).catch(error=>{
    if(closed||active!==turn)return;finishMessage();cancelPermissions();
    emit('turn/completed',{turn:{id:turn.id,status:turn.cancelled?'interrupted':'failed',error:{message:String(error)}}});active=undefined;
   });
   return turn.id;
  },
  async interrupt(id,turnId){if(active?.id!==turnId||id!==sessionId)return;active.cancelled=true;cancelPermissions();if(active.promptStarted)await connection.cancel({sessionId});},
  replyApproval(id,result){
   const pending=permissions.get(String(id));if(!pending)return;
   const response=result as RequestPermissionResponse;
   if(response?.outcome?.outcome!=='cancelled'&&(response?.outcome?.outcome!=='selected'||!pending.allowed.has(response.outcome.optionId)))throw new Error('Invalid ACP permission choice');
   permissions.delete(String(id));pending.resolve(response);
  },
  close,
 };
}
export async function startAcp(cli:Cli,options:CodexOptions):Promise<CodexClient>{
 const runtime=runtimeCatalog[cli];if(runtime.protocol!=='acp')throw new Error('Not an ACP runtime');
 if(options.safeSystem&&!supportsSystemTasks(cli))throw new Error(`${cli} cannot disable all tools for system tasks`);
 validateRuntimeArgs(cli,options.extraArgs??[]);
 if(cli==='hermes'&&({...process.env,...options.env}).HERMES_TUI_GATEWAY_URL?.trim())throw new Error('Hermes Gateway must run on the selected execution machine. Use Mandala SSH execution on its host with a native local Gateway profile; HERMES_TUI_GATEWAY_URL overrides are unavailable.');
 const native=cli==='openclaw'?await openClawNativeSettings(options):undefined;
 let env={...options.env};
 if(cli==='claude')env=await claudeNativeEnv(env);
 if(options.safeSystem&&cli==='gemini'){
  const settings=join(options.cwd,'mandala-system-settings.json');
  await writeFile(settings,JSON.stringify({tools:{core:[],discoveryCommand:'',callCommand:''},admin:{mcp:{enabled:false},extensions:{enabled:false},skills:{enabled:false}},hooksConfig:{enabled:false},telemetry:{enabled:false}}),{mode:0o600});
  env.GEMINI_CLI_SYSTEM_SETTINGS_PATH=settings;
 }
 if(options.safeSystem&&cli==='opencode')env.OPENCODE_PERMISSION=JSON.stringify({'*':'deny'});
 let child;
 const ownGroup=process.platform!=='win32'&&['codebuddy','kimi','dsh','grok'].includes(cli);
 child=spawn(runtime.command,[...runtime.args,...(options.safeSystem&&cli==='codebuddy'?['--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','','--settings','{"disableAllHooks":true}','--no-session-persistence']:[])],{cwd:options.cwd,env:{...process.env,...env},signal:options.signal,stdio:'pipe',shell:false,detached:ownGroup});
 let stderr='';child.stderr.on('data',data=>{stderr=(stderr+String(data)).slice(-8192);});
 let stopping=false;
 const kill=(signal:NodeJS.Signals)=>{if(ownGroup&&child.pid)try{process.kill(-child.pid,signal);return;}catch{}child.kill(signal);};
 const abort=()=>kill('SIGTERM');options.signal?.addEventListener('abort',abort,{once:true});
 const ended=new Promise<void>(resolve=>child.once('close',()=>resolve()));
 child.once('close',()=>{options.signal?.removeEventListener('abort',abort);if(ownGroup&&child.pid)kill('SIGKILL');});
 child.on('error',error=>{if(!stopping)options.onExit(runtimeError(error.message,stderr,env));});
 return connectAcp(ndJsonStream(Writable.toWeb(child.stdin),Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>),{...options,nativeModel:native?.model,runtimeCli:cli},async()=>{
  stopping=true;kill('SIGTERM');
  const timer=setTimeout(()=>kill('SIGKILL'),2000);
  try{await ended;}finally{clearTimeout(timer);}
 });
}
