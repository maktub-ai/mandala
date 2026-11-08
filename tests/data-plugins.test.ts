import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createMarket } from '../server/market';
import { parsePluginManifest } from '../shared/data-plugins';
import { defaultPreferences, exportThemePackage } from '../shared/themes';
const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
const theme = exportThemePackage(defaultPreferences(), 'light');
const language = JSON.stringify({ format: 'mandala-language', version: 1, locale: 'fr', name: 'Français', direction: 'ltr', messages: { '市场': 'Marché' } });
const manifest = { format: 'mandala-plugin', schemaVersion: 1, execution: 'data', id: 'studio', name: 'Studio', description: 'Theme and translation', version: '1.0.0', minAppVersion: '0.1.2', contributes: { themes: [{ id: 'paper', path: 'theme.json', sha256: hash(theme) }], languagePacks: [{ id: 'french', path: 'language.json', sha256: hash(language) }] } };
let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'data-plugins-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
function fixture() {
  const files: Record<string, string> = { 'mandala-plugin.json': JSON.stringify(manifest), 'theme.json': theme, 'language.json': language };
  const entry = { id: 'studio', name: 'Studio', description: manifest.description, version: '1.0.0', publisher: 'Example', minAppVersion: '0.1.2', kinds: ['theme', 'language'], package: { repository: 'example/studio', revision: 'a'.repeat(40), path: 'mandala-plugin.json', sha256: hash(files['mandala-plugin.json']) } };
  const requests: string[] = [];
  const market = createMarket(home, async url => {
    requests.push(url);
    if (url === 'https://raw.githubusercontent.com/maktub-ai/mandala-plugins/main/catalog.json') return Response.json({ format: 'mandala-plugin-catalog', version: 1, items: [entry] });
    const prefix = `https://raw.githubusercontent.com/${entry.package.repository}/${entry.package.revision}/`;
    if (url.startsWith(prefix) && files[url.slice(prefix.length)]) return new Response(files[url.slice(prefix.length)]);
    throw Error('unexpected request');
  });
  const install = async () => market.extensions.install({ catalogId: 'plugin:maktub-ai/mandala-plugins:studio', version: entry.version, digest: entry.package.sha256, revision: (await market.extensions.read()).revision });
  return { market, files, entry, requests, install };
}
it('installs a multi-contribution data plugin as one atomic unit and reopens offline', async () => {
  const { market, install } = fixture();
  expect((await market.search('plugin')).items).toHaveLength(1);
  const installed = await install();
  expect(installed.plugins).toHaveLength(1);
  expect(installed.items.map(item => item.kind)).toEqual(['theme', 'language']);
  expect(installed.items[0].catalogId).toBe('plugin:maktub-ai/mandala-plugins:studio/theme:paper');
  const offline = createMarket(home, async () => { throw Error('offline'); });
  expect(await offline.extensions.read()).toEqual(installed);
  await expect(offline.extensions.uninstall(installed.items[0].catalogId, installed.revision)).rejects.toThrow('plugin');
  expect((await offline.extensions.uninstall(installed.plugins![0].catalogId, installed.revision)).items).toEqual([]);
});
it('does not write legacy data on read and retains legacy identifiers during plugin writes', async () => {
  const { market, install } = fixture();
  const oldEntry = { id: 'old', name: 'Old', description: 'Legacy', version: '1.0.0', publisher: 'Example', minAppVersion: '0.1.1', package: { repository: 'example/old', revision: 'b'.repeat(40), path: 'theme.json', sha256: hash(theme) } };
  const legacy = createMarket(home, async url => url.endsWith('catalog.json') ? Response.json({ format: 'mandala-catalog', version: 1, kind: 'theme', items: [oldEntry] }) : new Response(theme));
  const original = await legacy.extensions.install({ catalogId: 'theme:old', version: '1.0.0', digest: hash(theme), revision: (await legacy.extensions.read()).revision });
  const path = join(home, 'market/ui-extensions.json'), bytes = await readFile(path, 'utf8');
  expect(await market.extensions.read()).toEqual(original);
  expect(await readFile(path, 'utf8')).toBe(bytes);
  const installed = await install();
  expect(installed.items.find(item => item.catalogId === 'theme:old')).toEqual(original.items[0]);
  const removed = await market.extensions.uninstall(installed.plugins![0].catalogId, installed.revision);
  expect(removed.items).toEqual(original.items);
});
it('leaves all installed contributions unchanged when an update fails checksum validation', async () => {
  const { install, files, market } = fixture();
  const original = await install();
  files['language.json'] += ' ';
  await expect(install()).rejects.toThrow('checksum');
  expect(await market.extensions.read()).toEqual(original);
});
it('rejects package source replacement for an installed identity', async () => {
  const { install, entry, market } = fixture();
  const original = await install(); entry.package.repository = 'other/studio';
  await expect(install()).rejects.toThrow('source changed');
  expect(await market.extensions.read()).toEqual(original);
});
it.each(['entry', 'main', 'scripts', 'permissions', 'capabilities'])('rejects executable or undeclared manifest field %s', key => {
  expect(() => parsePluginManifest({ ...manifest, [key]: 'run.js' })).toThrow('invalid');
});
it.each(['../x.json', '/x.json', 'https://example.org/x.json', 'a/%2e%2e/x.json', 'run.js'])('rejects contribution path %s', path => {
  expect(() => parsePluginManifest({ ...manifest, contributes: { themes: [{ id: 'x', path, sha256: hash(theme) }] } })).toThrow('invalid');
});
it('rejects executable mode, unknown contribution types and duplicate IDs', () => {
  expect(() => parsePluginManifest({ ...manifest, execution: 'worker' })).toThrow();
  expect(() => parsePluginManifest({ ...manifest, contributes: { commands: [] } })).toThrow();
  expect(() => parsePluginManifest({ ...manifest, contributes: { themes: [...manifest.contributes.themes, ...manifest.contributes.themes] } })).toThrow();
});
it('rejects a combined download over 4 MiB even when each file is individually small', async () => {
  const { files, entry, market, install } = fixture();
  files['theme.json'] += ' '.repeat(2 * 1024 * 1024);
  files['language.json'] += ' '.repeat(2 * 1024 * 1024);
  const updated = structuredClone(manifest);
  updated.contributes.themes[0].sha256 = hash(files['theme.json']);
  updated.contributes.languagePacks[0].sha256 = hash(files['language.json']);
  files['mandala-plugin.json'] = JSON.stringify(updated); entry.package.sha256 = hash(files['mandala-plugin.json']);
  const original = await market.extensions.read();
  await expect(install()).rejects.toThrow('size');
  expect(await market.extensions.read()).toEqual(original);
});
it('requires catalog and manifest metadata to agree', async () => {
  const { entry, install } = fixture(); entry.kinds = ['theme'];
  await expect(install()).rejects.toThrow('metadata mismatch');
});
it('preserves disabled sources and supports explicitly registered plugin catalogs', async () => {
  const { githubPluginSource } = await import('../shared/market');
  const market = createMarket(home, async () => Response.json({ format: 'mandala-plugin-catalog', version: 1, items: [] }));
  const source = githubPluginSource('Example plugins', 'https://github.com/example/plugins');
  const initial = await market.sources();
  await market.saveSources({ sources: [source], enabled: [], revision: initial.revision });
  const reopened = createMarket(home, async () => Response.json({ format: 'mandala-plugin-catalog', version: 1, items: [] }));
  expect((await reopened.sources()).enabled).toEqual([]);
  expect((await reopened.search('plugin', '', '', source.id)).items).toEqual([]);
  await expect(reopened.extensions.detail('plugin:unknown/catalog:studio')).rejects.toThrow('source');
});
it('does not confuse plugin contribution pet identifiers with executable or arbitrary locations', async () => {
  const { parsePetPreference } = await import('../shared/mandala-pet');
  const preference = { figure: 'plugin:maktub-ai/mandala-plugins:studio/pet:dot', placement: 'panel' };
  expect(parsePetPreference(JSON.stringify(preference))).toEqual(preference);
  expect(parsePetPreference(JSON.stringify({ ...preference, figure: 'plugin:../../secret' })).figure).toBe('official');
});
it('validates author packages locally without following symlinks outside their directory', async () => {
  const { mkdir, writeFile, symlink } = await import('node:fs/promises');
  const { validateDataPlugin } = await import('../scripts/validate-data-plugin');
  const directory = join(home, 'package'); await mkdir(directory);
  const { files } = fixture();
  for (const [path, raw] of Object.entries(files)) await writeFile(join(directory, path), raw);
  expect(await validateDataPlugin(directory)).toMatchObject({ id: 'studio', version: '1.0.0', contributions: 2 });
  await writeFile(join(directory, 'language.json'), language + ' ');
  await expect(validateDataPlugin(directory)).rejects.toThrow('checksum');
  await rm(join(directory, 'language.json'));
  await writeFile(join(home, 'outside.json'), language);
  await symlink(join(home, 'outside.json'), join(directory, 'language.json'));
  await expect(validateDataPlugin(directory)).rejects.toThrow('outside');
});
it('rejects duplicate locales within a plugin before committing any contribution', async () => {
  const { files, entry, install, market } = fixture();
  const duplicate = structuredClone(manifest);
  duplicate.contributes.languagePacks.push({ id: 'another', path: 'other.json', sha256: hash(language) });
  files['other.json'] = language; files['mandala-plugin.json'] = JSON.stringify(duplicate);
  entry.package.sha256 = hash(files['mandala-plugin.json']);
  const initial = await market.extensions.read();
  await expect(install()).rejects.toThrow('duplicate language');
  expect(await market.extensions.read()).toEqual(initial);
});
it('serializes plugin mutations and preserves data on stale writes', async () => {
  const { market, entry } = fixture(), revision = (await market.extensions.read()).revision;
  const input = { catalogId: 'plugin:maktub-ai/mandala-plugins:studio', version: entry.version, digest: entry.package.sha256, revision };
  const results = await Promise.allSettled([market.extensions.install(input), market.extensions.install(input)]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const current = await market.extensions.read();
  await expect(market.extensions.uninstall(input.catalogId, revision)).rejects.toThrow('configuration changed');
  expect(await market.extensions.read()).toEqual(current);
});
it('updates an existing plugin without duplicating contributions or changing their identities', async () => {
  const { market, entry, files, install } = fixture(), old = await install();
  const next = { ...manifest, version: '1.1.0' }; files['mandala-plugin.json'] = JSON.stringify(next);
  entry.version = next.version; entry.package.sha256 = hash(files['mandala-plugin.json']);
  const updated = await install();
  expect(updated.items.map(item => item.catalogId)).toEqual(old.items.map(item => item.catalogId));
  expect(updated.plugins).toHaveLength(1);
  expect(updated.plugins![0].version).toBe('1.1.0');
  expect(await market.extensions.read()).toEqual(updated);
});
