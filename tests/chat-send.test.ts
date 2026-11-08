import { expect, it } from 'vitest';
import { submitChatInput, type SubmissionRecovery } from '../src/chat-send';

const body = { text: 'Synthetic request', commandKey: 'synthetic-key' };
const accepted = { id: 'input', commandKey: body.commandKey, state: 'completed' };

it('reads the exact command key after a lost receipt without replaying the mutation', async () => {
 const calls: string[] = [];
 const call = async (path: string, method: string) => {
  calls.push(method + ' ' + path);
  if (method === 'POST') throw new Error('Lost receipt');
  return [{ ...accepted, commandKey: 'other-key' }, accepted];
 };
 await expect(submitChatInput(call, 'chat', body, 'queue')).resolves.toEqual(accepted);
 expect(calls).toEqual(['POST /conversations/chat/queue', 'GET /conversations/chat/queue']);
});

for (const input of [null, { ...accepted, state: 'unknown' }, { ...accepted, state: 'cancelled' }, { ...accepted, unrecorded: true }]) {
 it(`keeps an unconfirmed draft recoverable for ${JSON.stringify(input)}`, async () => {
  let posts = 0;
  const recovery = {};
  const call = async (_path: string, method: string) => {
   if (method === 'POST') { posts++; throw new Error('Lost receipt'); }
   return input ? [input] : [];
  };
  await expect(submitChatInput(call, 'chat', body, 'queue', recovery)).rejects.toThrow();
  await expect(submitChatInput(call, 'chat', body, 'queue', recovery)).rejects.toThrow();
  expect(posts).toBe(1);
 });
}

it('recovers after reconnect by readback only when a later manual send uses the same command', async () => {
 let online = false, posts = 0;
 const recovery = {};
 const call = async (_path: string, method: string) => {
  if (method === 'POST') { posts++; throw new Error('Offline'); }
  if (!online) throw new Error('Offline');
  return [accepted];
 };
 await expect(submitChatInput(call, 'chat', body, 'continue', recovery)).rejects.toThrow('提交状态待确认');
 online = true;
 await expect(submitChatInput(call, 'chat', body, 'continue', recovery)).resolves.toEqual(accepted);
 expect(posts).toBe(1);
});

it('never repeats a stop after its lost receipt when a newer run is active', async () => {
 const calls: string[] = [], recovery = {expectedExecutionId:'old-run'};
 const call = async (path: string, method: string) => {
  calls.push(method + ' ' + path);
  if (method === 'POST') throw new Error('Lost stop receipt');
  return [];
 };
 await expect(submitChatInput(call, 'chat', body, 'interrupt', recovery)).rejects.toThrow();
 await expect(submitChatInput(call, 'chat', body, 'interrupt', recovery)).rejects.toThrow();
 expect(calls).toEqual(['POST /conversations/chat/queue','GET /conversations/chat/queue','GET /conversations/chat/queue']);
});

for (const input of [{ ...accepted, state: 'unknown' }, { ...accepted, state: 'cancelled' }, { ...accepted, unrecorded: true }]) {
 it(`does not report a successful send for an unusable direct receipt: ${JSON.stringify(input)}`, async () => {
  await expect(submitChatInput(async () => input, 'chat', body, 'queue')).rejects.toThrow();
 });
}


for (const readback of [false, true]) for (const input of [{ ...accepted, state: 'cancelled' }, { ...accepted, unrecorded: true }]) {
 it(`marks an unusable terminal receipt as rejected without replay: readback=${readback}, ${JSON.stringify(input)}`, async () => {
  const recovery: SubmissionRecovery = {};
  const calls: string[] = [];
  const call = async (_path: string, method: string) => {
   calls.push(method);
   if(method==='POST') { if(readback)throw new Error('Lost receipt'); return input; }
   return [input];
  };
  await expect(submitChatInput(call, 'chat', body, 'queue', recovery)).rejects.toThrow('unrecorded' in input ? '无法确认执行记录' : '提交未执行');
  expect(recovery.rejection).toBeInstanceOf(Error);
  const originalCalls=calls.slice();
  await expect(submitChatInput(call, 'chat', body, 'queue', recovery)).rejects.toBe(recovery.rejection);
  expect(calls).toEqual(originalCalls);
 });
}

for (const readback of [false, true]) it(`keeps unknown receipts pinned for later readback: readback=${readback}`, async () => {
 const recovery: SubmissionRecovery = {};
 let complete=false,posts=0;
 const call=async (_path:string,method:string)=>{
  const input=complete?accepted:{...accepted,state:'unknown'};
  if(method==='POST'){posts++;if(readback)throw new Error('Lost receipt');return input;}
  return [input];
 };
 await expect(submitChatInput(call,'chat',body,'queue',recovery)).rejects.toThrow('提交状态待确认');
 expect(recovery.attempted).toBe(true);expect(recovery.rejection).toBeUndefined();
 complete=true;
 await expect(submitChatInput(call,'chat',body,'queue',recovery)).resolves.toEqual(accepted);
 expect(posts).toBe(1);
});

for(const status of [403,409,422])it(`allows an explicit same-key retry after a definite ${status} rejection without automatically retrying`,async()=>{
 const recovery:SubmissionRecovery={},calls:unknown[]=[];let reject=true;
 const call=async(_path:string,method:string,payload?:unknown)=>{calls.push(payload);if(reject){reject=false;throw Object.assign(new Error('Not accepted'),{status});}return {...accepted,state:'queued'};};
 await expect(submitChatInput(call,'chat',body,'queue',recovery)).rejects.toThrow('Not accepted');expect(calls).toEqual([body]);
 await expect(submitChatInput(call,'chat',body,'queue',recovery)).resolves.toMatchObject({commandKey:body.commandKey,state:'queued'});expect(calls).toEqual([body,body]);
});
