import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import manifest from './manifest.json' with { type: 'json' };

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { build } = require('../../node_modules/esbuild');
const dependencies = ['@agentclientprotocol/sdk', 'zod'];

export async function buildClaudeBridge(outdir) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['entry.mjs'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    minify: true,
    legalComments: 'none',
    preserveSymlinks: true,
    metafile: true,
    write: false,
  });
  for (const input of Object.keys(result.metafile.inputs)) {
    const path = input.replaceAll('\\', '/');
    const dependency = path.split('/node_modules/').at(-1);
    if (dependency !== path && !dependencies.some(name => dependency.startsWith(name + '/'))) {
      throw new Error(`Unexpected Claude bridge dependency: ${dependency}`);
    }
  }
  const bytes = result.outputFiles[0].contents;
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== manifest.sha256) throw new Error(`Claude bridge SHA-256 mismatch: ${digest}`);

  const notices = await Promise.all(dependencies.map(async name => {
    const directory = join(root, '../../node_modules', name);
    const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    const license = await readFile(join(directory, 'LICENSE'), 'utf8');
    return `${name} ${metadata.version}\n\n${license}`;
  }));
  await writeFile(join(outdir, manifest.notices), notices.join('\n\n'));
  await writeFile(join(outdir, manifest.entry), bytes);
}
