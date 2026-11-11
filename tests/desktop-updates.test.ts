import { expect, test, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { checkForUpdate, createUpdateController, CHECK_INTERVAL, STARTUP_DELAY } = require('../desktop/updates.cjs');
const repo = 'https://github.com/maktub-ai/mandala-releases';
const FEED = 'https://mandala.pub/api/releases';
const GITHUB = 'https://api.github.com/repos/maktub-ai/mandala-releases/releases?per_page=100';
function installer(tag: string, platform = 'mac-arm64') { return `Mandala-${tag.slice(1)}-${platform}.${platform.startsWith('mac') ? 'dmg' : 'exe'}`; }
function github(tag: string, platform = 'mac-arm64') {
  const name = installer(tag, platform);
  return { tag_name: tag, html_url: `${repo}/releases/tag/${tag}`, draft: false, prerelease: tag.includes('-'), assets: [{ name, state: 'uploaded', size: 123, browser_download_url: `${repo}/releases/download/${tag}/${name}` }] };
}
function feedRelease(tag: string, platform = 'mac-arm64') {
  const name = installer(tag, platform);
  return { tag, prerelease: tag.includes('-'), url: `${repo}/releases/tag/${tag}`, assets: [{ name, size: 456, url: `${repo}/releases/download/${tag}/${name}` }] };
}
const ok = (body: unknown) => ({ ok: true, json: async () => body });
// The website feed fails, so GitHub answers with these releases.
const githubOnly = (releases: unknown[]) => vi.fn(async (url: string) => url === FEED ? { ok: false, json: async () => ({}) } : ok(releases));

test('reads the website release feed first', async () => {
  const fetch = vi.fn(async (_url: string) => ok({ schema: 1, releases: [feedRelease('v1.0.1'), feedRelease('v1.1.0', 'win-x64')] }));
  const result = await checkForUpdate({ version: '1.0.0', platform: 'darwin', arch: 'arm64', fetch });
  expect(result).toEqual({ version: '1.0.1', url: `${repo}/releases/download/v1.0.1/Mandala-1.0.1-mac-arm64.dmg`, notes: `${repo}/releases/tag/v1.0.1`, size: 456 });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe(FEED);
});
test('falls back to GitHub when the website is unreachable or returns something unexpected', async () => {
  for (const website of [() => { throw Error('offline'); }, () => ({ ok: false }), () => ok({ schema: 2 }), () => ok([])]) {
    const fetch = vi.fn(async (url: string) => url === FEED ? website() : ok([github('v1.0.1')]));
    expect(await checkForUpdate({ version: '1.0.0', platform: 'darwin', arch: 'arm64', fetch })).toMatchObject({ version: '1.0.1', size: 123 });
    expect(fetch.mock.calls.map(call => call[0])).toEqual([FEED, GITHUB]);
  }
});
test('stable installs only get stable versions; preview installs also get newer previews', async () => {
  const releases = [github('v1.1.0-preview.2'), github('v1.1.0-preview.10'), github('v1.0.1')];
  expect(await checkForUpdate({ version: '1.0.0', platform: 'darwin', arch: 'arm64', fetch: githubOnly(releases) })).toMatchObject({ version: '1.0.1' });
  expect(await checkForUpdate({ version: '1.1.0-preview.1', platform: 'darwin', arch: 'arm64', fetch: githubOnly(releases) })).toMatchObject({ version: '1.1.0-preview.10' });
});
test('never downgrades or offers drafts, wrong architectures or untrusted download URLs', async () => {
  const unsafe = github('v9.0.0'); unsafe.assets[0].browser_download_url = 'https://untrusted.example/installer.dmg';
  const unsafeFeed = feedRelease('v9.0.0'); unsafeFeed.assets[0].url = 'https://untrusted.example/installer.dmg';
  for (const releases of [[github('v0.9.9')], [github('v1.0.0')], [{ ...github('v2.0.0'), draft: true }], [github('v2.0.0', 'mac-x64')], [unsafe]]) {
    expect(await checkForUpdate({ version: '1.0.0', platform: 'darwin', arch: 'arm64', fetch: githubOnly(releases) })).toBeNull();
  }
  expect(await checkForUpdate({ version: '1.0.0', platform: 'darwin', arch: 'arm64', fetch: async () => ok({ schema: 1, releases: [unsafeFeed] }) })).toBeNull();
});
test('a stable version supersedes its preview and numeric versions compare numerically', async () => {
  for (const [current, next] of [['1.0.2-preview.10', 'v1.0.2'], ['0.9.9', 'v0.10.0'], ['1.0.2-preview.9', 'v1.0.2-preview.10']]) {
    expect(await checkForUpdate({ version: current, platform: 'win32', arch: 'x64', fetch: githubOnly([github(next, 'win-x64')]) })).toMatchObject({ version: next.slice(1) });
  }
});
function controller(fetch: (url: string) => Promise<unknown>, extra: Record<string, unknown> = {}) {
  const showMessage = vi.fn(async () => ({ response: 0 })), openExternal = vi.fn(), notify = vi.fn(), onChange = vi.fn();
  const updates = createUpdateController({ version: '1.0.0', platform: 'darwin', arch: 'arm64', fetch, now: () => 1000, showMessage, openExternal, notify, onChange, ...extra });
  return { updates, showMessage, openExternal, notify, onChange };
}
test('automatic checks are silent offline; menu checks explain failure; settings checks report state', async () => {
  const { updates, showMessage } = controller(async () => { throw Error('offline'); });
  await updates.check('auto'); expect(showMessage).not.toHaveBeenCalled();
  expect((await updates.check('settings')).status).toBe('error'); expect(showMessage).not.toHaveBeenCalled();
  await updates.check('menu'); expect(showMessage).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not check for updates' }));
});
test('notifies once per version automatically and only opens a download on request', async () => {
  const { updates, showMessage, openExternal, notify, onChange } = controller(githubOnly([github('v1.0.1')]));
  await updates.check('auto'); await updates.check('auto');
  expect(notify).toHaveBeenCalledTimes(1); expect(showMessage).not.toHaveBeenCalled(); expect(openExternal).not.toHaveBeenCalled();
  expect(updates.state()).toMatchObject({ status: 'available', checkedAt: 1000, update: { version: '1.0.1' } });
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ status: 'checking' }));
  showMessage.mockResolvedValue({ response: 1 }); await updates.check('menu');
  expect(openExternal).toHaveBeenCalledWith(`${repo}/releases/download/v1.0.1/Mandala-1.0.1-mac-arm64.dmg`);
  openExternal.mockClear(); await updates.download(); expect(openExternal).toHaveBeenCalledTimes(1);
});
test('remembers the setting, last check and notified version; automatic checks can be turned off', async () => {
  let saved: unknown = { autoCheck: false, checkedAt: 500, notified: '1.0.1' };
  const store = { read: () => saved, write: (value: unknown) => { saved = value; } };
  const fetch = vi.fn(githubOnly([github('v1.0.1')]));
  const { updates, notify } = controller(fetch, { store });
  expect(updates.state()).toMatchObject({ autoCheck: false, checkedAt: 500 });
  await updates.check('auto'); expect(fetch).not.toHaveBeenCalled();
  updates.setAutoCheck(true); await updates.check('auto');
  expect(notify).not.toHaveBeenCalled();
  expect(saved).toEqual({ autoCheck: true, checkedAt: 1000, notified: '1.0.1' });
});
test('concurrent checks share one request', async () => {
  let resolve!: (v: unknown) => void;
  const fetch = vi.fn((url: string) => url === FEED ? new Promise(r => resolve = r) : Promise.reject(Error('unused')));
  const { updates } = controller(fetch);
  const first = updates.check('auto'), second = updates.check('settings');
  resolve(ok({ schema: 1, releases: [feedRelease('v1.0.1')] }));
  await Promise.all([first, second]);
  expect(fetch).toHaveBeenCalledTimes(1);
});
test('does not prompt after app shutdown while a request is pending', async () => {
  let active = true, resolve!: (v: unknown) => void;
  const { updates, showMessage, openExternal, notify } = controller(() => new Promise(r => resolve = r), { isActive: () => active });
  const pending = updates.check('menu'); active = false; resolve(ok({ schema: 1, releases: [feedRelease('v1.0.1')] })); await pending;
  expect(showMessage).not.toHaveBeenCalled(); expect(openExternal).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
});
test('checks 30 seconds after start and then every 6 hours', () => {
  const later = vi.fn(() => ({ unref() {} })), every = vi.fn(() => ({ unref() {} })), clearOnce = vi.fn(), clearRepeat = vi.fn();
  const { updates } = controller(async () => ok([]));
  const stop = updates.schedule({ setTimeout: later, setInterval: every, clearTimeout: clearOnce, clearInterval: clearRepeat });
  expect(STARTUP_DELAY).toBe(30_000); expect(CHECK_INTERVAL).toBe(6 * 60 * 60 * 1000);
  expect(later).toHaveBeenCalledWith(expect.any(Function), STARTUP_DELAY);
  expect(every).toHaveBeenCalledWith(expect.any(Function), CHECK_INTERVAL);
  stop(); expect(clearOnce).toHaveBeenCalledTimes(1); expect(clearRepeat).toHaveBeenCalledTimes(1);
});
test('unsupported platforms never contact the release service', async () => {
  const fetch = vi.fn();
  const updates = createUpdateController({ version: '1.0.0', platform: 'linux', arch: 'x64', fetch, showMessage: vi.fn(), openExternal: vi.fn() });
  expect((await updates.check('settings')).supported).toBe(false); expect(fetch).not.toHaveBeenCalled();
});

test('downloads a local build inside Mandala and preserves its ready state during checks', async () => {
  const candidate = { version: '1.0.3-local.main.abcdef0' };
  const local = { check: vi.fn(() => candidate), download: vi.fn(async () => {}), ready: vi.fn(() => null) };
  const fetch = vi.fn();
  const { updates, onChange, openExternal } = controller(fetch, { local });
  expect(await updates.check()).toMatchObject({ status: 'available', update: { ...candidate, local: true } });
  await updates.download();
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ status: 'downloading' }));
  expect(await updates.check()).toMatchObject({ status: 'ready', update: candidate });
  expect(fetch).not.toHaveBeenCalled();
  expect(openExternal).not.toHaveBeenCalled();
});

test('restores a staged local update on startup', () => {
  const candidate = { version: '1.0.3-local.main.abcdef0' };
  const local = { ready: () => candidate };
  const { updates } = controller(vi.fn(), { local });
  expect(updates.state()).toMatchObject({ status: 'ready', update: { ...candidate, local: true } });
});
