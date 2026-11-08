import Button from './ui/Button';
import Disclosure from './ui/Disclosure';
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Approval, DisplayEvent } from "../shared/types";
import { summarizeOperations } from "./execution";
import type { ChatTurn } from "./chatTurns";
import { eventTime, formatDuration, presentRun, type RunOperation, type RunApproval } from "./runView";
import { useLanguage } from "./i18n";
import ExplicitProgressView from "./ExplicitProgressView";
import ExecutionTrace, { ApprovalContent, statusLabels } from "./ExecutionTrace";
import MarkdownMessage from "./MarkdownMessage";
import Dialog from "./Dialog";
import Icon from "./ui/Icon";
import "./observability.css";
import {reasoningTitle,type ActivityTimelineItem} from "./activity-presentation";
import {nativeQuestions} from "../shared/questions";

const running = (status: string) => ["running", "inProgress", "approval"].includes(status);
const failed = (status: string) => ["failed", "error", "declined", "blocked"].includes(status);
function operationTitle(op: RunOperation, t: ReturnType<typeof useLanguage>["t"]) {
  if (op.item.hook?.source === "platform") return t(op.item.hook.task === "title" ? "生成标题" : op.item.hook.task === "recall" ? ((op.item.result as { entries?: {kind: string}[] })?.entries?.some(entry => entry.kind === "document") ? "资料加载" : "记忆加载") : "提炼记忆");
  if (op.item.type === "fileChange") return t("修改文件");
  return op.item.command || op.item.hook?.name || op.item.tool || op.item.model || op.item.query || op.item.type;
}

function isHookEvent(event: DisplayEvent) {
  return event.kind === "hook" || event.kind === "metadata" && !!(
    (event.data as { systemTask?: string; memoryRecall?: string }).systemTask ||
    (event.data as { memoryRecall?: string }).memoryRecall);
}

function ActivityDisclosure({title,children,className=''}:{title:ReactNode;children:ReactNode;className?:string}){
 const [open,setOpen]=useState(false);
 return <Disclosure className={'run-activity-disclosure '+className} title={title} onToggle={event=>{if(event.target===event.currentTarget)setOpen(event.currentTarget.open);}}>{open&&children}</Disclosure>;
}

function OperationGroup({entry,events}:{entry:Extract<ActivityTimelineItem,{kind:'operationGroup'}>;events:DisplayEvent[]}){
 const {t}=useLanguage();
 const paths=entry.operations.map(op=>op.presentation.target).filter((path):path is string=>!!path);
 const files=entry.category==='read'&&paths.length===entry.operations.length?new Set(paths).size:undefined;
 const title=files!==undefined?t('读取 {count} 个文件',{count:files}):t(entry.category==='read'?'读取 {count} 次':'搜索 {count} 次',{count:entry.operations.length});
 const ids=new Set(entry.operations.flatMap(op=>op.eventIds));
 return <ActivityDisclosure className="run-operation-group" title={<><Icon name={entry.category==='read'?'file':'search'} size={16}/><strong>{title}</strong><span className="run-group-preview">{paths.map(path=>path.split(/[\\/]/).at(-1)).join('、')}</span><span className="run-group-state"><Icon name="check" size={12}/>{t('完成')}</span></>}>
  <ExecutionTrace events={events.filter(event=>ids.has(event.id))} lazy/>
 </ActivityDisclosure>;
}

function ReasoningActivity({entry,events}:{entry:Extract<ActivityTimelineItem,{kind:'reasoning'|'reasoningGroup'}>;events:DisplayEvent[]}){
 const {t}=useLanguage();
 const operations=entry.kind==='reasoningGroup'?entry.operations:[];
 const ids=new Set(operations.flatMap(op=>op.eventIds));
 return <ActivityDisclosure className={operations.length?'run-reasoning-summary run-reasoning-group':'run-reasoning-summary'} title={<><Icon name="memory" size={16}/><span className="run-reasoning-title" data-placeholder={reasoningTitle(entry.text)?undefined:true}>{reasoningTitle(entry.text)??t('推理摘要')}</span>{operations.length>0&&<span className="run-group-state">{t('{count} 次操作',{count:operations.length})}</span>}</>}>
  <MarkdownMessage text={entry.text}/>
  {operations.length>0&&<ExecutionTrace events={events.filter(event=>ids.has(event.id))} lazy/>}
 </ActivityDisclosure>;
}

function ApprovalHistory({approval,events}:{approval:RunApproval;events:DisplayEvent[]}){
 const {t}=useLanguage(),question=approval.request.method==='item/tool/requestUserInput';
 const labels={approved:'已允许',rejected:'已拒绝',resolved:question?'提问已结束':'请求已结束',unknown:'审批状态待确认',pending:'等待审批'} as const;
 const scope=approval.decision==='approve-conversation'?'授权本对话后续工具':approval.decision==='approve-session'?'本会话内批准':approval.decision==='approve-rule'?'始终允许此前缀':approval.decision==='approve-always'?(approval.request.method==='acp/permission'?'始终允许（原生范围）':'始终允许此工具'):approval.decision==='approve'||approval.decision==='reject'?'仅本次':undefined;
 return <ActivityDisclosure className="run-approval-history" title={<><Icon name={question?'message':'approval'} size={14}/><span>{t(labels[approval.state])}</span>{scope&&<small>{t(scope)}</small>}</>}>
  {question?nativeQuestions(approval.request).map(item=><p key={item.id}>{item.question}</p>):<ApprovalContent approval={approval.request} events={events}/>}
 </ActivityDisclosure>;
}

export default function TurnProcess({turn,run:providedRun,onInspect,approvals=[],renderApproval}:{
 turn:ChatTurn;run?:ReturnType<typeof presentRun>;onInspect:()=>void;
 approvals?:Approval[];renderApproval?:(approval:Approval)=>ReactNode;
}){
 const {text: localize, t,errorText}=useLanguage();
 const [expanded,setExpanded]=useState(false),[now,setNow]=useState(Date.now());
 const run=useMemo(()=>providedRun??presentRun(turn),[turn,providedRun]);
 const active=running(run.status),backgroundActive=run.background.some(op=>running(op.status));
 const showHistory=expanded;
 useEffect(()=>{
  if(!active&&!backgroundActive)return;
  setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);
 },[active,backgroundActive]);
 if(!turn.events.some(event=>event.kind!=='user'))return null;
 const operations=run.operations.filter(op=>op.item.type!=='hook');
 const liveApprovals=new Map(approvals.map(approval=>[approval.id,approval]));
 const latestReport=run.timeline.filter(entry=>entry.kind==='progress').sort((a,b)=>a.progress.sourceEventId-b.progress.sourceEventId).at(-1);
 const current=operations.filter(op=>running(op.status)).at(-1);
 const elapsed=run.durationMs??(active&&run.startedAt!==undefined?Math.max(0,now-run.startedAt):undefined);
 const connection=[...turn.events].reverse().find(event=>event.kind==='metadata'&&typeof (event.data as {remoteConnection?:unknown}).remoteConnection==='string')?.data as {remoteConnection:string;machineName?:string;host?:string}|undefined;
 const connecting=active&&connection?.remoteConnection==='connecting',machineLabel=connection?.machineName||connection?.host||'';
 const status=connecting?localize(`正在连接执行机器 ${machineLabel}…`,`Connecting to ${machineLabel}…`):run.status==='queued'?t(run.queueReason==='directory'?'等待目录释放':run.queueReason==='concurrency'?'等待执行名额':'等待执行'):run.status==='approval'?t('等待审批'):active?t(current?'正在执行的操作':latestReport||run.progress.length||run.reasoning.length||run.answers.length?'正在生成回复':'正在启动执行端'):run.incomplete?t('本轮未完成'):run.answers.length?localize('本轮已回复','Replied this turn'):t('本轮结束');
 const quietTime=run.lastActivityAt===undefined?0:Math.max(0,now-run.lastActivityAt);
 const visible=showHistory?run.activityTimeline:run.activityTimeline.filter(entry=>entry.kind==='error'||entry.kind==='approval'&&liveApprovals.has(entry.approval.request.id)||entry.kind==='operation'&&['interrupted','unknown'].includes(entry.operation.status));
 return <section className="turn-process" aria-label={t('执行过程')} onClick={event=>{if((event.target as HTMLElement).closest('summary'))onInspect();}}>
  <div className="turn-process-row"><Button type="button" className="turn-process-toggle" variant="ghost" aria-label={t(showHistory?'收起本轮过程':'展开本轮过程')} aria-expanded={showHistory} aria-controls={'run-'+turn.key} onClick={()=>{onInspect();setExpanded(!showHistory);}}>
   <Icon name={showHistory?'chevronDown':'chevronRight'} size={14}/>{(active||run.incomplete)&&<Icon name={active?'activity':'error'} size={14}/>}<span className="turn-process-status">{status}</span><span className="turn-process-time">{elapsed===undefined?'—':elapsed<60000?localize(`${Math.floor(elapsed/1000)} 秒`,`${Math.floor(elapsed/1000)}s`):localize(`${Math.floor(elapsed/60000)} 分 ${Math.floor(elapsed/1000)%60} 秒`,`${Math.floor(elapsed/60000)}m ${Math.floor(elapsed/1000)%60}s`)}</span>{operations.length>0&&<span className="turn-process-count">{t('{count} 次操作',{count:operations.length})}</span>}
  </Button></div>
  {connecting&&<p className="run-quiet" title={connection?.host}>{localize('首次使用这台机器时会在远端安装执行服务，可能需要一分钟。','The first run on a machine installs the remote execution service and can take about a minute.')}</p>}
  {!showHistory&&(active||run.incomplete)&&run.latestProgress&&<ExplicitProgressView progress={run.latestProgress} compact hideOutputLabel live={active}/>}
  {active&&quietTime>=15000&&<p className="run-quiet" title={t('仅表示最近收到的事件，不代表 CLI 失去响应。')}>{t('{duration} 未收到新事件',{duration:formatDuration(quietTime)})}</p>}
  <div id={'run-'+turn.key} className="turn-process-detail" data-expanded={showHistory}>
   {showHistory&&!run.timeline.length&&<p>{t('本轮没有可展示的过程事件。')}</p>}
   <ol className="run-process-timeline">{visible.map(entry=><li key={entry.key} data-timeline-key={entry.key} data-activity-kind={entry.kind}>
    {entry.kind==='progress'?<><ExplicitProgressView progress={entry.progress} latest={entry.progress.sourceEventId===latestReport?.progress.sourceEventId}/>{entry.technicalOperation&&<ActivityDisclosure title={t('上报调用')}><ExecutionTrace events={turn.events.filter(event=>entry.technicalOperation!.eventIds.includes(event.id))} lazy/></ActivityDisclosure>}</>:
     entry.kind==='operationGroup'?<OperationGroup entry={entry} events={turn.events}/>:
     entry.kind==='operation'?<ExecutionTrace events={turn.events.filter(event=>entry.operation.eventIds.includes(event.id))} lazy/>:
     entry.kind==='message'?<div className="run-commentary" data-source={run.output.some(message=>message.key===entry.message.key)?'output':'commentary'}><span className="run-commentary-label" aria-hidden="true"><span className="progress-dot" data-live={active&&entry.key===run.activityTimeline.filter(item=>item.kind==='message').at(-1)?.key||undefined}/></span><MarkdownMessage text={entry.message.text} streaming={active}/></div>:
     entry.kind==='reasoning'||entry.kind==='reasoningGroup'?<ReasoningActivity entry={entry} events={turn.events}/>:
     entry.kind==='error'?<p className="run-event-error" role="alert"><Icon name="error" size={14}/>{errorText(entry.message.text)}</p>:
     !entry.approval.decision&&renderApproval&&liveApprovals.has(entry.approval.request.id)?renderApproval(liveApprovals.get(entry.approval.request.id)!):<ApprovalHistory approval={entry.approval.state==='pending'&&!liveApprovals.has(entry.approval.request.id)?{...entry.approval,state:'unknown'}:entry.approval} events={turn.events}/>}
   </li>)}</ol>
  </div>
  {run.incomplete&&<p className="run-incomplete">{t(turn.events.some(event=>event.kind==='error'&&(event.data as {nativeTurnSubmitted?:boolean}).nativeTurnSubmitted===false)?'请求已保存，执行端尚未接受。可复制消息或在新对话中使用。':'本轮没有完整的最终答复；已收到的内容保留在过程中。')}</p>}
 </section>;
}

export function TurnFooter({ turn, run: providedRun, turns, onInspect, actions }: { turn: ChatTurn; run?: ReturnType<typeof presentRun>; turns: ChatTurn[]; onInspect: () => void; actions?: ReactNode }) {
  const { t } = useLanguage();
  const [expanded, setExpanded] = useState(false);
  const [overview, setOverview] = useState(false);
  const [now, setNow] = useState(Date.now());
  const run = useMemo(() => providedRun ?? presentRun(turn), [turn, providedRun]);
  const settled = ["idle", "error", "interrupted"].includes(run.status);
  useEffect(() => {
    if (!overview) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [overview]);
  const hooks = useMemo(() => summarizeOperations(turn.events).filter(op => op.item.type === "hook"), [turn]);
  if (!actions && !hooks.length && !settled) return null;
  return <div className="turn-footer">
    <div className="turn-footer-row">
      {actions && <div className="reply-actions">{actions}</div>}
      {settled && <Button type="button" className="run-overview-button" aria-label={t("查看执行总览")} title={t("查看执行总览")}
        onClick={() => { onInspect(); setOverview(true); }}><Icon name="clock" size={15} /></Button>}
      {hooks.length > 0 && <Button type="button" className="turn-hooks-toggle" aria-label="Hooks" aria-expanded={expanded}
        aria-controls={`hooks-${turn.key}`} onClick={() => { onInspect(); setExpanded(!expanded); }}>
        <Icon name="hook" size={13} />Hooks · {hooks.length}{hooks.some(op => running(op.status)) && <> · {t("执行中")}</>}<Icon name={expanded ? "chevronDown" : "chevronRight"} size={12} />
      </Button>}
    </div>
    <div id={`hooks-${turn.key}`} className="turn-hooks" hidden={!expanded}>
      {expanded && <ExecutionTrace events={turn.events.filter(event => isHookEvent(event) || event.kind === "status")} label="Hooks" lazy />}
    </div>
    {overview && <ExecutionOverview turn={turn} turns={turns} now={now} onClose={() => setOverview(false)} />}
  </div>;
}

function ExecutionOverview({ turn, turns, now, onClose }: { turn: ChatTurn; turns: ChatTurn[]; now: number; onClose: () => void }) {
  const { t } = useLanguage();
  const [selected, setSelected] = useState(turn.key);
  const current = turns.find(item => item.key === selected) ?? turn;
  const run = presentRun(current);
  const elapsed = run.durationMs ?? (running(run.status) && run.startedAt !== undefined ? Math.max(0, now - run.startedAt) : undefined);
  const approvalMs = run.approvalMs + (run.approvalStarted !== undefined ? Math.max(0, now - run.approvalStarted) : 0);
  const timeline = [...run.operations, ...run.modelCalls].sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity));
  const startedAt = run.startedAt;
  const end = run.endedAt ?? now;
  const extent = startedAt === undefined ? 0 : Math.max(1, end - startedAt);
  const firstOutput = current.events.find(event => event.kind === "text" || event.kind === "tool" &&
    ((event.data as { method?: string }).method?.includes("reasoning/") ?? false));
  const firstTime = eventTime(firstOutput);
  const firstOutputMs = startedAt !== undefined && firstTime !== undefined ? Math.max(0, firstTime - startedAt) : undefined;
  const labels = { idle: "本轮结束", running: "执行中", approval: "等待审批", error: "出错", interrupted: "已中断" } as const;
  return <Dialog label={t("执行总览")} className="run-overview-panel" onClose={onClose}>
    <header className="run-overview-heading"><h2>{t("执行总览")}</h2><Button type="button" aria-label={t("关闭执行总览")} onClick={onClose}><Icon name="close" size={18} /></Button></header>
    <nav className="run-turns" aria-label={t("执行总览")}>{turns.map((item, index) => <Button type="button" key={item.key} aria-pressed={item.key === selected}
      onClick={() => setSelected(item.key)} title={item.messages.find(m => m.kind === "user")?.text}>{t("第 {number} 轮", { number: index + 1 })}</Button>)}</nav>
    <div className="run-overview-body">
      <p className="run-overview-request">{current.messages.find(m => m.kind === "user")?.text}</p>
      <p>{t(labels[run.status as keyof typeof labels] ?? "状态未提供")}</p>
      <dl className="run-metrics">
        <div><dt>{t("等待时间")} · {t("平台观测")}</dt><dd>{formatDuration(elapsed)}</dd></div>
        <div><dt>{t("首个输出")} · {t("平台观测")}</dt><dd>{formatDuration(firstOutputMs)}</dd></div>
        <div><dt>{t("等待审批耗时")} · {t("平台观测")}</dt><dd>{formatDuration(approvalMs)}</dd></div>
        <div><dt>{t("操作数")}</dt><dd>{run.operations.length}</dd></div>
        <div><dt>{t("峰值并行操作")} · {t("平台观测")}</dt><dd>{run.maxParallel || "—"}</dd></div>
        {run.nativeDuration !== undefined && <div><dt>{t("CLI 轮次耗时")} · {t("原生报告")}</dt><dd>{formatDuration(run.nativeDuration)}</dd></div>}
      </dl>
      <p className="run-timing-note">{t("等待时间包括启动与审批；并行操作不累加，后台任务单独计时。")}</p>
      {run.nativeDuration !== undefined && <p className="run-timing-note">{t("原生报告与平台观测的起止范围可能不同。")}</p>}
      {elapsed === undefined && <p className="run-timing-note">{t("历史事件缺少起止时间，无法还原完整耗时。")}</p>}
      <h3>{t("执行时间线")}</h3>
      <p className="run-timing-note">{t("时间线位置按平台接收事件的时间绘制。")}</p>
      <div className="run-timeline-axis"><span>0 s</span><span>{formatDuration(elapsed)}</span></div>
      <ol className="run-timeline">{timeline.map(op => {
        const known = op.startedAt !== undefined && startedAt !== undefined;
        const left = known ? Math.max(0, Math.min(100, (op.startedAt! - startedAt!) / extent * 100)) : 0;
        const width = known ? Math.max(.5, Math.min(100 - left, ((op.endedAt ?? end) - op.startedAt!) / extent * 100)) : 0;
        return <li key={op.key} className={failed(op.status) ? "failed" : ""}>
          <div className="run-timeline-label"><span title={operationTitle(op, t)}>{op.item.type === "modelCall" ? `${t("模型调用")} · ` : ""}{operationTitle(op, t)}</span>
            <small>{t(statusLabels[op.status] ?? "状态未提供")}</small></div>
          <div className="run-timeline-track">{known ? <span style={{ marginLeft: `${left}%`, width: `${width}%` }} /> : <small>{t("时间未知")}</small>}</div>
          <small className="run-timeline-time">{formatDuration(op.durationMs ?? (known && running(op.status) ? Math.max(0, now - op.startedAt!) : undefined))} · {t(op.timingSource === "native" ? "原生报告" : known ? "平台观测" : "时间未知")}
            {known && ` · ${t("开始于 {duration}", { duration: formatDuration(Math.max(0, op.startedAt! - startedAt!)) })}`}
            {op.item.ttftMs !== undefined && ` · ${t("首个输出")} ${formatDuration(op.item.ttftMs)}`}</small>
        </li>;
      })}</ol>
      {!run.modelCalls.length && <p className="run-timing-note">{t("此执行端未提供逐次模型调用事件。")}</p>}
      <h3>{t("模型与工具明细")}</h3>
      <ExecutionTrace events={current.events.filter(e => !(e.kind === "metadata" && (e.data as { systemTask?: string }).systemTask))} lazy />
      {run.background.length > 0 && <section><h3>{t("后台任务")}</h3>
        <ul className="run-background-timings">{run.background.map(op => <li key={op.key}><span>{operationTitle(op, t)}</span>
          <small>{formatDuration(op.durationMs ?? (op.startedAt !== undefined && running(op.status) ? Math.max(0, now - op.startedAt) : undefined))} · {t("平台观测")}</small></li>)}</ul>
        <ExecutionTrace events={current.events.filter(e => e.kind === "metadata" && (e.data as { systemTask?: string }).systemTask)} lazy /></section>}
    </div>
  </Dialog>;
}
