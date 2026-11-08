import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { CodexClient, CodexOptions } from './codex';
import type { ApprovalMode, McpServer } from '../shared/types';
import type { TurnOptions } from '../shared/chat-input';
import { canApproveAcpLocally } from './approval-policy';
import { spawn } from './native-spawn';
import { runtimeError } from './runtime';

const approvalPrefix = 'Mandala tool approval: ';
const noMcp = (mcp?: McpServer[]) => {
  if (mcp?.length) throw new Error('Pi native RPC does not support MCP servers');
};

export async function startPi(options: CodexOptions): Promise<CodexClient> {
  if (options.extraArgs?.length) throw new Error('Pi runtime arguments are managed by Mandala');
  const extensionPath = fileURLToPath(new URL('./pi-permission-extension.mjs', import.meta.url));
  const args = ['--mode', 'rpc', '--no-extensions'];
  if (options.safeSystem) args.push('--no-tools', '--no-skills', '--no-prompt-templates', '--no-context-files');
  else args.push('-e', extensionPath);
  const child = spawn('pi', args, { cwd: options.cwd, stdio: 'pipe', shell: false,
    env: { ...process.env, ...options.env }, detached: process.platform !== 'win32' });
  let closed = false, exited = false, started = false, exitReported = false, stderr = '', sessionId = '', instructions = '', bound = false;
  let model: any;
  let active: { id: string; mode: ApprovalMode; cancelled: boolean; failed: boolean } | undefined;
  let messageId = '', sequence = 0;
  const blocks = new Set<number>(), outputs = new Map<string, string>(), permissions = new Set<string>();
  const pending = new Map<string, {resolve:(value:any)=>void;reject:(error:Error)=>void}>();
  let closing: Promise<void> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<void>(resolve => child.once('close', () => { exited = true; resolve(); }));
  const emit = (method: string, params: Record<string, unknown> = {}) => options.onEvent({method,
    params: {threadId: sessionId, ...(active ? {turnId: active.id} : {}), ...params}});
  const item = (method: string, value: Record<string, unknown>) => emit(method, {item:value});
  const send = (value: unknown) => { if (!exited && !child.stdin.destroyed) child.stdin.write(JSON.stringify(value)+'\n'); };
  const denyPermissions = () => {
    for (const id of permissions) {
      send({type:'extension_ui_response',id,value:'Deny'});
      emit('serverRequest/resolved',{requestId:id});
    }
    permissions.clear();
  };
  const finish = (status: 'completed'|'failed'|'interrupted') => {
    if (!active) return;
    denyPermissions();
    emit('turn/completed',{turn:{id:active.id,status}});
    active = undefined; messageId = ''; blocks.clear(); outputs.clear();
  };
  const fail = (error: unknown) => {
    if (!active) return;
    active.failed = true;
    emit('error',{error:{message:error instanceof Error ? error.message : String(error)}});
  };
  const killGroup = (signal: NodeJS.Signals) => {
    if(process.platform!=='win32'&&child.pid){try{process.kill(-child.pid,signal);return;}catch{}}
    if(!exited)child.kill(signal);
  };
  const terminate = () => {
    if (exited) return;
    killGroup('SIGTERM');
    if(!killTimer){killTimer=setTimeout(() => { killGroup('SIGKILL'); }, 2000);killTimer.unref();}
  };
  const close = () => {
    if (closing) return closing;
    closed = true; finish('interrupted');
    for (const waiter of pending.values()) waiter.reject(new Error('Pi closed'));
    pending.clear();
    child.stdin.end(); terminate();
    options.signal?.removeEventListener('abort', abort);
    closing = Promise.race([stopped, new Promise<void>(resolve => { const timer=setTimeout(resolve,3000); timer.unref(); })]);
    return closing;
  };
  const abort = () => { finish('interrupted'); terminate(); };
  options.signal?.addEventListener('abort', abort, {once:true});
  const request = (type: string, values: Record<string, unknown> = {}) => {
    if (closed || exited) return Promise.reject(new Error('Pi exited'));
    const id = randomUUID();
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {pending.delete(id);reject(new Error(`Pi ${type} timed out`));},15000);
      pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
      send({id,type,...values});
    });
  };
  const beginMessage = (value: any) => {
    messageId = `${active!.id}:message:${++sequence}`; blocks.clear();
    item('item/started',{id:messageId,type:'modelCall',model:value?.model,status:'inProgress'});
  };
  createInterface({input:child.stdout}).on('line', line => {
    let event: any;
    try {event=JSON.parse(line);} catch {return;}
    if (event.type==='response') {
      const waiter=pending.get(event.id);pending.delete(event.id);
      if(event.success)waiter?.resolve(event.data);else waiter?.reject(new Error(event.error||'Pi request failed'));
      return;
    }
    if (event.type==='extension_ui_request') {
      const id=String(event.id);
      if (!['select','confirm','input','editor'].includes(event.method)) return;
      if (closed || options.safeSystem || !active || active.cancelled) {send({type:'extension_ui_response',id,cancelled:true});return;}
      let tool: any;
      if(event.method==='select' && event.title?.startsWith(approvalPrefix) &&
          JSON.stringify(event.options)===JSON.stringify(['Approve','Deny'])) {
        try {tool=JSON.parse(event.title.slice(approvalPrefix.length));} catch {}
      }
      if(!tool || typeof tool.toolName!=='string' || typeof tool.toolCallId!=='string') {
        send({type:'extension_ui_response',id,cancelled:true});return;
      }
      // Pi expands ~, @ prefixes and Unicode spaces, and tries filename variants.
      // Only exact existing absolute ASCII paths can share ACP's path decision.
      const rawPath=tool.input?.path;
      const path=typeof rawPath==='string'&&isAbsolute(rawPath)&&/^[\x20-\x7e]+$/.test(rawPath)&&existsSync(rawPath)?rawPath:undefined;
      const read=tool.toolName==='read' && path && canApproveAcpLocally({kind:'read',rawInput:{path},locations:[{path}]},options.cwd);
      if(active.mode==='auto'||active.mode==='default'&&read) {send({type:'extension_ui_response',id,value:'Approve'});return;}
      permissions.add(id);
      try {options.onApproval({id,method:'omp/confirm',params:{threadId:sessionId,turnId:active.id,
        title:'Pi tool approval',message:`${tool.toolName}\n${JSON.stringify(tool.input)}`,toolApproval:true,itemId:tool.toolCallId}});}
      catch {permissions.delete(id);send({type:'extension_ui_response',id,value:'Deny'});}
      return;
    }
    if(event.type==='extension_error') {
      const error=new Error(event.error||'Pi permission extension failed');
      fail(error);finish('failed');
      for(const waiter of pending.values())waiter.reject(error);pending.clear();
      terminate();return;
    }
    if (!active || closed) return;
    if(event.type==='message_start'&&event.message?.role==='assistant')beginMessage(event.message);
    else if(event.type==='message_update') {
      const update=event.assistantMessageEvent;
      if(!['text_delta','thinking_delta'].includes(update?.type))return;
      if(!messageId)beginMessage(event.message);
      const index=update.contentIndex??0,itemId=`${messageId}:${index}`;
      if(update.type==='text_delta') {
        if(!blocks.has(index)){blocks.add(index);item('item/started',{id:itemId,type:'agentMessage',text:''});}
        emit('item/agentMessage/delta',{itemId,delta:update.delta});
      } else emit('item/reasoning/textDelta',{itemId,delta:update.delta});
    } else if(event.type==='message_end'&&event.message?.role==='assistant') {
      const message=event.message;
      if(!messageId)beginMessage(message);
      emit('mandala/usageMessage',{messageId,model:message.model,usage:message.usage});
      for(const [index,content] of (message.content??[]).entries()) {
        if(content.type==='text')item('item/completed',{id:`${messageId}:${index}`,type:'agentMessage',text:content.text,stopReason:message.stopReason});
        if(content.type==='thinking')item('item/completed',{id:`${messageId}:${index}`,type:'reasoning',content:[content.thinking],summary:[]});
      }
      item('item/completed',{id:messageId,type:'modelCall',model:message.model,status:['error','aborted'].includes(message.stopReason)?'failed':'completed'});
      messageId='';
      if(message.stopReason==='error')fail(message.errorMessage||'Pi model request failed');
      if(message.stopReason==='aborted')active.cancelled=true;
    } else if(event.type==='tool_execution_update') {
      const output=(event.partialResult?.content??[]).filter((part:any)=>part.type==='text').map((part:any)=>part.text).join('\n');
      const previous=outputs.get(event.toolCallId)??'';
      const delta=output.startsWith(previous)?output.slice(previous.length):output;
      outputs.set(event.toolCallId,output);
      if(delta)emit('item/commandExecution/outputDelta',{itemId:event.toolCallId,delta});
    } else if(['tool_execution_start','tool_execution_end'].includes(event.type)) {
      const end=event.type==='tool_execution_end'; outputs.delete(event.toolCallId);
      item(end?'item/completed':'item/started',{id:event.toolCallId,type:'mcpToolCall',server:'Pi',tool:event.toolName,
        arguments:event.args,result:event.result,status:end?(event.isError?'failed':'completed'):'inProgress'});
    } else if(event.type==='agent_end') {
      const last=event.messages?.filter((message:any)=>message.role==='assistant').at(-1);
      finish(active.cancelled||last?.stopReason==='aborted'?'interrupted':active.failed||last?.stopReason==='error'?'failed':'completed');
    } else if(event.type==='auto_retry_end'&&event.success===false) fail(event.finalError||'Pi retry failed');
    else if(event.type==='compaction_end'&&event.result&&!event.aborted)emit('mandala/contextCompacted');
  });
  child.stderr.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-8192);});
  const processError = (error: Error) => {
    for(const waiter of pending.values())waiter.reject(error);pending.clear();
    if(active){fail(error);finish(active?.cancelled?'interrupted':'failed');}
    if(started&&!closed&&!exitReported){exitReported=true;options.onExit(runtimeError('Pi exited',stderr||error.message,options.env));}
  };
  child.on('error',error=>{exited=true;processError(error);});
  child.stdin.on('error',error=>{processError(error);terminate();});
  child.on('exit',(code,signal)=>{
    exited=true; clearTimeout(killTimer); killGroup('SIGKILL'); options.signal?.removeEventListener('abort',abort);
    processError(new Error(`Pi exited (${signal??code??'unknown'})`));
  });
  try {
    // Pi has no ready event: the first command itself is the startup handshake.
    const state=await request('get_state');
    if(typeof state?.sessionFile!=='string'||!isAbsolute(state.sessionFile))throw new Error('Pi did not provide an absolute native session file');
    sessionId=state.sessionFile;model=state.model;
    if(!options.safeSystem){
      const commands=await request('get_commands');
      if(!commands.commands?.some((command:any)=>command.name==='mandala-permission-gate'&&command.source==='extension'&&(command.sourceInfo?.path??command.path)===extensionPath))
        throw new Error('Pi Mandala permission extension did not load; tools cannot run safely');
    }
    started=true;
  } catch(error) {await close();throw error;}
  if(options.signal?.aborted){await close();throw new Error('Pi startup aborted');}
  const current = (nativeId:string) => {
    if(nativeId!==sessionId)throw new Error('Pi native session does not match');
    if(closed||exited)throw new Error('Pi exited');
  };
  const selectModel = async (id?:string) => {
    if(!id)return;
    const catalog=await request('get_available_models');
    const selected=catalog.models?.find((value:any)=>`${value.provider}/${value.id}`===id);
    if(!selected)throw new Error(`Pi model unavailable: ${id}`);
    await request('set_model',{provider:selected.provider,modelId:selected.id});model=selected;
  };
  const prepare = async (turn:TurnOptions={}) => {
    await selectModel(turn.model);
    if(turn.effort) {
      const level=turn.effort==='none'?'off':turn.effort;
      const available=await request('get_available_thinking_levels');
      if(!available.levels?.includes(level))throw new Error(`Pi thinking level unsupported: ${turn.effort}`);
      await request('set_thinking_level',{level});
    }
    if(turn.images?.length&&!model?.input?.includes('image'))throw new Error('Selected Pi model does not support images');
  };
  return {
    async getStatus(){const state=await request('get_state');return {status:state.model?'ready':'login-required',version:null};},
    async listModels(){
      const [catalog,state,thinking]=await Promise.all([request('get_available_models'),request('get_state'),request('get_available_thinking_levels')]);
      return (catalog.models??[]).map((value:any)=>{
        const selected=state.model?.provider===value.provider&&state.model?.id===value.id;
        return {id:`${value.provider}/${value.id}`,label:`${value.provider} / ${value.name??value.id}`,isDefault:selected,
          supportedReasoningEfforts:selected?(thinking.levels??[]).map((level:string)=>level==='off'?'none':level):[],
          ...(selected&&state.thinkingLevel?{defaultReasoningEffort:state.thinkingLevel==='off'?'none':state.thinkingLevel}:{})};
      });
    },
    async startThread(thread){
      noMcp(thread.mcp);
      if(resolve(thread.cwd)!==resolve(options.cwd))throw new Error('Pi cwd cannot change after launch');
      if(thread.safeSystem&&!options.safeSystem)throw new Error('Pi safe system mode requires a restricted process');
      if(active)throw new Error('Pi turn is running');
      if(bound){const result=await request('new_session');if(result?.cancelled)throw new Error('Pi new session cancelled');}
      const state=await request('get_state');
      if(typeof state?.sessionFile!=='string'||!isAbsolute(state.sessionFile))throw new Error('Pi did not provide an absolute native session file');
      sessionId=state.sessionFile;instructions=thread.instructions;await selectModel(thread.model);bound=true;
      return sessionId;
    },
    async resumeThread(nativeId,mcp,nextInstructions,nextModel){
      noMcp(mcp);
      if(!isAbsolute(nativeId))throw new Error('Pi resume requires an absolute native session file');
      if(active)throw new Error('Pi turn is running');
      const switched=await request('switch_session',{sessionPath:nativeId});
      if(switched?.cancelled)throw new Error('Pi session switch cancelled');
      const state=await request('get_state');
      if(state?.sessionFile!==nativeId)throw new Error('Pi resumed session could not be verified');
      sessionId=nativeId;model=state.model;instructions=nextInstructions??'';await selectModel(nextModel);bound=true;
    },
    async listMcpStatus(){return {};},
    async listSkills(){const result=await request('get_commands');return (result.commands??[]).filter((value:any)=>value.source==='skill').map((value:any)=>({name:value.name.replace(/^skill:/,''),path:value.sourceInfo?.path??value.path??''}));},
    async prepareTurn(nativeId,turn){current(nativeId);if(active)throw new Error('Pi turn is running');await prepare(turn);},
    async startTurn(nativeId,text,mode='default',_roots,turn={}){
      current(nativeId);if(active)throw new Error('Pi turn is running');await prepare(turn);
      const images=await Promise.all((turn.images??[]).map(async image=>({type:'image',mimeType:image.mimeType,data:(await readFile(image.path)).toString('base64')})));
      const id=randomUUID();active={id,mode,cancelled:false,failed:false};
      setTimeout(()=>{
        if(closed||!active||active.id!==id)return;
        emit('turn/started',{turn:{id,status:'inProgress'}});
        const message=instructions?`<mandala-context>\nCurrent Mandala invocation instructions replace earlier Mandala context.\n${instructions}\n</mandala-context>\n\n${text}`:text;
        void request('prompt',{message,...(images.length?{images}:{})}).catch(error=>{if(active?.id===id){fail(error);finish(active.cancelled?'interrupted':'failed');}});
      },0);
      return id;
    },
    async interrupt(nativeId,turnId){current(nativeId);if(active?.id!==turnId)return;active.cancelled=true;denyPermissions();send({type:'abort'});finish('interrupted');terminate();},
    replyApproval(id,result){
      const key=String(id);if(!permissions.delete(key))return;
      const accepted=!closed&&!!active&&!active.cancelled&&(result as {decision?:string}|null)?.decision==='accept';
      send({type:'extension_ui_response',id:key,value:accepted?'Approve':'Deny'});
    },
    close,
  };
}
