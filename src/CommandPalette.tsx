import { devicePreferences } from './devicePreferences';
import Button from './ui/Button';
import Input from './ui/Input';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Config, ModelChoice } from '../shared/types';
import type { TaskDetail } from '../shared/tasks';
import type { WorkbenchSnapshot } from '../shared/workbench';
import { paletteCommands, stoppablePaletteTargets, parsePaletteQuery, matchPaletteCommands, preselectPaletteTarget, createPaletteRequestGate, paletteKeyIntent, paletteCommandUnavailable, recentPaletteCommands, type PaletteAction, type PaletteContext, type WorkspaceSearchResult } from '../shared/command-palette';
import Dialog from './Dialog';
import { api } from './api';
import { useLanguage } from './i18n';
import './command-palette.css';
import { shortcutLabel } from './shortcuts';
export type { PaletteAction, PaletteContext } from '../shared/command-palette';

type Flow = {step:'task';command:string}|{step:'conversation';task:WorkspaceSearchResult}|{step:'confirm';task:WorkspaceSearchResult;conversation:WorkspaceSearchResult}|{step:'agent';command:string}|{step:'model'}|{step:'stop'};
type Row = {id:string;title:string;snippet:string;unavailable?:string;result?:WorkspaceSearchResult;model?:ModelChoice};
const historyKey='mana-command-history';
const readRecent=()=>{try{return recentPaletteCommands(JSON.parse(devicePreferences.getItem(historyKey)??'[]'));}catch{return [];}};
const search=(query:string,kind?:WorkspaceSearchResult['kind'])=>api<WorkspaceSearchResult[]>('/workspace-search?'+new URLSearchParams({query,...(kind?{kind}:{})}));
export async function linkPaletteConversation(taskId:string,conversationId:string,key:string):Promise<void> {
 // Read current authority and revision immediately before the mutation, never from a search hit.
 const detail=await api<TaskDetail>('/v2/tasks/'+encodeURIComponent(taskId));
 if(detail.task.conversationIds.includes(conversationId))return;
 const response=await fetch('/api/v2/tasks/'+encodeURIComponent(taskId)+'/executions',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({conversationId,expectedRevision:detail.task.revision})});
 const data=await response.json();if(!response.ok)throw new Error(data.error??'Request failed');
}

type CommandPaletteProps = {open?:boolean;config:Config;context:PaletteContext;onNavigate:(href:string)=>void|Promise<void>;onAction:(action:PaletteAction)=>void|Promise<void>;onClose:()=>void};
export default function CommandPalette(props:CommandPaletteProps) {return props.open===false?null:<PaletteDialog {...props}/>;}
function PaletteDialog({config,context,onNavigate,onAction,onClose}:CommandPaletteProps) {
 const {text: localize, language}=useLanguage(),say=(zh:string,en:string)=>localize(zh, en);
 const [input,setInput]=useState('> '),[flow,setFlow]=useState<Flow|null>(null),[selected,setSelected]=useState(0),[loaded,setLoaded]=useState<{key:string;rows:Row[]}|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false),[recent,setRecent]=useState(readRecent);
 const gate=useRef(createPaletteRequestGate()),inputRef=useRef<HTMLInputElement>(null),composing=useRef(false),mutationKey=useRef(''),previousStep=useRef('');
 const parsed=parsePaletteQuery(input),requestKey=JSON.stringify([input,flow,context.conversation?.id]);
 const asyncMode=!!flow&&flow.step!=='confirm'||!flow&&parsed.mode==='objects';
 const commandRows=useMemo(()=>{
  const commands=matchPaletteCommands(parsed.query);if(!parsed.query)commands.sort((a,b)=>{const rank=(id:string)=>recent.includes(id)?recent.indexOf(id):-1;return (rank(a.id)<0?99:rank(a.id))-(rank(b.id)<0?99:rank(b.id));});
  return commands.map(command=>{const reason=paletteCommandUnavailable(command.id,context);return {id:command.id,title:localize(command.label[0], command.label[1]),snippet:reason==='locked'?say('请先保存或取消当前编辑','Save or cancel the current edit first'):reason==='conversation'?say('请先打开一个对话','Open a conversation first'):reason==='running'?say(command.id==='model'?'执行结束后可切换模型':'当前对话没有正在进行的执行',command.id==='model'?'Change model after execution ends':'The current conversation has no running execution'):'',...(reason?{unavailable:reason}:{})};});
 },[parsed.query,language,recent,context.navigationLocked,context.conversation?.id,context.conversation?.status]);
 const rows:Row[]=asyncMode?(loaded?.key===requestKey?loaded.rows:[]):flow?.step==='confirm'||parsed.mode==='help'?[]:commandRows;
 useEffect(()=>{
  const revision=gate.current.next();setError('');
  if(!asyncMode){setLoading(false);setSelected(0);return;}
  setLoading(true);
  const fetchRows=async():Promise<Row[]>=>{
   if(flow?.step==='model'){
    const chat=context.conversation;if(!chat)return [];
    const query=new URLSearchParams({cli:chat.cli,projectId:chat.projectId,agentId:chat.agentId,...(chat.workspaceId?{workspaceId:chat.workspaceId}:{}),...(chat.cwd?{cwd:chat.cwd}:{})});
    return (await api<ModelChoice[]>('/models?'+query)).filter(model=>!parsed.query||[model.id,model.label].join(' ').toLowerCase().includes(parsed.query)).map(model=>({id:model.id,title:model.label,snippet:model.id===chat.model?say('当前模型','Current model'):'',model}));
   }
   if(flow?.step==='stop'){
    const snapshot=await api<WorkbenchSnapshot>('/workbench');
    return stoppablePaletteTargets(snapshot,config,parsed.query).map(result=>({id:result.kind+':'+result.id,title:result.title,snippet:result.snippet,result}));
   }
   const kind=flow?.step==='task'?'task':flow?.step==='conversation'?'conversation':flow?.step==='agent'?'agent':undefined;
   return (await search(parsed.query,kind)).map(result=>({id:result.kind+':'+result.id,title:result.title,snippet:result.snippet,result}));
  };
  void fetchRows().then(items=>{
   if(!gate.current.isCurrent(revision))return;
   setLoaded({key:requestKey,rows:items});setLoading(false);
   const current=flow?.step==='task'?context.taskId:flow?.step==='conversation'||flow?.step==='stop'?context.conversation?.id:flow?.step==='agent'?context.agentId:flow?.step==='model'?context.conversation?.model:undefined;
   setSelected(preselectPaletteTarget(items.map(row=>({id:row.result?.id??row.id})),current??undefined));
  }).catch(e=>{if(gate.current.isCurrent(revision)){setError(e.message);setLoading(false);setLoaded({key:requestKey,rows:[]});}});
  return()=>{gate.current.next();};
 },[requestKey]);
 useEffect(()=>{const step=flow?.step??'';if(step!==previousStep.current){previousStep.current=step;inputRef.current?.focus();}},[flow?.step]);
 useEffect(()=>{document.getElementById('palette-row-'+selected)?.scrollIntoView({block:'nearest'});},[selected]);
 const remember=(id:string)=>{const next=recentPaletteCommands([id,...recent]);setRecent(next);try{devicePreferences.setItem(historyKey,JSON.stringify(next));}catch{}};
 const reset=()=>{gate.current.next();setFlow(null);setInput('> ');setSelected(0);setError('');};
 const start=(next:Flow)=>{gate.current.next();setFlow(next);setInput('');setSelected(0);setError('');};
 const run=async(operation:()=>void|Promise<void>,command?:string)=>{
  if(busy)return;
  if(context.navigationLocked&&command!=='theme'){setError(say('请先保存或取消当前编辑','Save or cancel the current edit first'));return;}
  setBusy(true);setError('');try{await operation();if(command)remember(command);onClose();}catch(e){const code=(e as Error).message;setError(code==='execution_agent_required'?say('请选择有智能体的对话；纯执行端对话不能执行任务。','Choose a Chat with an Agent. Chats without an Agent cannot execute a Task.'):code==='execution_conversation_in_use'?say('此对话已属于另一个任务，请选择其他对话。','This Chat already executes another Task. Choose another Chat.'):code);}finally{setBusy(false);}
 };
 const navigate=(href:string,command?:string)=>run(()=>onNavigate(href),command);
 const action=(value:PaletteAction)=>run(()=>onAction(value),value.type);
 const choose=async(row:Row)=>{
  if(row.unavailable||busy||composing.current)return;
  if(context.navigationLocked&&row.id!=='theme'){setError(say('请先保存或取消当前编辑','Save or cancel the current edit first'));return;}
  if(flow?.step==='task'&&row.result){
   if(flow.command==='task-link'){start({step:'conversation',task:row.result});return;}
   const action=flow.command.slice('task-'.length);await navigate(row.result.href+'?action='+action,flow.command);return;
  }
  if(flow?.step==='conversation'&&row.result){mutationKey.current=crypto.randomUUID();start({step:'confirm',task:flow.task,conversation:row.result});return;}
  if(flow?.step==='stop'&&row.result){await action({type:'stop',conversationId:row.result.id});return;}
  if(flow?.step==='agent'&&row.result){await navigate(flow.command==='agent-config'?'/settings/agents?agent='+encodeURIComponent(row.result.id):'/?focusAgent='+encodeURIComponent(row.result.id),flow.command);return;}
  if(flow?.step==='model'&&row.model&&context.conversation){await action({type:'model',conversationId:context.conversation.id,model:row.model.id});return;}
  if(row.result){await navigate(row.result.href);return;}
  const command=paletteCommands.find(command=>command.id===row.id);if(!command)return;
  if(command.target){start({step:command.target,command:command.id});return;}
  const routes:Record<string,string>={usage:'/usage',conversations:'/?conversation=',tasks:'/tasks',projects:'/settings/projects',agents:'/settings/agents',assets:'/assets',memory:'/mana?tab=memory',skills:'/mana?tab=skill','task-create':'/tasks?action=create'+(context.projectId?'&project='+encodeURIComponent(context.projectId):'')};
  if(routes[command.id]){await navigate(routes[command.id],command.id);return;}
  if(command.id==='model'){start({step:'model'});return;}
  if(command.id==='stop'){start({step:'stop'});return;}
  if(command.id==='new-chat'){await action({type:'new-chat',projectId:context.projectId,agentId:context.agentId});return;}
  if(command.id==='theme'){await action({type:'theme'});return;}
  if(context.conversation&&command.id==='terminal')await action({type:'terminal',conversationId:context.conversation.id});
 };
 const currentTargetId=flow?.step==='task'?context.taskId:flow?.step==='conversation'||flow?.step==='stop'?context.conversation?.id:flow?.step==='agent'?context.agentId:undefined;
 const heading=flow?.step==='task'?say('选择任务','Choose task'):flow?.step==='conversation'?say('选择执行对话','Choose execution Chat'):flow?.step==='agent'?say('选择智能体','Choose Agent'):flow?.step==='model'?say('选择模型','Choose model'):flow?.step==='stop'?say('选择要停止的执行','Choose execution to stop'):flow?.step==='confirm'?say('设为执行对话','Set execution Chat'):say('命令面板','Command palette');
 const currentProject=config.projects.find(project=>project.id===(context.conversation?.projectId??context.projectId)),currentAgent=config.agents.find(agent=>agent.id===(context.conversation?.agentId??context.agentId));
 return <Dialog label={say('命令面板','Command palette')} className="command-palette" locked={busy} initialFocus={inputRef} onClose={onClose}
  onEscapeKeyDown={event=>{if(!flow)return;event.preventDefault();if(flow.step==='confirm')start({step:'conversation',task:flow.task});else reset();}}>
  <header className="palette-heading"><strong>{heading}</strong><Button type="button" disabled={busy} aria-label={say('关闭命令面板','Close command palette')} onClick={onClose}>×</Button></header>
  <p className="palette-context">{say('当前上下文','Current context')} · {[currentProject?.name,currentAgent?.name,context.conversation?.title].filter(Boolean).join(' · ')||say('个人空间','Personal workspace')}</p>
  {flow&&<Button className="palette-back" disabled={busy} onClick={reset}>{say('返回命令','Back to commands')}</Button>}
  {flow?.step==='confirm'?<div className="palette-confirm"><p>{say('将所选对话设为此任务的执行对话','Set the selected Chat as an execution of this Task')}</p><strong>{flow.task.title}</strong><span>→ {flow.conversation.title}</span><p className="field-hint">{say('设定后不会自动开始执行，任务仍需单独验收。','Setting the execution Chat does not start work. Task acceptance remains separate.')}</p><Button className="primary" autoFocus disabled={busy||context.navigationLocked} onClick={()=>void run(()=>linkPaletteConversation(flow.task.id,flow.conversation.id,mutationKey.current),'task-link')}>{say('设为执行对话','Set execution Chat')}</Button><Button disabled={busy} onClick={()=>start({step:'conversation',task:flow.task})}>{say('选择其他对话','Choose another conversation')}</Button></div>:<>
   <Input ref={inputRef} className="palette-input" aria-label={say('搜索命令或对象','Search commands or objects')} role="combobox" aria-autocomplete="list" aria-controls="palette-results" aria-expanded={parsed.mode!=='help'} aria-activedescendant={selected>=0&&rows[selected]?'palette-row-'+selected:undefined} value={input} disabled={busy} placeholder={flow?say('输入名称筛选…','Type a name to filter…'):say('> 搜索命令；删除 > 搜索对象；? 查看帮助','> commands; remove > for objects; ? for help')} onChange={event=>{gate.current.next();setInput(event.target.value);setSelected(0);}} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}} onKeyDown={event=>{
    if(composing.current||event.nativeEvent.isComposing||event.nativeEvent.keyCode===229){event.stopPropagation();return;}
    const intent=paletteKeyIntent({key:event.key,isComposing:event.nativeEvent.isComposing,keyCode:event.nativeEvent.keyCode,metaKey:event.metaKey,ctrlKey:event.ctrlKey,altKey:event.altKey});
    if(intent==='next'||intent==='previous'){event.preventDefault();setSelected(value=>rows.length?(value+(intent==='next'?1:-1)+rows.length)%rows.length:-1);}
    if(intent==='execute'){event.preventDefault();if(rows[selected])void choose(rows[selected]);}
   }}/>
   {!flow&&<div className="palette-modes"><Button aria-pressed={parsed.mode==='commands'} onClick={()=>{setInput('> ');inputRef.current?.focus();}}>{say('命令','Commands')} <kbd>&gt;</kbd></Button><Button aria-pressed={parsed.mode==='objects'} onClick={()=>{setInput('');inputRef.current?.focus();}}>{say('对象','Objects')}</Button><Button aria-pressed={parsed.mode==='help'} onClick={()=>setInput('?')}>{say('帮助','Help')} <kbd>?</kbd></Button></div>}
   {parsed.mode==='help'&&!flow?<div className="palette-help"><p>{say('> 查找并选择命令；删除 > 搜索对话、任务、项目、智能体、资料与记忆。','> finds commands; remove > to search conversations, tasks, projects, Agents, assets and memory.')}</p><p>{say('↑ ↓ 选择 · Enter 执行 · Escape 返回或关闭 · Tab 移动焦点','↑ ↓ select · Enter execute · Escape back or close · Tab move focus')}</p><p>{say('输入搜索词不会执行动作；中文输入确认不会触发命令。','Typing does not run an action; confirming IME input does not execute a command.')}</p></div>:<div id="palette-results" className="palette-results" role="listbox" aria-label={heading} aria-busy={loading}>
    {loading&&<p className="palette-empty" role="status">{say('正在搜索…','Searching…')}</p>}
    {rows.map((row,index)=><Button key={row.id} id={'palette-row-'+index} role="option" aria-selected={selected===index} aria-disabled={!!row.unavailable||!!context.navigationLocked&&row.id!=='theme'} className={selected===index?'selected':''} tabIndex={-1} onMouseMove={()=>setSelected(index)} onClick={()=>void choose(row)}><span><strong>{row.title}</strong><small>{row.snippet||(!flow&&parsed.mode==='commands'&&recent.includes(row.id)?say('最近使用','Recently used'):row.result?say(({conversation:'对话',task:'任务',project:'项目',agent:'智能体',asset:'资料',memory:'记忆'})[row.result.kind],row.result.kind):'')}</small></span>{!row.result&&!flow&&(row.id==='new-chat'||row.id==='terminal')&&<kbd className="shortcut-key" aria-hidden="true">{shortcutLabel(row.id)}</kbd>}{row.result&&currentTargetId&&row.result.id===currentTargetId&&<em>{say('当前','Current')}</em>}</Button>)}
    {!loading&&!error&&!rows.length&&<p className="palette-empty">{flow?.step==='stop'?say('没有可停止的对话执行；任务执行也可从任务原页停止。','No stoppable execution. Task executions can also be stopped on their task page.'):say('没有匹配项','No matches')}</p>}
   </div>}
  </>}
  {error&&<p className="palette-error" role="alert">{error}</p>}
  <footer className="palette-footer"><span>{say('↑ ↓ 选择 · Enter 确认 · Esc 关闭','↑ ↓ select · Enter confirm · Esc close')}</span>{context.navigationLocked&&<span>{say('当前编辑保护中','Editing is protected')}</span>}</footer>
 </Dialog>;
}
