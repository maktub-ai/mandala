import type { QueuedInput } from '../shared/tasks';
export type SubmissionRecovery = { attempted?: boolean; stopConfirmed?: boolean; stopAttempted?: boolean; expectedExecutionId?:string; rejection?: Error };
export async function submitChatInput(
 call: (path:string, method:'POST'|'GET', body?:unknown)=>Promise<unknown>,
 id:string, body:unknown, action:'queue'|'continue'|'interrupt', state:SubmissionRecovery = {},
) {
 if(state.rejection)throw state.rejection;
 const commandKey = (body as {commandKey?:string})?.commandKey;
 const uncertain = () => new Error('提交状态待确认；输入已保留。恢复连接后再次发送只核对本机记录，不会重发。请检查对话历史，确认未提交后再重新提出。');
 const confirmed = (input:QueuedInput|undefined) => {
  if(input?.state==='cancelled' || input?.unrecorded){
   state.rejection=new Error(input.unrecorded ? '无法确认执行记录；输入已保留，请检查任务状态并调整后重试。' : '提交未执行；输入已保留，请检查任务状态并调整后重试。');
   throw state.rejection;
  }
  if(!input || !['queued','running','completed'].includes(input.state))throw uncertain();
  return input;
 };
 const reconcile = async () => {
  if (!commandKey) throw uncertain();
  let inputs:QueuedInput[];
  try { inputs = await call(`/conversations/${id}/queue`,'GET') as QueuedInput[]; } catch { throw uncertain(); }
  return confirmed(inputs.find(input => input.commandKey === commandKey));
 };
 if(state.attempted)return reconcile();
 if(action==='interrupt'&&!state.expectedExecutionId)
  throw new Error(state.stopAttempted?'停止状态待确认；请先检查当前任务。输入已保留，不会自动再次停止任务。':'执行状态已变更，请刷新对话后再发送。');
 const queued=action!=='continue';
 state.attempted = true;
 let result:unknown;
 try { result = await call(`/conversations/${id}/${queued?'queue':'continue'}`,'POST',
  action==='interrupt'?{...body as object,expectedExecutionId:state.expectedExecutionId}:body); }
 catch(error) {
  if(typeof (error as {status?:number})?.status === 'number' && (error as {status:number}).status < 500){state.attempted=false;throw error;}
  // A readback may confirm acceptance; never replay a mutation after a lost receipt.
  return reconcile();
 }
 return queued ? confirmed(result as QueuedInput) : result;
}
