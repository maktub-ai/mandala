import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { readConfig, writeConfig } from '../server/config';
import * as configuration from '../server/config';
import { openStore } from '../server/store';
import { createSessionManager } from '../server/sessions';
import type { CodexClient, CodexOptions } from '../server/codex';
import { businessCliContext } from './business-cli-context';
import { invokeBusinessCli } from '../server/business-cli-http';
import { findCommand } from '../cli/commands.mjs';
import type { IncomingMessage } from 'node:http';
import { createSkillService } from '../server/skill-service';
import { DomainError } from '../shared/workspace-contracts';

let home: string, store: ReturnType<typeof openStore>, manager: ReturnType<typeof createSessionManager>;
let native: CodexOptions, token: string, instructions: string, conversationId: string;
let context: ReturnType<typeof businessCliContext>;
const input = { name: 'query-review', content: '---\nname: query-review\ndescription: Review a query\n---\nCheck predicates before querying.' };
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'mana-skill-cli-'));
  const initial = await readConfig(home);
  await writeConfig(home, { ...initial.config, agents: ['a', 'b'].map(id => ({ id, name: id, instructions: '', defaultCli: 'codex', models: {}, runtime: { codex: { fullAccess: false } }, mcp: [], skills: [] })), skillLibrary: [{ id: 'external', name: 'external', path: '/private/unreadable-skill' }] }, initial.revision);
  store = openStore(home);
  manager = createSessionManager(store, async () => (await readConfig(home)).config, async (options): Promise<CodexClient> => {
    native = options;
    return { getStatus: async () => ({ status: 'ready', version: 'fixture' }), listModels: async () => [], startThread: async p => { instructions = p.instructions; context = businessCliContext(instructions); token = context.token; return 'native'; }, resumeThread: async () => {}, startTurn: async () => 'turn', interrupt: async () => {}, replyApproval() {}, close() {} };
  }, undefined, home);
  const chat = await manager.create('', 'a', undefined, undefined, { workspaceId: null });
  conversationId = chat.id;
  await manager.send(chat.id, 'Find or register a shared skill');
});
afterEach(async () => { await manager.close(); store.close(); await rm(home, { recursive: true, force: true }); });
const invoke = (command: string, args: Record<string, unknown>, key = command) => invokeBusinessCli(manager, { headers: { authorization: `Bearer ${token}` } } as IncomingMessage, { command, args, commandKey: key }, name => findCommand(name)?.boundTool);

test('an active Agent registers, finds and reads system content and automatically binds only its creator', async () => {
  expect(instructions).toContain('skills find; skills read; skills register');
  const before = (await readConfig(home)).config;
  const registered = await invoke('skills register', input, 'register-query') as { skill: { id: string; content: string }; assigned: boolean };
  expect(registered).toMatchObject({ skill: input, assigned: true });
  const saved = (await readConfig(home)).config;
  expect(saved.skillLibrary?.find(skill => skill.id === registered.skill.id)).toMatchObject({ ...input, path: '' });
  expect(saved.agents[0].skillIds).toEqual([registered.skill.id]);
  expect(saved.agents[1]).toEqual(before.agents[1]);
  expect(await invoke('skills find', { query: 'predicates' })).toMatchObject({ items: [{ id: registered.skill.id, name: input.name }], scope: 'system' });
  expect(await invoke('skills read', { skillId: registered.skill.id })).toMatchObject({ ...input, id: registered.skill.id });
});

test('retries preserve one registration, reject changed input, and never resurrect a removed skill', async () => {
  const [first, retry] = await Promise.all([invoke('skills register', input, 'same'), invoke('skills register', input, 'same')]) as any[];
  expect(retry.skill.id).toBe(first.skill.id);
  expect((await readConfig(home)).config.skillLibrary?.filter(skill => skill.name === input.name)).toHaveLength(1);
  await expect(invoke('skills register', { ...input, content: input.content + '\nChanged' }, 'same')).rejects.toMatchObject({ status: 409, code: 'command_conflict' });
  const snapshot = await readConfig(home);
  await writeConfig(home, { ...snapshot.config, agents:snapshot.config.agents.map(agent=>({...agent,skillIds:agent.skillIds?.filter(id=>id!==first.skill.id)})), skillLibrary: snapshot.config.skillLibrary!.filter(skill => skill.id !== first.skill.id) }, snapshot.revision);
  await expect(invoke('skills register', input, 'same')).rejects.toMatchObject({ status: 404 });
  expect((await readConfig(home)).config.skillLibrary?.filter(skill => skill.name === input.name)).toHaveLength(0);
});

test('a new registration key cannot duplicate a managed or external skill name', async () => {
  await invoke('skills register', input, 'first-name');
  await expect(invoke('skills register', input, 'second-name')).rejects.toMatchObject({ code: 'skill_exists', status: 409 });
  await expect(invoke('skills register', { name: 'external', content: input.content.replaceAll('query-review', 'external') }, 'external-name')).rejects.toMatchObject({ code: 'skill_exists', status: 409 });
  expect((await readConfig(home)).config.skillLibrary).toHaveLength(2);
});

test('tools reject external paths, identity overrides and expired invocations before mutation', async () => {
  expect(await invoke('skills find', {})).toMatchObject({ items: [] });
  await expect(invoke('skills read', { skillId: 'external' })).rejects.toMatchObject({ status: 404 });
  for (const extra of [{ path: '/tmp/skill' }, { agentId: 'b' }, { projectId: 'fake' }, { assignToSelf: true }]) {
    await expect(invoke('skills register', { ...input, ...extra }, 'spoof')).rejects.toMatchObject({ status: 422 });
  }
  await expect(invoke('skills register', { name: 'unsafe/../name', content: input.content }, 'invalid')).rejects.toMatchObject({ status: 422 });
  await expect(invoke('skills register', { name: 'too-large', content: 'a'.repeat(200001) }, 'large')).rejects.toMatchObject({ status: 422 });
  await expect(invoke('skills register', { name: 'invalid-body', content: 'No header' }, 'header')).rejects.toMatchObject({ status: 422 });
  native.onEvent({ method: 'turn/completed', params: { threadId: 'native', turn: { id: 'turn', status: 'completed' } } });
  await expect(invoke('skills register', input, 'expired')).rejects.toMatchObject({ status: 403 });
  await expect(invoke('skills find', {})).rejects.toMatchObject({ status: 403 });
  expect((await readConfig(home)).config.skillLibrary).toHaveLength(1);
  expect(store.getConversation(conversationId)?.status).toBe('idle');
});

test('the actual invocation CLI registers and reads content through its constrained mailbox', async () => {
  const run = (args: string[]) => new Promise<any>((resolve, reject) => {
    execFile(context.launcher, args, (error, stdout, stderr) => error ? reject(new Error(stderr)) : resolve(JSON.parse(stdout)));
  });
  const result = await run(['skills', 'register', '--data', JSON.stringify(input), '--key', 'cli-create']);
  expect(result).toMatchObject({ ok: true, data: { skill: input, assigned: true } });
  const read = await run(['skills', 'read', result.data.skill.id]);
  expect(read).toMatchObject({ ok: true, data: input });
  await expect(run(['skills', 'register', '--data', JSON.stringify({ ...input, agentId: 'b' })])).rejects.toThrow('Unknown Agent command argument');
});

test('registration preserves a concurrent configuration change and a same-key retry succeeds', async () => {
  const service = createSkillService(home, store);
  let calls = 0;
  await expect(service('a', 'skill_register', input, 'concurrent', () => {
    if (++calls === 1) {
      const path = join(home, 'config.json'), current = JSON.parse(readFileSync(path, 'utf8'));
      current.agents[1].name = 'Concurrent edit';
      writeFileSync(path, JSON.stringify(current));
    }
  })).rejects.toMatchObject({ code: 'stale_revision', status: 409 });
  expect((await readConfig(home)).config.agents[1].name).toBe('Concurrent edit');
  await expect(invoke('skills register', input, 'concurrent')).resolves.toMatchObject({ skill: input });
  expect((await readConfig(home)).config.agents[1].name).toBe('Concurrent edit');
});

test('revocation while a registration waits for persistence prevents the write', async () => {
  const service = createSkillService(home, store);
  let checks = 0;
  await expect(service('a', 'skill_register', input, 'revoked', () => {
    if (++checks > 1) throw new DomainError('forbidden', 403, 'Expired tool binding');
  })).rejects.toMatchObject({ status: 403 });
  expect((await readConfig(home)).config.skillLibrary).toHaveLength(1);
});

test('a lost response after persistence cannot resurrect a subsequently removed registration', async () => {
  const service = createSkillService(home, store);
  let checks = 0;
  await expect(service('a', 'skill_register', input, 'lost-response', () => {
    if (++checks > 4) throw new DomainError('forbidden', 403, 'Expired tool binding');
  })).rejects.toMatchObject({ status: 403 });
  const snapshot = await readConfig(home);
  expect(snapshot.config.skillLibrary).toHaveLength(2);
  await writeConfig(home, { ...snapshot.config, agents:snapshot.config.agents.map(agent=>({...agent,skillIds:[]})), skillLibrary: snapshot.config.skillLibrary!.filter(skill => skill.name !== input.name) }, snapshot.revision);
  await expect(invoke('skills register', input, 'lost-response')).rejects.toMatchObject({ status: 404 });
  expect((await readConfig(home)).config.skillLibrary).toHaveLength(1);
});

test('a retry interrupted after persistence cannot reuse its earlier safe-to-retry receipt', async () => {
  const service = createSkillService(home, store);
  let checks = 0;
  await expect(service('a', 'skill_register', input, 'retry-crash', () => {
    if (++checks > 1) throw new DomainError('forbidden', 403, 'Expired tool binding');
  })).rejects.toMatchObject({ status: 403 });
  const persist = configuration.writeConfig;
  const interrupted = vi.spyOn(configuration, 'writeConfig').mockImplementationOnce(async (...args) => {
    await persist(...args);
    throw new Error('Simulated interruption after configuration persistence');
  });
  try {
    await expect(invoke('skills register', input, 'retry-crash')).rejects.toThrow('Simulated interruption');
  } finally { interrupted.mockRestore(); }
  const saved = await readConfig(home);
  expect(saved.config.skillLibrary).toHaveLength(2);
  await writeConfig(home, { ...saved.config, agents:saved.config.agents.map(agent=>({...agent,skillIds:[]})), skillLibrary: saved.config.skillLibrary!.filter(skill => skill.name !== input.name) }, saved.revision);
  const restarted = createSkillService(home, store);
  await expect(restarted('a', 'skill_register', input, 'retry-crash', () => {})).rejects.toMatchObject({ code: 'command_unconfirmed', status: 409 });
  expect((await readConfig(home)).config.skillLibrary).toHaveLength(1);
});


test('registration loads its exact AssetVersion into the creating Agent on the next native turn',async()=>{
 const registered:any=await invoke('skills register',input,'next-turn');
 const registeredVersion=registered.skill.versionRef.versionId;

 native.onEvent({method:'turn/completed',params:{threadId:'native',turn:{id:'turn',status:'completed'}}});
 await manager.send(conversationId,'Apply query-review');
 const runtimeFile=join(home,'runtime',conversationId,'skills','query-review','SKILL.md');
 expect(readFileSync(runtimeFile,'utf8')).toBe(input.content);
 const loaded=store.listEvents(conversationId,0).filter(event=>event.kind==='metadata'&&(event.data as any).skillVersions?.length).at(-1)!;
 expect((loaded.data as any).skillVersions).toContainEqual({skillId:registered.skill.id,...registered.skill.versionRef});
 expect((loaded.data as any).skillVersions[0].versionId).toBe(registeredVersion);
});
test('the bound CLI retries a rolled-back journal failure with its original key and cannot recreate a removed publication',async()=>{
 store.database.exec("CREATE TRIGGER fail_cli_stage BEFORE INSERT ON skill_publication_journal BEGIN SELECT RAISE(ABORT,'fixture journal failure'); END");
 await expect(invoke('skills register',input,'precommit-retry')).rejects.toThrow();
 expect((await readConfig(home)).config.skillLibrary).toHaveLength(1);
 store.database.exec('DROP TRIGGER fail_cli_stage');const result:any=await invoke('skills register',input,'precommit-retry');expect(result.assigned).toBe(true);
 const snapshot=await readConfig(home);snapshot.config.agents[0].skillIds=[];snapshot.config.skillLibrary=snapshot.config.skillLibrary!.filter(skill=>skill.id!==result.skill.id);await writeConfig(home,snapshot.config,snapshot.revision);
 await expect(invoke('skills register',input,'precommit-retry')).rejects.toMatchObject({status:404});
});
