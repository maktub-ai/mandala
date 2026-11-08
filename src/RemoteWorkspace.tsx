import ComposerRecovery from './ComposerRecovery';
import { useComposerDraft, composerDraftFingerprint, clearAcceptedComposerDraft } from './composer-drafts';
import ComposerDraftNotice from './ComposerDraftNotice';
import { restoreSubmission, submitComposerInput, uploadComposerFiles, submissionError, type ComposerSubmission } from './composer-submit';

import Button from './ui/Button';
import Input from './ui/Input';
import Textarea from './ui/Textarea';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkCjkFriendly from 'remark-cjk-friendly';
import type { Approval, Conversation, DisplayEvent } from '../shared/types';
import type { Attachment } from '../shared/chat-input';
import type { Task } from '../shared/tasks';
import { approvalChoices } from '../shared/approvals';
import { nativeQuestions } from '../shared/questions';
import { groupChatTurns } from './chatTurns';
import { createRemoteFetch } from './remote-client';
import { useLanguage } from './i18n';
import Select from './ui/Select';
import Icon from './ui/Icon';
import {WorkspacePage,PageHeader,DetailSection} from './ui/WorkspacePage';
import MetadataList from './ui/MetadataList';
import StatusLabel from './ui/StatusLabel';
import EmptyState from './ui/EmptyState';
import {runtimeLabel,isCli} from '../shared/runtimes';
import { useTheme } from './ThemeProvider';
import Disclosure from './ui/Disclosure';
import LoadingState from './ui/LoadingState';
import Dialog from './Dialog';
import './remote-workspace.css';

type Summary = { agents: { id: string; name: string; defaultCli: string; models: Record<string, string> }[]; projects: { id: string; name: string; agentIds: string[] }[]; settings: { localExecution: true; remoteConfiguration: 'read-only' } };
type Props = { userId:string;deviceId:string; hostPublicKey: string; keyPair: { publicKey: string; secretKey: string }; computerName: string; hostOnline?:boolean; onAccount: () => void };


export default function RemoteWorkspace({ hostPublicKey, keyPair, computerName, onAccount,userId,deviceId,hostOnline }: Props) {
  const {text: localize,  language } = useLanguage(), en = language !== 'zh-CN', l = (zh: string, english: string) => localize(zh, english);
  const { variant, changeMode } = useTheme();
  const remoteFetch = useMemo(() => createRemoteFetch(hostPublicKey, keyPair), [hostPublicKey, keyPair]);
  const call = useCallback(async <T,>(path: string, method = 'GET', body?: unknown,signal?:AbortSignal): Promise<T> => {
    let response:Response;try{response = await remoteFetch(path, { method,signal, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });}catch(reason){const problem=reason as Error,status=Number(/Remote transport unavailable \((\d+)\)/.exec(problem.message)?.[1]);if(status===401||status===403)throw Object.assign(problem,{status});throw reason;}
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error ?? `HTTP ${response.status}`), { status: response.status });
    return data;
  }, [remoteFetch]);
  const [summary, setSummary] = useState<Summary>(), [chats, setChats] = useState<Conversation[]>([]), [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState(new URLSearchParams(location.search).get('conversation') ?? ''), [chat, setChat] = useState<Conversation>();
  const [executionId, setExecutionId] = useState<string | null>(null), [stopUncertain, setStopUncertain] = useState(false);
  const [events, setEvents] = useState<DisplayEvent[]>([]), [approvals, setApprovals] = useState<Approval[]>([]);
  const [page, setPage] = useState<'chat' | 'tasks' | 'config'>('chat'), [listOpen, setListOpen] = useState(false);
  const [agentId, setAgentId] = useState(''), [projectId, setProjectId] = useState(''), [model, setModel] = useState('');
  const [connection,setConnection]=useState<'checking'|'online'|'offline'|'access-lost'>(hostOnline===false?'offline':'checking'),[lastRead,setLastRead]=useState<number|null>(null),[chatUnavailable,setChatUnavailable]=useState(false);
  const [taskTargets,setTaskTargets]=useState<Record<string,string>>({}),[taskSearch,setTaskSearch]=useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''),[transportError,setTransportError]=useState(''), [loaded, setLoaded] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{ url: string; name: string }>();
  const submission = useRef<ComposerSubmission | null>(null), fileInput = useRef<HTMLInputElement>(null), current = useRef(selected), inFlight = useRef(false),readGeneration=useRef(0),readController=useRef<AbortController|null>(null),summaryRef=useRef<Summary|undefined>(undefined),alive=useRef(true),authorityGeneration=useRef(0),selectionGeneration=useRef(0),fileControllers=useRef(new Set<AbortController>());
  const draft=useComposerDraft({kind:'chat',conversationId:selected,...!selected?{projectId,agentId}:{}},JSON.stringify([location.origin,userId,deviceId,hostPublicKey,keyPair.publicKey]),true);
  const {text,files}=draft.value,uncertain=!!draft.pending;
  const setText=(next:string)=>draft.setValue(value=>({...value,text:next}));
  const setFiles=(next:File[]|((old:File[])=>File[]))=>draft.setValue(value=>{const files=typeof next==='function'?next(value.files):next;return {...value,files,missingAttachments:value.missingAttachments.filter(item=>!files.some(file=>file.name===item.name&&file.size===item.size))};});
  useEffect(()=>{submission.current=null;},[selected]);
  current.current = selected;
  const clearProtected=()=>{setSummary(undefined);summaryRef.current=undefined;setChats([]);setTasks([]);setChat(undefined);setExecutionId(null);setEvents([]);setApprovals([]);setAnswers({});setPreview(undefined);};
  const markFailure=(reason:unknown)=>{
    const problem=reason as Error&{status?:number},status=problem.status??Number(/Remote transport unavailable \((\d+)\)/.exec(problem.message)?.[1]);
    if(status===401||status===403){authorityGeneration.current++;readGeneration.current++;readController.current?.abort();for(const controller of fileControllers.current)controller.abort();setConnection('access-lost');clearProtected();setError('');setTransportError(l('远程访问已失效或被撤销。请重新确认账号与电脑授权。','Remote access expired or was revoked. Check your account and computer access.'));}
    else{setConnection('offline');setTransportError(l('电脑暂不可用。草稿可继续编辑；连接恢复后不会自动发送。','Computer unavailable. Drafts remain editable; reconnecting will not send them automatically.'));}
  };
  const refresh = useCallback(async (includeConfig=false) => {
    const epoch=++readGeneration.current,id=current.current,controller=new AbortController();readController.current?.abort();readController.current=controller;
    const valid=()=>alive.current&&!controller.signal.aborted&&readGeneration.current===epoch;
    const timeout=setTimeout(()=>{if(valid()){setLoaded(true);markFailure(new Error('Remote read timed out'));controller.abort();}},8000);
    try{
      const [conversations,taskList,config]=await Promise.all([call<Conversation[]>('/api/conversations','GET',undefined,controller.signal),call<Task[]>('/api/v2/tasks','GET',undefined,controller.signal),includeConfig||!summaryRef.current?call<Summary>('/api/remote/config','GET',undefined,controller.signal):Promise.resolve(summaryRef.current)]);
      if(!valid())return;summaryRef.current=config;setSummary(config);setChats(conversations);setTasks(taskList);setLoaded(true);setLastRead(Date.now());setConnection(hostOnline===false?'offline':'online');setTransportError('');
      if(id){
        try{const [detail,history]=await Promise.all([call<{conversation:Conversation;approvals:Approval[];executionId:string|null}>(`/api/conversations/${id}`,'GET',undefined,controller.signal),call<DisplayEvent[]>(`/api/conversations/${id}/history`,'GET',undefined,controller.signal)]);
          if(valid()&&current.current===id){setChat(detail.conversation);setExecutionId(detail.executionId);setStopUncertain(false);setApprovals(detail.approvals);setEvents(history);setChatUnavailable(false);}
        }catch(reason){if(!valid())return;if((reason as {status?:number}).status===404){setChat(undefined);setExecutionId(null);setEvents([]);setApprovals([]);setChatUnavailable(true);}else throw reason;}
      }
    }catch(reason){if(valid()){setLoaded(true);markFailure(reason);}}finally{clearTimeout(timeout);}
  },[call,hostOnline,language]);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;authorityGeneration.current++;readGeneration.current++;readController.current?.abort();for(const controller of fileControllers.current)controller.abort();};},[]);
  useEffect(()=>{if(hostOnline===false)setConnection('offline');},[hostOnline]);
  useEffect(()=>{
    const update=()=>{if(inFlight.current||document.hidden)return;inFlight.current=true;void refresh().finally(()=>{inFlight.current=false;});};
    update();const timer=setInterval(update,2500);return()=>{clearInterval(timer);readGeneration.current++;readController.current?.abort();};
  },[refresh,selected]);
  useEffect(()=>{if(page==='config'||!selected)void refresh(true);},[page,selected]);
  const networkReady=hostOnline!==false&&connection==='online';
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);
  const run = async (work: () => Promise<void>) => {
    if (busy||!networkReady) return; setBusy(true); setError('');
    try { await work(); if(alive.current)await refresh(); } catch (reason) {if(!alive.current)return; const status=(reason as {status?:number}).status;if(status===401||status===403||/Remote transport unavailable|Failed to fetch|fetch failed/.test((reason as Error).message))markFailure(reason);else setError((reason as Error).message); } finally { if(alive.current)setBusy(false); }
  };
  const select = (id: string) => {
    void draft.flush();if(id===current.current){setPage('chat');setListOpen(false);void refresh();return;}selectionGeneration.current++;readGeneration.current++;readController.current?.abort();for(const controller of fileControllers.current)controller.abort();
    setPage('chat');setChatUnavailable(false);setSelected(id); setChat(undefined); setExecutionId(null); setStopUncertain(false); setEvents([]); setApprovals([]); setListOpen(false);
    history.replaceState(null, '', id ? '/?conversation=' + encodeURIComponent(id) : '/');
  };
  const send = async () => {
    if(!networkReady||chatUnavailable||!selected||!draft.loaded||(!draft.pending&&!text.trim()&&!files.length))return;
    if(!draft.pending&&chat?.id!==selected)return;
    if(!draft.pending&&draft.value.missingAttachments.length)throw Error(l('请先重新选择或移除缺失附件。','Reselect or remove missing attachments first.'));
    if(!draft.pending&&files.length>8)throw Error(l('最多添加 8 个附件。','Add up to 8 attachments.'));
    if(!draft.pending&&files.some(file=>!file.size||file.size>20*1024*1024))throw Error(l('附件大小需为 1 字节至 20 MB。','Each attachment must be 1 byte to 20 MB.'));
    const original=draft.value;
    let request=submission.current;
    if(!draft.pending&&request&&!request.recovery.attempted&&(!request.recovery.stopAttempted||request.recovery.stopConfirmed))request=null;
    if(!request)request=draft.pending?restoreSubmission(draft.pending):{conversationId:selected,commandKey:crypto.randomUUID(),draftFingerprint:composerDraftFingerprint(original),text,attachments:[],references:[],recovery:{},action:chat&&['interrupted','error'].includes(chat.status)?'continue':'queue'};
    submission.current=request;
    if(request.conversationId!==selected)throw Error(l('请先返回原对话确认上次发送结果。','Return to the original Chat to check the previous send.'));
    try {
      if(!request.recovery.attempted&&!draft.pending)await uploadComposerFiles((async(path,init)=>{const response=await remoteFetch(String(path),init);if(response.status===401||response.status===403){const problem=Object.assign(new Error(l('附件访问已失效','Attachment access was revoked')),{status:response.status});markFailure(problem);throw problem;}return response;}) as typeof fetch,selected,files,request.attachments);
      await submitComposerInput((path,method,body)=>call('/api'+path,method,body),request,draft.savePending,async()=>{draft.setValue(value=>clearAcceptedComposerDraft(value,request!.draftFingerprint));await draft.flush();});submission.current=null;
    }catch(reason){throw Object.assign(new Error(submissionError(reason,en)),{status:(reason as {status?:number}).status});}
  };
  const readFile = (attachment:Attachment,image:boolean)=>run(async()=>{
    const authority=authorityGeneration.current,selection=selectionGeneration.current,id=current.current,controller=new AbortController();fileControllers.current.add(controller);
    const valid=()=>alive.current&&authorityGeneration.current===authority&&selectionGeneration.current===selection&&current.current===id;
    try{
      const response=await remoteFetch(`/api/conversations/${id}/attachments/${attachment.id}${image?'':'?download=1'}`,{signal:controller.signal});
      if(!response.ok)throw Object.assign(new Error(l('读取文件失败','Cannot read file')),{status:response.status});
      const bytes=await response.blob();if(!valid())return;const url=URL.createObjectURL(bytes);
      if(image)setPreview({url,name:attachment.name});else{const link=document.createElement('a');link.href=url;link.download=attachment.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
    }catch(reason){if(valid())throw reason;}finally{fileControllers.current.delete(controller);}
  });
  const downloadOutput=(path:string,name:string)=>run(async()=>{
    const authority=authorityGeneration.current,selection=selectionGeneration.current,controller=new AbortController();fileControllers.current.add(controller);
    const valid=()=>alive.current&&authorityGeneration.current===authority&&selectionGeneration.current===selection;
    try{
      const response=await remoteFetch(path,{signal:controller.signal});if(!response.ok)throw Object.assign(new Error(l('读取交付文件失败','Cannot read output file')),{status:response.status});
      const bytes=await response.blob();if(!valid())return;const url=URL.createObjectURL(bytes),link=document.createElement('a');
      const encodedName=/filename\*=UTF-8''([^;]+)/i.exec(response.headers.get('content-disposition')??'')?.[1];link.href=url;link.download=encodedName?decodeURIComponent(encodedName):name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(reason){if(valid())throw reason;}finally{fileControllers.current.delete(controller);}
  });
  const agent = summary?.agents.find(item => item.id === agentId);
  const models = agent?.models[agent.defaultCli]?[agent.models[agent.defaultCli]]:[];
  const readableTaskChats=(task:Task)=>chats.filter(item=>task.conversationIds.includes(item.id));
  const messages = groupChatTurns(events).flatMap(turn => turn.messages).map(message => ({ ...message, attachments: message.attachments ?? (events.find(event => event.id === message.key)?.data as { attachments?: Attachment[] } | undefined)?.attachments }));
  const statusLabel = (state: string) => ({ idle: l('就绪', 'Ready'), running: l('执行中', 'Running'), approval: l('等待确认', 'Waiting for approval'), interrupted: l('已停止', 'Stopped'), error: l('执行错误', 'Error'), todo: l('待开始', 'To do'), waiting: l('等待中', 'Waiting'), review: l('待验收', 'Review'), completed: l('已完成', 'Completed'), cancelled: l('已取消', 'Cancelled') })[state] ?? state;
  const waitingLabel=(reason:string)=>({host_offline:l('执行主机离线','Execution host offline'),approval:l('等待审批','Approval required'),input:l('需要输入','Input required'),run_failed:l('执行失败，待处理','Run failed; needs attention'),interrupted:l('已停止','Stopped'),delivery_missing:l('缺少交付','Delivery missing'),check_failed:l('检查未通过','Checks not passed')})[reason]??reason;
  const runtimeName=(cli:string)=>isCli(cli)?runtimeLabel(cli):cli;
  const taskView=<WorkspacePage className="remote-content"><PageHeader title={l('任务','Tasks')} icon="plan" context={String(tasks.length)}><Input type="search" aria-label={l('搜索任务','Search tasks')} placeholder={l('搜索任务…','Search tasks…')} value={taskSearch} onChange={event=>setTaskSearch(event.target.value)}/></PageHeader><div className="remote-task-list">{tasks.filter(task=>task.goal.toLocaleLowerCase().includes(taskSearch.toLocaleLowerCase())).map(task=>{const linked=readableTaskChats(task),target=linked.length===1?linked[0].id:linked.some(chat=>chat.id===taskTargets[task.id])?taskTargets[task.id]:'';return <article className="remote-task" key={task.id} aria-label={task.goal.split('\n')[0]}><div className="remote-task-heading"><h2>{task.goal.split('\n')[0]}</h2><StatusLabel icon={task.state==='running'?'activity':task.state==='waiting'||task.state==='review'?'info':'clock'} tone={task.state==='running'?'active':task.state==='waiting'||task.state==='review'?'warning':'neutral'}>{statusLabel(task.state)}</StatusLabel></div><div className="remote-task-meta">{task.waitingReason&&<span>{waitingLabel(task.waitingReason)}</span>}<span>{summary?.agents.find(agent=>agent.id===task.assigneeAgentId)?.name||l('未指派智能体','Unassigned Agent')}</span>{task.projectId&&<span>{summary?.projects.find(project=>project.id===task.projectId)?.name||l('项目不可用','Unavailable Project')}</span>}</div>{task.goal.includes('\n')&&<Disclosure title={l('任务说明','Task details')}><p>{task.goal}</p></Disclosure>}<div className="remote-task-chat">{linked.length>1?<Select ariaLabel={l('执行对话 · ','Execution Chat · ')+task.goal.split('\n')[0]} value={target} onChange={value=>setTaskTargets(old=>({...old,[task.id]:value}))} options={[{value:'',label:l('选择执行对话','Choose execution Chat')},...linked.map(chat=>({value:chat.id,label:chat.title||l('未命名对话','Untitled Chat'),description:runtimeName(chat.cli)}))]}/>:linked.length===1?<span><Icon name="message" size={14}/>{linked[0].title||l('未命名对话','Untitled Chat')}</span>:<span className="remote-muted">{l('没有可读取的执行对话','No readable execution Chat')}</span>}{linked.length>0&&<Button disabled={!target||busy||uncertain} onClick={()=>select(target)}><Icon name="arrowRight" size={14}/>{l('打开对话','Open Chat')}</Button>}{task.waitingReason!=='interrupted'&&['running','waiting'].includes(task.state)&&<Button disabled={busy||!networkReady} onClick={()=>void run(async()=>{await call(`/api/v2/tasks/${task.id}/stop`,'POST',{expectedRevision:task.revision});})}><Icon name="stop" size={14}/>{l('停止任务','Stop task')}</Button>}</div></article>;})}{!tasks.length&&<EmptyState icon="plan">{connection==='online'?l('暂无任务','No tasks yet'):l('连接后可读取任务。','Connect to read tasks.')}</EmptyState>}{tasks.length>0&&!tasks.some(task=>task.goal.toLocaleLowerCase().includes(taskSearch.toLocaleLowerCase()))&&<EmptyState icon="search">{l('没有匹配的任务','No matching tasks')}</EmptyState>}</div></WorkspacePage>;
  const configView=<WorkspacePage className="remote-content"><PageHeader title={l('配置概览','Configuration')} icon="settings" context={<StatusLabel icon="settings">{l('只读','Read only')}</StatusLabel>}/><p className="remote-muted">{l('配置修改在电脑上完成；这里只展示获准读取的概览。','Edit configuration on your computer. This view shows only the permitted summary.')}</p><DetailSection title={l('智能体','Agents')} icon="agent">{summary?.agents.map(item=><div className="remote-row" key={item.id}><strong>{item.name}</strong><MetadataList items={[{label:l('执行端','Runtime'),value:runtimeName(item.defaultCli)},{label:l('智能体模型','Agent model'),value:item.models[item.defaultCli]||l('未覆盖默认值','No override')}]}/></div>)}{!summary?.agents.length&&<EmptyState icon="agent">{l('没有可读取的智能体','No readable Agents')}</EmptyState>}</DetailSection><DetailSection title={l('项目','Projects')} icon="project">{summary?.projects.map(item=><div className="remote-row" key={item.id}><strong>{item.name}</strong><span>{item.agentIds.map(id=>summary.agents.find(agent=>agent.id===id)?.name).filter(Boolean).join(', ')||l('未关联智能体','No associated Agents')}</span></div>)}{!summary?.projects.length&&<EmptyState icon="project">{l('没有可读取的项目','No readable Projects')}</EmptyState>}</DetailSection></WorkspacePage>;
  return <main className="remote-workspace">
    <header className="remote-header"><Button className="remote-icon-button remote-menu-button" aria-label={l('对话列表', 'Chat list')} aria-expanded={listOpen} onClick={() => { setPage('chat'); setListOpen(value => !value); }}><Icon name="menu" size={18} /></Button><div className="remote-computer"><strong>{computerName}</strong><span>{l('远程工作区', 'Remote workspace')} · {connection==='online'?l('在线','Online'):connection==='access-lost'?l('访问已失效','Access lost'):connection==='checking'?l('正在连接','Connecting'):l('离线','Offline')}</span></div><div className="remote-actions"><Button className="remote-icon-button" aria-label={variant === 'dark' ? l('切换为浅色', 'Switch to light') : l('切换为深色', 'Switch to dark')} onClick={() => changeMode(variant === 'dark' ? 'light' : 'dark')}><Icon name={variant === 'dark' ? 'sun' : 'moon'} size={18} /></Button><Button className="remote-icon-button" aria-label={l('账号与连接', 'Account and connection')} onClick={onAccount}><Icon name="user" size={18} /></Button></div></header>
    <nav className="remote-tabs" aria-label={l('工作区', 'Workspace')}>{(['chat', 'tasks', 'config'] as const).map((item, i) => <Button key={item} aria-current={page === item ? 'page' : undefined} onClick={() => setPage(item)}><Icon name={(['message', 'plan', 'settings'] as const)[i]} size={17} />{[l('对话', 'Chats'), l('任务', 'Tasks'), l('配置概览', 'Configuration')][i]}</Button>)}</nav>
    <div className="remote-read-status" role="status"><StatusLabel icon={connection==='online'?'circleCheck':connection==='access-lost'?'user':'clock'} tone={connection==='online'?'neutral':'warning'}>{connection==='online'?l('电脑在线','Computer online'):connection==='access-lost'?l('访问已失效','Access lost'):connection==='checking'?l('正在连接电脑','Connecting to computer'):l('电脑离线或不可用','Computer offline or unavailable')}</StatusLabel>{lastRead&&<span>{l('上次成功读取：','Last successful read: ')}<time dateTime={new Date(lastRead).toISOString()}>{new Date(lastRead).toLocaleTimeString(language,{hour:'2-digit',minute:'2-digit'})}</time></span>}<Button disabled={busy} aria-label={l('刷新远程工作区','Refresh remote workspace')} onClick={()=>void refresh(page==='config'||!selected)}><Icon name="refresh" size={14}/>{l('刷新','Refresh')}</Button></div>
    {(error||transportError) && <div className="remote-notice" role="alert"><p>{transportError||error}</p><Button disabled={busy} onClick={() => void refresh(page==='config'||!selected)}>{l('刷新确认', 'Refresh to check')}</Button></div>}
    {!loaded && !(selected&&draft.loaded) ? <LoadingState label={l('正在连接电脑…', 'Connecting to computer…')} /> : page === 'config' ? configView : page === 'tasks' ? taskView : <div className="remote-chat-layout">
      <aside className={listOpen ? 'remote-chat-list is-open' : 'remote-chat-list'} aria-label={l('对话列表', 'Chat list')}><Button disabled={busy || uncertain} onClick={() => { select(''); }}><Icon name="plus" size={16} />{l('新对话', 'New chat')}</Button>{chats.map(item => <Button key={item.id} disabled={busy || uncertain} aria-current={selected === item.id ? 'page' : undefined} onClick={() => select(item.id)}><strong>{item.title || l('未命名对话', 'Untitled chat')}</strong><small>{statusLabel(item.status)}</small></Button>)}</aside>
      <section className="remote-chat-main">{!selected ? <form className="remote-create" onSubmit={event=>{event.preventDefault();if(!agentId)return;void run(async()=>{const created=await call<Conversation>('/api/conversations','POST',{agentId,projectId,...(model?{model}:{})});select(created.id);});}}><PageHeader title={l('新对话','New Chat')} icon="message"/><p className="remote-muted">{l('选择项目和智能体，创建后再明确发送消息。','Choose a Project and Agent, then send a message when ready.')}</p><label>{l('项目','Project')}<Select ariaLabel={l('项目','Project')} value={projectId} disabled={busy||!summary} onChange={value=>{setProjectId(value);setAgentId('');setModel('');}} options={[{value:'',label:l('无项目','No Project')},...(summary?.projects.map(item=>({value:item.id,label:item.name}))??[])]}/></label><label>{l('智能体','Agent')}<Select ariaLabel={l('智能体','Agent')} value={agentId} disabled={busy||!summary} onChange={value=>{setAgentId(value);setModel('');}} options={[{value:'',label:l('选择智能体','Choose Agent')},...(summary?.agents.filter(item=>!projectId||summary.projects.find(project=>project.id===projectId)?.agentIds.includes(item.id)).map(item=>({value:item.id,label:item.name,description:runtimeName(item.defaultCli)}))??[])]}/></label>{agent&&<MetadataList items={[{label:l('执行端','Runtime'),value:runtimeName(agent.defaultCli)}]}/>} {models.length>0&&<label>{l('模型','Model')}<Select ariaLabel={l('模型','Model')} value={model} onChange={setModel} options={[{value:'',label:l('沿用智能体配置','Use Agent configuration')},...models.map(id=>({value:id,label:id}))]}/></label>}<Button type="submit" className="primary" disabled={busy||!networkReady||!agentId}>{l('创建对话','Create Chat')}</Button></form> : <>
        <div className="remote-chat-heading"><PageHeader title={chat?.title||l('对话','Chat')} icon="message" context={<StatusLabel icon={chat?.status==='running'?'activity':'message'}>{chat?statusLabel(chat.status):chatUnavailable?l('对话不可用','Chat unavailable'):connection==='online'?l('读取中…','Loading…'):l('离线','Offline')}</StatusLabel>}/>{chat&&<MetadataList items={[{label:l('智能体','Agent'),value:summary?.agents.find(agent=>agent.id===chat.agentId)?.name||(chat.agentId?l('智能体不可用','Unavailable Agent'):l('无智能体','No Agent'))},{label:l('执行端','Runtime'),value:runtimeName(chat.cli)}]}/>}</div>
        <div className="remote-messages" aria-label={l('消息记录', 'Messages')}>{messages.map(message => <article key={message.key} className={`remote-message ${message.kind}`}><small>{message.kind === 'user' ? l('你', 'You') : message.kind === 'error' ? l('错误', 'Error') : 'Mandala'}</small><Markdown remarkPlugins={[remarkGfm, remarkCjkFriendly]} components={{ a: ({ href, children }) => /^\/api\/v2\/assets\/[a-zA-Z0-9_-]+\/versions\/[a-zA-Z0-9_-]+\/files\/[a-zA-Z0-9_-]+$/.test(href ?? '') ? <Button disabled={!networkReady||busy} onClick={() => void downloadOutput(href!, typeof children === 'string' ? children : 'download')}>{children}</Button> : <a href={/^https?:\/\//.test(href ?? '') ? href : undefined} target="_blank" rel="noreferrer">{children}</a>, img: ({ alt }) => <span>{alt}</span> }}>{message.text}</Markdown>{message.attachments?.map(item => <div className="remote-attachment" key={item.id}><span>{item.name}</span>{/^image\/(png|jpeg|gif|webp)$/.test(item.mimeType) && <Button disabled={!networkReady||busy} onClick={() => void readFile(item, true)}>{l('预览图片', 'Preview image')}</Button>}<Button disabled={!networkReady||busy} onClick={() => void readFile(item, false)}>{l('下载', 'Download')}</Button></div>)}</article>)}{!messages.length&&(chatUnavailable?<EmptyState icon="message">{l('此对话已删除或不可访问。草稿仍保留在此浏览器。','This Chat was deleted or is unavailable. Its draft remains in this browser.')}</EmptyState>:!chat&&connection==='online'?<LoadingState label={l('读取消息…','Loading messages…')}/>:<EmptyState icon="message">{connection==='online'?l('发送第一条消息开始对话。','Send your first message to start.'):l('离线时无法读取消息，草稿可以继续编辑。','Messages cannot be read offline; you can continue editing your draft.')}</EmptyState>)}</div>
        {approvals.map(approval => { const questions = nativeQuestions(approval); return <section key={approval.id} className="remote-approval"><h2>{questions.length ? l('需要你的回答', 'Your answer is needed') : l('需要你的批准', 'Your approval is needed')}</h2>{questions.length ? <form onSubmit={event => { event.preventDefault(); void run(async () => { await call(`/api/conversations/${selected}/questions/${approval.id}`, 'POST', { answers: Object.fromEntries(questions.map(q => [q.id, { answers: [answers[q.id] ?? ''] }])) }); }); }}>{questions.map(q => <label key={q.id}>{q.question}{q.options?.length ? <Select ariaLabel={q.question} value={answers[q.id] ?? ''} onChange={value => setAnswers(old => ({ ...old, [q.id]: value }))} options={[{ value: '', label: l('请选择', 'Choose') }, ...q.options.map(option => ({ value: option.label, label: option.label + ' — ' + option.description }))]} /> : <Input required type={q.isSecret ? 'password' : 'text'} value={answers[q.id] ?? ''} onChange={event => setAnswers(old => ({ ...old, [q.id]: event.target.value }))} />}</label>)}<Button type="submit" disabled={busy || !networkReady || questions.some(q => !answers[q.id]?.trim())}>{l('提交回答', 'Submit answer')}</Button></form> : <><Disclosure title={l('查看请求', 'View request')}><pre>{JSON.stringify(approval.params, null, 2)}</pre></Disclosure><div className="remote-actions">{approvalChoices(approval).filter(decision => ['approve', 'reject', 'reject-stop'].includes(decision)).map(decision => <Button disabled={busy||!networkReady} key={decision} onClick={() => void run(async () => { await call(`/api/conversations/${selected}/approvals/${approval.id}`, 'POST', { decision }); })}>{decision === 'approve' ? l('仅批准这次', 'Approve once') : decision === 'reject-stop' ? l('拒绝并停止', 'Reject and stop') : l('拒绝', 'Reject')}</Button>)}</div></>}</section>; })}
        <form className="remote-composer" onSubmit={event => { event.preventDefault(); void run(send); }}><label htmlFor="remote-message">{l('消息', 'Message')}</label><Textarea id="remote-message" value={text} onChange={event => setText(event.target.value)} disabled={!draft.loaded} rows={3} placeholder={l('继续这段对话…', 'Continue this conversation…')} /><Input ref={fileInput} type="file" multiple hidden onChange={event => { const picked = Array.from(event.target.files ?? []); setFiles(old => [...old, ...picked]); event.target.value = ''; }} />{files.map((file, index) => <div className="remote-attachment" key={index}><span>{file.name}</span><Button type="button" disabled={uncertain} onClick={() => setFiles(old => old.filter((_, i) => i !== index))}>{l('移除', 'Remove')}</Button></div>)}<ComposerRecovery draft={draft} onResolved={()=>{submission.current=null;}} onInspect={select}/><ComposerDraftNotice draft={draft} onReselect={()=>fileInput.current?.click()}/>{uncertain && <p className="remote-muted">{l('先核对消息记录，再明确重试。不会自动重发。', 'Check history before explicitly retrying. No automatic resend.')}</p>}<div className="remote-actions"><Button type="button" disabled={busy || uncertain} onClick={() => fileInput.current?.click()}><Icon name="plus" size={18} />{l('添加附件', 'Attach file')}</Button>{['running', 'approval'].includes(chat?.status ?? '') && <Button type="button" disabled={busy || !networkReady || stopUncertain} onClick={() => void run(async () => { try { await call(`/api/conversations/${selected}/stop`, 'POST', { expectedExecutionId: executionId }); } catch (reason) { setStopUncertain(true); throw reason; } })}>{stopUncertain ? l('停止结果待确认', 'Stop result unconfirmed') : l('停止执行', 'Stop execution')}</Button>}<Button type="submit" className="primary" disabled={busy || !networkReady || chatUnavailable || !draft.loaded || (!draft.pending&&chat?.id!==selected) || !!(draft.value.missingAttachments.length&&!draft.pending) || (!uncertain&&!text.trim()&&!files.length)}>{busy ? l('正在提交…', 'Submitting…') : uncertain ? l('核对上次发送', 'Check previous send') : l('发送', 'Send')}</Button></div></form>
      </>}</section></div>}
    {preview && <Dialog className="remote-image-preview" label={preview.name} onClose={() => setPreview(undefined)}><Button onClick={() => setPreview(undefined)}>{l('关闭预览', 'Close preview')}</Button><img src={preview.url} alt={preview.name} /></Dialog>}
  </main>;
}
