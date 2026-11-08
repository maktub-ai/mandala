import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createMarket } from '../server/market';
import { defaultPreferences, exportThemePackage } from '../src/themes';
let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'market-ui-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
const sha = 'a'.repeat(40);
const body = exportThemePackage(defaultPreferences(), 'light');
const digest = createHash('sha256').update(body).digest('hex');
const entry = { id: 'paper', name: 'Paper', description: 'A community theme', version: '1.0.0', publisher: 'Example', minAppVersion: '0.1.1', package: { repository: 'example/themes', revision: sha, path: 'packages/paper.json', sha256: digest } };
const catalog = (item = entry) => ({ format: 'mandala-catalog', version: 1, kind: 'theme', items: [item] });
const fetcher = async (url: string) => {
  if (url === 'https://raw.githubusercontent.com/maktub-ai/mandala-themes/main/catalog.json') return Response.json(catalog());
  if (url === `https://raw.githubusercontent.com/example/themes/${sha}/packages/paper.json`) return new Response(body);
  throw Error('Unexpected request: ' + url);
};
it('discovers a pinned theme, installs without an Agent, persists offline, detects stale writes and uninstalls', async () => {
  const market = createMarket(home, fetcher);
  const found = await market.search('theme' as any, 'community');
  expect(found.items).toHaveLength(1);
  const detail = await market.detail(found.items[0].catalogId);
  expect(detail).toMatchObject({ kind: 'theme', version: '1.0.0', extension: { package: { sha256: digest } } });
  const initial = await market.extensions.read();
  const installed = await market.extensions.install({ catalogId: detail.catalogId, version: detail.version, digest, revision: initial.revision });
  expect(installed.items[0].data).toMatchObject({ format: 'mandala-theme', theme: { id: 'mandala-light' } });
  const reopened = createMarket(home, async () => { throw Error('offline'); });
  expect(await reopened.extensions.read()).toEqual(installed);
  await expect(reopened.extensions.uninstall(detail.catalogId, initial.revision)).rejects.toThrow('configuration changed');
  expect((await reopened.extensions.uninstall(detail.catalogId, installed.revision)).items).toEqual([]);
});
it('rejects tampered downloads without changing installed state', async () => {
  const market = createMarket(home, async url => url.endsWith('catalog.json') ? Response.json(catalog()) : new Response(body + ' '));
  const initial = await market.extensions.read();
  await expect(market.extensions.install({ catalogId: 'theme:paper', version: '1.0.0', digest, revision: initial.revision })).rejects.toThrow('checksum');
  expect(await market.extensions.read()).toEqual(initial);
});
it.each(['../outside.json', 'packages/%2e%2e/a.json', 'https://localhost/secret'])('rejects unsafe package paths: %s', async path => {
  const market = createMarket(home, async () => Response.json(catalog({ ...entry, package: { ...entry.package, path } })));
  await expect(market.search('theme' as any)).rejects.toThrow(/invalid/);
});
it('rejects incompatible packages and catalog version drift before installation', async () => {
  const market = createMarket(home, async () => Response.json(catalog({ ...entry, minAppVersion: '999.0.0' })));
  const initial = await market.extensions.read();
  expect((await market.detail('theme:paper')).unsupported).toBeTruthy();
  await expect(market.extensions.install({ catalogId: 'theme:paper', version: '1.0.0', digest, revision: initial.revision })).rejects.toThrow(/unsupported/);
  const changed = createMarket(home, async () => Response.json(catalog({ ...entry, version: '2.0.0' })));
  await expect(changed.extensions.install({ catalogId: 'theme:paper', version: '1.0.0', digest, revision: initial.revision })).rejects.toThrow('market version changed');
});
it('updates a pinned package atomically, rejects stale concurrent writes and refuses a changed digest at the same version', async () => {
  let currentEntry = entry;
  const market = createMarket(home, async url => url.endsWith('catalog.json') ? Response.json(catalog(currentEntry)) : new Response(body));
  const input = { catalogId: 'theme:paper', version: '1.0.0', digest, revision: (await market.extensions.read()).revision };
  const outcomes = await Promise.allSettled([market.extensions.install(input), market.extensions.install(input)]);
  expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
  const first = await market.extensions.read();
  currentEntry = { ...entry, version: '1.1.0' };
  const updated = await market.extensions.install({ ...input, version: '1.1.0', revision: first.revision });
  expect(updated.items).toHaveLength(1);
  expect(updated.items[0].version).toBe('1.1.0');
  currentEntry = { ...currentEntry, package: { ...entry.package, sha256: 'b'.repeat(64) } };
  await expect(market.extensions.install({ ...input, version: '1.1.0', revision: updated.revision })).rejects.toThrow('market version changed');
  expect(await market.extensions.read()).toEqual(updated);
});
it('persists languages and rejects two installed packages claiming the same locale', async () => {
  const raw = JSON.stringify({ format: 'mandala-language', version: 1, locale: 'ar', name: 'العربية', direction: 'rtl', messages: { '市场': 'السوق' } });
  const languageEntry = { ...entry, id: 'arabic', package: { ...entry.package, sha256: createHash('sha256').update(raw).digest('hex') } };
  const market = createMarket(home, async url => url.endsWith('catalogs/languages.json') ? Response.json({ format: 'mandala-catalog', version: 1, kind: 'language', items: [languageEntry, { ...languageEntry, id: 'other-arabic' }] }) : new Response(raw));
  const first = await market.extensions.install({ catalogId: 'language:arabic', version: '1.0.0', digest: languageEntry.package.sha256, revision: (await market.extensions.read()).revision });
  expect(first.items[0].data).toMatchObject({ locale: 'ar', direction: 'rtl', messages: { '市场': 'السوق' } });
  await expect(market.extensions.install({ catalogId: 'language:other-arabic', version: '1.0.0', digest: languageEntry.package.sha256, revision: first.revision })).rejects.toThrow('duplicate language');
  expect(await market.extensions.read()).toEqual(first);
});
