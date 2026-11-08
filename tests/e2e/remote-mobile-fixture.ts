import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { openAccountStore } from '../../server/account-store';
import {createControlServer,accountServiceAvailable} from '../helpers/account-service';
import {test} from '@playwright/test';
import { openStore } from '../../server/store';
import { readConfig,writeConfig } from '../../server/config';
import { createSessionManager } from '../../server/sessions';
import { createHttpServer } from '../../server/http';
import { connectCodex } from '../../server/codex';
import { createRpcClient } from '../../server/rpc';
import { openRemote, fromBase64 } from '../../shared/remote-crypto';
import { createAssetFiles } from '../../server/asset-files';
import { createAssets } from '../../server/assets';
import { workspacePrincipal } from '../../server/workspace-identity';

export async function remoteMobileFixture() {
 test.skip(!accountServiceAvailable,'Set MANDALA_ACCOUNT_SERVICE_SOURCE for cross-repository relay integration');
  const home = mkdtempSync(join(tmpdir(), 'mandala-remote-mobile-')), relayHome = mkdtempSync(join(tmpdir(), 'mandala-relay-mobile-'));
  const password = 'synthetic-remote-password';
  const hostAccounts = openAccountStore(home), relayAccounts = openAccountStore(relayHome);
  await hostAccounts.createUser('mobile', password); await relayAccounts.createUser('mobile', password); hostAccounts.close(); relayAccounts.close();
  const initial=await readConfig(home);await writeConfig(home,{...initial.config,agents:[...initial.config.agents,{id:'remote-fixture-agent',name:'Remote fixture Agent',defaultCli:'codex',models:{},instructions:'Synthetic remote execution',mcp:[],skills:[]}]},initial.revision);
  const store = openStore(home);
  const conversation = store.createConversation({ projectId: '', agentId: 'remote-fixture-agent', cli: 'codex', model: null });
  store.renameConversation(conversation.id, '手机端合成对话');
  store.appendEvent(conversation.id, 'text', { text: 'History remains on this computer.' });
  const manager = createSessionManager(store, async () => (await readConfig(home)).config, async options => connectCodex(createRpcClient(spawn(process.execPath, ['tests/fixtures/fake-cli.mjs', '--chat', '--state', join(home, 'native-threads.json')], { stdio: 'pipe', signal: options.signal }), { onNotification: options.onEvent, onRequest: options.onApproval, onExit: options.onExit })), undefined, home);
  const principal = workspacePrincipal(store), task = manager.taskService.createTask(principal, { goal: '合成持久任务' }, 'mobile-task');
  manager.taskService.moveTask(principal, task.id, task.revision, 'running', null, 'mobile-task-state');
  const files = createAssetFiles(home), assets = createAssets(store, files); writeFileSync(join(home, 'synthetic-output.txt'), 'Synthetic issued output');
  const staged = await files.stageFiles(principal, null, [{ allowedRoot: home, relativePath: 'synthetic-output.txt', manifestPath: 'synthetic-output.txt' }]);
  const asset = assets.createAsset(principal, { kind: 'file', title: 'Synthetic output', owner: { userId: principal.userId } });
  const version = assets.publishAssetVersion(principal, { assetId: asset.id, expectedHeadVersionId: null, submissionId: staged.submissionId, files: staged.files, provenance: { sourceVersions: [] } }, 'mobile-output');
  store.appendEvent(conversation.id, 'text', { text: `\n\n[接收交付文件](/api/v2/assets/${asset.id}/versions/${version.id}/files/0)` });
  const local = createHttpServer({ home, store, manager, requireIdentity: true }), relay = createControlServer({ home: relayHome, dist: resolve('dist') });
  local.listen(0, '127.0.0.1'); relay.listen(0, '127.0.0.1'); await Promise.all([once(local, 'listening'), once(relay, 'listening')]);
  const localUrl = `http://127.0.0.1:${(local.address() as { port: number }).port}`, relayUrl = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
  return { home, localUrl, relayUrl, password, conversation, manager, store, principal, task, inspectRequest(wire: string) {
    const state = JSON.parse(readFileSync(join(home, 'remote-access.json'), 'utf8'));
    const peer = Object.values(state.grants)[0] as string; const request = openRemote(wire, peer, state.identity.secretKey);
    return { method: request.method as string, path: request.path as string, body: request.body ? Buffer.from(fromBase64(request.body)).toString('utf8') : '' };
  }, async disconnectHost() { await new Promise<void>(r => { local.close(() => r()); local.closeAllConnections(); }); }, async close() {
    await Promise.all([new Promise<void>(r => { local.close(() => r()); local.closeAllConnections(); }), new Promise<void>(r => { relay.close(() => r()); relay.closeAllConnections(); })]);
    await manager.close(); store.close(); rmSync(home, { recursive: true, force: true }); rmSync(relayHome, { recursive: true, force: true });
  } };
}
