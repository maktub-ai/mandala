// Update check: GitHub `mandala-releases` is where installers are published; the website's
// release feed re-serves that list from one stable address, and GitHub is the fallback.
// Installers are downloaded by the user (unsigned builds cannot replace themselves).
const RELEASES = 'https://github.com/maktub-ai/mandala-releases';
const FEED = 'https://mandala.pub/api/releases';
const GITHUB_API = 'https://api.github.com/repos/maktub-ai/mandala-releases/releases?per_page=100';
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const STARTUP_DELAY = 30 * 1000;
function versionParts(value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) return null;
  return { core: match.slice(1, 4).map(Number), pre: match[4]?.split('.') ?? [] };
}
function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
  if (!a.pre.length || !b.pre.length) return Number(!a.pre.length) - Number(!b.pre.length);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
async function readJson(fetch, url, accept) {
  const response = await fetch(url, { headers: { Accept: accept }, signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!response.ok) throw Error('The release service is unavailable. Please try again later.');
  return response.json();
}
// Both sources become [{ tag, notes, assets: [{ name, url, size }] }]; every field is checked again below.
async function fetchReleases(fetch) {
  try {
    const feed = await readJson(fetch, FEED, 'application/json');
    if (feed?.schema === 1 && Array.isArray(feed.releases)) return feed.releases.map(release => ({ tag: release?.tag, notes: release?.url, assets: release?.assets }));
  } catch { /* The website may be unreachable; GitHub has the same list. */ }
  const list = await readJson(fetch, GITHUB_API, 'application/vnd.github+json');
  if (!Array.isArray(list)) throw Error('The release service returned an invalid response.');
  return list.filter(release => !release?.draft).map(release => ({ tag: release?.tag_name, notes: release?.html_url,
    assets: (release?.assets ?? []).filter(asset => asset?.state === 'uploaded').map(asset => ({ name: asset.name, url: asset.browser_download_url, size: asset.size })) }));
}
async function checkForUpdate({ version, platform, arch, fetch = globalThis.fetch }) {
  const current = versionParts(version);
  if (!current) throw Error('The installed version could not be identified.');
  const os = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : null;
  if (!os) return null;
  // A stable install is only offered stable versions; a preview install also gets newer previews.
  const previews = current.pre.length > 0;
  let latest = null;
  for (const release of await fetchReleases(fetch)) {
    const tag = typeof release.tag === 'string' ? release.tag : '';
    const next = versionParts(tag);
    if (!next || (next.pre.length && !previews) || compare(next, current) <= 0 || (latest && compare(next, latest.parts) <= 0)) continue;
    const name = `Mandala-${tag.replace(/^v/, '')}-${os}-${arch}.${os === 'mac' ? 'dmg' : 'exe'}`;
    const url = `${RELEASES}/releases/download/${encodeURIComponent(tag)}/${name}`;
    const asset = Array.isArray(release.assets) ? release.assets.find(item => item?.name === name && item.url === url && Number.isSafeInteger(item.size) && item.size > 0) : undefined;
    if (!asset) continue;
    const notes = `${RELEASES}/releases/tag/${encodeURIComponent(tag)}`;
    latest = { version: tag.replace(/^v/, ''), url, notes, size: asset.size, parts: next };
  }
  return latest && { version: latest.version, url: latest.url, notes: latest.notes, size: latest.size };
}
const memoryStore = () => { let saved = {}; return { read: () => saved, write: value => { saved = value; } }; };
// Keeps the update state for the menu, the settings page and the background schedule.
// mode: 'auto' (silent; notifies once per version), 'menu' (native dialogs), 'settings' (the page shows the result).
function createUpdateController({ version, platform, arch, fetch, store = memoryStore(), now = Date.now, isActive = () => true, showMessage, openExternal, notify = () => {}, onChange = () => {} }) {
  let saved = {};
  try { const value = store.read(); if (value && typeof value === 'object') saved = value; } catch { /* Start fresh. */ }
  const supported = platform === 'darwin' || platform === 'win32';
  let state = { supported, current: version, status: 'idle', update: null, checkedAt: Number.isFinite(saved.checkedAt) ? saved.checkedAt : null, autoCheck: saved.autoCheck !== false, error: null };
  let pending = null;
  const persist = () => { try { store.write({ autoCheck: state.autoCheck, checkedAt: state.checkedAt, notified: saved.notified ?? null }); } catch { /* Convenience only. */ } };
  const set = patch => { state = { ...state, ...patch }; if (isActive()) onChange(state); };
  const download = async () => { if (state.update && isActive()) await openExternal(state.update.url); };
  // One request at a time; callers that arrive meanwhile share its result.
  const refresh = () => pending ??= (async () => {
    set({ status: 'checking', error: null });
    try {
      const update = await checkForUpdate({ version, platform, arch, fetch });
      set({ status: update ? 'available' : 'current', update, checkedAt: now() });
      persist();
    } catch { set({ status: 'error', error: 'Could not reach the release service.' }); }
  })().finally(() => { pending = null; });
  const present = async mode => {
    const { status, update } = state;
    if (mode === 'auto') {
      if (status === 'available' && saved.notified !== update.version) { saved.notified = update.version; persist(); notify(update); }
    } else if (mode === 'menu') {
      if (status === 'error') await showMessage({ type: 'warning', title: 'Could not check for updates', message: 'Check your connection and try again later. You can keep using Mandala.', buttons: ['OK'] });
      else if (status === 'available') {
        const answer = await showMessage({ type: 'info', title: 'Mandala update available', message: `Mandala ${update.version} is available`, detail: 'Download the installer, then use “Stop runtime and quit…” before replacing Mandala.', buttons: ['Later', 'Download update'], defaultId: 0, cancelId: 0 });
        if (answer.response === 1) await download();
      } else await showMessage({ type: 'info', title: 'Mandala is up to date', message: `Mandala ${version} is the newest version for this computer.`, buttons: ['OK'] });
    }
  };
  const check = async (mode = 'settings') => {
    if (!supported || !isActive() || (mode === 'auto' && !state.autoCheck)) return state;
    await refresh();
    if (isActive()) await present(mode);
    return state;
  };
  const setAutoCheck = value => { set({ autoCheck: value === true }); persist(); return state; };
  // Startup check after a short delay, then every six hours while automatic checks are on.
  const schedule = (timers = { setTimeout, setInterval, clearTimeout, clearInterval }) => {
    const first = timers.setTimeout(() => { void check('auto'); }, STARTUP_DELAY), repeat = timers.setInterval(() => { void check('auto'); }, CHECK_INTERVAL);
    first.unref?.(); repeat.unref?.();
    return () => { timers.clearTimeout(first); timers.clearInterval(repeat); };
  };
  return { state: () => state, check, download, setAutoCheck, schedule };
}
module.exports = { checkForUpdate, createUpdateController, CHECK_INTERVAL, STARTUP_DELAY };
