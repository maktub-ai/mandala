import { expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { marketZip } from './fixtures/market-zip';

it('ships the original Electron and Chromium notices from the exact runtime archive', async () => {
  const modulePath = '../scripts/copy-release-licenses.mjs';
  const helper = await import(modulePath);
  const root = await mkdtemp(join(tmpdir(), 'mandala-electron-terms-'));
  try {
    const archive = join(root, 'electron.zip');
    await writeFile(archive, marketZip([{path:'LICENSE',content:'Original Electron license'}, {path:'LICENSES.chromium.html',content:'Original Chromium notices'}, {path:'Electron.app/binary',content:'not a notice'}]));
    await helper.copyElectronLicenses(archive, join(root, 'output'));
    expect(await readFile(join(root, 'output/licenses/electron/LICENSE'), 'utf8')).toBe('Original Electron license');
    expect(await readFile(join(root, 'output/licenses/electron/LICENSES.chromium.html'), 'utf8')).toBe('Original Chromium notices');
    await expect(readFile(join(root, 'output/licenses/electron/Electron.app/binary'))).rejects.toThrow();
    await writeFile(archive, marketZip([{path:'LICENSE',content:'Original Electron license'}]));
    await expect(helper.copyElectronLicenses(archive, join(root, 'incomplete'))).rejects.toThrow('Missing Electron notices');
  } finally { await rm(root, {recursive:true,force:true}); }
});

it('ships project and original bundled third-party terms without collecting dev dependencies', async () => {
  const modulePath = '../scripts/copy-release-licenses.mjs';
  const helper = await import(modulePath).catch(() => null);
  expect(helper, 'distributables need complete applicable license notices').not.toBeNull();
  const root = await mkdtemp(join(tmpdir(), 'mandala-license-'));
  try {
    const files: Record<string, string> = {
      'LICENSE': 'project terms', 'THIRD_PARTY_NOTICES.md': 'separate upstream rights',
      'package-lock.json': JSON.stringify({packages: {'': {}, 'node_modules/box': {version: '1', license: 'Unlicense'}, 'node_modules/readme-only': {version: '2', license: 'MIT'}, 'node_modules/dev': {version: '1', license: 'MIT', dev: true}}}),
      'node_modules/readme-only/README.md': 'Package documentation\nCopyright Original Author\nMIT permission and warranty terms',
      'node_modules/box/LICENSE': 'original box terms', 'node_modules/dev/LICENSE': 'dev only',
      'server/vendor/tencentdb/LICENSE': 'vendor terms',
      'src/assets/fonts/Inter-LICENSE.txt': 'font terms',
      'src/assets/fonts/EBGaramond-OFL.txt': 'original OFL terms',
      'public/runtime-logos/LICENSE-bootstrap.txt': 'icon terms',
      'third-party-notices/CodeGraph-1.2.0-LICENSE.txt': 'original graph MIT terms',
      'third-party-notices/Node-24.16.0-LICENSE.txt': 'original sidecar Node terms',
    };
    for (const [path, text] of Object.entries(files)) {
      const target = join(root, path); await mkdir(join(target, '..'), {recursive: true}); await writeFile(target, text);
    }
    await helper.copyReleaseLicenses(root, join(root, 'output'));
    expect(await readFile(join(root, 'output/LICENSE'), 'utf8')).toBe('project terms');
    expect(await readFile(join(root, 'output/licenses/assets/third-party-notices/CodeGraph-1.2.0-LICENSE.txt'), 'utf8')).toBe('original graph MIT terms');
    expect(await readFile(join(root, 'output/licenses/assets/third-party-notices/Node-24.16.0-LICENSE.txt'), 'utf8')).toBe('original sidecar Node terms');
    expect(await readFile(join(root, 'output/licenses/dependencies/box/LICENSE'), 'utf8')).toBe('original box terms');
    expect(await readFile(join(root, 'output/licenses/assets/server/vendor/tencentdb/LICENSE'), 'utf8')).toBe('vendor terms');
    expect(await readFile(join(root, 'output/licenses/assets/src/assets/fonts/EBGaramond-OFL.txt'), 'utf8')).toBe('original OFL terms');
    expect(await readFile(join(root, 'output/licenses/dependencies/readme-only/README.md'), 'utf8')).toBe(files['node_modules/readme-only/README.md']);
    expect(JSON.parse(await readFile(join(root, 'output/licenses/dependencies.json'), 'utf8'))).toEqual([{name: 'box', version: '1', license: 'Unlicense'}, {name: 'readme-only', version: '2', license: 'MIT'}]);
    await expect(readFile(join(root, 'output/licenses/dependencies/dev/LICENSE'))).rejects.toThrow();
  } finally { await rm(root, {recursive: true, force: true}); }
});
