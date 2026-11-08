import {isSystemAgent} from '../shared/chat-context';
import DetachedTaskRecovery from './DetachedTaskRecovery';
import type { DraftScope } from '../shared/drafts';
import ComposerRecovery from './ComposerRecovery';
import { useEffect, useRef, useState } from 'react';
import type { TaskDetail } from '../shared/tasks';
import type { Config, Conversation } from '../shared/types';
import { useLanguage } from './i18n';
import { api, requestJson } from './api';
import { useComposerDraft, useComposerDraftIdentity, composerDraftFingerprint, clearAcceptedComposerDraft } from './composer-drafts';
import { restoreSubmission, submitComposerInput, uploadComposerFiles, submissionError, type ComposerSubmission } from './composer-submit';
import ComposerDraftNotice from './ComposerDraftNotice';
import Button from './ui/Button';
import Textarea from './ui/Textarea';
import Input from './ui/Input';
import Select from './ui/Select';
import Icon from './ui/Icon';
import Notice from './ui/Notice';
import Disclosure from './ui/Disclosure';
import { DetailSection } from './ui/WorkspacePage';
import MetadataList from './ui/MetadataList';
import { composingKey } from './shortcuts';
import { enabledRuntimes, runtimeLabel } from '../shared/runtimes';
import './task-reply.css';

export default function TaskReply({detail,config,onChanged,onNeedsAttention}:{detail:TaskDetail;config:Config;onChanged:()=>Promise<void>;onNeedsAttention?:(attention:boolean)=>void}) {
 const {text: localize, language}=useLanguage(),en=language !== 'zh-CN',say=(zh:string,english:string)=>localize(zh, english);
 const chats=detail.readableAssociatedChats??[];
 const [detached,setDetached]=useState<DraftScope[]>([]),[recoveryRevision,setRecoveryRevision]=useState(0);
 useEffect(()=>{let active=true;void api<{pending:{scope:DraftScope}[]}>('/drafts').then(data=>{if(active)setDetached(data.pending.filter(entry=>entry.scope.kind==='task'&&entry.scope.taskId===detail.task.id&&!chats.some(chat=>chat.id===entry.scope.conversationId)).map(entry=>entry.scope));}).catch(()=>{});return()=>{active=false;};},[detail.task.id,detail.task.revision,chats.map(chat=>chat.id).join(','),recoveryRevision]);
 const [target,setTarget]=useState(chats.length===1?chats[0].id:''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [linkOpen,setLinkOpen]=useState(false),[choices,setChoices]=useState<Conversation[]>([]),[linkTarget,setLinkTarget]=useState(''),[preparingAgent,setPreparingAgent]=useState(''),[preparingCli,setPreparingCli]=useState(''),[search,setSearch]=useState(''),[searching,setSearching]=useState(false);
 const input=useRef<HTMLInputElement>(null),composing=useRef(false),request=useRef<ComposerSubmission|null>(null),operation=useRef<{id:string;revision:number;key:string}|null>(null);
 const draft=useComposerDraft({kind:'task',taskId:detail.task.id,conversationId:target},useComposerDraftIdentity());
 const needsAttention=!!draft.pending&&!busy||detached.length>0||!!error||['buffered','error','conflict'].includes(draft.status)||draft.value.missingAttachments.length>0;
 useEffect(()=>{onNeedsAttention?.(needsAttention);},[needsAttention,onNeedsAttention]);
 const selected=chats.find(chat=>chat.id===target),agent=config.agents.find(agent=>agent.id===selected?.agentId);
 useEffect(()=>{if(target&&!chats.some(chat=>chat.id===target))setTarget(chats.length===1?chats[0].id:'');else if(!target&&chats.length===1)setTarget(chats[0].id);},[chats.map(chat=>chat.id).join(','),target]);
 useEffect(()=>{request.current=null;setError('');},[target]);
 const run=async(work:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError('');try{await work();}catch(reason){setError((reason as Error).message==='execution_agent_required'?say('请选择有智能体的对话；纯执行端对话不能执行任务。','Choose a Chat with an Agent. Chats without an Agent cannot execute a Task.'):(reason as Error).message==='execution_conversation_in_use'?say('此对话已属于另一个任务，请选择其他对话。','This Chat already executes another Task. Choose another Chat.'):(reason as Error).message==='execution_has_history'?say('此执行对话已有运行记录或待处理输入／回报，不能移除。','This execution Chat has history or pending input/reports and cannot be removed.'):submissionError(reason,en));}finally{setBusy(false);}};
 const link=async(id:string)=>{
  if(!operation.current||operation.current.id!==id||operation.current.revision!==detail.task.revision)operation.current={id,revision:detail.task.revision,key:crypto.randomUUID()};
  await requestJson('/api/v2/tasks/'+detail.task.id+'/executions',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':operation.current.key},body:JSON.stringify({conversationId:id,expectedRevision:detail.task.revision})});
  operation.current=null;await onChanged();setTarget(id);setLinkOpen(false);
 };
 useEffect(()=>{
  if(!linkOpen)return;const controller=new AbortController();setSearching(true);
  const timer=setTimeout(()=>{void fetch('/api/conversations?query='+encodeURIComponent(search.trim()),{signal:controller.signal}).then(async response=>{if(!response.ok)throw Error(say('无法读取对话','Cannot load conversations'));const chats=await response.json() as Conversation[];if(!controller.signal.aborted)setChoices(chats);}).catch(error=>{if(!controller.signal.aborted)setError(error.message);}).finally(()=>{if(!controller.signal.aborted)setSearching(false);});},search.trim()?200:0);
  return()=>{clearTimeout(timer);controller.abort();};
 },[linkOpen,search]);
 const showLinks=()=>{setSearch('');setLinkOpen(true);};
 const remove=()=>void run(async()=>{
  const execution=detail.executions.find(item=>item.conversationId===target);if(!execution)return;
  if(!operation.current||operation.current.id!==execution.id||operation.current.revision!==detail.task.revision)operation.current={id:execution.id,revision:detail.task.revision,key:crypto.randomUUID()};
  await requestJson('/api/v2/tasks/'+detail.task.id+'/executions/'+execution.id+'/remove',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':operation.current.key},body:JSON.stringify({expectedRevision:detail.task.revision})});
  operation.current=null;await onChanged();
 });
 const prepare=()=>void run(async()=>{
  if(!preparingAgent)throw Error(say('请先选择智能体。','Choose an Agent first.'));
  const agent=config.agents.find(item=>item.id===preparingAgent),cli=enabledRuntimes(config).find(cli=>cli===preparingCli);if(!cli)throw Error(say('请先连接可用执行端。','Connect an available runtime first.'));
  const conversation=await api<Conversation>('/conversations','POST',{projectId:detail.task.projectId??'',agentId:preparingAgent,cli,...agent?.models[cli]?{model:agent.models[cli]}:{}});
  // A failed execution attachment retains this explicitly prepared Chat for an explicit retry.
  setChoices(old=>[conversation,...old]);setLinkTarget(conversation.id);setLinkOpen(true);await link(conversation.id);
 });
 const send=(interrupt=false)=>void run(async()=>{
  if(!selected||!draft.loaded)throw Error(say('请先选择可读取的执行对话。','Choose a readable execution Chat first.'));
  if(!draft.pending&&draft.value.missingAttachments.length)throw Error(say('请先重新选择或移除缺失附件。','Reselect or remove the missing attachments first.'));
  const original=draft.value;
  if(!draft.pending&&request.current&&!request.current.recovery.attempted&&(!request.current.recovery.stopAttempted||request.current.recovery.stopConfirmed))request.current=null;
  let pending=request.current;
  if(draft.pending&&pending?.commandKey!==draft.pending.commandKey)pending=null;
  if(!pending)pending=draft.pending?restoreSubmission(draft.pending):{conversationId:target,commandKey:crypto.randomUUID(),draftFingerprint:composerDraftFingerprint(original),text:original.text,attachments:[],references:original.references.map(item=>({id:item.id})),action:interrupt?'interrupt':['interrupted','error'].includes(selected.status)?'continue':'queue',recovery:interrupt&&selected.executionId?{expectedExecutionId:selected.executionId}:{}};
  request.current=pending;
  if(!pending.recovery.attempted&&!pending.recovery.stopAttempted&&!draft.pending)await uploadComposerFiles(fetch,target,original.files,pending.attachments);
  await submitComposerInput(api,pending,draft.savePending,async()=>{draft.setValue(current=>clearAcceptedComposerDraft(current,pending!.draftFingerprint));await draft.flush();});request.current=null;await onChanged();
 });
 const addFiles=(files:File[])=>{
  if(files.some(file=>!file.size||file.size>20*1024*1024)||draft.value.files.length+files.length>8){setError(say('最多8个附件，每个需为1字节至20MB。','Add up to 8 attachments, each 1 byte to 20 MB.'));return;}
  draft.setValue(value=>({...value,files:[...value.files,...files],missingAttachments:value.missingAttachments.filter(item=>!files.some(file=>file.name===item.name&&file.size===item.size))}));
 };
 const canSend=!!selected&&draft.loaded&&!busy&&(!draft.value.missingAttachments.length||!!draft.pending)&&(!!draft.pending||!!draft.value.text.trim()||!!draft.value.files.length);
 return <DetailSection title={say('补充说明','Add context')}>
  <div className="task-reply">
   {detached.map(scope=><DetachedTaskRecovery key={scope.conversationId} scope={scope} onResolved={()=>setRecoveryRevision(value=>value+1)}/>)}
   {chats.length>0&&<Select ariaLabel={say('目标对话','Target Chat')} value={target} disabled={busy||!chats.length} onChange={setTarget} options={[...(chats.length!==1?[{value:'',label:say('选择执行对话','Choose an execution Chat')}]:[]),...chats.map(chat=>({value:chat.id,label:chat.title||say('未命名对话','Untitled Chat'),description:(config.agents.find(agent=>agent.id===chat.agentId)?.name??runtimeLabel(chat.cli))+' · '+chat.status}))]}/>}
   {selected?<MetadataList items={[{label:say('目标智能体','Target Agent'),value:agent?.name??(selected.agentId?say('智能体不可用','Unavailable Agent'):say('无智能体','No Agent')),icon:'agent'},{label:say('执行端','Runtime'),value:runtimeLabel(selected.cli),icon:'terminal'},{label:say('对话执行状态','Chat execution'),value:say(...({idle:['就绪','Ready'],running:['执行中，回复会排队','Running; replies queue'],approval:['等待审批，回复会排队','Awaiting approval; replies queue'],interrupted:['已停止，发送将继续','Stopped; sending continues'],error:['出错，发送将继续','Error; sending continues']}[selected.status] as [string,string]??[selected.status,selected.status])),icon:'activity'}]}/>:<p className="field-hint">{chats.length?say('此任务有多个执行对话，请明确选择回复目标。','This task has multiple Chats. Choose the destination explicitly.'):say('尚无可读取的执行对话。可设定已有对话或新开执行对话。','No readable execution Chat. Set an existing Chat as an execution or open a new one.')}</p>}
   {chats.length>0&&<Textarea aria-label={say('任务回复','Task reply')} rows={3} disabled={!selected||!draft.loaded} value={draft.value.text} placeholder={say('补充说明、调整要求或继续协作…','Add context, adjust the request, or continue working…')} onChange={event=>draft.setValue(value=>({...value,text:event.target.value}))} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}} onKeyDown={event=>{if(composing.current||composingKey(event.nativeEvent))return;if(event.key==='Enter'&&!event.shiftKey&&!event.ctrlKey&&!event.metaKey&&!event.altKey){event.preventDefault();if(canSend)send();}}}/>}
   {!!draft.value.files.length&&<div className="task-reply-files">{draft.value.files.map((file,index)=><span key={index}><Icon name="paperclip" size={13}/>{file.name}<Button aria-label={say('移除附件 ','Remove attachment ')+file.name} disabled={busy} onClick={()=>draft.setValue(value=>({...value,files:value.files.filter((_,i)=>i!==index)}))}><Icon name="close" size={12}/></Button></span>)}</div>}
   <input ref={input} type="file" multiple hidden onChange={event=>{addFiles(Array.from(event.target.files??[]));event.target.value='';}}/>
   {selected&&<ComposerDraftNotice draft={draft} onReselect={()=>input.current?.click()}/>}
   <ComposerRecovery draft={draft} onResolved={()=>{request.current=null;}}/>
   {chats.length>0&&<div className="task-reply-actions"><Button disabled={busy||!draft.loaded||!selected} onClick={()=>input.current?.click()}><Icon name="paperclip" size={15}/>{say('附件','Attach')}</Button><Button disabled={busy} onClick={showLinks}>{say('设为执行对话','Set execution Chat')}</Button><Button className="primary" disabled={!canSend} onClick={()=>send()}><Icon name={draft.pending?'refresh':selected?.status==='running'?'clock':'arrowUp'} size={15}/>{draft.pending?say('核对上次发送','Check previous send'):selected?.status==='running'||selected?.status==='approval'?say('排队回复','Queue reply'):say('发送回复','Send reply')}</Button></div>}
   {selected&&<Button disabled={busy} onClick={remove}>{say('移除执行对话','Remove execution Chat')}</Button>}
   {selected&&['running','approval'].includes(selected.status)&&!draft.pending&&<Disclosure title={say('打断选项','Interrupt option')}><Button disabled={!canSend} onClick={()=>send(true)}><Icon name="stop" size={14}/>{say('停止当前执行并发送回复','Stop current execution and send reply')}</Button></Disclosure>}
   {linkOpen&&<div className="task-reply-link"><Input type="search" aria-label={say('搜索执行对话','Search execution Chats')} placeholder={say('搜索标题、正文、智能体或项目','Search title, messages, Agent or Project')} value={search} onChange={event=>setSearch(event.target.value)}/><Select ariaLabel={say('已有对话','Existing Chat')} value={linkTarget} disabled={busy||searching} onChange={setLinkTarget} options={[{value:'',label:say('选择可读取的对话','Choose a readable Chat')},...choices.filter(chat=>chat.purpose!=='mandala-main'&&!chats.some(item=>item.id===chat.id)).map(chat=>({value:chat.id,label:chat.title||chat.id,description:config.agents.find(agent=>agent.id===chat.agentId)?.name??runtimeLabel(chat.cli)}))]}/><Button disabled={busy||!linkTarget} onClick={()=>void run(()=>link(linkTarget))}>{say('设为执行对话','Set execution Chat')}</Button><Select ariaLabel={say('新对话智能体','New Chat Agent')} value={preparingAgent} onChange={id=>{setPreparingAgent(id);setPreparingCli(config.agents.find(agent=>agent.id===id)?.defaultCli??'');}} disabled={busy} options={[{value:'',label:say('选择智能体','Choose an Agent')},...config.agents.filter(agent=>!agent.temporary&&!agent.archivedAt&&(!agent.systemRole||isSystemAgent(config,agent))).map(agent=>({value:agent.id,label:agent.name,group:isSystemAgent(config,agent)?say('系统智能体','System Agent'):say('智能体','Agents')}))]}/><Select ariaLabel={say('新对话执行端','New Chat runtime')} value={preparingCli} onChange={setPreparingCli} disabled={busy} options={[{value:'',label:say('选择执行端','Choose runtime')},...enabledRuntimes(config).map(cli=>({value:cli,label:runtimeLabel(cli)}))]}/><Button disabled={busy||!preparingAgent||!enabledRuntimes(config).some(cli=>cli===preparingCli)} onClick={prepare}>{say('新开执行对话','New execution Chat')}</Button><Button disabled={busy} onClick={()=>setLinkOpen(false)}>{say('关闭','Close')}</Button></div>}
   {!chats.length&&!linkOpen&&<Button disabled={busy} onClick={showLinks}><Icon name="plus" size={14}/>{say('设为执行对话 / 新开执行对话','Set / open execution Chat')}</Button>}
   {error&&<Notice className="form-error">{error}</Notice>}
  </div>
 </DetailSection>;
}
