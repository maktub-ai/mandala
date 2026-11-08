import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { productHome } from '../cli/product-env.mjs';
import type { TurnOptions } from '../shared/chat-input';
import type { ApprovalMode, McpServer, ModelChoice } from '../shared/types';
import type { CodexClient, CodexOptions } from './codex';
import { spawn } from './native-spawn';
import { runtimeError } from './runtime';

type LocalCli = 'cursor' | 'antigravity';
type Turn = { id:string; cancelled:boolean; started:boolean; child?:ChildProcessWithoutNullStreams; stop?:Promise<void>; permission?:string; text:string; input:TurnOptions; finishItems?:()=>void; settle:(status:string,error?:string)=>void };

// These headless CLIs cannot mediate individual tools. A host grant covers this turn.
export async function startLocalCli(cli:LocalCli, options:CodexOptions):Promise<CodexClient> {
 if(options.safeSystem)throw new Error(`${cli} cannot disable all tools; tools-disabled system tasks are unsupported`);
 if(options.extraArgs?.length)throw new Error(`${cli} runtime arguments are managed by Mandala`);
 if(options.gateway&&options.gateway!=='native')throw new Error(`${cli} does not support this credential gateway`);
 const command=cli==='cursor'?'agent':'agy',env={...process.env,...options.env};
 const fixedModel=cli==='antigravity'?options.env?.MANDALA_AGY_MODEL:undefined;
 const validateModel=(selected:string|undefined)=>{if(fixedModel&&selected&&selected!==fixedModel)throw new Error('Antigravity model differs from its TT gateway; reconnect with the selected model');};
 let closed=false,closing:Promise<void>|undefined,sessionId='',nativeId='',instructions='',model:string|undefined=options.model??fixedModel,cwd=options.cwd,active:Turn|undefined;
 const helpers=new Set<ChildProcessWithoutNullStreams>();
 const pending=new Set<Promise<unknown>>();
 const track=<T>(promise:Promise<T>)=>{pending.add(promise);void promise.then(()=>pending.delete(promise),()=>pending.delete(promise));return promise;};
 const mappingPath=(id:string)=>{
  if(!/^mandala-agy:[0-9a-f-]{36}$/.test(id))throw new Error('Invalid Antigravity adapter session ID');
  return join(productHome('workspace',env),'native','antigravity-sessions',id.slice('mandala-agy:'.length)+'.json');
 };
 const assertOpen=()=>{if(closed||options.signal?.aborted)throw new Error(`${cli} runtime is closed`);};
 const validateMcp=(mcp:McpServer[]|undefined)=>{if(mcp?.length)throw new Error(`${cli} does not support isolated session MCP injection; configure native MCP explicitly`);};
 const emit=(method:string,params:Record<string,unknown>)=>options.onEvent({method,params:{threadId:sessionId,turnId:active?.id,...params}});
 const saveMapping=async(value:{nativeId:string|null;started?:boolean})=>{
  const file=mappingPath(sessionId),directory=join(file,'..');await mkdir(directory,{recursive:true,mode:0o700});
  const temporary=file+'.'+randomUUID();await writeFile(temporary,JSON.stringify(value),{mode:0o600});await rename(temporary,file);
 };
 const kill=(child:ChildProcessWithoutNullStreams,signal:NodeJS.Signals)=>{
  if(process.platform!=='win32'&&child.pid){try{process.kill(-child.pid,signal);return;}catch{}}
  child.kill(signal);
 };
 const terminate=(child:ChildProcessWithoutNullStreams):Promise<void>=>{
  if(child.exitCode!==null||child.signalCode!==null)return Promise.resolve();
  return new Promise(resolve=>{
   const timer=setTimeout(()=>{kill(child,'SIGKILL');finish();},2000);
   const finish=()=>{clearTimeout(timer);child.removeListener('close',finish);resolve();};
   child.once('close',finish);kill(child,'SIGTERM');
  });
 };
 const execute=(args:string[]):Promise<string>=>{
  assertOpen();return new Promise((resolve,reject)=>{
   let child:ChildProcessWithoutNullStreams;
   try{child=spawn(command,args,{cwd,env,stdio:'pipe',shell:false,detached:process.platform!=='win32'});}catch(error){reject(error);return;}
   helpers.add(child);let output='',stderr='',settled=false,identityReady=false;
   const timer=setTimeout(()=>{finish(new Error(`${cli} command timed out`));void terminate(child);},30000);
   const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);helpers.delete(child);error?reject(error):resolve(output.trim());};
   child.stdout.setEncoding('utf8');child.stdout.on('data',data=>{output=(output+String(data)).slice(-262144);
    // Cursor can print its durable local ID and keep its event writer open.
    // Retire that helper after the acknowledged ID instead of timing out a new chat.
    if(args[0]==='create-chat'&&!identityReady&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(output.trim())){identityReady=true;void terminate(child).then(()=>finish());}
   });
   child.stderr.on('data',data=>{stderr=(stderr+String(data)).slice(-8192);});
   child.once('error',error=>finish(new Error(runtimeError(error.message,stderr,options.env))));
   child.once('close',code=>finish(code===0||identityReady?undefined:new Error(runtimeError(`${cli} command exited ${code}`,stderr,options.env))));
   child.stdin.end();
  });
 };
 const prepareTurn=async(id:string,input:TurnOptions={})=>{
  assertOpen();if(id!==sessionId||active)throw new Error(`${cli} session is unavailable or busy`);
  if(input.images?.length)throw new Error(`${cli} images are unsupported by this adapter`);
  if(input.effort)throw new Error(`${cli} reasoning effort selection is not verified`);
  validateModel(input.model??model);
 };
 const cancel=async()=>{
  const turn=active;if(!turn)return;turn.cancelled=true;
  if(!turn.started){turn.started=true;emit('turn/started',{turn:{id:turn.id,status:'inProgress'}});}
  if(turn.permission){emit('serverRequest/resolved',{requestId:turn.permission});turn.permission=undefined;}
  if(turn.child)await (turn.stop??=terminate(turn.child));
  turn.settle('interrupted');
 };
 const abort=()=>{void close();};
 const close=()=>{
  if(closing)return closing;closed=true;options.signal?.removeEventListener('abort',abort);
  return closing=Promise.resolve().then(async()=>{await Promise.all([cancel(),...Array.from(helpers,terminate)]);while(pending.size)await Promise.allSettled([...pending]);});
 };
 options.signal?.addEventListener('abort',abort,{once:true});
 const launchNative=(turn:Turn,text:string,input:TurnOptions)=>{
  if(closed||turn.cancelled||active!==turn)return;
  const prompt=instructions?`<mandala-context>\n${instructions}\n</mandala-context>\n\n${text}`:text;
  const args=cli==='cursor'?['--print','--output-format','stream-json','--force','--workspace',cwd]:['--print',prompt,'--output-format','stream-json','--dangerously-skip-permissions'];
  if(nativeId)args.push(cli==='cursor'?'--resume':'--conversation',nativeId);
  const selectedModel=input.model??model;if(selectedModel)args.push('--model',selectedModel);
  if(cli==='cursor')args.push(prompt);
  else if(options.env?.MANDALA_AGY_SETTINGS)args.push('--settings',options.env.MANDALA_AGY_SETTINGS);
  let child:ChildProcessWithoutNullStreams;
  try{child=spawn(command,args,{cwd,env,stdio:'pipe',shell:false,detached:process.platform!=='win32'});turn.child=child;}catch(error){turn.settle('failed',String(error));return;}
  let buffer='',stderr='',chain=Promise.resolve(),resultSeen=false,resultError='',textSeen=false;
  const messageIds=new Set<string>(),calls=new Map<string,Record<string,unknown>>(),messages=new Map<string,string>();
  turn.finishItems=()=>{for(const [id,text] of messages)emit('item/completed',{item:{id,type:'agentMessage',text}});messages.clear();};
  const textDelta=(text:string,id=turn.id+':message')=>{if(!text)return;textSeen=true;if(!messages.has(id))emit('item/started',{item:{id,type:'agentMessage',text:''}});messages.set(id,(messages.get(id)??'')+text);emit('item/agentMessage/delta',{itemId:id,delta:text});};
  const remember=async(id:unknown)=>{
   if(typeof id!=='string'||!id.trim())return;
   if(nativeId&&nativeId!==id)throw new Error(`${cli} returned a different native session ID`);
   if(nativeId)return;
   if(cli==='antigravity'){
    const file=mappingPath(sessionId);await mkdir(join(file,'..'),{recursive:true,mode:0o700});
    const temporary=file+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify({nativeId:id}),{mode:0o600});await rename(temporary,file);
   }
   nativeId=id;
  };
  const event=async(data:any)=>{
   if(active!==turn||turn.cancelled)return;
   const kind=data.event??data.type;
   if(kind==='init'||kind==='system'&&data.subtype==='init')await remember(data.conversation_id??data.session_id);
   else if(kind==='assistant'){
    const id=data.message?.id;if(id&&messageIds.has(id))return;if(id)messageIds.add(id);
    for(const content of data.message?.content??[])if(content.type==='text')textDelta(content.text,id);
   }else if(kind==='thinking'&&data.subtype==='delta')emit('item/reasoning/textDelta',{itemId:turn.id+':thought',delta:data.text??''});
   else if(kind==='tool_call'){
    const id=data.call_id;if(typeof id!=='string')return;
    const name=Object.keys(data.tool_call??{})[0]??'Tool',value=data.tool_call?.[name];
    const item={...calls.get(id),id,type:'mcpToolCall',server:cli,tool:name,...(value?.args!==undefined?{arguments:value.args}:{}),...(value?.result!==undefined?{result:value.result}:{}),status:data.subtype==='completed'?'completed':'inProgress'};
    calls.set(id,item);emit(data.subtype==='completed'?'item/completed':'item/started',{item});
   }else if(kind==='step_update'){
    const step=data.step_update??{},index=data.step_index??step.step_index??0,id=turn.id+':step:'+index;
    if(typeof step.text_delta==='string'&&step.step_type==='agent_response')textDelta(step.text_delta,id);
    const tool=data.tool_name??step.tool_name;if(tool){const info=step.tool_info??{},done=['completed','complete','done','failed','error'].includes(String(data.state??step.state).toLowerCase());emit(done?'item/completed':'item/started',{item:{id,type:'mcpToolCall',server:cli,tool,status:info.error?'failed':done?'completed':'inProgress',...(info.parameters!==undefined?{arguments:info.parameters}:{}),...(info.output!==undefined?{result:info.output}:{}),...(info.error?{error:info.error}:{})}});}
   }else if(kind==='result'){
    const result=cli==='antigravity'?data.result:data;
    await remember(result?.conversation_id??data.session_id);resultSeen=true;
    const error=cli==='cursor'?data.is_error:result?.error||!['success','completed','succeeded'].includes(String(result?.status).toLowerCase());
    if(error)resultError=typeof result?.error==='string'?result.error:typeof result?.result==='string'?result.result:JSON.stringify(result?.error??result??'Native turn failed');
    const finalText=cli==='cursor'?data.result:result?.response;if(!error&&!textSeen&&typeof finalText==='string')textDelta(finalText);
    const usage=result?.usage;if(usage)emit('mandala/usageSnapshot',{usage,model:selectedModel});
   }
  };
  const consume=(line:string)=>{if(!line.trim())return;chain=track(chain.then(async()=>{let data;try{data=JSON.parse(line);}catch{throw new Error(`${cli} returned invalid stream JSON`);}await event(data);}).catch(error=>{resultError=String(error);void terminate(child);}));};
  child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{buffer+=String(chunk);let index;while((index=buffer.indexOf('\n'))>=0){consume(buffer.slice(0,index));buffer=buffer.slice(index+1);}if(buffer.length>1048576){resultError='Native stream line exceeds size limit';void terminate(child);}});
  child.stderr.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-8192);});
  child.once('error',error=>turn.settle(turn.cancelled?'interrupted':'failed',runtimeError(error.message,stderr,options.env)));
  child.once('close',code=>{if(process.platform!=='win32'&&child.pid)kill(child,'SIGKILL');if(buffer.trim())consume(buffer);void chain.then(()=>{
   if(turn.cancelled){turn.settle('interrupted');return;}
   const error=resultError||(!resultSeen?'Native process ended without a terminal result':!nativeId?'Native process did not provide a durable session ID':code!==0?`${cli} exited ${code}`:'');
   turn.settle(error?'failed':'completed',error?runtimeError(error,stderr,options.env):undefined);
  });});child.stdin.end();
 };
 const launch=(turn:Turn,text:string,input:TurnOptions)=>{
  void track((async()=>{if(active!==turn||turn.cancelled||closed)return;if(cli==='antigravity'&&!nativeId)await saveMapping({nativeId:null,started:true});if(active===turn&&!turn.cancelled&&!closed)launchNative(turn,text,input);else if(cli==='antigravity'&&!nativeId)await saveMapping({nativeId:null,started:false});})().catch(error=>turn.settle('failed',String(error))));
 };
 return {
  prepareTurn,
  async getStatus(){return {status:'ready',version:await execute(['--version'])};},
  async listModels(){
   const output=(await execute(cli==='cursor'?['--list-models']:['models'])).replace(/\x1b\[[0-9;]*m/g,'');
   const models:ModelChoice[]=[];
   for(const line of output.split('\n')){const match=/^\s*([\w][\w.\/:+-]*)\s+-\s+(.+?)\s*(\((?:current|default)(?:, (?:current|default))*\))?\s*$/.exec(line);if(match)models.push({id:match[1],label:match[2],...(match[3]?{isDefault:true}:{})});}
   return models;
  },
  async startThread(input){
   assertOpen();if(active||sessionId)throw new Error(`${cli} session is already initialized`);validateMcp(input.mcp);
   if(input.safeSystem)throw new Error(`${cli} cannot disable all tools`);
   validateModel(input.model??model);
   const id=cli==='cursor'?await execute(['create-chat']):'mandala-agy:'+randomUUID();
   if(!id||/\s/.test(id))throw new Error(`${cli} did not provide a valid session ID`);
   sessionId=id;nativeId=cli==='cursor'?id:'';instructions=input.instructions;model=input.model??model;cwd=input.cwd;
   if(cli==='antigravity')await saveMapping({nativeId:null,started:false});return sessionId;
  },
  async resumeThread(id,mcp,nextInstructions,nextModel){
   assertOpen();if(active)throw new Error(`${cli} turn is still running`);validateMcp(mcp);
   validateModel(nextModel??model);
   let restored=id;
   if(cli==='antigravity'){
    try{const saved=JSON.parse(await readFile(mappingPath(id),'utf8'));if(saved.nativeId===null&&saved.started===false)restored='';else if(typeof saved.nativeId==='string'&&saved.nativeId.trim())restored=saved.nativeId;else throw new Error('Invalid ID');}
    catch{throw new Error('Antigravity native session mapping is missing or invalid; this conversation cannot be resumed');}
   }else if(!id.trim()||/\s/.test(id))throw new Error('Invalid Cursor native session ID');
   sessionId=id;nativeId=restored;instructions=nextInstructions??instructions;model=nextModel??model;
  },
  async startTurn(id,text,mode:ApprovalMode='default',_roots,input={}){
   await prepareTurn(id,input);
   const turn:Turn={id:randomUUID(),cancelled:false,started:false,text,input,settle(status,error){
    if(active!==turn)return;
    turn.finishItems?.();
    if(turn.permission){emit('serverRequest/resolved',{requestId:turn.permission});turn.permission=undefined;}
    emit('turn/completed',{turn:{id:turn.id,status,...(error?{error:{message:error}}:{})}});active=undefined;
   }};active=turn;
   setTimeout(()=>{
    if(active!==turn||closed||turn.cancelled)return;turn.started=true;emit('turn/started',{turn:{id:turn.id,status:'inProgress'}});
    if(mode==='auto'){launch(turn,text,input);return;}
    turn.permission=randomUUID();options.onApproval({id:turn.permission,method:'acp/permission',params:{threadId:sessionId,turnId:turn.id,wholeTurnApproval:true,title:`Allow ${cli} tools for this entire turn`,itemId:turn.id+':grant',toolCall:{toolCallId:turn.id+':grant',title:'This entire turn may execute commands and read or change files, including native configured tools. Approval applies to all tools in this turn; individual tools will not prompt again.',kind:'execute'},options:[{optionId:'allow',name:'Allow entire turn',kind:'allow_once'},{optionId:'reject',name:'Reject turn',kind:'reject_once'}]}});
   },0);
   return turn.id;
  },
  async interrupt(id,turnId){if(sessionId===id&&active?.id===turnId)await cancel();},
  replyApproval(id,result){
   const turn=active;if(!turn||turn.permission!==String(id)||closed)return;
   const outcome=(result as any)?.outcome;
   if(outcome?.outcome!=='cancelled'&&(outcome?.outcome!=='selected'||!['allow','reject'].includes(outcome.optionId)))throw new Error('Invalid whole-turn permission choice');
   emit('serverRequest/resolved',{requestId:turn.permission});turn.permission=undefined;
   if(outcome.outcome==='selected'&&outcome.optionId==='allow')launch(turn,turn.text,turn.input);else{turn.cancelled=true;turn.settle('interrupted');}
  },
  close,
 };
}
