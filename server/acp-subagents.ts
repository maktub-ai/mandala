import {ndJsonStream,type SessionNotification} from '@agentclientprotocol/sdk';
import {Readable,type Writable} from 'node:stream';
import type {Cli} from '../shared/types';
import type {SubagentStatus} from '../shared/native-subagents';

type Update=SessionNotification['update'];
type Status=SubagentStatus;
type Child={key:string;parent:string;turn:string;agentId?:string;teamIdentity?:string;name?:string|null;task?:string|null;status?:Status;updatedAt?:number;parentCall?:string;memberTask?:string};
type Snapshot={type:'nativeSubagent';id:string;agentId?:string;name?:string|null;task?:string|null;status:Status;text?:string};
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const string=(value:unknown)=>typeof value==='string'&&value.trim()?value:undefined;
const memberKey='codebuddy.ai/memberEvent', subagentKey='codebuddy.ai/subagent', rosterKey='codebuddy.ai/teamUpdate';

function reportedStatus(value:unknown):Status {
 switch(value){
  case 'running':case 'completed':case 'failed':return value;
  case 'cancelled':case 'aborted':case 'stopped':return 'interrupted';
  default:return 'unknown';
 }
}
function stateStatus(state:unknown):Status{
 const current=object(state);
 if(current.state==='running')return 'running';
 if(current.state==='idle'){
  if(current.stopReason==='end_turn')return 'completed';
  if(current.stopReason==='cancelled')return 'interrupted';
  if(current.stopReason==='error'||current.stopReason==='refusal')return 'failed';
 }
 return 'unknown';
}

// acpx 0.22 sends one complete NDJSON message per write. Add the negotiated
// capability to its initial handshake, retaining the real pipe and write receipts.
export function advertiseAcpSubagents(input:Writable) {
 const write=input.write;
 type Callback=(error?:Error|null)=>void;
 input.write=function(chunk,encoding?:BufferEncoding|Callback,callback?:Callback){
  input.write=write;
  const handshake=JSON.parse(Buffer.from(chunk).toString('utf8'));
  if(handshake.method==='initialize'&&handshake.params?.clientCapabilities){
   handshake.params.clientCapabilities.subagents={};
   chunk=Buffer.from(JSON.stringify(handshake)+'\n');
  }
  return typeof encoding==='string'?input.write(chunk,encoding,callback):input.write(chunk,encoding??callback);
 };
}

// acpx's config reducer uses one control record for the whole process. Keep
// child config out of it, including same-session vendor-tagged child updates.
// Normalize legacy Claude frames before the SDK can log their task on rejection.
export function normalizeAcpSessionOutput(output:Readable,cli:Cli,acceptConfig:(sessionId:string,meta:Record<string,unknown>)=>boolean) {
 const configured=Number(process.env.ACPX_MAX_ACP_MESSAGE_BYTES?.trim()||64*1024*1024);
 const {readable}=ndJsonStream(new WritableStream(),Readable.toWeb(output) as ReadableStream<Uint8Array>,{
  maxMessageBytes:configured===0?Number.MAX_SAFE_INTEGER:configured,
 });
 return Readable.from((async function*(){
  const reader=readable.getReader();
  try{
   for(;;){
    const {done,value}=await reader.read();
    if(done)return;
    if('method' in value&&value.method==='session/update'){
     const params=object(value.params),u=object(params.update),child=string(u.subagentSessionId);
     if(u.sessionUpdate==='config_option_update'&&(typeof params.sessionId!=='string'||!acceptConfig(params.sessionId,object(u._meta))))continue;
     if(cli==='claude'&&child&&u.sessionUpdate==='subagent_spawned'){
      params.update={sessionUpdate:'subagent_update',sessionId:child,title:string(u.name),description:string(u.task),state:{state:'running'}};
     }else if(cli==='claude'&&child&&u.sessionUpdate==='subagent_state_update'){
      const reasons:Record<string,string>={completed:'end_turn',failed:'error',cancelled:'cancelled'};
      const stopReason=typeof u.state==='string'&&Object.hasOwn(reasons,u.state)?reasons[u.state]:undefined;
      params.update={sessionUpdate:'subagent_update',sessionId:child,state:stopReason?{state:'idle',stopReason}:{state:'unknown'}};
     }
    }
    yield Buffer.from(JSON.stringify(value)+'\n');
   }
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 })(),{objectMode:false});
}

// The wire observer runs before ACPX flattens session ownership and vendor metadata.
// Read only the notification shapes this UI supports; leave future variants to ACPX.
export function readAcpNotification(params:unknown):SessionNotification|undefined {
 const outer=object(params),u=object(outer.update);
 if(typeof outer.sessionId!=='string'||u._meta!=null&&(typeof u._meta!=='object'||Array.isArray(u._meta)))return;
 let update=u;
 const content=(value:unknown)=>{const part=object(value);return typeof part.type==='string'&&(part.type!=='text'||typeof part.text==='string');};
 switch(update.sessionUpdate){
  case 'subagent_update':
   if(!string(update.sessionId)||[update.title,update.description].some(v=>v!=null&&typeof v!=='string'))return;
   break;
  case 'session_info_update': break;
  case 'config_option_update': {
   const choice=(item:unknown)=>{const o=object(item);return typeof o.value==='string'&&typeof o.name==='string';};
   const valid=(item:unknown)=>{
    const o=object(item);
    if(typeof o.id!=='string'||typeof o.name!=='string')return false;
    if(o.type==='boolean')return typeof o.currentValue==='boolean';
    return o.type==='select'&&typeof o.currentValue==='string'&&Array.isArray(o.options)&&o.options.every(raw=>{
     const group=object(raw);
     return 'options' in group?typeof group.group==='string'&&typeof group.name==='string'&&Array.isArray(group.options)&&group.options.every(choice):choice(raw);
    });
   };
   if(!Array.isArray(update.configOptions)||!update.configOptions.every(valid))return;
   break;
  }
  case 'session_message': case 'session_message_chunk':
   if(!string(update.messageId)||[update.senderSessionId,update.recipientSessionId].some(v=>v!=null&&typeof v!=='string'))return;
   if(update.sessionUpdate==='session_message_chunk'?!content(update.content):update.content!=null&&(!Array.isArray(update.content)||!update.content.every(content)))return;
   break;
  case 'agent_message_chunk': case 'agent_thought_chunk': {
   const block=object(update.content);
   if(block.type&&block.type!=='text')return;
   const text=typeof block.text==='string'&&block.text?block.text:update.text;
   if(typeof text!=='string'||!text)return;
   update={...update,content:{type:'text',text}};
   break;
  }
  case 'tool_call': case 'tool_call_update':
   if(!string(update.toolCallId)||update.title!=null&&typeof update.title!=='string'||
    update.locations!=null&&!Array.isArray(update.locations)||update.kind!=null&&typeof update.kind!=='string'||
    update.content!=null&&(!Array.isArray(update.content)||!update.content.every(part=>content(part)&&(part.type!=='content'||content(part.content)))))return;
   break;
  case 'plan': {
   if(!Array.isArray(update.entries))return;
   const entries=update.entries.flatMap(entry=>{
    const step=string(entry?.content)?.trim(),status=string(entry?.status)?.trim();
    return step&&status&&['pending','in_progress','completed'].includes(status)?[{content:step,status}]:[];
   });
   if(update.entries.length&&!entries.length)return;
   update={...update,entries};break;
  }
  default: return;
 }
 return {sessionId:outer.sessionId,update:update as Update};
}
export class AcpSubagents {
 private root='';
 private turn='';
 private children=new Map<string,Child>();
 private teams=new Map<string,Map<string,Child>>();
 private calls=new Map<string,Child>();
 private rootToolNames=new Map<string,string>();
 private reports=new Map<string,{sender:string;text:string}>();
 private pending=new Map<string,Snapshot>();
 private timer?:ReturnType<typeof setTimeout>;
 private rows=new Map<string,Snapshot>();
 private text=new Map<string,string>();
 constructor(private cli:Cli|undefined,private emit:(item:Snapshot)=>void,private expire:(id:string)=>void){}
 bind(root:string){
  if(this.root===root)return;
  this.root=root;this.children.clear();this.teams.clear();this.begin('');
 }
 begin(turn:string){
  clearTimeout(this.timer);this.timer=undefined;this.pending.clear();this.turn=turn;
  this.rows.clear();this.calls.clear();this.rootToolNames.clear();this.reports.clear();this.text.clear();
 }
 flush(){
  clearTimeout(this.timer);this.timer=undefined;
  for(const snapshot of this.pending.values())this.emit(snapshot);
  this.pending.clear();
 }
 private record(child:Child,patch:Partial<Pick<Child,'agentId'|'name'|'task'|'status'>>={},body?:string,streaming=false){
  Object.assign(child,patch);
  if(!this.turn||child.turn!==this.turn)return;
  const old=this.rows.get(child.key);
  const item:Snapshot={type:'nativeSubagent',id:JSON.stringify(['acp-subagent',this.turn,child.key]),
   agentId:child.teamIdentity??child.agentId,name:child.name,task:child.task,status:child.status??'unknown',text:body??old?.text};
  if(old&&item.agentId===old.agentId&&item.name===old.name&&item.task===old.task&&item.status===old.status&&item.text===old.text)return;
  this.rows.set(child.key,item);
  if(streaming&&old){
   // Keep the latest text snapshot per child, instead of persisting the whole
   // growing response for each token. Terminal updates and turn end flush it.
   this.pending.set(child.key,item);
   this.timer??=setTimeout(()=>this.flush(),200);
  }else{this.pending.delete(child.key);this.emit(item);}
  if(item.agentId&&['completed','failed','interrupted'].includes(item.status))this.expire(item.agentId);
 }
 private session(childId:string,parent:string,preferred?:Child){
  if(childId===this.root||childId===parent||parent!==this.root&&!this.children.has(parent))return;
  const old=this.children.get(childId);
  if(old&&old.parent!==parent)return;
  const child=old??preferred??{key:JSON.stringify(['session',childId]),parent,turn:parent===this.root?this.turn:this.children.get(parent)?.turn??''};
  child.agentId=childId;this.children.set(childId,child);return child;
 }
 private member(name:unknown){
  if(typeof name!=='string')return;
  const matches=[...this.teams.values()].map(team=>team.get(name)).filter((child):child is Child=>!!child);
  return matches.length===1?matches[0]:undefined;
 }
 // undefined is the ordinary root, null is an untrusted or unresolved child.
 owner(id:string,meta:Record<string,unknown>|null|undefined):Child|null|undefined{
  const direct=id===this.root?undefined:this.children.get(id)??null;
  if(direct===null||direct&&this.turn&&direct.turn!==this.turn)return null;
  if(this.cli==='codebuddy'&&meta){
   if(subagentKey in meta){
    const ref=object(meta[subagentKey]);
    const child=ref.version===1&&typeof ref.sessionId==='string'?this.children.get(ref.sessionId):undefined;
    if(!child||this.turn&&child.turn!==this.turn||direct&&direct!==child||ref.rootSessionId!==undefined&&ref.rootSessionId!==this.root||
     ref.parentSessionId!==undefined&&ref.parentSessionId!==child.parent)return null;
    if(memberKey in meta&&this.member(meta[memberKey])!==child)return null;
    return child;
   }
   if(memberKey in meta||meta['codebuddy.ai/isTeamMember']===true){
    const child=this.member(meta[memberKey]??meta['codebuddy.ai/memberName']);
    return child&&(!this.turn||child.turn===this.turn)&&(!direct||direct===child)?child:null;
   }
   if('codebuddy.ai/parentToolCallId' in meta){
    const callId=string(meta['codebuddy.ai/parentToolCallId']);
    const child=callId?this.calls.get(callId):undefined;
    return child&&child.turn===this.turn&&(!direct||direct===child)?child:null;
   }
   if(meta['codebuddy.ai/isSubAgent']===true&&!direct)return null;
  }
  const claudeMeta=object(meta?.claudeCode);
  if(this.cli==='claude'&&!direct&&'agentId' in claudeMeta){
   const id=string(claudeMeta.agentId),child=id?this.children.get(id):undefined;
   return child&&child.turn===this.turn?child:null;
  }
  const parentCall=string(claudeMeta.parentToolUseId);
  if(this.cli==='claude'&&!direct&&parentCall)return this.calls.get(parentCall)??null;
  return direct;
 }
 private roster(event:Record<string,unknown>){
  const teamName=string(event.teamName);
  if(!teamName)return;
  if(event.type==='team_deleted'){
   for(const member of this.teams.get(teamName)?.values()??[]){
    this.expire(member.teamIdentity??member.agentId??member.key);
    if(member.agentId)this.children.delete(member.agentId);
   }
   this.teams.delete(teamName);return;
  }
  if(event.type!=='member_status_change'||!Array.isArray(event.members))return;
  const previous=this.teams.get(teamName),next=new Map<string,Child>();
  for(const raw of event.members){
   const m=object(raw),name=string(m.name);if(!name)continue;
   const memberId=string(m.sessionId);
   const old=previous?.get(name);
   const teamIdentity=JSON.stringify(['teamMember',teamName,name]);
   const fallback=old&&(!memberId||old.agentId===memberId||!old.agentId)?old:{key:teamIdentity,parent:this.root,teamIdentity,turn:this.turn};
   const callId=string(m.parentToolCallId),call=callId?this.calls.get(callId):undefined;
   const child=memberId?this.session(memberId,this.root,call??(old&&!old.agentId?fallback:undefined)):call??fallback;
   if(!child)continue;
   const memberTask=string(m.taskId);
   if(call?.turn===this.turn||memberTask&&child.memberTask&&memberTask!==child.memberTask)child.turn=this.turn;
   child.memberTask=memberTask??child.memberTask;
   if(callId)this.calls.set(callId,child);
   next.set(name,child);
   const task=string(m.description)??child.task;
   const status=m.status?reportedStatus(m.status):child.status;
   // A roster snapshot can repeat finished members from a previous turn.
   if(old!==child||name!==child.name||task!==child.task||status!==child.status)this.record(child,{name,task,status});
  }
  for(const [name,member] of previous??[]){
   if(next.get(name)===member)continue;
   this.expire(member.teamIdentity??member.agentId??member.key);
   if(member.agentId&&this.children.get(member.agentId)===member)this.children.delete(member.agentId);
  }
  this.teams.set(teamName,next);
 }
 handle(id:string,u:Update):boolean{
  if(!this.root||id!==this.root&&!this.children.has(id))return true;
  if(u.sessionUpdate==='subagent_update'){
   const callId=this.cli==='claude'&&id===this.root?string(object(u._meta?.claudeCode).parentToolUseId):undefined;
   const child=this.session(u.sessionId,id,callId?this.calls.get(callId):undefined);
   if(child){
    this.record(child,{...(u.title!==undefined?{name:u.title}:{}),...(u.description!==undefined?{task:u.description}:{}),
     ...(u.state!==undefined?{status:stateStatus(u.state)}:{})});
   }
   return true;
  }
  const meta=u._meta;
  if(this.cli==='codebuddy'&&id===this.root&&meta&&rosterKey in meta){this.roster(object(meta[rosterKey]));return true;}
  if(this.cli==='codebuddy'&&meta&&subagentKey in meta){
   const snap=object(meta[subagentKey]),childId=string(snap.sessionId),parent=string(snap.parentSessionId);
   if(snap.version===1&&childId&&parent&&snap.rootSessionId===this.root&&(id===this.root||id===parent)){
    const callId=string(snap.parentToolCallId);
    const call=callId&&parent===this.root?this.calls.get(callId):undefined;
    const child=this.session(childId,parent,call);
    if(child){
     const timestamp=typeof snap.updatedAt==='number'?snap.updatedAt:undefined;
     if(timestamp!==undefined&&child.updatedAt!==undefined&&timestamp<child.updatedAt)return true;
     if(callId&&parent===this.root)this.calls.set(callId,child);
     child.updatedAt=timestamp??child.updatedAt;
     if(call?.turn===this.turn||snap.status==='running'&&callId&&child.parentCall&&callId!==child.parentCall&&
      (parent===this.root||this.children.get(parent)?.turn===this.turn))child.turn=this.turn;
     child.parentCall=callId??child.parentCall;
     this.record(child,{name:string(snap.agentNickname)??string(snap.role)??child.name,task:string(snap.description)??child.task,
      status:snap.status?reportedStatus(snap.status):child.status},string(snap.error));
    }
   }
  }
  if(u.sessionUpdate==='session_message'||u.sessionUpdate==='session_message_chunk'){
   if(!this.turn)return true;
   const key=JSON.stringify([id,u.messageId]),old=this.reports.get(key);
   const sender=u.senderSessionId??old?.sender;
   const recipient=u.recipientSessionId&&this.children.get(u.recipientSessionId);
   if(recipient&&sender===recipient.parent&&(sender===this.root||this.children.get(sender)?.turn===this.turn)){
    if(recipient.turn!==this.turn){
     recipient.turn=this.turn;
     this.record(recipient,{status:'unknown'});
    }
    return true;
   }
   const child=sender&&this.children.get(sender);
   if(!child||child.turn!==this.turn||old&&old.sender!==sender||u.recipientSessionId&&u.recipientSessionId!==this.root&&!this.children.has(u.recipientSessionId))return true;
   const body=u.sessionUpdate==='session_message_chunk'?(old?.text??'')+(u.content.type==='text'?u.content.text:''):
    u.content===undefined?old?.text??'':(u.content??[]).flatMap(part=>part.type==='text'?[part.text]:[]).join('\n');
   this.reports.set(key,{sender:child.agentId!,text:body});
   this.record(child,{},body,u.sessionUpdate==='session_message_chunk');return true;
  }
  const child=this.owner(id,meta);
  if(child===null)return true;
  if(child){
   if(this.turn&&u.sessionUpdate==='agent_message_chunk'&&u.content.type==='text'){
    const body=(this.text.get(child.key)??'')+u.content.text;
    this.text.set(child.key,body);this.record(child,{},body,true);
   }else if(this.turn&&(u.sessionUpdate==='tool_call'||u.sessionUpdate==='tool_call_update')&&u.title&&!this.text.has(child.key)){
    this.record(child,{},u.title);
   }
   return true;
  }
  if(this.turn&&(u.sessionUpdate==='tool_call'||u.sessionUpdate==='tool_call_update'))return this.delegation(u);
  return false;
 }
 private delegation(u:Extract<Update,{sessionUpdate:'tool_call'|'tool_call_update'}>){
  const input=object(u.rawInput),desc=string(input.description),meta=u._meta;
  let child=this.calls.get(u.toolCallId);
  if(u.sessionUpdate==='tool_call'&&u.title)this.rootToolNames.set(u.toolCallId,u.title);
  const original=this.rootToolNames.get(u.toolCallId);
  if(!child){
   const matched=this.cli==='opencode'&&original==='task'&&string(input.subagent_type)||
    this.cli==='dsh'&&['subagent','subagent_fork'].includes(original??'')||
    this.cli==='kimi'&&['Agent','AgentSwarm'].includes(original??'')&&!!desc||
    this.cli==='codebuddy'&&meta?.['codebuddy.ai/isSubagent']===true||
    this.cli==='claude'&&['Agent','Task'].includes(String(object(meta?.claudeCode).toolName));
   if(!matched)return false;
   child={key:JSON.stringify(['call',u.toolCallId]),parent:this.root,turn:this.turn,status:'dispatching'};
   this.calls.set(u.toolCallId,child);
  }
  const metadata=object(object(u.rawOutput).metadata);
  let childId=this.cli==='opencode'&&metadata.parentSessionId===this.root?string(metadata.sessionId):undefined;
  if(this.cli==='dsh'&&u.status==='completed'&&u.content?.length===1){
   const only=u.content[0];
   if(only.type==='content'&&only.content.type==='text')childId=/^started subagent ([A-Za-z0-9_:/.-]+)$/.exec(only.content.text)?.[1];
  }
  // Kimi renders its own identity and status header before model-authored output.
  // A batched AgentSwarm or arbitrary text containing an agent_id is not this header.
  const report=this.cli==='kimi'&&original==='Agent'&&typeof u.rawOutput==='string'?kimiReport(u.rawOutput):undefined;
  childId??=report?.id;
  const receiptStatus=u.status==='failed'?'failed':u.status==='completed'?'dispatched':child.status;
  const status=child.status&&!['unknown','dispatching','dispatched'].includes(child.status)?child.status:receiptStatus;
  if(childId&&childId!==this.root&&(!this.children.has(childId)||this.children.get(childId)?.parent===this.root))child.agentId=childId;
  this.record(child,{...(desc?{task:desc}:{}),...(report?{name:report.name}:{}),status:report?.status??status},report?.text);
  return true;
 }
}

function kimiReport(output:string):{id:string;name:string;status:Status;text?:string}|undefined{
 const foreground=/^agent_id: ([^\s]+)\nactual_subagent_type: ([^\r\n]+)\nstatus: (completed|failed)\nstop_reason: ([^\r\n]+)/.exec(output);
 if(foreground){
  const status=foreground[4]==='cancelled'?'interrupted':reportedStatus(foreground[3]);
  const text=status==='completed'?/\n\n\[summary\]\n([\s\S]*?)\n\nresume_hint:/.exec(output)?.[1]:
   /\n\nsubagent error: ([^\n]+)/.exec(output)?.[1];
  return {id:foreground[1],name:foreground[2],status,text};
 }
 const background=/^task_id: [^\s]+\nstatus: running\nagent_id: ([^\s]+)\nactual_subagent_type: ([^\r\n]+)\nautomatic_notification: true(?:\n|$)/.exec(output);
 return background?{id:background[1],name:background[2],status:'running'}:undefined;
}
