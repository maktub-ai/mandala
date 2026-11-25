import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open) };
});
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { fromBuffer, type Entry } from 'yauzl';
import { crc32 } from 'node:zlib';
import { openStore } from '../server/store';
import { readConfig, writeConfig } from '../server/config';
import { createAssetFiles } from '../server/asset-files';
import { createAssets } from '../server/assets';
import { workspacePrincipal } from '../server/workspace-identity';
import { createHttpServer } from '../server/http';
import type { SessionManager } from '../server/sessions';
import type { VersionRef } from '../shared/workspace-contracts';

let home: string, store: ReturnType<typeof openStore>, server: Server, base: string;
const content = '---\nname: review\ndescription: Review a sample\n---\nRead references/指南.md and run scripts/check.sh.';
const image = Buffer.from([0, 255, 137, 80, 78, 71, 13, 10]);
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'skill-export-'));
  const snapshot = await readConfig(home);
  await writeConfig(home, { ...snapshot.config, agents: [{ id: 'a', name: 'Agent', defaultCli: 'codex', models: {}, instructions: '', mcp: [], skills: [] }] }, snapshot.revision);
  store = openStore(home);
  server = createHttpServer({ home, store, manager: {} as SessionManager, requireIdentity: false });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/skills`;
});
afterEach(async () => {
  vi.mocked(fs.open).mockImplementation((await vi.importActual<typeof fs>('node:fs/promises')).open);
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close(); await rm(home, { recursive: true, force: true });
});

async function register(id = 'review', sources: VersionRef[] = [], extraFiles = 0) {
  const directory = join(home, id);
  const packageFiles = [
    { path: 'SKILL.md', data: Buffer.from(content), mode: 0o600 },
    { path: 'references/指南.md', data: Buffer.from('完整参考资料'), mode: 0o600 },
    { path: 'assets/sample.png', data: image, mode: 0o600 },
    { path: 'scripts/check.sh', data: Buffer.from('#!/bin/sh\nprintf checked\n'), mode: 0o700 },
  ];
  for (let index = 0; index < extraFiles; index++) packageFiles.push({ path: `references/item-${index}.txt`, data: Buffer.from(`Reference ${index}`), mode: 0o600 });
  for (const file of packageFiles) {
    await mkdir(join(directory, file.path, '..'), { recursive: true });
    await writeFile(join(directory, file.path), file.data, { mode: file.mode });
  }
  const files = createAssetFiles(home), assets = createAssets(store, files), principal = workspacePrincipal(store);
  const staged = await files.stageFiles(principal, null, packageFiles.map(file => ({ allowedRoot: directory, relativePath: file.path, manifestPath: file.path })), 'skill');
  const asset = assets.createAsset(principal, { kind: 'skill', title: 'review', owner: { userId: principal.userId, agentId: 'a' } });
  const version = assets.publishAssetVersion(principal, { assetId: asset.id, expectedHeadVersionId: null, submissionId: staged.submissionId, files: staged.files, provenance: { sourceVersions: sources, skill: { creatorAgentId: 'a' } } }, id);
  const snapshot = await readConfig(home);
  snapshot.config.skillLibrary = [...snapshot.config.skillLibrary ?? [], { id, name: 'review', path: '', content, versionRef: { assetId: asset.id, versionId: version.id }, creatorAgentId: 'a' }];
  await writeConfig(home, snapshot.config, snapshot.revision);
  return { asset, version, files, assets, principal, packageFiles };
}

function unpack(bytes: Buffer): Promise<Map<string, { bytes: Buffer; mode: number }>> {
  return new Promise((resolve, reject) => fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error);
    const entries = new Map<string, { bytes: Buffer; mode: number }>();
    zip.on('error', reject);
    zip.on('end', () => resolve(entries));
    zip.on('entry', (entry: Entry) => zip.openReadStream(entry, (error, stream) => {
      if (error) return reject(error);
      const chunks: Buffer[] = [];
      stream!.on('error', reject);
      stream!.on('data', chunk => chunks.push(chunk));
      stream!.on('end', () => {
        const bytes = Buffer.concat(chunks);
        try { expect(crc32(bytes)).toBe(entry.crc32); }
        catch (error) { reject(error); zip.close(); return; }
        entries.set(entry.fileName, { bytes, mode: entry.externalFileAttributes >>> 16 });
        zip.readEntry();
      });
    }));
    zip.readEntry();
  }));
}

test('exports the complete selected Skill package as a usable ZIP, including binary resources and executable scripts', async () => {
  const { version } = await register();
  const response = await fetch(`${base}/review/versions/${version.id}/export`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/zip');
  expect(response.headers.get('content-disposition')).toContain('review-v1.zip');
  const entries = await unpack(Buffer.from(await response.arrayBuffer()));
  expect([...entries.keys()]).toEqual(['review/SKILL.md', 'review/references/指南.md', 'review/assets/sample.png', 'review/scripts/check.sh']);
  expect(entries.get('review/SKILL.md')?.bytes.toString()).toBe(content);
  expect(entries.get('review/references/指南.md')?.bytes.toString()).toBe('完整参考资料');
  expect(entries.get('review/assets/sample.png')?.bytes).toEqual(image);
  expect(entries.get('review/scripts/check.sh')?.mode! & 0o777).toBe(0o700);
  expect(entries.get('review/assets/sample.png')?.mode! & 0o777).toBe(0o600);
});

test('exports an older published version without substituting the current body', async () => {
  const { version } = await register();
  const snapshot = await readConfig(home);
  snapshot.config.skillLibrary![0].content = content + '\nNew version';
  await writeConfig(home, snapshot.config, snapshot.revision);
  const response = await fetch(`${base}/review/versions/${version.id}/export`);
  expect(response.status).toBe(200);
  const entries = await unpack(Buffer.from(await response.arrayBuffer()));
  expect(entries.get('review/SKILL.md')?.bytes.toString()).toBe(content);
  expect(entries.get('review/assets/sample.png')?.bytes).toEqual(image);
});

test('exports a 201-file package accepted by Skill registration without truncating resources', async () => {
  const { version } = await register('review', [], 197);
  const response = await fetch(`${base}/review/versions/${version.id}/export`);
  expect(response.status).toBe(200);
  const entries = await unpack(Buffer.from(await response.arrayBuffer()));
  expect(entries.size).toBe(201);
  expect(entries.get('review/references/item-196.txt')?.bytes.toString()).toBe('Reference 196');
  expect(entries.get('review/assets/sample.png')?.bytes).toEqual(image);
},30000);

test('rejects another Skill asset version and unpublished versions', async () => {
  const first = await register(), other = await register('other');
  expect((await fetch(`${base}/review/versions/${other.version.id}/export`)).status).toBe(403);
  store.database.prepare("INSERT INTO skill_publication_journal VALUES(?,?,?,?,?)").run(first.version.id, first.asset.id, 'review', 'fixture', 'abandoned');
  expect((await fetch(`${base}/review/versions/${first.version.id}/export`)).status).toBe(403);
});

test('refuses export when original source evidence is no longer available', async () => {
  const source = await register('source');
  const target = await register('derived', [{ assetId: source.asset.id, versionId: source.version.id }]);
  source.assets.setLifecycle(source.principal, source.asset.id, 'retracted', source.assets.getAuthorizedAsset(source.principal, source.asset.id).revision);
  const response = await fetch(`${base}/derived/versions/${target.version.id}/export`);
  expect(response.status).toBe(403);
  expect(response.headers.get('content-type')).toContain('application/json');
});

test('fails before sending an archive if a resource is missing or changed', async () => {
  const { version, files } = await register();
  const resource = version.files.find(file => file.path === 'assets/sample.png')!;
  await writeFile(files.blobPath(resource.blobHash), Buffer.alloc(image.length));
  let response = await fetch(`${base}/review/versions/${version.id}/export`);
  expect(response.status).toBe(409);
  expect(response.headers.get('content-type')).toContain('application/json');
  await rm(files.blobPath(resource.blobHash));
  response = await fetch(`${base}/review/versions/${version.id}/export`);
  expect(response.status).toBe(409);
});

test('rechecks source permissions after reading the last resource before sending the ZIP', async () => {
  const source = await register('source');
  const target = await register('derived', [{ assetId: source.asset.id, versionId: source.version.id }]);
  const lastBlob = target.files.blobPath(target.version.files.at(-1)!.blobHash);
  const actual = await vi.importActual<typeof fs>('node:fs/promises');
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    if (args[0] === lastBlob) source.assets.setLifecycle(source.principal, source.asset.id, 'retracted', source.assets.getAuthorizedAsset(source.principal, source.asset.id).revision);
    return handle;
  });
  const response = await fetch(`${base}/derived/versions/${target.version.id}/export`);
  expect(response.status).toBe(403);
  expect(response.headers.get('content-type')).toContain('application/json');
});

test('invocation credentials cannot use the local user export endpoint', async () => {
  const { version } = await register();
  expect((await fetch(`${base}/review/versions/${version.id}/export`, { headers: { authorization: 'Bearer invocation' } })).status).toBe(403);
});
