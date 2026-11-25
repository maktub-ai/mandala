import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig, writeConfig } from '../server/config';
import { createSkillCatalog } from '../server/skill-catalog';
import { createSessionManager, type SessionManager } from '../server/sessions';
import { openStore, type Store } from '../server/store';
import type { CodexClient, CodexOptions } from '../server/codex';
import type { OmpOptions } from '../server/omp';
import type { Config } from '../shared/types';

let home: string, store: Store, manager: SessionManager | undefined;
const content = '---\nname: review\ndescription: Review using the packaged guide\n---\nRead references/guide.md and run scripts/check.sh.';

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'mana-skill-package-runtime-'));
  store = openStore(home);
});
afterEach(async () => {
  await manager?.close();
  manager = undefined;
  store.close();
  await rm(home, { recursive: true, force: true });
});

it.each([
  { cli: 'codex' as const, assignment: 'agent' },
  { cli: 'omp' as const, assignment: 'project' },
])('pins the complete $cli package for each turn and preserves $assignment bindings', async ({ cli, assignment }) => {
  const source = join(home, 'source');
  for (const directory of ['references', 'scripts', 'assets']) await mkdir(join(source, directory), { recursive: true });
  await writeFile(join(source, 'SKILL.md'), content);
  await writeFile(join(source, 'references/guide.md'), 'First guide');
  await writeFile(join(source, 'references/retired.md'), 'Old attachment');
  await writeFile(join(source, 'scripts/check.sh'), '#!/bin/sh\nprintf first\n', { mode: 0o700 });
  await writeFile(join(source, 'assets/sample.bin'), Buffer.from([0, 255, 128, 1]));
  const initial = await readConfig(home);
  const config: Config = {
    ...initial.config,
    runtimes: ['codex', 'omp'],
    system: { skillLearning: false, memoryCapture: false, automaticTaskProgress: false },
    projects: [{ id: 'p', name: 'Project', cwd: home, agentIds: ['a', 'b'], resources: [], mcp: [], skills: [], skillIds: assignment === 'project' ? ['review'] : [] }],
    agents: [
      { id: 'a', name: 'Reviewer', instructions: '', defaultCli: cli, models: {}, mcp: [], skills: [], skillIds: assignment === 'agent' ? ['review'] : [] },
      { id: 'b', name: 'Paused reviewer', instructions: '', defaultCli: cli, models: {}, mcp: [], skills: [], skillIds: ['review'], disabledSkillIds: ['review'] },
    ],
    skillLibrary: [{ id: 'review', name: 'review', path: '', content }],
  };
  const packages = new Map([['review', source]]);
  await writeConfig(home, config, initial.revision, undefined, undefined, packages);
  const first = (await readConfig(home)).config.skillLibrary![0].versionRef!;
  const catalog = createSkillCatalog(home, store);
  expect(catalog.versions((await readConfig(home)).config.skillLibrary![0])[0].files.map(file => file.path).sort()).toEqual([
    'SKILL.md', 'assets/sample.bin', 'references/guide.md', 'references/retired.md', 'scripts/check.sh',
  ]);

  let callbacks: CodexOptions, sequence = 0;
  type Received = { body: string | null; guide: string | null; retired: string | null; binary: Buffer | null; executable: boolean };
  const received: Received[] = [];
  const factory = async (options: OmpOptions): Promise<CodexClient> => {
    callbacks = options;
    let root = options.pluginDir ? join(options.pluginDir, 'skills') : '';
    return {
      getStatus: async () => ({ status: 'ready', version: 'fixture' }), listModels: async () => [],
      setSkillRoots: async roots => { root = roots[0] ?? ''; },
      startThread: async () => 'package-thread', resumeThread: async () => {},
      startTurn: async () => {
        const text = (path: string) => root ? readFile(join(root, 'review', path), 'utf8').catch(() => null) : Promise.resolve(null);
        received.push({
          body: await text('SKILL.md'), guide: await text('references/guide.md'), retired: await text('references/retired.md'),
          binary: root ? await readFile(join(root, 'review/assets/sample.bin')).catch(() => null) : null,
          executable: root ? await stat(join(root, 'review/scripts/check.sh')).then(info => Boolean(info.mode & 0o100)).catch(() => false) : false,
        });
        return `turn-${++sequence}`;
      },
      interrupt: async () => {}, replyApproval() {}, close: async () => {},
    };
  };
  manager = createSessionManager(store, async () => (await readConfig(home)).config, factory, factory, home);
  const conversation = await manager.create('p', 'a');
  const finish = async () => {
    callbacks.onEvent({ method: 'turn/completed', params: { threadId: 'package-thread', turn: { id: `turn-${sequence}`, status: 'completed' } } });
    await expect.poll(() => store.getConversation(conversation.id)?.status).toBe('idle');
  };
  const providedVersions = () => store.listEvents(conversation.id, 0).filter(event => event.kind === 'metadata' && 'skillVersions' in (event.data as object))
    .map(event => (event.data as { skillVersions: { skillId: string; assetId: string; versionId: string }[] }).skillVersions);

  await manager.send(conversation.id, 'Review with the package');
  expect(received[0]).toEqual({ body: content, guide: 'First guide', retired: 'Old attachment', binary: Buffer.from([0, 255, 128, 1]), executable: true });
  expect(providedVersions()).toEqual([[{ skillId: 'review', ...first }]]);

  // Publishing during execution must not rewrite the files already handed to the native client.
  await writeFile(join(source, 'SKILL.md'), content + '\nUpdated procedure.');
  await writeFile(join(source, 'references/guide.md'), 'Second guide');
  await rm(join(source, 'references/retired.md'));
  let snapshot = await readConfig(home);
  snapshot.config.skillLibrary![0].content = content + '\nUpdated procedure.';
  await writeConfig(home, snapshot.config, snapshot.revision, undefined, undefined, packages);
  const second = (await readConfig(home)).config.skillLibrary![0].versionRef!;
  expect(second.assetId).toBe(first.assetId);
  expect(second.versionId).not.toBe(first.versionId);
  const runtime = join(home, 'runtime', conversation.id, 'skills/review');
  expect(await readFile(join(runtime, 'SKILL.md'), 'utf8')).toBe(content);
  expect(await readFile(join(runtime, 'references/guide.md'), 'utf8')).toBe('First guide');
  expect(await readFile(join(runtime, 'references/retired.md'), 'utf8')).toBe('Old attachment');
  await finish();
  await manager.send(conversation.id, 'Review the updated package');
  expect(received[1]).toEqual({ body: content + '\nUpdated procedure.', guide: 'Second guide', retired: null, binary: Buffer.from([0, 255, 128, 1]), executable: true });
  expect(providedVersions().at(-1)).toEqual([{ skillId: 'review', ...second }]);
  await finish();

  // An attachment-only update must change the selected version and invalidate the runtime package.
  await writeFile(join(source, 'references/guide.md'), 'Third guide');
  snapshot = await readConfig(home);
  await writeConfig(home, snapshot.config, snapshot.revision, undefined, undefined, packages);
  const third = (await readConfig(home)).config.skillLibrary![0].versionRef!;
  expect(third.assetId).toBe(first.assetId);
  expect(third.versionId).not.toBe(second.versionId);
  await manager.send(conversation.id, 'Review the changed attachment');
  expect(received[2]).toEqual({ ...received[1], guide: 'Third guide' });
  expect(providedVersions()).toEqual([
    [{ skillId: 'review', ...first }], [{ skillId: 'review', ...second }], [{ skillId: 'review', ...third }],
  ]);
  await finish();

  snapshot = await readConfig(home);
  expect(snapshot.config.agents[0].skillIds).toEqual(assignment === 'agent' ? ['review'] : []);
  expect(snapshot.config.projects[0].skillIds).toEqual(assignment === 'project' ? ['review'] : []);
  expect(snapshot.config.agents[1]).toMatchObject({ skillIds: ['review'], disabledSkillIds: ['review'] });
  const owner = assignment === 'agent' ? snapshot.config.agents[0] : snapshot.config.projects[0];
  owner.disabledSkillIds = ['review'];
  await writeConfig(home, snapshot.config, snapshot.revision);
  await manager.send(conversation.id, 'Review with the Skill disabled');
  expect(received[3]).toEqual({ body: null, guide: null, retired: null, binary: null, executable: false });
  expect(providedVersions().at(-1)).toEqual([]);
  await finish();
  const saved = (await readConfig(home)).config;
  expect((assignment === 'agent' ? saved.agents[0] : saved.projects[0]).skillIds).toEqual(['review']);
  expect(saved.skillLibrary![0].versionRef).toEqual(third);
});
