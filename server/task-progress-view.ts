import type {Store} from './store';
// A yielded native Run is terminal; only a current inquiry wait with live work is active.
export const liveInquiryWaitSql=`SELECT r.* FROM task_inquiry_waits w JOIN task_runs r ON r.id=w.run_id JOIN work_tasks t ON t.id=r.task_id
 WHERE w.resumed_by_run_id IS NULL AND w.task_revision=t.revision AND w.continuation_epoch=t.continuation_epoch AND t.state='waiting' AND t.waiting_reason='input'
 AND EXISTS(SELECT 1 FROM agent_messages m WHERE m.source_conversation_id=json_extract(r.routing,'$.executionConversationId') AND m.auto_resume_allowed=1 AND m.source_invocation_id IN (SELECT id FROM task_runs WHERE task_id=r.task_id)
 AND (m.state IN ('queued','running') AND m.reply_state<>'parked' OR m.state IN ('succeeded','failed') AND (m.reply_state='pending' OR m.reply_state='queued' AND EXISTS(SELECT 1 FROM task_user_inputs i WHERE i.id=m.reply_input_id AND i.state IN ('queued','running')))))`;
// Display facts do not complete a goal or start work.
export function taskActivity(store:Store,id:string,createdAt:string){
 const db=store.database;
 const changed=db.prepare('SELECT MAX(created_at) AS at FROM outbox WHERE aggregate_id=?').get(id)?.at as string|null;
 const row=db.prepare('SELECT waiting_reason,completion FROM work_tasks WHERE id=?').get(id);
 const executions=db.prepare("SELECT MAX(state IN ('queued','starting','running','approval')) AS live,MAX(state='unknown') AS uncertain FROM task_runs WHERE task_id=?").get(id)!;
 const inquiryWait=db.prepare('SELECT 1 FROM task_inquiry_waits w JOIN task_runs r ON r.id=w.run_id JOIN work_tasks t ON t.id=r.task_id WHERE r.task_id=? AND w.resumed_by_run_id IS NULL AND w.task_revision=t.revision AND w.continuation_epoch=t.continuation_epoch LIMIT 1').get(id);
 const accepted=row?.completion?JSON.parse(row.completion as string).acceptedAt as string:undefined;
 return {activityAt:[createdAt,changed,accepted].filter((at):at is string=>!!at).sort().at(-1)!,
  live:Boolean(executions.live)||Boolean(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('agent_messages','task_user_inputs')").get()!.n===2&&db.prepare(liveInquiryWaitSql+' AND r.task_id=?').get(id))||row?.waiting_reason==='approval'||row?.waiting_reason==='input'&&!executions.uncertain&&!inquiryWait};
}
