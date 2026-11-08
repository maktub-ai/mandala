import type { InstalledPlugin } from './data-plugins';
import { parseThemePackage } from './themes';
import { parsePetPack, type PetPack } from './mandala-pet';
export type UiExtensionKind = 'theme' | 'language' | 'pet';
export const extensionRepositories = { theme: 'maktub-ai/mandala-themes', language: 'maktub-ai/mandala-plugins', pet: 'maktub-ai/mandala-pets' } as const;
/** Pet packs imported from a file are stored beside Market installs under this reserved repository name. */
export const localPetRepository = 'local/import';
export type ExtensionEntry = {
  id: string; name: string; description: string; version: string; publisher: string; minAppVersion: string;
  package: { repository: string; revision: string; path: string; sha256: string };
};
export type LanguagePack = { format: 'mandala-language'; version: 1; locale: string; name: string; direction: 'ltr' | 'rtl'; messages: Record<string, string> };
export type ThemePack = ReturnType<typeof parseThemePackage> & { format: 'mandala-theme'; version: 1 };
export type UiExtension = ExtensionEntry & { pluginId?: string; kind: UiExtensionKind; catalogId: string; sourceUrl: string; installedAt: string; data: ThemePack | LanguagePack | PetPack };
export type ExtensionSnapshot = { revision: string; items: UiExtension[]; plugins?: InstalledPlugin[] };
export const isUiExtension = (kind: string): kind is UiExtensionKind => kind === 'theme' || kind === 'language' || kind === 'pet';
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= limit;
export const releaseVersion = (value: unknown): value is string => typeof value === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value);
export function supportsExtension(minimum: string, current: string): boolean {
  const a = minimum.split('.').map(Number), b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return true;
}
export function parseExtensionCatalog(value: unknown, kind: UiExtensionKind): ExtensionEntry[] {
  if (!record(value) || value.format !== 'mandala-catalog' || value.version !== 1 || value.kind !== kind || !Array.isArray(value.items) || value.items.length > 500) throw Error('invalid extension catalog');
  const ids = new Set<string>();
  return value.items.map((item: unknown) => {
    if (!record(item) || typeof item.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,59}$/.test(item.id) || ids.has(item.id) || !text(item.name, 100) || !text(item.description, 2000) || !text(item.publisher, 100) || !releaseVersion(item.version) || !releaseVersion(item.minAppVersion)) throw Error('invalid extension entry');
    const p = item.package;
    if (!record(p) || typeof p.repository !== 'string' || !/^[A-Za-z0-9_-]{1,39}\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/.test(p.repository) || typeof p.revision !== 'string' || !/^[a-f0-9]{40}$/.test(p.revision) || typeof p.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.sha256) || typeof p.path !== 'string' || p.path.length > 240 || !/^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.json$/.test(p.path)) throw Error('invalid extension package reference');
    ids.add(item.id);
    return { id: item.id, name: item.name, description: item.description, version: item.version, publisher: item.publisher, minAppVersion: item.minAppVersion, package: { repository: p.repository, revision: p.revision, path: p.path, sha256: p.sha256 } };
  });
}
export function parseLanguagePack(value: unknown): LanguagePack {
  if (!record(value) || Object.keys(value).some(key => !['format','version','locale','name','direction','messages'].includes(key)) || value.format !== 'mandala-language' || value.version !== 1 || !text(value.locale, 40) || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value.locale) || ['en', 'zh-CN'].includes(value.locale) || !text(value.name, 80) || !['ltr','rtl'].includes(value.direction) || !record(value.messages)) throw Error('invalid language package');
  try { if (Intl.getCanonicalLocales(value.locale)[0] !== value.locale) throw Error(); } catch { throw Error('invalid language locale'); }
  const entries = Object.entries(value.messages);
  if (!entries.length || entries.length > 10000 || entries.some(([key, translation]) => !text(key, 4000) || ['__proto__','constructor','prototype'].includes(key) || !text(translation, 8000))) throw Error('invalid language messages');
  // Placeholders are part of the message contract; missing or invented names corrupt UI values.
  for (const [key, translation] of entries) {
    const slots = (s: string) => [...new Set(s.match(/\{\w+\}/g) ?? [])].sort().join(',');
    if (slots(key) !== slots(translation)) throw Error('invalid language placeholders');
  }
  return { format: 'mandala-language', version: 1, locale: value.locale, name: value.name, direction: value.direction, messages: Object.fromEntries(entries) };
}
export function parseExtensionData(raw: string, kind: UiExtensionKind): ThemePack | LanguagePack | PetPack {
  if (new TextEncoder().encode(raw).length > 4 * 1024 * 1024) throw Error('invalid extension package size');
  return kind === 'theme' ? { format: 'mandala-theme', version: 1, ...parseThemePackage(raw) } : kind === 'pet' ? parsePetPack(JSON.parse(raw)) : parseLanguagePack(JSON.parse(raw));
}
export function localizeMessage(locale: string, pack: LanguagePack | undefined, key: string, english: string, values: Record<string, string | number> = {}): string {
  const translated = pack?.locale === locale && Object.hasOwn(pack.messages, key) ? pack.messages[key] : locale === 'zh-CN' ? key : english;
  return translated.replace(/\{(\w+)\}/g, (match, name: string) => String(values[name] ?? match));
}
