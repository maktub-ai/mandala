import type { IncomingMessage, ServerResponse } from 'node:http';
import { ensureMandalaConfig } from '../../server/config';
import { ensureMandalaConversation } from '../../server/mandala';
import type { SessionManager } from '../../server/sessions';
import type { Store } from '../../server/store';

// Give the fixture tasks to the coordinator using its normal takeover and human-event checks.
export async function projectTaskGroupsFixture(req: IncomingMessage, res: ServerResponse, home: string, store: Store, manager: SessionManager) {
  if (req.method !== 'POST' || req.url !== '/__test__/project-task-groups/takeover') return false;
  let body = '';
  for await (const chunk of req) body += chunk;
  const ids: string[] = JSON.parse(body);
  const { config } = await ensureMandalaConfig(home);
  const main = ensureMandalaConversation(store, config);
  for (const id of ids) {
    const task = manager.taskService.getTask({ userId: store.ownerUserId }, id);
    const invocationId = 'takeover-' + id;
    const source = store.appendEvent(main.id, 'user', { text: '请跟进：' + task.goal, invocationId });
    await manager.coordination.takeover({ agentId: main.agentId, conversationId: main.id, invocationId, humanEventId: source.id },
      { taskId: id, expectedRevision: task.revision, criteria: [{ id: 'check', text: 'Review the result', checkRef: null }] }, invocationId);
  }
  res.writeHead(204).end();
  return true;
}
