import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// Vite has already bundled these into dist. Keep server/shared packages such as
// mdast-util-from-markdown, and let npm retain any shared transitive dependency.
const browserDependencies = ['@xterm/addon-fit', '@xterm/xterm', 'dompurify', 'highlight.js', 'lowlight', 'lucide-react', 'mermaid', 'pdfjs-dist', 'react', 'react-dom', 'react-markdown', 'remark-gfm'];

export async function pruneDesktopRuntime(runtime, metafile) {
  const imports = Object.values(metafile.outputs).flatMap(output => output.imports).filter(item => item.external).map(item => item.path);
  for (const name of browserDependencies) {
    if (imports.some(path => path === name || path.startsWith(name + '/'))) throw new Error('Server requires browser dependency: ' + name);
  }
  const path = join(runtime, 'package.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  for (const name of browserDependencies) delete manifest.dependencies[name];
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n');
  // Install and native postinstall ran with the original lock. Prune offline,
  // without re-running lifecycle hooks or changing the root lock/version pins.
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npm, ['prune', '--omit=dev', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], {cwd: runtime, stdio: 'inherit', shell: process.platform === 'win32'});
  await prunePtyPrebuilds(runtime);
}

export async function prunePtyPrebuilds(runtime, platform = process.platform, arch = process.arch) {
  const prebuilds = join(runtime, 'node_modules/node-pty/prebuilds');
  const entries = await readdir(prebuilds).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const target of entries) {
    if (target !== `${platform}-${arch}`) await rm(join(prebuilds, target), {recursive: true, force: true});
  }
}
