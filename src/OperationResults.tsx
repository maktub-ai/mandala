import {ChangeRow,TaskChangeRow,operationTask,type OperationTasks} from './TaskOperationCards';
import type {DisplayEvent} from '../shared/types';
import type {Task} from '../shared/tasks';
import type {OperationResult} from '../shared/operation-results';
import StatusLabel from './ui/StatusLabel';
import {useLanguage} from './i18n';


export default function OperationResults({events,allEvents,onOpen,taskState}:{taskState:OperationTasks;events:DisplayEvent[];allEvents:DisplayEvent[];onOpen:(path:string)=>void}){
 const {text:t}=useLanguage();
 const latest=new Map<string,OperationResult>(),heads=new Map<string,number>();
 for(const event of allEvents){const result=event.kind==='metadata'&&(event.data as {operationResult?:OperationResult}).operationResult;if(result){latest.set(result.id,result);if(!heads.has(result.id))heads.set(result.id,event.id);}}
 const names:Record<string,string>={mandala_create:t('目标已创建','Goal created'),mandala_takeover:t('目标已接管','Goal taken over'),mandala_delegate:t('任务已分派','Task delegated'),mandala_temporary:t('临时智能体已创建','Temporary Agent created'),task_create:t('任务已创建','Task created'),task_update:t('任务已更新','Task updated'),task_assign:t('执行者已调整','Assignee updated'),task_start:t('执行请求已提交','Execution requested'),task_stop:t('停止请求已处理','Stop request processed'),task_cancel:t('任务已取消','Task cancelled'),task_review:t('已请求验收','Review requested'),task_accept:t('任务已验收','Task accepted'),task_reopen:t('任务已重新打开','Task reopened'),task_request_changes:t('已要求修改','Changes requested'),task_mark_completed:t('完成请求已处理','Completion request processed'),automation_create:t('自动化规则已保存','Automation saved'),automation_update:t('自动化规则已更新','Automation updated'),automation_remove:t('自动化规则已移除','Automation removed'),automation_run:t('已请求运行自动化','Automation run requested'),automation_stop:t('已处理停止运行请求','Automation stop processed'),artifact_publish:t('产物已保存','Deliverable saved'),artifact_update:t('产物已更新','Deliverable updated'),wiki_create:t('Wiki 已创建','Wiki created'),wiki_edit:t('Wiki 内容已保存','Wiki content saved'),wiki_configure:t('Wiki 配置已保存','Wiki settings saved'),wiki_refresh:t('Wiki 更新请求已提交','Wiki refresh requested'),wiki_add_source:t('Wiki 来源已添加','Wiki source added'),wiki_remove_source:t('Wiki 来源已移除','Wiki source removed'),wiki_restore:t('Wiki 恢复请求已提交','Wiki restore requested'),skill_register:t('Skill 已保存','Skill saved'),skill_update:t('Skill 已更新','Skill updated'),skill_accept:t('Skill 建议已采纳','Skill suggestion accepted'),skill_reject:t('Skill 建议已拒绝','Skill suggestion rejected'),mandala_discover_work:t('工作发现已返回','Work discovery returned'),mandala_discover_capabilities:t('能力发现已返回','Capability discovery returned')};
 const states:Record<string,string>={queued:t('排队中','Queued'),starting:t('启动中','Starting'),running:t('执行中','Running'),approval:t('待批准','Approval needed'),succeeded:t('执行结束','Run finished'),failed:t('执行失败','Run failed'),unknown:t('状态待确认','Status unconfirmed'),interrupted:t('已中断','Interrupted'),todo:t('待办','To do'),waiting:t('等待中','Waiting'),review:t('待验收','Awaiting review'),completed:t('任务已完成','Task completed'),cancelled:t('已取消','Cancelled')};
 const verbs:Record<string,string>={mandala_create:t('新目标','New goal'),mandala_takeover:t('已接管','Taken over'),mandala_delegate:t('已分派','Delegated'),task_create:t('新任务','New task'),task_update:t('已更新','Updated'),task_assign:t('已改派','Reassigned'),task_start:t('已开始','Started'),task_stop:t('已停止','Stopped'),task_cancel:t('已取消','Cancelled'),task_review:t('请求验收','Review requested'),task_accept:t('已验收','Accepted'),task_reopen:t('已重开','Reopened'),task_request_changes:t('要求修改','Changes requested'),task_mark_completed:t('已完成','Completed')};
 const attempts=events.flatMap(event=>{const original=event.kind==='metadata'&&(event.data as {operationResult?:OperationResult}).operationResult;return original&&heads.get(original.id)===event.id?[latest.get(original.id)!]:[];});
 const results=attempts.filter(result=>result.state==='succeeded'&&result.command!=='message_ask'&&result.kind!=='discovery'&&result.facts.unchanged!=='true');
 const attemptNames:Record<string,string>={mandala_create:t('创建目标','Create goal'),mandala_delegate:t('分派任务','Delegate task'),message_ask:t('询问专员','Ask specialist')};
 const feedback=attempts.filter(result=>result.state!=='succeeded'&&Object.hasOwn(attemptNames,result.command));
 const reason=(result:OperationResult)=>{
  switch(result.errorCode){
   case 'storage_failure':return t('存储操作异常，未能确认是否受理。','A storage error prevented confirmation.');
   case 'executor_unavailable':case 'assignment_unavailable':return t('执行方当前不可用。','The executor is unavailable.');
   case 'forbidden':return t('当前权限不允许。','Current permissions do not allow this.');
   case 'invalid_message_source':return t('未指定有效的项目范围。','A valid project scope is required.');
   default:return result.state==='unknown'?t('未能确认是否受理。','Acceptance could not be confirmed.'):'';
  }
 };
 // Each task gets one live row at its first appearance in this chat; later task operations update that row.
 const rootOf=(result:OperationResult)=>result.kind==='task'&&result.state==='succeeded'?operationTask(result,taskState.tasks):undefined,firstSeen=new Map<string,number>();
 for(const event of allEvents){const result=event.kind==='metadata'&&(event.data as {operationResult?:OperationResult}).operationResult;const root=result&&heads.get(result.id)===event.id&&rootOf(latest.get(result.id)!);if(root&&!firstSeen.has(root.id))firstSeen.set(root.id,event.id);}
 const turnIds=new Set(events.map(event=>event.id)),verbOf=(result:OperationResult)=>verbs[result.command]??names[result.command]??t('操作结果已返回','Operation result returned');
 const tasks=new Map<string,{task:Task;verb:string}>();
 for(const result of results){const root=rootOf(result);if(root&&turnIds.has(firstSeen.get(root.id)!)&&!tasks.has(root.id))tasks.set(root.id,{task:root,verb:verbOf(result)});}
 // A task this chat cannot read yet keeps one plain line: what happened and its name, without a stale state.
 const generic=[...new Map(results.filter(result=>!rootOf(result)).map(result=>[result.kind==='task'&&result.path||result.id,result] as const)).values()];
 const count=tasks.size+generic.length;
 if(!count&&!feedback.length)return null;
 return <>
 {feedback.length>0&&<section className="turn-changes" aria-label={t('委派状态','Delegation status')}><h3 className="turn-changes-head">{t('委派状态','Delegation status')}</h3><ul>
  {feedback.map(result=><ChangeRow key={result.id} verb={attemptNames[result.command]} name={reason(result)} onOpen={onOpen}>
   <StatusLabel filled icon={result.state==='unknown'?'clock':'error'} tone={result.state==='unknown'?'warning':'danger'}>{result.state==='unknown'?t('结果待确认','Outcome unconfirmed'):t('未接受','Not accepted')}</StatusLabel>
  </ChangeRow>)}
 </ul></section>}
 {count>0&&<section className="turn-changes" aria-label={t('本轮改动','Changes this turn')}><h3 className="turn-changes-head">{t(`本轮改动 · ${count}`,`Changes this turn · ${count}`)}</h3><ul>
  {[...tasks.values()].map(({task,verb})=><TaskChangeRow key={task.id} task={task} verb={verb} {...taskState} onOpen={onOpen}/>)}
  {generic.map(result=>{
   const facts=result.facts,status=result.kind==='task'?undefined:facts.workState==='pending'?t('待确认','Approval needed'):facts.workState?states[facts.workState]??t('处理中','Processing'):result.command==='automation_remove'?t('已移除','Removed'):facts.enabled==='false'?t('未启用','Not enabled'):facts.enabled==='true'?t('已启用','Enabled'):facts.runState?states[facts.runState]:undefined;
   const verb=facts.workState==='pending'?t('Skill 更新建议已提交','Skill update proposed'):names[result.command]??t('操作结果已返回','Operation result returned');
   const name=[result.name.split('\n')[0],result.kind==='automation'&&facts.schedule,result.kind==='automation'&&facts.timeZone].filter(Boolean).join(' · ');
   return <ChangeRow key={result.id} verb={result.kind==='task'?verbOf(result):verb} name={name} path={result.path} onOpen={onOpen}>{status&&<StatusLabel filled icon="clock" tone={facts.enabled==='true'?'success':facts.workState==='pending'?'warning':'neutral'}>{status}</StatusLabel>}</ChangeRow>;
  })}
 </ul></section>}</>;
}
