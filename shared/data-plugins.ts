import { isUiExtension, parseExtensionCatalog, parseExtensionData, releaseVersion, type ExtensionEntry, type ExtensionSnapshot, type UiExtension } from './ui-extensions';
export const pluginRepository = 'maktub-ai/mandala-plugins';
export const retiredBlueprintPlugin = 'plugin:' + pluginRepository + ':omino';
export const pluginLimit = 4 * 1024 * 1024;
export type PluginContribution = { id: string; path: string; sha256: string };
type LocalizedText = { zh: string; en: string };
export type LibrarySummary = {
  file: string; format: string; version: number; title: string;
  badgeItems?: string; closedField?: string; closedValue?: string;
};
export type LibrarySection = {
  format: 'mandala-library-section'; version: 1; type: 'project-files';
  label: LocalizedText; icon: 'target' | 'file' | 'book' | 'folder';
  source: { kind: 'workspace'; file: string } | { kind: 'collection'; namespace: string; file: string; summary?: LibrarySummary };
  emptyText?: LocalizedText; updateText?: LocalizedText; loopback?: true;
};
// Older locally installed declarations stay removable when a reader type is retired.
export type RetiredSection = Pick<LibrarySection, 'format' | 'version' | 'label' | 'icon'> & { type: 'unavailable' };
export type PluginContributionKind = typeof contributionKinds[keyof typeof contributionKinds];
export type PluginManifest = { format: 'mandala-plugin'; schemaVersion: 1; execution: 'data'; id: string; name: string; description: string; version: string; minAppVersion: string; contributes: { themes?: PluginContribution[]; languagePacks?: PluginContribution[]; pets?: PluginContribution[]; librarySections?: PluginContribution[] } };
export type PluginEntry = ExtensionEntry & { kinds: PluginContributionKind[] };
export type InstalledPlugin = PluginEntry & { catalogId: string; sourceUrl: string; installedAt: string; manifest: PluginManifest; items: UiExtension[] };
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,59}$/.test(value);
const text = (value: unknown, size: number) => typeof value === 'string' && !!value.trim() && value.length <= size;
export const contributionKinds = { themes: 'theme', languagePacks: 'language', pets: 'pet', librarySections: 'library-section' } as const;
export function pluginContributions(manifest: PluginManifest) {
  return Object.entries(contributionKinds).flatMap(([key, kind]) => (manifest.contributes[key as keyof typeof contributionKinds] ?? []).map(item => ({ ...item, kind })));
}
const localized = (value: unknown, max: number) => record(value) && keys(value, ['zh', 'en']) && text(value.zh, max) && text(value.en, max);
const field = (value: unknown) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) && !Object.hasOwn(Object.prototype, value) && value !== 'prototype';
function validSummary(value: unknown) {
  return record(value) && keys(value, ['file', 'format', 'version', 'title', 'badgeItems', 'closedField', 'closedValue'])
    && text(value.file, 120) && /^[a-zA-Z0-9][a-zA-Z0-9_-]*\.json$/.test(value.file)
    && text(value.format, 120) && Number.isSafeInteger(value.version) && value.version >= 1 && field(value.title)
    && (value.badgeItems === undefined || field(value.badgeItems))
    && (value.closedField === undefined && value.closedValue === undefined || field(value.closedField) && text(value.closedValue, 100));
}
function validSource(value: unknown) {
  if (!record(value) || !text(value.file, 240) || !value.file.endsWith('.html')
    || !value.file.split('/').every((part: string) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(part))) return false;
  if (value.kind === 'workspace') return keys(value, ['kind', 'file']);
  return value.kind === 'collection' && keys(value, ['kind', 'namespace', 'file', 'summary']) && !value.file.includes('/')
    && typeof value.namespace === 'string' && /^[a-z][a-z0-9]{0,31}$/.test(value.namespace)
    && (value.summary === undefined || validSummary(value.summary));
}
export function parsePluginContributionData(raw: string, kind: PluginContributionKind) {
  if (kind !== 'library-section') return parseExtensionData(raw, kind);
  const value: unknown = JSON.parse(raw);
  if (!record(value) || !keys(value, ['format', 'version', 'type', 'label', 'icon', 'source', 'emptyText', 'updateText', 'loopback'])
    || value.format !== 'mandala-library-section' || value.version !== 1 || value.type !== 'project-files'
    || !['target', 'file', 'book', 'folder'].includes(value.icon) || !localized(value.label, 100) || !validSource(value.source)
    || (value.emptyText !== undefined && !localized(value.emptyText, 500)) || (value.updateText !== undefined && !localized(value.updateText, 500))
    || (value.loopback !== undefined && value.loopback !== true)) throw Error('invalid library section');
  return value as LibrarySection;
}
export function readStoredContribution(raw: string, kind: PluginContributionKind) {
  if (kind === 'library-section') {
    const value = JSON.parse(raw);
    if (record(value) && keys(value, ['format', 'version', 'type', 'label', 'icon'])
      && value.format === 'mandala-library-section' && value.version === 1 && ['omino-plan', 'unavailable'].includes(value.type)
      && value.icon === 'target' && localized(value.label, 100)) return { ...value, type: 'unavailable' } as RetiredSection;
  }
  return parsePluginContributionData(raw, kind);
}

export function librarySections(snapshot: ExtensionSnapshot | null) {
  const sections = (snapshot?.items ?? []).flatMap(item => item.pluginId && item.data.format === 'mandala-library-section' && item.data.type === 'project-files'
    ? [{ ...item.data, id: item.id, pluginId: item.pluginId, catalogId: item.catalogId }] : []);
  // Updating a plugin can reorder the store. Keep colliding tab URLs stable across updates.
  sections.sort((a, b) => a.catalogId.localeCompare(b.catalogId, 'en'));
  const used = new Set(['recent', 'wiki']);
  return sections.map(({ catalogId, ...section }) => {
    const id = used.has(section.id) ? catalogId : section.id;
    used.add(id);
    return { ...section, id };
  });
}

export function parsePluginManifest(value: unknown): PluginManifest {
  if (!record(value) || !keys(value, ['format', 'schemaVersion', 'execution', 'id', 'name', 'description', 'version', 'minAppVersion', 'contributes']) || value.format !== 'mandala-plugin' || value.schemaVersion !== 1 || value.execution !== 'data' || !id(value.id) || !text(value.name, 100) || !text(value.description, 2000) || !releaseVersion(value.version) || !releaseVersion(value.minAppVersion) || !record(value.contributes) || !keys(value.contributes, Object.keys(contributionKinds))) throw Error('invalid data plugin manifest');
  let count = 0;
  const paths = new Set<string>();
  for (const [kind, entries] of Object.entries(value.contributes)) {
    if (!Array.isArray(entries) || !entries.length || entries.length > (kind === 'librarySections' ? 1 : 50)) throw Error('invalid plugin contributions');
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
    if (!Array.isArray(kinds) || !kinds.length || kinds.length > Object.keys(contributionKinds).length || kinds.some(kind => !isUiExtension(kind) && kind !== 'library-section') || new Set(kinds).size !== kinds.length || !/(^|\/)mandala-plugin\.json$/.test(entry.package.path)) throw Error('invalid plugin catalog entry');
    return { ...entry, kinds };
  });
}
export function pluginIdentity(catalogId: string): { repository: string; id: string } {
  const match = /^plugin:([a-z0-9_-]{1,39}\/[a-z0-9_-][a-z0-9_.-]{0,99}):([a-z0-9][a-z0-9-]{0,59})$/.exec(catalogId);
  if (!match) throw Error('invalid plugin identifier');
  return { repository: match[1], id: match[2] };
}
export const pluginSourceId = (repository: string) => repository === pluginRepository ? 'mandala-plugins' : `plugins:${repository}`;
