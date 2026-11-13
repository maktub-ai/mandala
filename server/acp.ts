import {openClawNativeSettings} from './gateway-native';
import { canApproveAcpLocally } from './approval-policy';
import type { TurnOptions } from "../shared/chat-input";
import type { SessionConfigOption, SessionNotification, RequestPermissionRequest, RequestPermissionResponse, McpServer as AcpMcpServer, ContentBlock } from '@agentclientprotocol/sdk';
import {createAcpRuntime,createAgentRegistry,type AcpRuntimeHandle,type AcpRuntimeTurn,type AcpSessionRecord,type AcpRuntimeEvent} from 'acpx/runtime';
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
export async function connectAcp(options: CodexOptions & {nativeModel?:ModelChoice;runtimeCli:Cli}, command:string[]): Promise<CodexClient> {
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
 const requestPermission=async(request:RequestPermissionRequest):Promise<RequestPermissionResponse>=>{
  if(closed||!active||active.cancelled||request.sessionId!==sessionId)return {outcome:{outcome:'cancelled'}};
  if(options.safeSystem){options.onApproval({id:randomUUID(),method:'acp/permission',params:{threadId:sessionId,toolCall:request.toolCall}});return {outcome:{outcome:'cancelled'}};}
  const once=request.options.find(option=>option.kind==='allow_once');
  if(once&&(active.wholeTurnApproved||active.mode==='auto'||active.mode==='default'&&canApproveAcpLocally(request.toolCall,options.cwd)))return {outcome:{outcome:'selected',optionId:once.optionId}};
  const id=randomUUID();
  return new Promise<RequestPermissionResponse>(resolve=>{
   permissions.set(id,{resolve,allowed:new Set(request.options.filter(o=>o.kind==='allow_once'||o.kind==='allow_always'||o.kind==='reject_once').map(o=>o.optionId))});
   options.onApproval({id,method:'acp/permission',params:{threadId:sessionId,turnId:active!.id,title:request.toolCall.title??'ACP tool',itemId:request.toolCall.toolCallId,toolCall:request.toolCall,options:request.options}});
  });
 };
 const cli=options.runtimeCli, gatewayBacked=cli==='hermes'||cli==='openclaw';
 const setupTimeout=gatewayBacked?45000:15000,lifetime=new AbortController();
 let handle:AcpRuntimeHandle|undefined,nativeTurn:AcpRuntimeTurn|undefined,servers:AcpMcpServer[]=[],stderr='';
 // Mandala persists native session IDs. acpx records only cache this connection;
 // every later attachment explicitly resumes the same native session.
 const records=new Map<string,AcpSessionRecord>();
 const agentPids=new Set<number>();
 const runtime=createAcpRuntime({
  cwd:options.cwd,agentRegistry:createAgentRegistry({overrides:{[cli]:command}}),probeAgent:cli,
  sessionStore:{async load(id){const record=records.get(id);return record?structuredClone(record):undefined;},async save(record){records.set(record.acpxRecordId,structuredClone(record));}},
  agentProcessEnv:options.env,timeoutMs:setupTimeout,permissionMode:'deny-all',nonInteractivePermissions:'deny',fs:false,terminal:false,
  mcpServers:()=>servers,
  processLifecycle:{onExit(exit){
   const agent=agentPids.delete(exit.pid);
   if(!agent||closed||exit.scope.kind!=='runtime-session'||exit.scope.sessionKey!==handle?.sessionKey)return;
   cancelPermissions();options.onExit(runtimeError('ACP connection closed',stderr,options.env??{}));
  }},
  sessionRequestMeta:options.safeSystem?()=>({claudeCode:{options:{tools:[],settingSources:[],persistSession:false,settings:{disableAllHooks:true},mcpServers:{}}}}):undefined,
  spawnAgent({command,args,options:launch}){
   lifetime.signal.throwIfAborted();
   const child=spawn(command,args,{...launch,stdio:'pipe'});
   // acpx also owns --version/--help probes; only piped-stdin ACP agents
   // represent the conversation connection, even when they share its scope.
   if(!(Array.isArray(launch.stdio)&&launch.stdio[0]==='ignore'))child.once('spawn',()=>{if(child.pid)agentPids.add(child.pid);});
   const stop=()=>{child.kill('SIGTERM');};
   lifetime.signal.addEventListener('abort',stop,{once:true});
   child.once('close',()=>lifetime.signal.removeEventListener('abort',stop));
   child.stderr.on('data',data=>{stderr=(stderr+String(data)).slice(-8192);});
   return child;
  },
  async onPermissionRequest({raw},{signal}){
   if(signal.aborted)return {outcome:'cancel'};
   const abort=()=>cancelPermissions();signal.addEventListener('abort',abort,{once:true});
   try{const response=await requestPermission(raw);return response.outcome.outcome==='selected'?response.outcome:{outcome:'cancel'};}
   finally{signal.removeEventListener('abort',abort);}
  },
 });
 const snapshot=async()=>{
  const status=await runtime.getStatus({handle:handle!});
  return {sessionId:handle!.backendSessionId!,configOptions:status.details?.configOptions as SessionConfigOption[]|undefined,
   _meta:{mandalaLegacyModels:status.models?{currentModelId:status.models.currentModelId,availableModels:status.models.availableModelIds.map(modelId=>({modelId,name:status.models?.availableModels?.find(model=>model.modelId===modelId)?.name??modelId}))}:undefined}};
 };
 const attach=async(cwd:string,mcp:AcpMcpServer[],resumeSessionId?:string)=>{
  servers=mcp;
  const next=await runtime.ensureSession({sessionKey:randomUUID(),agent:cli,mode:'persistent',cwd,resumeSessionId});
  if(!next.backendSessionId||resumeSessionId&&next.backendSessionId!==resumeSessionId)throw new Error('ACP did not restore the requested native session');
  // Once Mandala receives an ID, even the first reconnect must keep that ID.
  // acpx otherwise permits replacing an unprompted fresh persistent session.
  handle=resumeSessionId?next:await runtime.ensureSession({sessionKey:next.sessionKey,agent:cli,mode:'persistent',cwd,resumeSessionId:next.backendSessionId});
  return snapshot();
 };
 const forward=(event:AcpRuntimeEvent)=>{
  if(event.type==='text_delta')update({sessionId,update:{sessionUpdate:event.stream==='thought'?'agent_thought_chunk':'agent_message_chunk',content:{type:'text',text:event.text}}});
  else if(event.type==='status'&&event.tag==='plan'&&event.entries&&!closed&&active)emit('turn/plan/updated',{plan:event.entries.map(entry=>({step:entry.content,status:entry.status}))});
  else if(event.type==='tool_call'&&event.toolCallId)update({sessionId,update:{sessionUpdate:event.tag==='tool_call'?'tool_call':'tool_call_update',toolCallId:event.toolCallId,title:event.title,kind:event.kind,status:event.status,locations:event.locations,rawInput:event.rawInput,rawOutput:event.rawOutput,content:event.content} as SessionNotification['update']});
 };
 const sendPrompt=async(content:ContentBlock[])=>{
  const text=content.filter(block=>block.type==='text').map(block=>block.text).join('');
  const attachments=content.filter(block=>block.type==='image').map(block=>({mediaType:block.mimeType,data:block.data}));
  // Setup is bounded; coding turns last until completion or explicit cancellation.
  const turn=runtime.startTurn({handle:handle!,requestId:active!.id,mode:'prompt',text,attachments,timeoutMs:0,assertActive:()=>{if(closed||active?.cancelled)throw new Error('ACP turn cancelled');}});
  nativeTurn=turn;
  try{for await(const event of turn.events)forward(event);const result=await turn.result;
   if(result.status==='failed')throw new Error(result.error.message);
   configure(await snapshot());
   return {stopReason:result.status==='cancelled'?'cancelled':result.stopReason};
  }finally{if(nativeTurn===turn)nativeTurn=undefined;}
 };
 let closing:Promise<void>|undefined;
 const abort=()=>{void close().catch(error=>options.onExit(String(error)));};
 const close=()=>{if(closing)return closing;closed=true;cancelPermissions();options.signal?.removeEventListener('abort',abort);lifetime.abort();return closing=runtime.shutdown();};
 options.signal?.addEventListener('abort',abort,{once:true});
 let initialized;
 try {options.signal?.throwIfAborted();initialized=await bounded(runtime.doctor(),setupTimeout);if(!initialized.ok)throw new Error(initialized.details?.at(-1)??initialized.message);}
 catch(error){await close();throw new Error(runtimeError(String(error),stderr,options.env??{}),{cause:error});}
 const capabilities=initialized.agentCapabilities;
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
   if(!legacyModels.some(choice=>choice.id===model&&choice.isDefault))await bounded(runtime.setModel({handle:handle!,model}));
   legacyModels=legacyModels.map(choice=>({...choice,isDefault:choice.id===model}));return;
  }
  if(!setting)throw new Error('ACP agent does not advertise model selection; use its native default');
  if(setting.currentValue===model)return;
  await bounded(runtime.setConfigOption({handle:handle!,key:setting.id,value:model}));configure(await snapshot());
 };
 let prepared: {id:string;input:TurnOptions;images:ContentBlock[]}|undefined;
 const setup=async<T>(request:Promise<T>):Promise<T>=>{try{return await bounded(request,gatewayBacked?45000:15000);}catch(error){if(!gatewayBacked)throw error;throw new Error(`${runtimeLabel(options.runtimeCli!)} Gateway setup failed. Check the native installation, Gateway startup and provider login in the selected profile. No task was sent.`,{cause:error});}};
 const ensureSession=async()=>{if(!sessionId){const result=await setup(attach(options.cwd,[]));sessionId=result.sessionId;configure(result);}};
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
   if(closed||active)throw new Error('ACP session is unavailable or busy');
   if(input.safeSystem&&!options.safeSystem)throw new Error('Restricted ACP must be configured before launch');
   if(!options.safeSystem&&!capabilities?.loadSession&&!capabilities?.sessionCapabilities?.resume)throw new Error('ACP agent must support session resume for durable chats');
   const result=await setup(attach(input.cwd,options.safeSystem?[]:mcpServers(input.mcp)));
   sessionId=result.sessionId;instructions=input.instructions;configure(result);
   await setModel(input.model);return sessionId;
  },
  async resumeThread(id,mcp,nextInstructions,model){
   if(closed||active)throw new Error('ACP turn is still running or the session is closed');
   const servers=mcpServers(mcp);
   if(id!==sessionId){
    if(!capabilities?.loadSession&&!capabilities?.sessionCapabilities?.resume)throw new Error('ACP agent cannot resume this session; start a new chat');
    const openclaw=options.runtimeCli==='openclaw';
    if(openclaw&&!capabilities?.sessionCapabilities?.resume)throw new Error('OpenClaw must support strict session resume; upgrade the native CLI.');
    const result=await attach(options.cwd,options.safeSystem?[]:servers,id);
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
    return sendPrompt(prompt);
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
  async interrupt(id,turnId){if(active?.id!==turnId||id!==sessionId)return;active.cancelled=true;cancelPermissions();if(active.promptStarted)await nativeTurn?.cancel();},
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
 const command=[runtime.command,...runtime.args,...(options.safeSystem&&cli==='codebuddy'?['--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','','--settings','{"disableAllHooks":true}','--no-session-persistence']:[])];
 return connectAcp({...options,env,nativeModel:native?.model,runtimeCli:cli},command);
}
