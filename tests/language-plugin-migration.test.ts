import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchesMarketSource } from '../shared/market';
import { createMarket } from '../server/market';
import { localizeMessage, type LanguagePack } from '../shared/ui-extensions';
import { writeDesktopPreference } from '../desktop/preferences';
import { arabicEntry, arabicFiles, arabicPayload, legacyArabicCatalog, legacyArabicEntry } from './fixtures/language-plugin';
let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'language-plugin-migration-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
async function fixture(repository = 'maktub-ai/mandala-language-packs') {
  const legacy = { ...legacyArabicEntry, version: '1.0.0', package: { ...legacyArabicEntry.package, repository, revision: 'a'.repeat(40) }, kind: 'language', catalogId: 'language:arabic-starter', sourceUrl: '', installedAt: '2026-01-01T00:00:00.000Z', data: JSON.parse(arabicPayload) };
  await mkdir(join(home, 'market'));
  await writeFile(join(home, 'market/ui-extensions.json'), JSON.stringify({ version: 1, items: [legacy] }));
  await writeFile(join(home, 'market/sources.json'), JSON.stringify({ sources: [], enabled: ['mandala-languages'] }));
  writeDesktopPreference(home, 'mana-language', 'ar');
  const files = { ...arabicFiles }, requests: string[] = [];
  const market = createMarket(home, async url => {
    requests.push(url);
    if (url === 'https://raw.githubusercontent.com/maktub-ai/mandala-plugins/main/catalog.json') return Response.json({ format: 'mandala-plugin-catalog', version: 1, items: [arabicEntry] });
    if (url === 'https://raw.githubusercontent.com/maktub-ai/mandala-plugins/main/catalogs/languages.json') return Response.json(legacyArabicCatalog);
    const prefix = `https://raw.githubusercontent.com/maktub-ai/mandala-plugins/${arabicEntry.package.revision}/`;
    if (url.startsWith(prefix) && files[url.slice(prefix.length)]) return new Response(files[url.slice(prefix.length)]);
    throw Error('unexpected request: ' + url);
  });
  const install = async () => market.extensions.install({ catalogId: 'plugin:maktub-ai/mandala-plugins:arabic-starter', version: arabicEntry.version, digest: arabicEntry.package.sha256, revision: (await market.extensions.read()).revision });
  return { market, files, requests, install };
}
it.each(['maktub-ai/mandala-language-packs', 'MaktubCN/mandala-language-packs'])('replaces the official legacy language from %s only on explicit plugin installation, preserving locale and offline use', async repository => {
  const { market, install, requests } = await fixture(repository);
  const path = join(home, 'market/ui-extensions.json'), original = await readFile(path, 'utf8');
  expect((await market.extensions.read()).items[0].catalogId).toBe('language:arabic-starter');
  expect(await readFile(path, 'utf8')).toBe(original);
  const sources = await market.sources();
  expect(sources.enabled).toEqual(['mandala-languages']);
  expect(sources.sources.find(source => source.id === 'mandala-languages')?.url).toBe('https://github.com/maktub-ai/mandala-plugins');
  const found = (await market.search('language')).items;
  expect(found.map(item => item.catalogId)).toEqual(['plugin:maktub-ai/mandala-plugins:arabic-starter']);
  expect(matchesMarketSource(found[0], 'mandala-languages')).toBe(true);
  expect(matchesMarketSource({ ...found[0], catalogId: 'plugin:example/plugins:arabic-starter' }, 'mandala-languages')).toBe(false);
  const preferences = await readFile(join(home, 'desktop-preferences.json'), 'utf8');
  const installed = await install();
  expect(installed.plugins).toHaveLength(1);
  expect(installed.items).toHaveLength(1);
  expect(installed.items[0].catalogId).toBe('plugin:maktub-ai/mandala-plugins:arabic-starter/language:arabic-starter');
  expect(localizeMessage('ar', installed.items[0].data as LanguagePack, '市场', 'Market')).toBe('السوق');
  expect(await readFile(join(home, 'desktop-preferences.json'), 'utf8')).toBe(preferences);
  expect(await market.sources()).toEqual(sources);
  expect(requests.some(url => url.includes('/mandala-language-packs/'))).toBe(false);
  const offline = createMarket(home, async () => { throw Error('offline'); });
  expect(await offline.extensions.read()).toEqual(installed);
  expect((await offline.extensions.uninstall(installed.plugins![0].catalogId, installed.revision)).items).toEqual([]);
});
it('keeps the legacy update endpoint and identifier while fetching its package from the new repository', async () => {
  const { market, requests } = await fixture();
  const detail = await market.detail('language:arabic-starter');
  expect(detail.extension?.package.repository).toBe('maktub-ai/mandala-plugins');
  const installed = await market.extensions.install({ catalogId: detail.catalogId, version: detail.version, digest: detail.extension!.package.sha256, revision: (await market.extensions.read()).revision });
  expect(installed.items[0]).toMatchObject({ catalogId: 'language:arabic-starter', package: { repository: 'maktub-ai/mandala-plugins' }, data: { locale: 'ar' } });
  expect(requests.some(url => url.includes('/mandala-language-packs/'))).toBe(false);
});
it('can convert an already relocated legacy installation to its plugin', async () => {
  const { install } = await fixture('maktub-ai/mandala-plugins');
  expect((await install()).items).toHaveLength(1);
});
it('leaves legacy bytes and preferences intact when the new payload fails validation', async () => {
  const { market, files, install } = await fixture();
  const original = await market.extensions.read(), bytes = await readFile(join(home, 'market/ui-extensions.json'), 'utf8');
  files['packages/ar.mandala-language.json'] += ' ';
  await expect(install()).rejects.toThrow('checksum');
  expect(await market.extensions.read()).toEqual(original);
  expect(await readFile(join(home, 'market/ui-extensions.json'), 'utf8')).toBe(bytes);
});
it('does not replace an unrelated language provider with a matching ID and locale', async () => {
  const { market, install } = await fixture('example/languages');
  const original = await market.extensions.read();
  await expect(install()).rejects.toThrow('duplicate language');
  expect(await market.extensions.read()).toEqual(original);
});
