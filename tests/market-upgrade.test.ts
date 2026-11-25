import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig, writeConfig } from '../server/config';
import { createMarket } from '../server/market';
import { createSkillCatalog } from '../server/skill-catalog';
import { openStore } from '../server/store';
import { linkedCapabilities } from '../shared/catalog';
import { prepareCapabilityRuntime } from '../server/omp';

let home: string;
const catalogId = 'skill:anthropics/sample', firstVersion = 'a'.repeat(40), nextVersion = 'b'.repeat(40);
const content = '---\nname: sample\ndescription: A package with resources\n---\nRead references/guide.md.';
let version: string, failDownload: boolean, onDownload: (() => Promise<void>) | undefined;
const packageFiles = () => version === firstVersion
  ? [{ path: 'SKILL.md', content, mode: '100644' }, { path: 'references/guide.md', content: 'Old guide', mode: '100644' }, { path: 'scripts/check.sh', content: '#!/bin/sh\necho old', mode: '100755' }]
  : [{ path: 'SKILL.md', content, mode: '100644' }, { path: 'references/guide.md', content: 'New guide', mode: '100644' }, { path: 'assets/image.bin', content: Buffer.from([0, 255, 128, 10]), mode: '100644' }];
const fetcher = async (url: string) => {
  if (url.includes('/git/trees/')) return Response.json({ sha: version, tree: packageFiles().map(file => ({ path: 'skills/sample/' + file.path, type: 'blob', mode: file.mode, size: Buffer.byteLength(file.content) })) });
  if (url.endsWith('references/guide.md')) { await onDownload?.(); if (failDownload) return new Response('unavailable', { status: 503 }); }
  const file = packageFiles().find(file => url.endsWith('/' + file.path));
  return file ? new Response(file.content) : new Response('missing', { status: 404 });
};
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'market-upgrade-')); version = firstVersion; failDownload = false; onDownload = undefined;
  const snapshot = await readConfig(home);
  snapshot.config.agents = [{ id: 'a', name: 'Reader', instructions: '', defaultCli: 'codex', models: {}, mcp: [], skills: [] }];
  snapshot.config.projects = [{ id: 'p', name: 'Project', cwd: '', agentIds: ['a'], resources: [], mcp: [], skills: [] }];
  await writeConfig(home, snapshot.config, snapshot.revision);
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
const install = async (market = createMarket(home, fetcher)) => market.install({ catalogId, version: firstVersion, revision: (await readConfig(home)).revision, targets: [{ kind: 'agent', id: 'a' }, { kind: 'project', id: 'p' }] });
async function runtime(id: string) {
  const store = openStore(home);
  try {
    const config = createSkillCatalog(home, store).resolve((await readConfig(home)).config, 'a');
    return await prepareCapabilityRuntime(home, id, [], linkedCapabilities(config, config.agents[0]).skills);
  } finally { store.close(); }
}

test('market registration publishes a complete immutable package with executable resources', async () => {
  const item = await install(), snapshot = await readConfig(home), skill = snapshot.config.skillLibrary![0];
  expect(skill).toMatchObject({ id: item.id, path: '', content, humanMaintained: false, versionRef: { assetId: expect.any(String), versionId: expect.any(String) } });
  const root = await runtime('registered');
  expect(await readFile(join(root, 'skills/sample/references/guide.md'), 'utf8')).toBe('Old guide');
  expect((await stat(join(root, 'skills/sample/scripts/check.sh'))).mode & 0o100).toBeTruthy();
});

test('a removed market package can be installed again with its complete resources', async () => {
  const market = createMarket(home, fetcher), item = await install(market);
  for (const target of [{ kind: 'agent', id: 'a' }, { kind: 'project', id: 'p' }] as const) await market.unlink(item.id, target, (await readConfig(home)).revision);
  await market.uninstall(item.id, (await readConfig(home)).revision);
  const reinstalled = await install(market);
  expect(reinstalled.id).toBe(item.id);
  const root = await runtime('reinstalled');
  expect(await readFile(join(root, 'skills/sample/references/guide.md'), 'utf8')).toBe('Old guide');
});

test('resource-only upgrades retain IDs and all enabled or paused bindings while replacing the complete package', async () => {
  const market = createMarket(home, fetcher), item = await install(market);
  const snapshot = await readConfig(home), original = snapshot.config.skillLibrary![0].versionRef!;
  snapshot.config.projects[0].disabledSkillIds = [item.id];
  await writeConfig(home, snapshot.config, snapshot.revision);
  const before = await runtime('running-old-version'); version = nextVersion;
  expect((await market.detail(catalogId, undefined, true)).version).toBe(nextVersion);
  const upgraded = await market.upgrade({ id: item.id, version, revision: (await readConfig(home)).revision });
  const saved = await readConfig(home), skill = saved.config.skillLibrary![0];
  expect(upgraded).toMatchObject({ id: item.id, version: nextVersion, targets: expect.any(Array) });
  expect(skill.versionRef!.assetId).toBe(original.assetId);
  expect(skill.versionRef!.versionId).not.toBe(original.versionId);
  expect(saved.config.agents[0].skillIds).toEqual([item.id]);
  expect(saved.config.projects[0].skillIds).toEqual([item.id]);
  expect(saved.config.projects[0].disabledSkillIds).toEqual([item.id]);
  const after = await runtime('next-turn');
  expect(await readFile(join(before, 'skills/sample/references/guide.md'), 'utf8')).toBe('Old guide');
  expect(await readFile(join(after, 'skills/sample/references/guide.md'), 'utf8')).toBe('New guide');
  expect(await readFile(join(after, 'skills/sample/assets/image.bin'))).toEqual(Buffer.from([0, 255, 128, 10]));
  await expect(stat(join(after, 'skills/sample/scripts/check.sh'))).rejects.toMatchObject({ code: 'ENOENT' });
  const store = openStore(home);
  try { expect(createSkillCatalog(home, store).versions(skill)).toHaveLength(2); } finally { store.close(); }
  const repeat = await market.upgrade({ id: item.id, version, revision: saved.revision });
  expect(repeat.version).toBe(nextVersion);
  expect((await readConfig(home)).config.skillLibrary![0].versionRef).toEqual(skill.versionRef);
  expect(await readdir(join(home, 'market/packages'))).toHaveLength(1);
});

test.each(['download', 'revision'] as const)('a failed %s during upgrade preserves the previous package and bindings', async failure => {
  const market = createMarket(home, fetcher), item = await install(market), snapshot = await readConfig(home);
  version = nextVersion;
  if (failure === 'download') failDownload = true;
  else onDownload = async () => { const current = await readConfig(home); current.config.agents[0].name = 'Concurrent edit'; await writeConfig(home, current.config, current.revision); };
  await expect(market.upgrade({ id: item.id, version, revision: snapshot.revision })).rejects.toThrow(failure === 'download' ? /503/ : /configuration changed/);
  const current = await readConfig(home);
  expect(current.config.skillLibrary![0].versionRef).toEqual(snapshot.config.skillLibrary![0].versionRef);
  expect(current.config.marketInstallations).toEqual(snapshot.config.marketInstallations);
  expect(current.config.agents[0].skillIds).toEqual([item.id]);
  expect(await readdir(join(home, 'market/packages'))).toHaveLength(1);
  const root = await runtime('after-failure');
  expect(await readFile(join(root, 'skills/sample/references/guide.md'), 'utf8')).toBe('Old guide');
});

test('upgrading a legacy directory installation creates a managed package without changing assignments', async () => {
  const market = createMarket(home, fetcher), item = await install(market), snapshot = await readConfig(home);
  const legacy = join(home, 'legacy'); await mkdir(legacy); await writeFile(join(legacy, 'SKILL.md'), content);
  snapshot.config.skillLibrary = [{ id: item.id, name: 'sample', path: legacy }];
  await writeConfig(home, snapshot.config, snapshot.revision); version = nextVersion;
  await market.upgrade({ id: item.id, version, revision: (await readConfig(home)).revision });
  const saved = (await readConfig(home)).config;
  expect(saved.skillLibrary![0]).toMatchObject({ id: item.id, path: '', versionRef: { assetId: expect.any(String) } });
  expect(saved.agents[0].skillIds).toEqual([item.id]); expect(saved.projects[0].skillIds).toEqual([item.id]);
  expect(await readFile(join(legacy, 'SKILL.md'), 'utf8')).toBe(content);
});

test('legacy preparation can still copy its selected package after a concurrent upgrade', async () => {
  const market=createMarket(home,fetcher),item=await install(market),snapshot=await readConfig(home);
  const legacy=join(home,'market/packages',item.packageId!);
  const selected={id:item.id,name:'sample',path:legacy};
  snapshot.config.skillLibrary=[selected];await writeConfig(home,snapshot.config,snapshot.revision);
  version=nextVersion;await market.upgrade({id:item.id,version,revision:(await readConfig(home)).revision});
  const pending=await prepareCapabilityRuntime(home,'legacy-preparation',[],[selected]);
  expect(await readFile(join(pending,'skills/sample/references/guide.md'),'utf8')).toBe('Old guide');
  expect(await readFile(join(await runtime('next-preparation'),'skills/sample/references/guide.md'),'utf8')).toBe('New guide');
});
