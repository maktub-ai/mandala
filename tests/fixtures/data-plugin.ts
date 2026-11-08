import { createHash } from 'node:crypto';
import { defaultPreferences, exportThemePackage } from '../../shared/themes';
const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
const dot = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>').toString('base64');
export const pluginFiles: Record<string, string> = {
  'theme.json': exportThemePackage(defaultPreferences(), 'light'),
  'language.json': JSON.stringify({ format: 'mandala-language', version: 1, locale: 'fr', name: 'Français', direction: 'ltr', messages: { '市场': 'Marché' } }),
  'pet.json': JSON.stringify({ format: 'mandala-pet', version: 1, name: 'Studio Dot', tint: true, states: { idle: dot, working: dot, waiting: dot, error: dot } }),
};
const contribution = (id: string, path: string) => ({ id, path, sha256: hash(pluginFiles[path]) });
export const studioManifest = { format: 'mandala-plugin', schemaVersion: 1, execution: 'data', id: 'studio', name: 'Studio', description: 'Synthetic theme, language and pet', version: '1.0.0', minAppVersion: '0.1.2', contributes: { themes: [contribution('paper', 'theme.json')], languagePacks: [contribution('french', 'language.json')], pets: [contribution('dot', 'pet.json')] } };
pluginFiles['mandala-plugin.json'] = JSON.stringify(studioManifest);
export const studioEntry = { id: 'studio', name: 'Studio', description: studioManifest.description, version: '1.0.0', minAppVersion: '0.1.2', publisher: 'Example', kinds: ['theme', 'language', 'pet'], package: { repository: 'example/studio', revision: 'c'.repeat(40), path: 'mandala-plugin.json', sha256: hash(pluginFiles['mandala-plugin.json']) } };
export const studioCatalog = { format: 'mandala-plugin-catalog', version: 1, items: [studioEntry] };
