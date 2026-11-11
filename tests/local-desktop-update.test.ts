import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';

const require = createRequire(import.meta.url);
const currentCommit = 'a'.repeat(40);
const nextCommit = '1'.repeat(40);

test.skipIf(process.platform !== 'darwin')('copies and verifies a local build, defers while busy, and swaps the app on quit', async () => {
  const { createLocalUpdate } = require('../desktop/local-update.cjs');
  const root = mkdtempSync(join(tmpdir(), 'mandala-local-update-'));
  const installed = join(root, 'Mandala.app');
  const feed = join(root, 'feed');
  const offered = join(feed, 'Mandala.app');
  const swap = join(root, 'swap');
  function bundle(path: string, commit: string, day: number) {
    const version = '1.0.3-local.main.' + commit.slice(0, 7);
    const runtime = join(path, 'Contents/Resources/runtime');
    mkdirSync(runtime, { recursive: true });
    mkdirSync(join(path, 'Contents/MacOS'), { recursive: true });
    copyFileSync('/usr/bin/true', join(path, 'Contents/MacOS/Mandala'));
    chmodSync(join(path, 'Contents/MacOS/Mandala'), 0o755);
    writeFileSync(join(path, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
      <plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.maktubcn.mandala</string>
      <key>CFBundleExecutable</key><string>Mandala</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
    const manifest = { version, commit, platform: 'darwin', arch: process.arch, sourceDirty: false, signingRequested: false, builtAt: new Date(Date.UTC(2026, 0, day)).toISOString() };
    writeFileSync(join(runtime, 'build.json'), JSON.stringify(manifest));
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', path]);
    return manifest;
  }
  try {
    mkdirSync(feed, { mode: 0o700 });
    const current = bundle(installed, currentCommit, 1);
    const next = bundle(offered, nextCommit, 2);
    execFileSync('/usr/bin/clang', ['desktop/swap-app.c', '-o', swap]);
    const updater = () => createLocalUpdate({ installed, feed, swap, version: current.version, arch: process.arch });
    const local = updater();
    chmodSync(feed, 0o755);
    expect(local.check()).toBeNull();
    chmodSync(feed, 0o700);
    const candidate = local.check();
    expect(candidate.version).toBe(next.version);
    expect(local.ready()).toBeNull();
    await local.download(candidate);
    expect(updater().ready()).toMatchObject({ version: next.version });
    const buildAt = (path: string) => JSON.parse(readFileSync(join(path, 'Contents/Resources/runtime/build.json'), 'utf8')).commit;
    expect(await local.install(async () => false)).toBe('busy');
    expect(buildAt(installed)).toBe(currentCommit);
    const staged = join(root, '.Mandala.app-update', 'Mandala.app');
    const manifest = join(staged, 'Contents/Resources/runtime/build.json');
    const checkIdle = vi.fn(async () => true);
    writeFileSync(manifest, JSON.stringify(next) + '\n');
    await expect(local.install(checkIdle)).rejects.toThrow();
    expect(checkIdle).not.toHaveBeenCalled();
    expect(buildAt(installed)).toBe(currentCommit);
    expect(local.ready()).toBeNull();
    await local.download(candidate);
    expect(await local.install(checkIdle)).toBe('installed');
    expect(buildAt(staged)).toBe(currentCommit);
    expect(buildAt(installed)).toBe(nextCommit);
    expect(local.ready()).toBeNull();
    const idle = vi.fn();
    expect(await local.install(idle)).toBe('none');
    expect(idle).not.toHaveBeenCalled();
    const newApp = createLocalUpdate({ installed, feed, swap, version: next.version, arch: process.arch });
    expect(newApp.check()).toBeNull();
    expect(newApp.ready()).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
