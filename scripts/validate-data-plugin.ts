/** Local-only author check: reads declared files; never runs package code or contacts a network. */
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePluginManifest, pluginContributions, pluginLimit } from '../shared/data-plugins';
import { parseExtensionData } from '../shared/ui-extensions';
export async function validateDataPlugin(directory: string) {
  const root = await realpath(directory);
  let bytes = 0;
  const read = async (path: string) => {
    const location = await realpath(join(root, path)), local = relative(root, location);
    if (local === '..' || local.startsWith('..' + sep)) throw Error('invalid plugin path outside package');
    const size = (await stat(location)).size;
    if (size + bytes > pluginLimit) throw Error('invalid plugin size');
    const raw = await readFile(location); bytes += raw.length;
    if (bytes > pluginLimit) throw Error('invalid plugin size');
    return raw;
  };
  const manifest = parsePluginManifest(JSON.parse((await read('mandala-plugin.json')).toString('utf8')));
  for (const contribution of pluginContributions(manifest)) {
    const raw = await read(contribution.path);
    if (createHash('sha256').update(raw).digest('hex') !== contribution.sha256) throw Error('invalid plugin checksum');
    parseExtensionData(raw.toString('utf8'), contribution.kind);
  }
  return { id: manifest.id, version: manifest.version, contributions: pluginContributions(manifest).length, bytes };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw Error('Usage: node --import tsx scripts/validate-data-plugin.ts PACKAGE_DIRECTORY');
  console.log(JSON.stringify(await validateDataPlugin(process.argv[2])));
}
