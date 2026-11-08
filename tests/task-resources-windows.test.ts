import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../server/store';
import { createTaskResources } from '../server/task-resources';

// Exercise the real scheduler with native Windows path semantics on every CI host.
vi.mock('node:path', async importOriginal => {
  const path = await importOriginal<typeof import('node:path')>();
  return { ...path, relative: path.win32.relative, isAbsolute: path.win32.isAbsolute, sep: path.win32.sep };
});
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, realpathSync: (path: string) => /^[A-Z]:\\/i.test(path) ? path : fs.realpathSync(path) };
});
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach(clean => clean()));

test('Windows delegated writes allow unrelated roots and still exclude ancestors and descendants', () => {
  const home = mkdtempSync(join(tmpdir(), 'mana-win-claims-')), store = openStore(home);
  cleanups.push(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const resources = createTaskResources(store);
  expect(resources.claimDirectory('first', String.raw`C:\work\project-a`, 'write')).toBe('granted');
  expect(resources.claimDirectory('sibling', String.raw`C:\work\project-b`, 'write')).toBe('granted');
  expect(resources.claimDirectory('other-drive', String.raw`D:\work\project-a`, 'write')).toBe('granted');
  expect(resources.claimDirectory('child', String.raw`C:\work\project-a\src`, 'write')).toBe('queued');
  expect(resources.claimDirectory('parent', String.raw`C:\work`, 'write')).toBe('queued');
  expect(resources.claimDirectory('same', String.raw`c:\WORK\project-a`, 'write')).toBe('queued');
});
