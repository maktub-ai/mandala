import { expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('prunes browser-only dependencies while retaining shared transitive dependencies and locked versions', async () => {
  const modulePath = '../scripts/prune-desktop-runtime.mjs';
  const helper = await import(modulePath).catch(() => null);
  expect(helper, 'desktop runtime needs dependency-aware browser pruning').not.toBeNull();
  if (!helper) return;
  const root = await mkdtemp(join(tmpdir(), 'mandala-runtime-prune-'));
  const packages = {
    '': { name: 'synthetic-runtime', version: '1.0.0', dependencies: { mermaid: '1.0.0', yaml: '1.0.0' } },
    'node_modules/mermaid': { version: '1.0.0', dependencies: { shared: '1.0.0', 'browser-child': '1.0.0' } },
    'node_modules/yaml': { version: '1.0.0', dependencies: { shared: '1.0.0' } },
    'node_modules/shared': { version: '1.0.0' },
    'node_modules/browser-child': { version: '1.0.0' },
  };
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify(packages['']));
    await writeFile(join(root, 'package-lock.json'), JSON.stringify({name: 'synthetic-runtime', version: '1.0.0', lockfileVersion: 3, packages}));
    for (const [path, metadata] of Object.entries(packages).filter(([path]) => path)) {
      await mkdir(join(root, path), {recursive: true});
      await writeFile(join(root, path, 'package.json'), JSON.stringify({name: path.slice(13), ...metadata}));
    }
    await helper.pruneDesktopRuntime(root, {outputs: {server: {imports: [{path: 'yaml', external: true}]}}});
    expect(await readdir(join(root, 'node_modules'))).toEqual(expect.arrayContaining(['yaml', 'shared']));
    expect(await readdir(join(root, 'node_modules'))).not.toContain('mermaid');
    expect(await readdir(join(root, 'node_modules'))).not.toContain('browser-child');
    const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
    expect(lock.packages['node_modules/yaml'].version).toBe('1.0.0');
    expect(lock.packages['node_modules/shared'].version).toBe('1.0.0');
    expect(lock.packages['node_modules/mermaid']).toBeUndefined();
  } finally { await rm(root, {recursive: true, force: true}); }
});

it('refuses to remove a browser package that a server entry needs, including subpath imports', async () => {
  const modulePath = '../scripts/prune-desktop-runtime.mjs';
  const helper = await import(modulePath).catch(() => null);
  expect(helper).not.toBeNull();
  if (!helper) return;
  const root = await mkdtemp(join(tmpdir(), 'mandala-runtime-guard-'));
  try {
    const original = JSON.stringify({dependencies: {mermaid: '1.0.0'}});
    await writeFile(join(root, 'package.json'), original);
    await expect(helper.pruneDesktopRuntime(root, {outputs: {server: {imports: [{path: 'mermaid/dist/mermaid.js', external: true}]}}})).rejects.toThrow('Server requires browser dependency: mermaid');
    expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(original);
  } finally { await rm(root, {recursive: true, force: true}); }
});

it('keeps the current native PTY binary, executable helper and licenses while removing other platform prebuilds', async () => {
  const modulePath = '../scripts/prune-desktop-runtime.mjs';
  const helper = await import(modulePath).catch(() => null);
  expect(helper).not.toBeNull();
  if (!helper) return;
  const root = await mkdtemp(join(tmpdir(), 'mandala-pty-prune-'));
  try {
    const pty = join(root, 'node_modules/node-pty');
    for (const target of ['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64']) {
      await mkdir(join(pty, 'prebuilds', target), {recursive: true});
      await writeFile(join(pty, 'prebuilds', target, 'pty.node'), 'synthetic native binary');
      await writeFile(join(pty, 'prebuilds', target, 'spawn-helper'), 'synthetic helper', {mode: 0o755});
    }
    await writeFile(join(pty, 'LICENSE'), 'Original PTY terms');
    await helper.prunePtyPrebuilds(root, 'darwin', 'arm64');
    expect(await readdir(join(pty, 'prebuilds'))).toEqual(['darwin-arm64']);
    expect(await readFile(join(pty, 'prebuilds/darwin-arm64/pty.node'), 'utf8')).toBe('synthetic native binary');
    if (process.platform !== 'win32') expect((await stat(join(pty, 'prebuilds/darwin-arm64/spawn-helper'))).mode & 0o111).toBe(0o111);
    expect(await readFile(join(pty, 'LICENSE'), 'utf8')).toBe('Original PTY terms');
  } finally { await rm(root, {recursive: true, force: true}); }
});
