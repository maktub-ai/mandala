import { expect, test, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { checkForUpdate } = require('../desktop/updates.cjs');
const repo = 'https://github.com/maktub-ai/mandala-releases';
function release(tag: string, platform = 'mac-arm64') {
  const name = `Mandala-${tag.slice(1)}-${platform}.${platform.startsWith('mac') ? 'dmg' : 'exe'}`;
  return { tag_name: tag, draft: false, prerelease: tag.includes('-'), assets: [{ name, state: 'uploaded', size: 123, browser_download_url: `${repo}/releases/download/${tag}/${name}` }] };
}
test('offers the newest compatible installer, including preview versions', async () => {
  const fetch = vi.fn(async (_url: string) => ({ ok: true, json: async () => [release('v0.1.3-preview.2'), release('v0.1.3-preview.10'), release('v0.2.0', 'win-x64')] }));
  const result = await checkForUpdate({ version: '0.1.2', platform: 'darwin', arch: 'arm64', fetch });
  expect(result.version).toBe('0.1.3-preview.10');
  expect(result.url).toBe(`${repo}/releases/download/v0.1.3-preview.10/Mandala-0.1.3-preview.10-mac-arm64.dmg`);
  expect(fetch.mock.calls[0][0]).toBe('https://api.github.com/repos/maktub-ai/mandala-releases/releases?per_page=100');
});
test('never downgrades, offers drafts, wrong architectures or untrusted download URLs', async () => {
  const unsafe = release('v9.0.0'); unsafe.assets[0].browser_download_url = 'https://untrusted.example/installer.dmg';
  for (const releases of [[release('v0.1.1')], [release('v0.1.2')], [release('v0.1.2-preview.9')], [{ ...release('v0.2.0'), draft: true }], [release('v0.2.0', 'mac-x64')], [unsafe]]) {
    expect(await checkForUpdate({ version: '0.1.2', platform: 'darwin', arch: 'arm64', fetch: async () => ({ ok: true, json: async () => releases }) })).toBeNull();
  }
});
test('a stable version supersedes its preview and numeric versions compare numerically', async () => {
  for (const [current, next] of [['0.1.2-preview.10', 'v0.1.2'], ['0.9.9', 'v0.10.0'], ['0.1.2-preview.9', 'v0.1.2-preview.10']]) {
    expect(await checkForUpdate({ version: current, platform: 'win32', arch: 'x64', fetch: async () => ({ ok: true, json: async () => [release(next, 'win-x64')] }) })).toMatchObject({ version: next.slice(1) });
  }
});
test('automatic checks are silent offline, manual checks explain failure', async () => {
  const { createUpdateChecker } = require('../desktop/updates.cjs');
  const showMessage = vi.fn(async () => ({ response: 0 })), openExternal = vi.fn();
  const check = createUpdateChecker({ version: '0.1.2', platform: 'darwin', arch: 'arm64', fetch: async () => { throw Error('offline'); }, showMessage, openExternal });
  await check(); expect(showMessage).not.toHaveBeenCalled();
  await check(true); expect(showMessage).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not check for updates' }));
  expect(openExternal).not.toHaveBeenCalled();
});
test('only opens a download on explicit acceptance and suppresses repeated automatic prompts', async () => {
  const { createUpdateChecker } = require('../desktop/updates.cjs');
  const showMessage = vi.fn(async () => ({ response: 0 })), openExternal = vi.fn();
  const check = createUpdateChecker({ version: '0.1.2', platform: 'darwin', arch: 'arm64', fetch: async () => ({ ok: true, json: async () => [release('v0.2.0')] }), showMessage, openExternal });
  await check(); await check(); expect(showMessage).toHaveBeenCalledTimes(1); expect(openExternal).not.toHaveBeenCalled();
  showMessage.mockResolvedValue({ response: 1 }); await check(true);
  expect(openExternal).toHaveBeenCalledWith(`${repo}/releases/download/v0.2.0/Mandala-0.2.0-mac-arm64.dmg`);
});
test('does not prompt after app shutdown while a request is pending', async () => {
  const { createUpdateChecker } = require('../desktop/updates.cjs');
  let active = true, resolve!: (v: unknown) => void;
  const showMessage = vi.fn(), openExternal = vi.fn();
  const check = createUpdateChecker({ version: '0.1.2', platform: 'darwin', arch: 'arm64', isActive: () => active, fetch: () => new Promise(r => resolve = r), showMessage, openExternal });
  const pending = check(); active = false; resolve({ ok: true, json: async () => [release('v0.2.0')] }); await pending;
  expect(showMessage).not.toHaveBeenCalled(); expect(openExternal).not.toHaveBeenCalled();
});
