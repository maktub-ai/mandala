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

export const planSection = {
  format: 'mandala-library-section', version: 1, type: 'project-files', label: { zh: '归档', en: 'Archive' }, icon: 'target',
  source: { kind: 'collection', namespace: 'omino', file: 'view.html', summary: {
    file: 'summary.json', format: 'omino-summary', version: 1, title: 'title', badgeItems: 'waiting', closedField: 'status', closedValue: 'closed',
  } }, loopback: true,
  emptyText: { zh: '这个项目还没有归档文件。', en: 'This project has no archived files.' },
  updateText: { zh: '更新归档文件', en: 'Update archived files' },
};
const handbookSection = {
  format: 'mandala-library-section', version: 1, type: 'project-files', label: { zh: '手册', en: 'Handbook' }, icon: 'book',
  source: { kind: 'workspace', file: 'docs/handbook.html' },
};
function makeSectionPackage(id: string, name: string, sectionId: string, section: typeof planSection | typeof handbookSection) {
  const sectionJson = JSON.stringify(section);
  const manifest = {
    format: 'mandala-plugin', schemaVersion: 1, execution: 'data', id, name, description: name + ' in the library',
    version: '1.0.0', minAppVersion: '0.1.2', contributes: { librarySections: [{ id: sectionId, path: 'section.json', sha256: hash(sectionJson) }] },
  };
  const files: Record<string, string> = { 'mandala-plugin.json': JSON.stringify(manifest), 'section.json': sectionJson };
  const entry = {
    id, name, description: manifest.description, version: manifest.version, minAppVersion: manifest.minAppVersion,
    publisher: 'Example', kinds: ['library-section'],
    package: { repository: 'example/' + id, revision: 'd'.repeat(40), path: 'mandala-plugin.json', sha256: hash(files['mandala-plugin.json']) },
  };
  return { manifest, files, entry };
}
export const { manifest: planManifest, files: planFiles, entry: planEntry } = makeSectionPackage('todo-plans', 'Example Archive', 'plan', planSection);
export const { files: handbookFiles, entry: handbookEntry } = makeSectionPackage('todo-handbook', 'Todo Handbook', 'handbook', handbookSection);
