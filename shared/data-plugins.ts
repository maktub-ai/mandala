import { isUiExtension, parseExtensionCatalog, releaseVersion, type ExtensionEntry, type UiExtension, type UiExtensionKind } from './ui-extensions';
export const pluginRepository = 'maktub-ai/mandala-plugins';
export const pluginLimit = 4 * 1024 * 1024;
export type PluginContribution = { id: string; path: string; sha256: string };
export type PluginManifest = { format: 'mandala-plugin'; schemaVersion: 1; execution: 'data'; id: string; name: string; description: string; version: string; minAppVersion: string; contributes: { themes?: PluginContribution[]; languagePacks?: PluginContribution[]; pets?: PluginContribution[] } };
export type PluginEntry = ExtensionEntry & { kinds: UiExtensionKind[] };
export type InstalledPlugin = PluginEntry & { catalogId: string; sourceUrl: string; installedAt: string; manifest: PluginManifest; items: UiExtension[] };
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,59}$/.test(value);
const text = (value: unknown, size: number) => typeof value === 'string' && !!value.trim() && value.length <= size;
export const contributionKinds = { themes: 'theme', languagePacks: 'language', pets: 'pet' } as const;
export function pluginContributions(manifest: PluginManifest) {
  return Object.entries(contributionKinds).flatMap(([key, kind]) => (manifest.contributes[key as keyof typeof contributionKinds] ?? []).map(item => ({ ...item, kind })));
}
export function parsePluginManifest(value: unknown): PluginManifest {
  if (!record(value) || !keys(value, ['format', 'schemaVersion', 'execution', 'id', 'name', 'description', 'version', 'minAppVersion', 'contributes']) || value.format !== 'mandala-plugin' || value.schemaVersion !== 1 || value.execution !== 'data' || !id(value.id) || !text(value.name, 100) || !text(value.description, 2000) || !releaseVersion(value.version) || !releaseVersion(value.minAppVersion) || !record(value.contributes) || !keys(value.contributes, Object.keys(contributionKinds))) throw Error('invalid data plugin manifest');
  let count = 0;
  const paths = new Set<string>();
  for (const entries of Object.values(value.contributes)) {
    if (!Array.isArray(entries) || !entries.length || entries.length > 50) throw Error('invalid plugin contributions');
    const ids = new Set<string>();
    for (const entry of entries) {
      if (!record(entry) || !keys(entry, ['id', 'path', 'sha256']) || !id(entry.id) || ids.has(entry.id) || typeof entry.path !== 'string' || entry.path.length > 240 || !/^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.json$/.test(entry.path) || paths.has(entry.path) || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw Error('invalid plugin contribution');
      ids.add(entry.id); paths.add(entry.path); count++;
    }
  }
  if (!count || count > 50) throw Error('invalid plugin contribution count');
  return value as PluginManifest;
}
export function parsePluginCatalog(value: unknown): PluginEntry[] {
  if (!record(value) || !keys(value, ['format', 'version', 'items']) || value.format !== 'mandala-plugin-catalog' || value.version !== 1 || !Array.isArray(value.items)) throw Error('invalid plugin catalog');
  const entries = parseExtensionCatalog({ format: 'mandala-catalog', version: 1, kind: 'theme', items: value.items }, 'theme');
  return entries.map((entry, index) => {
    const kinds = value.items[index].kinds;
    if (!Array.isArray(kinds) || !kinds.length || kinds.length > 3 || kinds.some(kind => !isUiExtension(kind)) || new Set(kinds).size !== kinds.length || !/(^|\/)mandala-plugin\.json$/.test(entry.package.path)) throw Error('invalid plugin catalog entry');
    return { ...entry, kinds };
  });
}
export function pluginIdentity(catalogId: string): { repository: string; id: string } {
  const match = /^plugin:([a-z0-9_-]{1,39}\/[a-z0-9_-][a-z0-9_.-]{0,99}):([a-z0-9][a-z0-9-]{0,59})$/.exec(catalogId);
  if (!match) throw Error('invalid plugin identifier');
  return { repository: match[1], id: match[2] };
}
export const pluginSourceId = (repository: string) => repository === pluginRepository ? 'mandala-plugins' : `plugins:${repository}`;
