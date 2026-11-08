import {useState} from 'react';
import type {Automation,AutomationRun,AutomationState,Schedule} from '../shared/automations';
import {executionResultHref} from '../shared/conversation-results';
import {weekdayText,awaitingReview} from './schedule-view';
import {useLanguage} from './i18n';
import Button from './ui/Button';
import Icon from './ui/Icon';
import Disclosure from './ui/Disclosure';
import EmptyState from './ui/EmptyState';
import StatusMark,{statusShape} from './ui/StatusMark';
import {relativeTime} from './mandala-panel-time';

type RuleFilter='all'|'enabled'|'paused';
export function scheduleText(schedule:Schedule,english:boolean){
 if(schedule.kind==='interval')return english?`Every ${schedule.minutes} minutes`:`每 ${schedule.minutes} 分钟`;
 if(schedule.kind==='once')return (english?'Once · ':'单次 · ')+new Date(schedule.at).toLocaleString(english?'en':'zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
 return (schedule.kind==='daily'?(english?'Daily':'每天'):weekdayText(schedule,english))+' '+schedule.time+' · '+schedule.timeZone;
}
export function runSummary(run:AutomationRun,say:(zh:string,en:string)=>string){
 if(awaitingReview(run))return {tone:'warning',shape:statusShape('review'),text:say('结果待确认','Awaiting review')};
 const map:Record<string,[string,string,string]>={succeeded:['success','已结束','Ended'],completed:['success','已结束','Ended'],running:['active','执行中','Running'],starting:['active','正在启动','Starting'],queued:['active','等待执行','Queued'],approval:['warning','等待审批','Awaiting approval'],missed:['warning','等待补跑','Awaiting catch-up'],interrupted:['neutral','已中断','Interrupted'],failed:['danger','执行失败','Failed'],legacy_unverified:['neutral','历史记录未验证','History unverified']};
 const [tone,zh,en]=map[run.status]??['neutral','执行状态待确认','Execution unconfirmed'];
 return {tone,shape:statusShape(run.status),text:say(zh,en)};
}
const order=(rule:Automation)=>rule.enabled?(rule.nextRunAt??'9'):'~';

export default function MandalaSchedulesTab({rules,runs,onOpen}:{rules:Automation[];runs:AutomationState['runs'];onOpen:(path:string)=>void}){
 const {text:say,language}=useLanguage(),english=language!=='zh-CN',now=Date.now();
 const [filter,setFilter]=useState<RuleFilter>('all');
 const counts={all:rules.length,enabled:rules.filter(rule=>rule.enabled).length,paused:rules.filter(rule=>!rule.enabled).length};
 const shown=rules.filter(rule=>filter==='all'||(filter==='enabled')===rule.enabled).sort((a,b)=>order(a).localeCompare(order(b)));
 const labels:Record<RuleFilter,string>={all:say('全部','All'),enabled:say('已启用','Enabled'),paused:say('已暂停','Paused')};
 return <>
  <div className="mandala-task-scope" role="group" aria-label={say('定时筛选','Schedule filter')}>{(['all','enabled','paused'] as const).map(value=><Button key={value} aria-pressed={filter===value} onClick={()=>setFilter(value)}>{labels[value]} <span className="mandala-scope-count">{counts[value]}</span></Button>)}</div>
  {!shown.length&&<EmptyState icon="schedule">{rules.length?(filter==='enabled'?say('没有启用中的定时安排。','No enabled schedules.'):say('没有已暂停的定时安排。','No paused schedules.')):say('还没有定时安排。在聊天中说明何时需要完成什么。','No schedules yet. Describe what should happen and when in chat.')}</EmptyState>}
  <div className="mandala-rule-list">{shown.map(rule=>{
   const latest=runs.filter(run=>run.automationId===rule.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0],last=latest&&runSummary(latest,say);
   const lastPath=latest&&(latest.conversationId?executionResultHref(latest.conversationId,latest.runId):latest.taskId?'/tasks/'+latest.taskId:null);
   const lastAt=latest&&(latest.finishedAt??latest.startedAt??latest.createdAt);
   const next=rule.enabled&&rule.nextRunAt?say(`下次 ${relativeTime(rule.nextRunAt,english,now)}`,`Next ${relativeTime(rule.nextRunAt,english,now)}`):rule.enabled?say('暂无下次执行','No next run'):null;
   return <section className="mandala-rule" key={rule.id} data-enabled={rule.enabled}>
    <div className="mandala-rule-heading">
     <button type="button" className="mandala-rule-title" aria-label={say('查看规则：','View rule: ')+rule.name} title={rule.name} onClick={()=>onOpen('/schedules?schedule='+rule.id)}><span>{rule.name}</span></button>
     <span className="mandala-rule-state"><i aria-hidden="true"/>{rule.enabled?say('已启用','Enabled'):say('已暂停','Paused')}</span>
    </div>
    <p className="mandala-rule-meta" data-tail={!last&&!rule.catchingUp||undefined}><Icon name="clock" size={13}/><span>{scheduleText(rule.schedule,english)}{next&&<span title={rule.nextRunAt?new Date(rule.nextRunAt).toLocaleString():undefined}>{' · '+next}</span>}</span></p>
    {rule.catchingUp&&<p className="mandala-rule-meta" role="status" data-tail={!last||undefined}>{rule.pendingThroughAt?say('正在补齐暂停前的待处理记录','Finishing records due before pause'):say('正在补齐待处理记录','Catching up pending occurrences')}</p>}
    {last&&(lastPath
     ?<a className="mandala-rule-last" data-tail data-tone={last.tone} href={lastPath} aria-label={say('查看上次执行','Last execution')} onClick={event=>{if(event.button||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();onOpen(lastPath);}}><StatusMark tone={last.tone} shape={last.shape}/><span>{say('上次','Last')} · {last.text}{lastAt&&' · '+relativeTime(lastAt,english,now)}</span><Icon name="arrowRight" size={13}/></a>
     :<p className="mandala-rule-last" data-tail data-tone={last.tone}><StatusMark tone={last.tone} shape={last.shape}/><span>{say('上次','Last')} · {last.text}{lastAt&&' · '+relativeTime(lastAt,english,now)}</span></p>)}
    {rule.instructions&&<Disclosure className="task-work-related mandala-rule-instructions" title={say('工作内容','Instructions')}><p>{rule.instructions}</p></Disclosure>}
   </section>;
  })}</div>
 </>;
}
