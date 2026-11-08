import { parsePluginCatalog, parsePluginManifest, pluginContributions, pluginIdentity, pluginLimit, pluginRepository, type InstalledPlugin, type PluginEntry } from '../shared/data-plugins';
import { createMarketSources } from './market-sources';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { version as appVersion } from '../package.json';
import { extensionRepositories, localPetRepository, isUiExtension, parseExtensionCatalog, parseExtensionData, supportsExtension, type ExtensionSnapshot, type UiExtension, type UiExtensionKind } from '../shared/ui-extensions';
import type { MarketDetail } from '../shared/market';
import { marketBytes, type MarketFetcher } from './market-source';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const maxStoreBytes = 20 * 1024 * 1024;
export function createUiExtensions(home: string, fetcher: MarketFetcher) {
  const directory = join(home, 'market'), path = join(directory, 'ui-extensions.json');
  let mutations: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => { const next = mutations.catch(() => {}).then(work); mutations = next; return next; };
  const legacyCatalog = async (kind: UiExtensionKind, signal?: AbortSignal): Promise<MarketDetail[]> => {
    const raw = await marketBytes(await fetcher(`https://raw.githubusercontent.com/${extensionRepositories[kind]}/main/${kind === 'language' ? 'catalogs/languages.json' : 'catalog.json'}`, signal), 2 * 1024 * 1024);
    return parseExtensionCatalog(JSON.parse(raw.toString('utf8')), kind).map(entry => ({ ...entry, kind, catalogId: `${kind}:${entry.id}`, sourceUrl: `https://github.com/${entry.package.repository}/blob/${entry.package.revision}/${entry.package.path}`, extension: entry,
      ...(!supportsExtension(entry.minAppVersion, appVersion) ? { unsupported: `unsupported extension: requires Mandala ${entry.minAppVersion}` } : {}) }));
  };
  const pluginCatalog = async (repository = pluginRepository, signal?: AbortSignal): Promise<MarketDetail[]> => {
    const sources = await createMarketSources(home).read();
    if (!sources.sources.some(source => source.kind === 'plugin' && source.url === `https://github.com/${repository}`)) throw Error('invalid plugin source');
    const raw = await marketBytes(await fetcher(`https://raw.githubusercontent.com/${repository}/main/catalog.json`, signal), 2 * 1024 * 1024);
    return parsePluginCatalog(JSON.parse(raw.toString('utf8'))).map(entry => ({ ...entry, kind: 'plugin', catalogId: `plugin:${repository}:${entry.id}`, sourceUrl: `https://github.com/${entry.package.repository}/blob/${entry.package.revision}/${entry.package.path}`, plugin: entry,
      ...(!supportsExtension(entry.minAppVersion, appVersion) ? { unsupported: `unsupported plugin: requires Mandala ${entry.minAppVersion}` } : {}) }));
  };
  // Keep the saved language source ID, but browse the unified catalog without duplicate releases.
  const catalog = async (kind: UiExtensionKind, signal?: AbortSignal): Promise<MarketDetail[]> => kind === 'language'
    ? (await pluginCatalog(pluginRepository, signal)).filter(item => item.kinds?.includes('language'))
    : legacyCatalog(kind, signal);
  const detail = async (catalogId: string, signal?: AbortSignal) => {
    if (catalogId.startsWith('plugin:')) {
      const { repository } = pluginIdentity(catalogId);
      const item = (await pluginCatalog(repository, signal)).find(entry => entry.catalogId === catalogId);
      if (!item) throw Error('market item not found');
      return item;
    }
    const [kind] = catalogId.split(':');
    if (!isUiExtension(kind) || !/^(theme|language|pet):[a-z0-9][a-z0-9-]{0,79}$/.test(catalogId)) throw Error('invalid extension identifier');
    const item = (await legacyCatalog(kind, signal)).find(entry => entry.catalogId === catalogId);
    if (!item) throw Error('market item not found');
    return item;
  };
  const read = async (): Promise<ExtensionSnapshot> => {
    let raw = '';
    try { if ((await stat(path)).size > maxStoreBytes) throw Error('invalid extension store size'); raw = await readFile(path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!raw) return { revision: hash(''), items: [] };
    const data = JSON.parse(raw);
    if (![1, 2].includes(data.version) || !Array.isArray(data.items) || data.items.length > 50 || data.version === 2 && (!Array.isArray(data.plugins) || data.items.length + data.plugins.length > 50)) throw Error('invalid extension store');
    const seen = new Set<string>();
    const items = data.items.map((item: UiExtension) => {
      if (!item || !isUiExtension(item.kind) || seen.has(item.catalogId)) throw Error('invalid extension store');
      const [entry] = parseExtensionCatalog({ format: 'mandala-catalog', version: 1, kind: item.kind, items: [item] }, item.kind);
      if (item.catalogId !== `${item.kind}:${entry.id}` || !Number.isFinite(Date.parse(item.installedAt))) throw Error('invalid extension store');
      seen.add(item.catalogId);
      const local = item.kind === 'pet' && entry.package.repository === localPetRepository;
      return { ...entry, kind: item.kind, catalogId: item.catalogId, installedAt: item.installedAt, sourceUrl: local ? '' : `https://github.com/${entry.package.repository}/blob/${entry.package.revision}/${entry.package.path}`, data: parseExtensionData(JSON.stringify(item.data), item.kind) };
    });
    const plugins: InstalledPlugin[] = (data.version === 2 ? data.plugins : []).map((plugin: InstalledPlugin) => {
      const identity = pluginIdentity(plugin.catalogId);
      if (seen.has(plugin.catalogId) || !Number.isFinite(Date.parse(plugin.installedAt))) throw Error('invalid plugin store');
      seen.add(plugin.catalogId);
      const [entry] = parsePluginCatalog({ format: 'mandala-plugin-catalog', version: 1, items: [plugin] });
      const manifest = parsePluginManifest(plugin.manifest);
      validateManifest(manifest, entry);
      if (identity.id !== entry.id || !Array.isArray(plugin.items)) throw Error('invalid plugin store');
      const contributions = pluginContributions(manifest);
      if (contributions.length !== plugin.items.length) throw Error('invalid plugin store');
      const sourceUrl = `https://github.com/${entry.package.repository}/blob/${entry.package.revision}/${entry.package.path}`;
      const content = contributions.map((contribution, index): UiExtension => {
        const item = plugin.items[index], catalogId = `${plugin.catalogId}/${contribution.kind}:${contribution.id}`;
        if (!item || item.catalogId !== catalogId || item.kind !== contribution.kind) throw Error('invalid plugin store');
        const payload = parseExtensionData(JSON.stringify(item.data), contribution.kind);
        const name = payload.format === 'mandala-theme' ? payload.theme.name : payload.name;
        return { ...entry, id: contribution.id, name, kind: contribution.kind, catalogId, pluginId: plugin.catalogId, sourceUrl, installedAt: plugin.installedAt,
          package: { ...entry.package, path: contribution.path, sha256: contribution.sha256 }, data: payload };
      });
      return { ...entry, catalogId: plugin.catalogId, sourceUrl, installedAt: plugin.installedAt, manifest, items: content };
    });
    return { revision: hash(raw), items: [...items, ...plugins.flatMap(plugin => plugin.items)], ...(data.version === 2 ? { plugins } : {}) };
  };
  const save = async (items: UiExtension[], revision: string, plugins: InstalledPlugin[] = []) => {
    if ((await read()).revision !== revision) throw Error('configuration changed');
    const legacy = items.filter(item => !item.pluginId);
    const raw = JSON.stringify(plugins.length ? { version: 2, items: legacy, plugins } : { version: 1, items: legacy });
    if (legacy.length + plugins.length > 50 || Buffer.byteLength(raw) > maxStoreBytes) throw Error('invalid extension store size');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path + '.' + randomUUID();
    try { await writeFile(temporary, raw, { flag: 'wx', mode: 0o600 }); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }); }
    return read();
  };
  const validateManifest = (manifest: ReturnType<typeof parsePluginManifest>, entry: PluginEntry) => {
    if (['id', 'name', 'description', 'version', 'minAppVersion'].some(key => manifest[key as keyof typeof manifest] !== entry[key as keyof PluginEntry]) || [...new Set(pluginContributions(manifest).map(item => item.kind))].sort().join() !== [...entry.kinds].sort().join()) throw Error('invalid plugin metadata mismatch');
  };
  const installPlugin = async (item: MarketDetail, current: ExtensionSnapshot) => {
    const entry = item.plugin!, p = entry.package;
    const old = current.plugins?.find(plugin => plugin.catalogId === item.catalogId);
    if (old && old.package.repository.toLowerCase() !== p.repository.toLowerCase()) throw Error('plugin source changed; uninstall before changing source');
    let bytes = 0;
    const download = async (path: string, digest: string) => {
      const raw = await marketBytes(await fetcher(`https://raw.githubusercontent.com/${p.repository}/${p.revision}/${path}`), pluginLimit - bytes);
      bytes += raw.length;
      if (hash(raw) !== digest) throw Error('invalid plugin checksum');
      return raw.toString('utf8');
    };
    const manifest = parsePluginManifest(JSON.parse(await download(p.path, p.sha256)));
    validateManifest(manifest, entry);
    const installedAt = new Date().toISOString(), content: UiExtension[] = [];
    for (const contribution of pluginContributions(manifest)) {
      const data = parseExtensionData(await download(contribution.path, contribution.sha256), contribution.kind);
      const name = data.format === 'mandala-theme' ? data.theme.name : data.name;
      content.push({ ...entry, id: contribution.id, name, kind: contribution.kind, catalogId: `${item.catalogId}/${contribution.kind}:${contribution.id}`, pluginId: item.catalogId, sourceUrl: item.sourceUrl, installedAt,
        package: { ...p, path: contribution.path, sha256: contribution.sha256 }, data });
    }
    // Only the reviewed official Arabic release may replace its legacy installation.
    // Never infer ownership from a locale or publisher label alone.
    const replacesLegacy = (other: UiExtension) => item.catalogId === `plugin:${pluginRepository}:arabic-starter`
      && p.repository === pluginRepository && !other.pluginId && other.catalogId === 'language:arabic-starter'
      && ['maktubcn/mandala-language-packs', 'maktub-ai/mandala-language-packs', pluginRepository].includes(other.package.repository.toLowerCase())
      && other.data.format === 'mandala-language' && other.data.locale === 'ar'
      && content.some(contribution => contribution.id === 'arabic-starter' && contribution.data.format === 'mandala-language' && contribution.data.locale === 'ar');
    const retained = current.items.filter(other => other.pluginId !== item.catalogId && !replacesLegacy(other)), locales = new Set<string>();
    for (const other of [...retained, ...content]) if (other.data.format === 'mandala-language') {
      if (locales.has(other.data.locale)) throw Error('invalid duplicate language locale');
      locales.add(other.data.locale);
    }
    return save(retained, current.revision, [...(current.plugins ?? []).filter(plugin => plugin.catalogId !== item.catalogId), { ...entry, catalogId: item.catalogId, sourceUrl: item.sourceUrl, installedAt, manifest, items: content }]);
  };
  return { catalog, pluginCatalog, detail, read,
    install: (input: { catalogId: string; version: string; digest: string; revision: string }) => exclusive(async () => {
      const current = await read();
      if (current.revision !== input.revision) throw Error('configuration changed');
      const item = await detail(input.catalogId), entry = (item.plugin ?? item.extension)!;
      if (item.version !== input.version || entry.package.sha256 !== input.digest) throw Error('market version changed; reopen details');
      if (item.unsupported) throw Error(item.unsupported);
      if (item.plugin) return installPlugin(item, current);
      const p = entry.package, raw = await marketBytes(await fetcher(`https://raw.githubusercontent.com/${p.repository}/${p.revision}/${p.path}`), 4 * 1024 * 1024);
      if (hash(raw) !== p.sha256) throw Error('invalid extension checksum');
      const data = parseExtensionData(raw.toString('utf8'), item.kind as UiExtensionKind);
      if (data.format === 'mandala-language' && current.items.some(other => other.catalogId !== item.catalogId && other.data.format === 'mandala-language' && other.data.locale === data.locale)) throw Error('invalid duplicate language locale');
      return save([...current.items.filter(other => other.catalogId !== item.catalogId), { ...entry, catalogId: item.catalogId, kind: item.kind as UiExtensionKind, sourceUrl: item.sourceUrl, installedAt: new Date().toISOString(), data }], current.revision, current.plugins);
    }),
    // A pet made by the person is imported from a file and kept beside Market installs; it never reaches a catalog.
    importPet: (input: { raw: string; revision: string }) => exclusive(async () => {
      const current = await read();
      if (current.revision !== input.revision) throw Error('configuration changed');
      if (typeof input.raw !== 'string') throw Error('invalid pet package');
      const data = parseExtensionData(input.raw, 'pet');
      if (data.format !== 'mandala-pet') throw Error('invalid pet package');
      const digest = hash(input.raw), id = 'local-' + digest.slice(0, 12), catalogId = `pet:${id}`;
      const entry = { id, name: data.name, description: 'Imported from a file', version: '1.0.0', publisher: 'Local', minAppVersion: '0.0.0',
        package: { repository: localPetRepository, revision: digest.slice(0, 40), path: 'pet.json', sha256: digest } };
      return save([...current.items.filter(other => other.catalogId !== catalogId), { ...entry, catalogId, kind: 'pet' as const, sourceUrl: '', installedAt: new Date().toISOString(), data }], current.revision, current.plugins);
    }),
    uninstall: (catalogId: string, revision: string) => exclusive(async () => {
      const current = await read();
      if (current.items.some(item => item.catalogId === catalogId && item.pluginId)) throw Error('invalid uninstall: remove the whole plugin');
      return save(current.items.filter(item => item.catalogId !== catalogId), revision, (current.plugins ?? []).filter(plugin => plugin.catalogId !== catalogId));
    }),
  };
}
