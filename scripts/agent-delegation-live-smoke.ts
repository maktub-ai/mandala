// Explicit opt-in real model test for same-project @Agent delegation and result delivery.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { readConfig, writeConfig } from '../server/config';
import { openStore } from '../server/store';
import { createSessionManager } from '../server/sessions';
import { createHttpServer } from '../server/http';
import { listComposerReferences } from '../server/composer-references';
const home = await mkdtemp(join(tmpdir(), 'mandala-a2a-live-'));
const initial = await readConfig(home);
await writeConfig(home, { ...initial.config, runtimes: ['opencode'], projects: [{ id: 'sample', name: 'Temporary A2A check', cwd: home, agentIds: ['lead','peer'], resources: [], mcp: [], skills: [] }], agents: ['lead','peer'].map(id => ({ id, name: id, defaultCli: 'opencode' as const, models: {}, mcp: [], skills: [], instructions: 'Use only this synthetic temporary project. Do not inspect personal files or credentials. Do not contact anyone outside this test project.', runtime: { opencode: { approvalMode: 'auto' as const } } })) }, initial.revision);
const { config } = await readConfig(home);
const store = openStore(home), manager = createSessionManager(store, async () => config, undefined, undefined, home);
const server = createHttpServer({ home, store, manager }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
const priorPort = process.env.MANDALA_PORT; process.env.MANDALA_PORT = String((server.address() as { port: number }).port);
const evidence: Record<string, unknown> = { home, cli: 'opencode', startedAt: new Date().toISOString() };
async function wait(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 180000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out: ' + label); await new Promise(r => setTimeout(r, 200)); }
}
try {
  const chat = await manager.create('sample', 'lead', undefined, 'opencode', { approvalMode: 'auto' });
  const references = await listComposerReferences({ home, store, manager, config, principal: { userId: 'local' }, conversationId: chat.id });
  const peer = references.find(item => item.kind === 'agent' && item.name === 'peer');
  if (!peer) throw new Error('Same-project peer reference missing');
  evidence.reference = true; evidence.sourceConversationId = chat.id;
  await manager.send(chat.id, 'Delegate to the selected @peer Agent using the provided Mandala CLI tasks delegate command with policy notify and stable key a2a-live-peer. Ask the peer to reply exactly MANDALA_PEER_RESULT, use no tools and do not delegate further. This explicitly authorizes this one delegation. Do not do the peer task yourself. Once delegation is accepted, reply DELEGATION_SENT and finish your turn.', [], [{ id: peer.id }]);
  await wait(() => manager.listTasks().length > 0 || store.getConversation(chat.id)!.status === 'error', 'real delegation');
  const task = manager.listTasks().find(t => t.sourceConversationId === chat.id);
  if (!task) throw new Error('No real delegation task');
  evidence.taskId = task.id;
  await wait(() => manager.listTasks().find(t => t.id === task.id)?.status === 'completed', 'peer result');
  await wait(() => !['running','approval'].includes(store.getConversation(chat.id)!.status), 'lead settled');
  const completed = manager.listTasks().find(t => t.id === task.id)!;
  if (store.getConversation(completed.targetConversationId)?.agentId !== 'peer' || !completed.result?.includes('MANDALA_PEER_RESULT')) throw new Error('Wrong peer or missing native result');
  const receipts = manager.taskService.listReceipts({ userId: 'local' }, task.id);
  if (!receipts.some(receipt => receipt.destinationConversationId === chat.id && JSON.stringify(receipt).includes('MANDALA_PEER_RESULT'))) throw new Error('Result was not delivered to original chat');
  evidence.sameProjectDelegation = true; evidence.peerResult = true; evidence.resultReceipt = true; evidence.passed = true;
} catch (error) { evidence.passed = false; evidence.error = String(error); process.exitCode = 1; }
finally {
  await manager.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); store.close();
  if (priorPort === undefined) delete process.env.MANDALA_PORT; else process.env.MANDALA_PORT = priorPort;
  evidence.finishedAt = new Date().toISOString(); await writeFile(join(home, 'verification.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence, null, 2));
}
