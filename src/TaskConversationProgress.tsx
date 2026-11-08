import type {Agent} from '../shared/types';
import {runtimeLabel} from '../shared/runtimes';
import {runningConversationCount,type ConversationProgress} from '../shared/conversation-progress';
import {useLanguage} from './i18n';
import ExplicitProgressView from './ExplicitProgressView';
import Disclosure from './ui/Disclosure';
import {followAssetPage} from './AssetLibrary';

export function latestTaskProgress(rows:ConversationProgress[]){
 return rows.filter(row=>row.latestProgress).sort((a,b)=>Number(a.latestProgress!.historical)-Number(b.latestProgress!.historical)||b.latestProgress!.updatedAt.localeCompare(a.latestProgress!.updatedAt)||b.latestProgress!.sourceEventId-a.latestProgress!.sourceEventId)[0];
}
export function TaskProgressSummary({rows}:{rows:ConversationProgress[]}){
 const {text: localize}=useLanguage(),say=(zh:string,en:string)=>localize(zh, en);
 const latest=latestTaskProgress(rows),running=runningConversationCount(rows);
 if(!latest&&!running)return null;
 return <div className="progress-latest-summary">{running>0&&<small className="progress-latest-source">{say(`${running} 个运行对话`,`${running} running chats`)}</small>}{latest&&<><small className="progress-latest-source">{say('来自对话：','From chat: ')}{latest.title??say('未命名对话','Untitled conversation')}</small><ExplicitProgressView progress={latest.latestProgress!} compact/></>}</div>;
}
export function TaskConversationProgress({rows,agents=[]}:{rows:ConversationProgress[];agents?:readonly Pick<Agent,'id'|'name'>[]}){
 const {text: localize}=useLanguage(),say=(zh:string,en:string)=>localize(zh, en);
 const executor=(row:ConversationProgress)=>row.agentId===''?say(`无 Agent（${runtimeLabel(row.cli)}）`,`No Agent (${runtimeLabel(row.cli)})`):agents.find(agent=>agent.id===row.agentId)?.name||say('执行者未知','Unknown executor');
 const executionLabels={running:say('执行中','Running'),approval:say('等待审批','Approval required'),idle:say('空闲','Idle'),error:say('执行失败','Failed'),interrupted:say('已停止','Stopped')};
 const labels={running:say('执行中','Running'),queued:say('排队中','Queued'),waiting:say('等待协作','Waiting for a reply'),attention:say('需要处理','Needs attention'),recent:say('空闲','Idle'),completed:say('对话已结束','Chat closed')};
 return <section className="task-conversation-progress"><TaskProgressSummary rows={rows}/>{rows.map(row=><div className="task-progress-chat" key={row.id}><a data-linked-conversation-id={row.id} href={'/?conversation='+row.id} onClick={followAssetPage}>{row.title??say('未命名对话','Untitled conversation')} · {executor(row)} · {row.executionStatus?executionLabels[row.executionStatus]:row.state==='completed'?labels.completed:say('历史对话 · 执行状态未知','Past chat · execution unknown')}</a><Disclosure summaryLabel={say('对话详情：','Chat details: ')+(row.title??say('未命名对话','Untitled conversation'))} title={say('对话详情','Chat details')}><time dateTime={row.activityAt}>{new Date(row.activityAt).toLocaleString()}</time>{row.latestProgress&&<ExplicitProgressView progress={row.latestProgress}/>}<a href={'/?conversation='+row.id} onClick={followAssetPage}>{say('打开对话','Open chat')}</a></Disclosure></div>)}</section>;
}
