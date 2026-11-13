import Button from './ui/Button';
import Input from './ui/Input';
import Textarea from './ui/Textarea';
import { runtimeLabel } from "../shared/runtimes";
import Disclosure from './ui/Disclosure';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Automation, AutomationInput, AutomationState, AutomationRun, Schedule } from "../shared/automations";
import type { Task } from "../shared/tasks";
import type { Cli, Config, Conversation } from "../shared/types";
import { enabledRuntimes } from "../shared/runtimes";
import { projectWorkspaces } from "../shared/workspaces";
import { requestJson } from "./api";
import StatusLabel from "./ui/StatusLabel";
import {useComposerDraftIdentity} from "./composer-drafts";
import {scheduleCommandKey,confirmScheduleCommand,pendingScheduleCommands} from "./schedule-command-keys";
import {ListDetail,DetailSection} from "./ui/WorkspacePage";
import LoadingState from "./ui/LoadingState";
import EmptyState from "./ui/EmptyState";
import { followAssetPage, navigateAssetPage } from "./AssetLibrary";
import { useLanguage } from "./i18n";
import RuntimeIcon from "./ui/RuntimeIcon";
import Select from "./ui/Select";
import Icon from "./ui/Icon";
import IdentityAvatar from "./IdentityAvatar";
import {isSystemAgent} from "../shared/chat-context";
import {weekdayText,executionModeText,awaitingReview} from "./schedule-view";
import "./automations.css";
import "./schedules.css";

type Draft = Omit<AutomationInput, "schedule"|"cli"> & {cli:Cli|""} & {id?:string; revision?:number; kind:Schedule["kind"]; minutes:number; anchor:string; time:string;timeZone:string;weekdays:number[];at:string};
// Retained only in memory for page-render recovery; never written to browser storage.
const editorCheckpoints=new Map<string,{draft:Draft;createKey:string}>();
const scheduleRequest=<T,>(path:string,options:RequestInit={})=>requestJson<T>('/api'+path,options,15000);
const statusKey = {starting:"启动中",succeeded:"原生执行已结束",unknown:"需确认执行状态",missed:"已错过",legacy_unverified:"历史记录未验证",queued:"排队中",running:"执行中",approval:"等待审批",completed:"运行已结束",interrupted:"已中断",failed:"失败"} as const;
const taskStateLabels:Record<string,[string,string]>={todo:["待办","To do"],running:["进行中","In progress"],waiting:["待处理","Needs attention"],review:["结果待确认","Awaiting review"],completed:["已完成","Completed"],cancelled:["已取消","Cancelled"]};
const waitingLabels:Record<string,[string,string]>={interrupted:["已中断","Interrupted"],host_offline:["主机离线","Host offline"],input:["需要输入","Input required"],approval:["等待审批","Approval required"],run_failed:["执行失败","Run failed"],delivery_missing:["缺少交付","Delivery missing"],check_failed:["检查未通过","Checks not passed"]};
const weekdays = ["周日","周一","周二","周三","周四","周五","周六"] as const;
function useAutomations(taskRevision?:number) {
  const [refreshToken,setRefreshToken]=useState(0);
  const [state,setState]=useState<AutomationState>({version:1,automations:[],runs:[]});
  const [loading,setLoading]=useState(true),[error,setError]=useState(""),[loadedRevision,setLoadedRevision]=useState<number|undefined>(undefined);
  // Every read shares one ordering clock. Starting a newer read or accepting a
  // mutation invalidates older snapshots, including same-ID status/rule rows.
  const snapshotVersion=useRef(0);
  const invalidate=()=>{snapshotVersion.current++;};
  const refreshSnapshot=async(signal:AbortSignal)=>{
    const version=++snapshotVersion.current;
    try{
      const data=await scheduleRequest<AutomationState>('/automations',{signal});
      if(signal.aborted||version!==snapshotVersion.current)return;
      setState(data);setLoadedRevision(taskRevision);setError('');
    }catch(reason){if(!signal.aborted&&version===snapshotVersion.current)throw reason;}
  };
  useEffect(()=>{
    let active=true,pending=false;const controller=new AbortController();
    const update=async()=>{if(!active||pending||document.hidden)return;pending=true;try{await refreshSnapshot(controller.signal);}
      catch(e){if(active)setError((e as Error).message);}finally{pending=false;if(active)setLoading(false);}};
    void update();const timer=setInterval(()=>void update(),3000);
    return()=>{active=false;clearInterval(timer);controller.abort();};
  },[taskRevision,refreshToken]);
  return {state,setState,invalidate,refreshSnapshot,loading:loading||loadedRevision!==taskRevision&&!error,error,retry:()=>setRefreshToken(value=>value+1)};
}
const localInput=(date:Date)=>new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);

/** `header` lets the Schedules page place the primary action in its PageHeader, like every other module page. */
export default function AutomationWorkspace({config,onOpenConversation,onEditingChange,task,disabled=false,manageOnly=false,header}:{task?:Task;disabled?:boolean;manageOnly?:boolean;config:Config;onOpenConversation?:(id:string)=>void;onEditingChange?:(editing:boolean)=>void;header?:(actions:ReactNode)=>ReactNode}) {
  const {text: localize, t,errorText,language}=useLanguage();const {state,setState,loading,error:loadError,retry,invalidate,refreshSnapshot}=useAutomations(task?.revision);
  const createKey=useRef<string>(crypto.randomUUID()),commandIdentity=useComposerDraftIdentity();
  const [pendingCommands,setPendingCommands]=useState<Record<string,string>>(()=>{try{return pendingScheduleCommands(commandIdentity);}catch{return {};}});
  useEffect(()=>{const sync=()=>{try{setPendingCommands(pendingScheduleCommands(commandIdentity));}catch{/* Mutations fail closed if the stored checkpoint cannot be read. */}};sync();addEventListener("storage",sync);return()=>removeEventListener("storage",sync);},[commandIdentity]);
  const [showAllRuns,setShowAllRuns]=useState(false);
  const [selectedId,setSelectedId]=useState(()=>new URLSearchParams(location.search).get("schedule")??"");
  const selectSchedule=(id:string)=>{const params=new URLSearchParams(location.search);id?params.set("schedule",id):params.delete("schedule");navigateAssetPage(location.pathname+(params.size?"?"+params:""));setSelectedId(id);};
  const [search,setSearch]=useState(""),[ruleStatus,setRuleStatus]=useState("all");
  const [projectId,setProjectId]=useState(()=>new URLSearchParams(location.search).get("project")??"all");

  const checkpointId=commandIdentity+':'+(task?.id??'schedules');
  const [draft,updateDraft]=useState<Draft|null>(()=>{const saved=editorCheckpoints.get(checkpointId);if(saved)createKey.current=saved.createKey;return saved?.draft??null;});
  const setDraft=(value:Draft|null)=>{if(value)editorCheckpoints.set(checkpointId,{draft:value,createKey:createKey.current});else editorCheckpoints.delete(checkpointId);updateDraft(value);};
  const [pending,setPending]=useState(false),[pendingPath,setPendingPath]=useState(''),[error,setError]=useState('');
  const mounted=useRef(true),mutationController=useRef<AbortController|null>(null);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;mutationController.current?.abort();};},[]);
  const editorRef=useRef<HTMLFormElement>(null),editorTrigger=useRef<HTMLElement|null>(null);useEffect(()=>{if(draft){editorRef.current?.scrollIntoView({block:"start"});editorRef.current?.querySelector<HTMLElement>('input:not([disabled]),textarea:not([disabled]),button[role="combobox"]:not([disabled])')?.focus({preventScroll:true});}else editorTrigger.current?.focus({preventScroll:true});},[!!draft]);
  const [deleting,setDeleting]=useState("");const [chats,setChats]=useState<Conversation[]>([]);useEffect(()=>{let active=true;const controller=new AbortController();void scheduleRequest<Conversation[]>("/conversations",{signal:controller.signal}).then(value=>{if(active)setChats(value);}).catch(()=>{});return()=>{active=false;controller.abort();};},[task?.id]);const eligibleChats=chats.filter(chat=>chat.purpose!=='mandala-main'&&chat.agentId===draft?.agentId&&chat.projectId===draft?.projectId&&chat.cli===draft?.cli&&(draft?.workspaceId===undefined||chat.workspaceId===draft.workspaceId));
  useEffect(()=>{const update=()=>{const params=new URLSearchParams(location.search);setProjectId(params.get("project")??"all");setSelectedId(params.get("schedule")??"");};addEventListener('popstate',update);return()=>removeEventListener('popstate',update);},[]);
  const changeProject=(value:string)=>{const params=new URLSearchParams(location.search);value==='all'?params.delete('project'):params.set('project',value);params.delete('schedule');navigateAssetPage(location.pathname+(params.size?'?'+params:''));};
  useEffect(()=>{const locked=!!draft;onEditingChange?.(locked);const unload=(event:BeforeUnloadEvent)=>{if(locked){event.preventDefault();event.returnValue="";}};addEventListener("beforeunload",unload);return()=>{onEditingChange?.(false);removeEventListener("beforeunload",unload);};},[!!draft,onEditingChange]);
  const runtimes=enabledRuntimes(config);
  const format=(at:string,timeZone?:string)=>new Intl.DateTimeFormat(language,{dateStyle:"medium",timeStyle:"short",...(timeZone?{timeZone}:{})}).format(new Date(at));
  const summary=(a:Automation)=>a.schedule.kind==="interval"?(localize(`每 ${a.schedule.minutes} 分钟`, `Every ${a.schedule.minutes} minutes`)):a.schedule.kind==="once"?format(a.schedule.at):
    `${a.schedule.kind==="daily"?t("每天"):weekdayText(a.schedule,language !== 'zh-CN')} ${a.schedule.time} · ${a.schedule.timeZone}`;
  const bindingChanged=(a:Automation)=>!!task&&(a.projectId!==(task.projectId??'')||!a.goalId&&a.agentId!==(task.assigneeAgentId??''));
  const createDraft=(a?:Automation)=>{
    if(loading)return;
    editorTrigger.current=document.activeElement instanceof HTMLElement?document.activeElement:null;
    const selected=task?task.projectId??"":a?.projectId??(projectId!=="all"?projectId:"");
    const agent=a?.goalId?config.agents.find(x=>x.id===a.agentId):task?config.agents.find(x=>x.id===task.assigneeAgentId):a?config.agents.find(x=>x.id===a.agentId):undefined;
    if(!a)createKey.current=crypto.randomUUID();
    const schedule=a?.schedule,repair=!!a&&bindingChanged(a);
    setDraft({id:a?.id,revision:a?.revision,taskId:a?.goalId?undefined:task?.id??a?.taskId,goalId:a?.goalId,executionMode:a?a.executionMode:task?'continuous':'independent',missedPolicy:a?.missedPolicy??(a?'manual':'latest'),overlapPolicy:a?.overlapPolicy??(a?'queue':'coalesce'),conversationId:repair?null:a?.conversationId??null,name:task?.goal.split("\n")[0]??a?.name??"",instructions:a?.instructions??task?.goal??"",projectId:selected,agentId:agent?.id??"",cli:a?.cli??(agent&&runtimes.includes(agent.defaultCli)?agent.defaultCli:""),
      workspaceId:repair?undefined:a?.workspaceId,enabled:repair?false:a?.enabled??false,kind:schedule?.kind??"daily",minutes:schedule?.kind==='interval'?schedule.minutes:60,anchor:schedule?.kind==='interval'?schedule.anchor:new Date().toISOString(),time:schedule&&(schedule.kind==='daily'||schedule.kind==='weekly')?schedule.time:"09:00",
      timeZone:schedule&&(schedule.kind==='daily'||schedule.kind==='weekly')?schedule.timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,
      weekdays:schedule?.kind==="weekly"?(schedule.weekdays??[schedule.weekday!]):[1],at:localInput(schedule?.kind==="once"?new Date(schedule.at):new Date(Date.now()+86400000))});
    setError("");setDeleting("");
  };
  const mutate=async(path:string,method:string,body?:unknown)=>{
    if(pending)return;invalidate();setPending(true);setPendingPath(path);setError('');const controller=new AbortController();mutationController.current=controller;let submitted=false;
    try{
      const needsKey=method==='POST'&&(path==='/automations'||path.endsWith('/run'));
      let key:string|undefined=path==='/automations'?createKey.current:undefined;
      if(needsKey&&!key){key=scheduleCommandKey(commandIdentity,path);setPendingCommands(current=>({...current,[path]:key!}));}
      submitted=true;
      const result=await scheduleRequest<Automation|AutomationRun>(path,{method,signal:controller.signal,headers:{'Content-Type':'application/json',...(needsKey?{'Idempotency-Key':key!}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
      // Receipt acceptance is independent from the following read. Never replay a
      // confirmed command merely because the directory could not be refreshed.
      if(path.endsWith('/run')){try{confirmScheduleCommand(commandIdentity,path,key!);if(mounted.current)setPendingCommands(pendingScheduleCommands(commandIdentity));}catch{if(mounted.current)setError(localize('执行已被接受，但本地检查点未能更新。开始另一请求前请核对运行历史。', 'Run accepted. The local checkpoint could not update; check run history before starting another request.'));}}
      if(!mounted.current)return false;
      invalidate();
      setState(current=>path.endsWith('/run')||path.endsWith('/catch-up')||path.endsWith('/stop')?{...current,runs:[result as AutomationRun,...current.runs.filter(run=>run.id!==result.id)]}:method==='DELETE'?{...current,automations:current.automations.filter(rule=>rule.id!==path.split('/').at(-1))}:{...current,automations:[result as Automation,...current.automations.filter(rule=>rule.id!==result.id)]});
      void refreshSnapshot(controller.signal).catch(reason=>{if(mounted.current&&!controller.signal.aborted)setError((localize('刷新失败，操作已被接受，当前回执已保留。 ', 'Refresh failed. The action was accepted; current receipt is retained. '))+reason.message);});
      return result as Automation;
    }
    catch(e){if(!mounted.current)return false;const message=(e as Error).message;if(!submitted&&method==='POST'&&path.endsWith('/run')){setError((localize('无法核对或保存此设备的请求检查点，本次未提交运行。 ', 'Cannot verify pending requests on this device. No run was submitted. '))+message);return false;}const status=(e as {status?:number}).status,unknown=status===undefined||status>=500||status>=200&&status<300;const recovery=unknown&&method==="POST"&&(path==="/automations"||path.endsWith("/run"))?(localize((path==="/automations"?"尚未确认保存结果。请保留原输入，再次保存以核对同一请求。 ":"尚未确认执行结果。刷新后再次运行仍核对同一请求；重启应用或清除浏览器数据前，请先核对运行历史。 "), (path==="/automations"?"Save was not confirmed. Keep the input unchanged and save again to check the same request. ":"Run was not confirmed. Run once again checks the same request, including after a browser reload. Review history before restarting the app or clearing browser data. "))):"";setError(message==='idempotency_conflict'?(localize("当前请求与先前提交不同。请取消编辑并核对已保存计划，再开始新请求。", "This request differs from an earlier submission. Cancel editing and review saved schedules before starting another request.")):message==='automation_catchup_pending'?(localize('正在保留待处理记录；补齐后再修改频率或处理策略。', 'Pending occurrences are still being recorded. Wait for catch-up to finish before changing frequency or policies.')):message==='revision_conflict'?(localize('规则已变化，当前输入已保留。请取消编辑并重新打开，核对最新规则后再保存。', 'The rule changed. Your input is preserved. Cancel editing and reopen it to review the latest rule before saving.')):recovery+message);if(message==='revision_conflict')void refreshSnapshot(controller.signal).catch(()=>{});return false;}finally{if(mounted.current){setPending(false);setPendingPath('');}}
  };
  const save=async(event:FormEvent)=>{
    event.preventDefault();if(!draft||!draft.cli)return;
    let schedule:Schedule;
    if(draft.kind==="once") {const at=new Date(draft.at);if(!Number.isFinite(at.getTime())){setError(t("请选择有效的执行时间。"));return;}schedule={kind:"once",at:at.toISOString()};}
    else if(draft.kind==='interval')schedule={kind:'interval',minutes:draft.minutes,anchor:draft.anchor};
    else schedule=draft.kind==="daily"?{kind:"daily",time:draft.time,timeZone:draft.timeZone}:{kind:"weekly",time:draft.time,timeZone:draft.timeZone,weekdays:draft.weekdays};
    const body:AutomationInput={...(draft.executionMode?{executionMode:draft.executionMode}:{}),taskId:draft.taskId,goalId:draft.goalId,missedPolicy:draft.missedPolicy,overlapPolicy:draft.overlapPolicy,conversationId:draft.conversationId,name:draft.name,instructions:draft.instructions,projectId:draft.projectId,agentId:draft.agentId,cli:draft.cli,
      ...(draft.workspaceId===undefined?{}:{workspaceId:draft.workspaceId}),enabled:draft.enabled,schedule};
    const saved=await mutate(draft.id?`/automations/${draft.id}`:"/automations",draft.id?"PATCH":"POST",draft.id?{...body,expectedRevision:draft.revision}:body);if(saved&&mounted.current){setDraft(null);if(!task)selectSchedule(saved.id);}
  };
  // A short manage-only list shows every rule without its search and filters.
  const few=manageOnly&&state.automations.length<=8;
  const filtered=state.automations.filter(a=>few||(task?(a.taskId??a.goalId)===task.id:projectId==="all"||a.projectId===projectId)&&a.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())&&(ruleStatus==="all"||(ruleStatus==="enabled"?a.enabled:!a.enabled)));
  const runs=state.runs.filter(r=>projectId==="all"||r.projectId===projectId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const project=config.projects.find(p=>p.id===draft?.projectId);
  const agents=config.agents.filter(a=>a.id===draft?.agentId||!a.temporary&&!a.archivedAt&&(!project||project.agentIds.includes(a.id)||isSystemAgent(config,a)));
  const selected=state.automations.find(item=>item.id===selectedId);
  const editor=draft&&<form ref={editorRef} className="automation-editor" onSubmit={save} aria-label={task?(localize((draft.id?'编辑执行规则':'新建执行规则'), (draft.id?'Edit execution rule':'New execution rule'))):(localize((draft.id?'编辑计划':'新建计划'), (draft.id?'Edit schedule':'New schedule')))}>
      <h2>{task?(localize((draft.id?'编辑执行规则':'新建执行规则'), (draft.id?'Edit execution rule':'New execution rule'))):(localize((draft.id?'编辑计划':'新建计划'), (draft.id?'Edit schedule':'New schedule')))}</h2>{!task&&draft.taskId&&<p className="field-hint">{localize('关闭规则编辑后，可在任务详情编辑目标与执行者。', 'Edit goal and assignee in task details after closing this rule editor.')}</p>}{!task&&draft.goalId&&<p className="field-hint">{localize('目标可在任务详情编辑；此规则单独选择执行智能体。', 'Edit the goal in task details. This rule selects its execution Agent separately.')}</p>}<fieldset disabled={pending||disabled}>
        {!task&&!draft.taskId&&!draft.goalId&&<label>{localize('计划名称', 'Schedule name')}<Input required maxLength={200} value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>}
        {!task&&!draft.taskId&&!draft.goalId&&<label>{localize('工作内容', 'Work instructions')}<Textarea aria-label={localize('工作内容', 'Work instructions')} required maxLength={50000} rows={4} value={draft.instructions} onChange={e=>setDraft({...draft,instructions:e.target.value})}/></label>}
        {(task||draft.taskId||draft.goalId)&&<label>{localize('执行说明', 'Execution instructions')}<Textarea aria-label={localize('执行说明', 'Execution instructions')} required maxLength={50000} rows={4} value={draft.instructions} onChange={event=>setDraft({...draft,instructions:event.target.value})}/><small>{localize('用于后续执行，任务目标与验收标准独立保留。', 'Applies to future runs; the Task goal and acceptance criteria stay separate.')}</small></label>}
        <div className="automation-fields">{!task&&!draft.taskId&&!draft.goalId&&<label>Project<Select ariaLabel="Project" value={draft.projectId} options={[{value:"",label:t("不关联项目"),icon:<Icon name="project" size={16}/>},...config.projects.map(p=>({value:p.id,label:p.name,icon:<IdentityAvatar identity={p} kind="project" size={20}/>}))]}
          onChange={id=>{const p=config.projects.find(p=>p.id===id);setDraft({...draft,projectId:id,conversationId:null,workspaceId:undefined,agentId:(!p||p.agentIds.includes(draft.agentId)||config.agents.some(agent=>agent.id===draft.agentId&&isSystemAgent(config,agent)))?draft.agentId:"",cli:(!p||p.agentIds.includes(draft.agentId)||config.agents.some(agent=>agent.id===draft.agentId&&isSystemAgent(config,agent)))?draft.cli:""});}}/></label>}
          {((!task&&!draft.taskId)||draft.goalId)&&<label>{t("智能体")}<Select ariaLabel={t("智能体")} value={draft.agentId} options={[{value:"",label:localize('选择智能体', 'Choose Agent')},...(draft.agentId&&!config.agents.some(agent=>agent.id===draft.agentId)?[{value:draft.agentId,label:(localize('智能体不可用 · ', 'Unavailable Agent · '))+draft.agentId,disabled:true}]:[]),...[...agents].sort((a,b)=>Number(isSystemAgent(config,b))-Number(isSystemAgent(config,a))).map(a=>({value:a.id,label:a.name+(a.archivedAt?(localize(' · 已归档', ' · Archived')):''),disabled:!!a.archivedAt,group:isSystemAgent(config,a)?(localize('系统智能体', 'System Agent')):(localize('智能体', 'Agents')),icon:<IdentityAvatar identity={a} kind="agent" size={20}/>}))]}
            onChange={id=>{const selected=config.agents.find(agent=>agent.id===id);setDraft({...draft,agentId:id,cli:selected&&runtimes.includes(selected.defaultCli)?selected.defaultCli:"",conversationId:null});}}/></label>}
          <label>{t("执行端")}<Select ariaLabel={t("执行端")} searchable={false} value={draft.cli} options={[{value:"",label:localize('选择执行端', 'Choose a CLI')},...(draft.cli&&!runtimes.includes(draft.cli)?[{value:draft.cli,label:runtimeLabel(draft.cli)+(localize(' · 不可用', ' · Unavailable')),disabled:true}]:[]),...runtimes.map(cli=>({value:cli,label:runtimeLabel(cli),icon:<RuntimeIcon cli={cli}/>}))]}
            onChange={cli=>{setDraft({...draft,cli:cli as Cli,conversationId:null});}}/></label>
          {project&&<label>{t("工作目录组")}<Select ariaLabel={t("工作目录组")} value={draft.workspaceId===null?"none":draft.workspaceId??""}
            options={[{value:"",label:t("默认目录组")},{value:"none",label:t("无工作目录")},...(draft.workspaceId&&!projectWorkspaces(project).some(workspace=>workspace.id===draft.workspaceId)?[{value:draft.workspaceId,label:localize('工作目录不可用', 'Unavailable workspace'),disabled:true}]:[]),...projectWorkspaces(project).map(w=>({value:w.id,label:w.name==="Default"?t("默认目录组"):w.name}))]}
            onChange={id=>setDraft({...draft,conversationId:null,workspaceId:id==="none"?null:id||undefined})}/></label>}
        </div>
        {task&&!draft.goalId&&!task.assigneeAgentId&&<p className="field-hint">{localize('启用或执行前，请先通过“编辑任务”设置执行智能体。', 'Assign an Agent in Edit task before enabling or starting.')}</p>}
        {project&&!agents.length&&<a href={"/projects/"+encodeURIComponent(project?.id??"")+"/settings"}>{t("项目尚未关联 Agent，请先在项目设置中关联。")}</a>}
        <label>{localize('执行方式', 'Execution mode')}<Select ariaLabel={localize('执行方式', 'Execution mode')} searchable={false} value={draft.executionMode??'legacy'} options={[...(!draft.executionMode?[{value:'legacy',label:executionModeText(draft,language !== 'zh-CN')}]:[]),{value:'continuous',label:localize('持续执行', 'Continuous'),description:localize('沿用同一任务与会话。', 'Continue the same Task and Chat.')},{value:'independent',label:localize('独立执行', 'Independent'),description:localize('每次新建任务与会话。', 'Create a new Task and Chat each run.')}]} onChange={mode=>{setDraft({...draft,executionMode:mode==='legacy'?undefined:mode as AutomationInput['executionMode'],conversationId:null});}}/><small>{draft.executionMode==='continuous'?(localize('在同一任务与会话中持续工作；需要时自动创建会话。', 'Keeps working in one Task and Chat; a Chat is created automatically when needed.')):draft.executionMode==='independent'?(localize('每次触发创建独立任务与会话。', 'Each trigger creates its own Task and Chat.')):(localize('修改时间会保留旧规则行为；选择新方式才会转换。', 'Saving time changes preserves this legacy behavior. Choose a mode to convert explicitly.'))}</small></label>
        {draft.executionMode!=='independent'&&<label>{localize('执行会话', 'Execution conversation')}<Select ariaLabel={localize('执行会话', 'Execution conversation')} value={draft.conversationId??''} onChange={conversationId=>{setDraft({...draft,conversationId:conversationId||null});}} options={[{value:'',label:draft.executionMode==='continuous'?(localize('自动创建或继续会话', 'Create or continue automatically')):(localize('每次新建会话', 'New conversation each run'))},...(draft.conversationId&&!eligibleChats.some(chat=>chat.id===draft.conversationId)?[{value:draft.conversationId,label:localize('绑定会话不可用', 'Bound conversation unavailable'),disabled:true}]:[]),...eligibleChats.map(chat=>({value:chat.id,label:chat.title||(localize('未命名会话', 'Untitled conversation'))}))]}/></label>}

        <div className="automation-fields"><label>{t("重复方式")}<Select ariaLabel={t("重复方式")} searchable={false} value={draft.kind==='weekly'&&draft.weekdays.length===5&&[1,2,3,4,5].every(day=>draft.weekdays.includes(day))?'workdays':draft.kind}
          options={[{value:"once",label:t("单次")},{value:"daily",label:t("每天")},{value:"weekly",label:t("每周")},{value:"workdays",label:localize('工作日（周一至周五）', 'Weekdays (Mon–Fri)')},{value:"interval",label:localize('按间隔', 'Interval')}]}
          onChange={kind=>setDraft({...draft,kind:kind==='workdays'?'weekly':kind as Schedule["kind"],...(kind==='workdays'?{weekdays:[1,2,3,4,5]}:{})})}/></label>
          {draft.kind==='interval'?<label>{localize('间隔（分钟）', 'Interval (minutes)')}<Input type="number" required min={1} max={525600} step={1} value={draft.minutes} onChange={e=>setDraft({...draft,minutes:Number(e.target.value)})}/></label>:draft.kind==="once"?<label>{t("执行时间")}<Input type="datetime-local" required value={draft.at} onChange={e=>setDraft({...draft,at:e.target.value})}/></label>:<>
            <label>{t("执行时间")}<Input type="time" required value={draft.time} onChange={e=>setDraft({...draft,time:e.target.value})}/></label>
            {draft.kind==="weekly"&&<fieldset className="schedule-weekdays"><legend>{localize('星期', 'Days of week')}</legend><div>{[1,2,3,4,5,6,0].map(day=><label key={day}><Input type="checkbox" checked={draft.weekdays.includes(day)} onChange={event=>setDraft({...draft,weekdays:event.target.checked?[...draft.weekdays,day].sort((a,b)=>a-b):draft.weekdays.filter(value=>value!==day)})}/>{localize(weekdays[day], ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day])}</label>)}</div></fieldset>}
            <label>{t("时区")}<Input required value={draft.timeZone} placeholder="Asia/Singapore" onChange={e=>setDraft({...draft,timeZone:e.target.value})}/></label>
          </>}
        </div>
        <Disclosure title={localize('高级策略', 'Advanced policies')}><div className="automation-fields"><label>{localize('错过执行时', 'Missed runs')}<Select ariaLabel={localize('错过执行时', 'Missed runs')} value={draft.missedPolicy??'manual'} options={[{value:'manual',label:localize('保留并手动补跑', 'Keep for manual catch-up')},{value:'latest',label:localize('仅补最新一次', 'Run only the latest')},...(draft.overlapPolicy!=='coalesce'?[{value:'each',label:localize('逐次处理', 'Process every occurrence')}]:[])]} onChange={value=>setDraft({...draft,missedPolicy:value as AutomationInput['missedPolicy']})}/></label><label>{localize('重复触发时', 'Overlapping checks')}<Select ariaLabel={localize('重复触发时', 'Overlapping checks')} value={draft.overlapPolicy??'queue'} options={[{value:'queue',label:localize('分别排队', 'Queue separately')},{value:'coalesce',label:localize('合并状态检查', 'Merge state checks')}]} onChange={value=>setDraft({...draft,overlapPolicy:value as AutomationInput['overlapPolicy'],...(value==='coalesce'?{missedPolicy:'latest'}:{})})}/></label></div></Disclosure>
        {draft.kind==="once"&&<p className="field-hint">{t("按当前设备时区安排：{zone}",{zone:Intl.DateTimeFormat().resolvedOptions().timeZone})}</p>}
        <p className="field-hint">{draft.enabled?(localize('保存后计划保持启用，后续执行使用本次修改。', 'Saving keeps this schedule enabled. Future runs use these changes.')):(localize('保存不会启动执行。请保存后单独启用规则。', 'Saving does not start execution. Enable the saved rule separately.'))}</p>
      </fieldset><div className="automation-actions"><Button type="button" disabled={pending||disabled} onClick={()=>setDraft(null)}>{t("取消")}</Button>
        <Button type="submit" className="primary" disabled={pending||disabled||!task&&!draft.taskId&&!draft.agentId||!draft.cli||!runtimes.includes(draft.cli)||draft.kind==='weekly'&&!draft.weekdays.length}>{task?(localize('保存规则', 'Save rule')):t(pending?"保存中…":"保存计划")}</Button></div>
    </form>;
  const renderRun=(run:AutomationRun)=><article className="automation-run" key={run.id} aria-label={`${run.name} · ${t(statusKey[run.status])}`}>
        <div><strong>{run.name}</strong><small>{format(run.createdAt)} · {runtimeLabel(run.cli)}</small>{run.taskId&&<small><a href={"/tasks/"+run.taskId} onClick={followAssetPage}>{localize('查看任务', 'View task')}</a>{run.taskState&&<span> · {localize('任务：', 'Task: ')}{taskStateLabels[run.taskState]?.[language !== 'zh-CN'?1:0]??run.taskState}{run.waitingReason?' · '+(waitingLabels[run.waitingReason]?.[language !== 'zh-CN'?1:0]??run.waitingReason):''}</span>}</small>}{run.coverage&&<small>{localize('合并触发范围：', 'Covered triggers: ')}{format(run.coverage.firstDueAt)} – {format(run.coverage.latestDueAt)}{run.coverage.count!==undefined?` (${run.coverage.count})`:''}</small>}{run.error&&<p role="status" className="form-error">{errorText(run.error)}</p>}</div>
        <StatusLabel icon={run.status==="approval"?"approval":run.status==="running"?"activity":run.status==="failed"?"error":"clock"} tone={run.status==="failed"?"danger":run.status==="approval"||run.status==="unknown"?"warning":run.status==="running"?"active":"neutral"}>{awaitingReview(run)?(localize('结果待确认', 'Awaiting review')):t(statusKey[run.status])}</StatusLabel>
        {run.status==='missed'&&<Button disabled={pending||disabled||!!draft} onClick={()=>void mutate(`/automations/${run.id}/catch-up`,'POST',{})}>{localize('补跑', 'Catch up')}</Button>}
        {run.conversationId&&<Button type="button" disabled={disabled||!!draft} onClick={()=>onOpenConversation?.(run.conversationId!)}><Icon name="message" size={15}/>{t(run.status==="approval"?"处理审批":"查看对话")}</Button>}
        {["queued","starting","running","approval","unknown"].includes(run.status)&&<Button type="button" disabled={pending||disabled||!!draft} aria-label={t("停止本次运行")} onClick={()=>void mutate(`/automations/${run.id}/stop`,"POST",{})}><Icon name="stop" size={15}/>{t("停止")}</Button>}
      </article>;
  const renderPlan=(a:Automation)=><article className={"automation-plan"+(!task?" schedule-detail-plan":"")} key={a.id} aria-label={a.name}>
        <div><h3>{!task&&((a.goalId||a.taskId)?<a href={'/tasks/'+(a.goalId||a.taskId)} onClick={followAssetPage}>{a.name}</a>:a.name)}<StatusLabel icon="schedule" tone={a.enabled&&a.nextRunAt?"active":"neutral"}>{!a.enabled?(localize('已暂停', 'Paused')):t(a.nextRunAt?"已启用":"计划已结束")}</StatusLabel></h3>
          {!task&&<div className="automation-identities"><span><Icon name="agent" size={14}/>{config.agents.find(x=>x.id===a.agentId)?.name||(localize('暂不指派', 'Unassigned'))}</span><span>{runtimeLabel(a.cli)}</span>{a.projectId&&<span><Icon name="project" size={14}/>{config.projects.find(x=>x.id===a.projectId)?.name??a.projectId}</span>}</div>}
          {task?<><div className="task-rule-schedule"><Icon name="schedule" size={18}/><span>{a.schedule.kind==='interval'?summary(a):a.schedule.kind==='once'?format(a.schedule.at):a.schedule.kind==='daily'?(localize('每天 ', 'Daily '))+a.schedule.time:(localize('每周 ', 'Weekly '))+weekdayText(a.schedule,language !== 'zh-CN')+' '+a.schedule.time}</span></div><small className="task-rule-zone">{a.schedule.kind==='once'||a.schedule.kind==='interval'?'':a.schedule.timeZone}</small></>:<p>{summary(a)}</p>}{bindingChanged(a)&&<p role="status">{localize('任务项目或执行者已变化。请编辑并保存规则以同步，再单独启用；原会话与目录选择将重置。', 'The task project or assignee changed. Edit and save this rule to sync its bindings, then enable it separately. Existing conversation and directory choices will reset.')}</p>}<p className="field-hint">{executionModeText(a,language !== 'zh-CN')}</p>{a.catchingUp&&<p role="status">{a.pendingThroughAt?(localize('正在补齐暂停前的待处理记录：', 'Finishing records due before pause: ')):(localize('正在补齐待处理记录：', 'Catching up from '))}{(a.pendingFromAt??a.nextRunAt)&&format((a.pendingFromAt??a.nextRunAt)!)}</p>}{a.enabled&&a.nextRunAt&&<p className="automation-next">{t("下次运行：{time}",{time:format(a.nextRunAt,(a.schedule.kind==="once"||a.schedule.kind==='interval')?undefined:a.schedule.timeZone)})}</p>}
          {a.reportConversationId&&<p>{localize('结果回报到：', 'Results return to: ')}<a href={'/?conversation='+encodeURIComponent(a.reportConversationId)} onClick={followAssetPage}>{chats.find(chat=>chat.id===a.reportConversationId)?.title||(localize('Mandala 对话', 'Mandala conversation'))}</a></p>}{!task&&<DetailSection title={localize('工作内容与执行位置', 'Work and destination')}><p className="schedule-instructions">{a.instructions}</p><dl><dt>{localize('会话方式', 'Conversation')}</dt><dd>{(a.conversationId??a.executionConversationId)?<a href={'/?conversation='+encodeURIComponent((a.conversationId??a.executionConversationId)!)} onClick={followAssetPage}>{chats.find(chat=>chat.id===(a.conversationId??a.executionConversationId))?.title||(localize('查看会话', 'View conversation'))}</a>:a.executionMode==='continuous'?(localize('首次执行时自动创建', 'Created automatically on first run')):localize('每次新建会话', 'New conversation each run')}</dd>{a.projectId&&a.workspaceId!==null&&<><dt>{localize('工作目录', 'Workspace')}</dt><dd>{projectWorkspaces(config.projects.find(project=>project.id===a.projectId)??{id:'',name:'',cwd:'',agentIds:[],resources:[],mcp:[],skills:[]}).find(workspace=>workspace.id===a.workspaceId)?.name||(a.projectId?(localize('项目默认目录', 'Project default')):(localize('无项目工作目录', 'No project workspace')))}</dd></>}</dl></DetailSection>}
        </div><div className="automation-plan-actions">{pendingCommands["/automations/"+a.id+"/run"]&&!pending&&<span role="status">{localize('提交结果待核对', 'Check submission')}</span>}
          <Button type="button" aria-busy={pendingPath===`/automations/${a.id}/run`||undefined} aria-label={pendingPath===`/automations/${a.id}/run`?(localize('提交中…', 'Submitting…')):pendingCommands["/automations/"+a.id+"/run"]?(localize('核对上次执行', 'Check previous run')):t("运行一次")} title={pendingPath===`/automations/${a.id}/run`?(localize('提交中…', 'Submitting…')):pendingCommands["/automations/"+a.id+"/run"]?(localize('核对上次执行', 'Check previous run')):t("运行一次")} disabled={pending||disabled||!!draft||bindingChanged(a)||!a.agentId&&!pendingCommands["/automations/"+a.id+"/run"]} onClick={()=>void mutate(`/automations/${a.id}/run`,"POST",{})}><Icon name={pendingCommands["/automations/"+a.id+"/run"]?"refresh":"play"} size={15}/>{pendingPath===`/automations/${a.id}/run`?(localize('提交中…', 'Submitting…')):!task&&(pendingCommands["/automations/"+a.id+"/run"]?(localize('核对上次执行', 'Check previous run')):t("运行一次"))}</Button>
          <Button type="button" disabled={pending||disabled||!!draft} onClick={()=>createDraft(a)}><Icon name="edit" size={15}/>{t("编辑")}</Button>
          {(a.nextRunAt||!a.enabled)&&<Button type="button" disabled={pending||disabled||!!draft||bindingChanged(a)||!a.enabled&&!a.agentId} onClick={()=>void mutate(`/automations/${a.id}`,"PATCH",{enabled:!a.enabled,expectedRevision:a.revision})}>{localize((a.enabled?'暂停后续执行':'启用定时规则'), (a.enabled?'Pause future runs':'Enable schedule'))}</Button>}
          <Button type="button" aria-label={t("删除计划")} disabled={pending||disabled||!!draft} onClick={()=>setDeleting(a.id)}><Icon name="trash" size={15}/></Button>
          {deleting===a.id&&<div className="automation-delete"><p>{t("删除计划会归档规则，已有任务和历史记录保留。")}</p><Button type="button" disabled={pending||disabled} onClick={()=>setDeleting("")}>{t("取消")}</Button><Button type="button" disabled={pending||disabled} onClick={()=>void mutate(`/automations/${a.id}`,"DELETE",{expectedRevision:a.revision}).then(ok=>{if(ok)setDeleting("");})}>{t("确认删除")}</Button></div>}
        </div>
      </article>;
  const closeDetail=()=>{setDraft(null);setDeleting("");selectSchedule("");};
  const rowTrigger=(a:Automation)=>a.schedule.kind==='interval'?summary(a):a.schedule.kind==='once'?new Intl.DateTimeFormat(language,{dateStyle:'short',timeStyle:'short'}).format(new Date(a.schedule.at)):a.schedule.kind==='daily'?(localize('每天 ', 'Daily '))+a.schedule.time:weekdayText(a.schedule,language !== 'zh-CN')+' '+a.schedule.time;
  const rowNext=(a:Automation)=>a.enabled&&a.nextRunAt?(localize('下次：', 'Next: '))+new Intl.DateTimeFormat(language,{dateStyle:'short',timeStyle:'short',...(a.schedule.kind==='once'||a.schedule.kind==='interval'?{}:{timeZone:a.schedule.timeZone})}).format(new Date(a.nextRunAt)):null;
  const rowOutcome=(run:AutomationRun)=>awaitingReview(run)?(localize('结果待确认', 'Awaiting review')):rowStatus(run.status);
  const rowStatus=(status:AutomationRun["status"])=>status==='succeeded'||status==='completed'?(localize('执行结束', 'Run ended')):status==='legacy_unverified'?(localize('未验证', 'Unverified')):status==='unknown'?(localize('未知', 'Unknown')):t(statusKey[status]);
  const compactRows=<section className="schedule-rows" aria-label={t("计划列表")}>{loading?<LoadingState label={localize('读取计划…', 'Loading schedules…')}/>:filtered.length?filtered.map(a=>{const last=runs.find(run=>run.automationId===a.id);return <button type="button" className="schedule-row" key={a.id} aria-label={a.name} aria-current={selectedId===a.id?'true':undefined} disabled={!!draft} onClick={()=>selectSchedule(a.id)}><span className="schedule-row-heading"><strong>{a.name}</strong><StatusLabel icon="schedule" tone={a.enabled&&a.nextRunAt?'active':'neutral'}>{!a.enabled?(localize('已暂停', 'Paused')):t(a.nextRunAt?'已启用':'计划已结束')}</StatusLabel></span><span className="schedule-row-meta"><span className="schedule-row-context"><span className="schedule-row-trigger" title={a.enabled&&a.nextRunAt?format(a.nextRunAt,(a.schedule.kind==='once'||a.schedule.kind==='interval')?undefined:a.schedule.timeZone):summary(a)}>{rowTrigger(a)}{rowNext(a)&&<span className="schedule-row-next">{rowNext(a)}</span>}</span><span className="schedule-row-identities"><span>{config.agents.find(agent=>agent.id===a.agentId)?.name||(localize('智能体不可用', 'Unavailable Agent'))} · {runtimeLabel(a.cli)}</span>{a.projectId&&<span>{' · '}{config.projects.find(project=>project.id===a.projectId)?.name??a.projectId}</span>}</span></span><span className="schedule-row-outcome" title={last?t(statusKey[last.status]):undefined}>{last?rowOutcome(last):localize('尚未执行', 'No runs')}</span></span></button>;}):!loadError?<EmptyState icon="schedule">{search||ruleStatus!=='all'?(localize('没有匹配的计划。', 'No matching schedules.')):t('还没有定时任务')}{(search||ruleStatus!=='all')&&<Button onClick={()=>{setSearch("");setRuleStatus("all");}}>{localize('清除筛选', 'Clear filters')}</Button>}{!config.agents.length&&<a href="/agents">{t('先创建一个 Agent')}</a>}</EmptyState>:null}</section>;
  const detail=draft?<div className="schedule-detail schedule-editor"><Button className="schedule-detail-back" disabled={!!draft&&pending} onClick={closeDetail}><Icon name="arrowLeft" size={14}/>{localize('返回计划', 'Back to schedules')}</Button>{editor}</div>:selected?<div className="schedule-detail"><Button className="schedule-detail-back" disabled={!!draft&&pending} onClick={closeDetail}><Icon name="arrowLeft" size={14}/>{localize('返回计划', 'Back to schedules')}</Button>{renderPlan(selected)}<DetailSection title={localize('运行记录', 'Run history')} icon="schedule"><div className="schedule-detail-history">{runs.filter(run=>run.automationId===selected.id).length?runs.filter(run=>run.automationId===selected.id).map(renderRun):<EmptyState icon="schedule">{localize('此计划尚未执行。', 'This schedule has not run yet.')}</EmptyState>}</div></DetailSection></div>:selectedId?<div className="schedule-detail"><Button onClick={closeDetail}>{localize('返回计划', 'Back to schedules')}</Button><EmptyState icon="schedule">{localize('此计划不可用或已归档，执行记录仍可在历史中查看。', 'This schedule is unavailable or archived. Its runs remain in history.')}</EmptyState></div>:undefined;
  const createButton=!manageOnly&&(!task||!filtered.length&&!['completed','cancelled'].includes(task.state))&&<Button type="button" className="primary" disabled={disabled||loading||!!loadError||pending||!!draft||!task&&(!config.agents.length||!runtimes.length)} onClick={()=>createDraft()}><Icon name="plus" size={16}/>{task?(localize('添加执行规则', 'Add execution rule')):(localize('新建计划', 'New schedule'))}</Button>;
  return <>{!task&&header?.(createButton)}<section className={"automation-workspace"+(!task?" schedules-workspace":"")} data-detail-open={!task&&!!detail} aria-label={t("定时任务")} onClickCapture={event=>{if(draft&&(event.target as HTMLElement).closest("a")){event.preventDefault();event.stopPropagation();}}}>
    {!few&&<header className="automation-heading">{task?<h2>{localize('执行规则', 'Execution rule')}</h2>:<label><Select ariaLabel={t("项目筛选")} value={projectId} disabled={disabled||!!draft} onChange={changeProject}
      options={[{value:"all",label:t("全部项目"),icon:<Icon name="project" size={16}/>},{value:"",label:t("不关联项目"),icon:<Icon name="project" size={16}/>},...config.projects.map(p=>({value:p.id,label:p.name,icon:<IdentityAvatar identity={p} kind="project" size={20}/>}))]} /></label>}
      {!task&&<><Input type="search" aria-label={localize('搜索计划', 'Search schedules')} placeholder={localize('搜索计划…', 'Search schedules…')} value={search} disabled={!!draft} onChange={event=>setSearch(event.target.value)}/><Select ariaLabel={localize('计划状态', 'Schedule state')} value={ruleStatus} disabled={!!draft} onChange={setRuleStatus} options={[{value:'all',label:localize('全部状态', 'All states')},{value:'enabled',label:localize('已启用', 'Enabled')},{value:'paused',label:localize('已暂停', 'Paused')}]}/></>}{(task||!header)&&createButton}</header>}

    {(error||loadError)&&<p className="form-error" role="alert">{errorText((error||loadError).replace('Request timed out. Check the result before trying again.',localize('请求超时。重试前请先核对结果。', 'Request timed out. Check the result before trying again.')))}{loadError&&<Button onClick={retry}>{localize('重新读取计划', 'Retry schedules')}</Button>}</p>}
    {task&&editor}

    {task?(<section className="automation-plans" aria-label={t("计划列表")}>
      {loading?<LoadingState label={localize('读取计划…', 'Loading schedules…')}/>:!filtered.length&&!loadError?<EmptyState icon="schedule"><p>{task?(localize('当前仅手动执行，可按需添加定时规则。', 'Manual execution; add a schedule when needed.')):search||ruleStatus!=="all"?(localize('没有匹配的计划。', 'No matching schedules.')):t("还没有定时任务")}</p>{(search||ruleStatus!=="all")&&<Button onClick={()=>{setSearch("");setRuleStatus("all");}}>{localize('清除筛选', 'Clear filters')}</Button>}{!config.agents.length&&<a href="/agents">{t("先创建一个 Agent")}</a>}</EmptyState>:filtered.map(renderPlan)}
    </section>):<ListDetail className="schedule-list-detail" list={compactRows} detail={detail}/>}

    {!task&&!(manageOnly&&!runs.length)&&<section className="automation-history" aria-labelledby="automation-history-title">
      <header className="automation-history-heading"><h2 id="automation-history-title">{localize('最近运行', 'Recent runs')}</h2>{runs.length>0&&<span className="automation-history-count">{runs.length}</span>}</header>
      {!runs.length?<p className="field-hint">{t("运行后，结果与审批会在这里显示。")}</p>:<div className="automation-history-list">{(showAllRuns?runs:runs.slice(0,5)).map(renderRun)}</div>}
      {runs.length>5&&<Button variant="ghost" size="sm" className="automation-history-more" aria-expanded={showAllRuns} onClick={()=>setShowAllRuns(value=>!value)}>{showAllRuns?localize('收起', 'Show less'):localize(`查看全部 ${runs.length} 条`, `Show all ${runs.length}`)}</Button>}
    </section>}
    {!manageOnly&&<Disclosure className="automation-help" title={<> <Icon name="info" size={14}/>{t("定时运行说明")} </>}><p>{localize('本地服务可用时执行；错过的运行按规则的补跑策略处理，状态检查可合并为一次待处理检查。', 'Schedules run while the local service is available. Missed runs follow each rule’s catch-up policy; state checks can merge into one pending check.')}</p>
      <p>{t("同一计划的运行依次排队；等待审批时不会自动批准。暂停影响后续投递，已开始的运行继续；停止运行不会停用计划。")}</p>
      <p>{t("自动标题和记忆提炼由系统任务设置管理。")}</p></Disclosure>}
  </section></>;
}

export function ProjectAutomations({projectId}:{projectId:string}) {
  const {text: localize, t,language,errorText}=useLanguage();const {state,loading,error}=useAutomations();
  const plans=state.automations.filter(a=>a.projectId===projectId);
  return <section className="workbench-section project-automations" aria-label={t("定时任务")}><header><h2><Icon name="schedule" size={17}/>{t("定时任务")}</h2>
    <a onClick={followAssetPage} href={`/schedules?project=${encodeURIComponent(projectId)}`}>{t("管理计划")}<Icon name="arrowRight" size={15}/></a></header>
    {error?<p role="alert" className="form-error">{errorText(error)}</p>:loading?<LoadingState label={localize('读取计划…', 'Loading schedules…')}/>:!plans.length?<p className="field-hint">{t("此项目尚无定时任务")}</p>:plans.map(a=><div className="project-automation-row" key={a.id}><strong>{a.name}</strong>
      <span>{!a.enabled?t("已暂停"):a.nextRunAt?new Intl.DateTimeFormat(language,{dateStyle:"short",timeStyle:"short"}).format(new Date(a.nextRunAt)):t("计划已结束")}</span></div>)}
  </section>;
}
