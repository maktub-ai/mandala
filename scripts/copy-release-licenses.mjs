import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { open as openZip } from 'yauzl';

const isNotice = name => /^(licen[cs]e|notice|copying|copyright)([-._]|$)/i.test(name);

/** Electron puts these beside the .app, so electron-builder does not include them. */
export async function copyElectronLicenses(archive, output) {
  const destination = join(output, 'licenses/electron');
  await mkdir(destination, { recursive: true });
  await new Promise((resolve, reject) => {
    openZip(archive, { lazyEntries: true }, (error, zip) => {
      if (error) { reject(error); return; }
      const needed = new Set(['LICENSE', 'LICENSES.chromium.html']);
      const fail = error => { zip.close(); reject(error); };
      zip.on('error', fail);
      zip.on('end', () => needed.size ? reject(new Error('Missing Electron notices: ' + [...needed].join(', '))) : resolve());
      zip.on('entry', entry => {
        if (!needed.has(entry.fileName)) { zip.readEntry(); return; }
        zip.openReadStream(entry, (error, stream) => {
          if (error) { fail(error); return; }
          pipeline(stream, createWriteStream(join(destination, entry.fileName))).then(() => {
            needed.delete(entry.fileName); zip.readEntry();
          }, fail);
        });
      });
      zip.readEntry();
    });
  });
}

/** Keep upstream terms alongside bundled code; project terms never replace them. */
export async function copyReleaseLicenses(root, output) {
  await mkdir(output, { recursive: true });
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await cp(join(root, name), join(output, name));
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  const inventory = [];
  for (const [path, pkg] of Object.entries(lock.packages)) {
    if (!path.startsWith('node_modules/') || pkg.dev) continue;
    const directory = join(root, path);
    const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT' && pkg.optional) return [];
      throw error;
    });
    if (!entries.length) continue;
    const name = path.slice('node_modules/'.length);
    inventory.push({ name, version: pkg.version, license: pkg.license ?? 'See original package terms' });
    const notices = entries.filter(entry => entry.isFile() && isNotice(entry.name));
    // Some packages publish their full license only in the README. Preserve it verbatim.
    const terms = notices.length ? notices : entries.filter(entry => entry.isFile() && /^readme([-.]|$)/i.test(entry.name));
    for (const entry of terms) {
      const destination = join(output, 'licenses/dependencies', name, entry.name);
      await mkdir(join(destination, '..'), { recursive: true });
      await cp(join(directory, entry.name), destination);
    }
  }
  for (const directory of ['server/vendor', 'src/assets', 'public', 'third-party-notices']) {
    const source = join(root, directory);
    const entries = await readdir(source, { recursive: true, withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries.filter(entry => entry.isFile() && /license|notice|(?:^|[-_.])ofl(?:[-_.]|$)/i.test(entry.name))) {
      const path = join(entry.parentPath, entry.name).slice(root.length + 1);
      const destination = join(output, 'licenses/assets', path);
      await mkdir(join(destination, '..'), { recursive: true });
      await cp(join(root, path), destination);
    }
  }
  await mkdir(join(output, 'licenses'), { recursive: true });
  await writeFile(join(output, 'licenses/dependencies.json'), JSON.stringify(inventory, null, 2) + '\n');
}
