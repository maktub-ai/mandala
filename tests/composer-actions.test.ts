import { expect, it, vi } from 'vitest';
import { submitChatInput } from '../src/chat-send';
it('submits an interrupt and its queued message together against the displayed execution', async () => {
 const queued={id:'selected',state:'queued',waitingReason:'background'};
 const call=vi.fn().mockResolvedValue(queued);
 await expect(submitChatInput(call,'chat',{text:'urgent',attachments:['image'],commandKey:'key'},'interrupt',{expectedExecutionId:'old-run'})).resolves.toEqual(queued);
 expect(call.mock.calls).toEqual([
  ['/conversations/chat/queue','POST',{text:'urgent',attachments:['image'],commandKey:'key',expectedExecutionId:'old-run'}],
 ]);
});
it('never submits an interrupt without an execution identity', async () => {
 const call=vi.fn();
 await expect(submitChatInput(call,'chat',{text:'urgent'},'interrupt')).rejects.toThrow('执行状态已变更');
 expect(call).not.toHaveBeenCalled();
});
it('keeps ordinary busy messages on the durable queue', async () => {
 const queued={id:'queued-input',conversationId:'chat',text:'later',commandKey:'later-key',state:'queued',createdAt:'2026-10-18T00:00:00.000Z'};
 const call=vi.fn().mockResolvedValue(queued);
 await expect(submitChatInput(call,'chat',{text:'later',commandKey:'later-key'},'queue')).resolves.toEqual(queued);
 expect(call.mock.calls).toEqual([['/conversations/chat/queue','POST',{text:'later',commandKey:'later-key'}]]);
});
