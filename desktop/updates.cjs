const RELEASES = 'https://github.com/maktub-ai/mandala-releases';
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
async function checkForUpdate({ version, platform, arch, fetch = globalThis.fetch }) {
  const current = versionParts(version);
  if (!current) throw Error('The installed version could not be identified.');
  const os = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : null;
  if (!os) return null;
  const response = await fetch('https://api.github.com/repos/maktub-ai/mandala-releases/releases?per_page=100', {
    headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10000), redirect: 'error'
  });
  if (!response.ok) throw Error('The release service is unavailable. Please try again later.');
  const releases = await response.json();
  if (!Array.isArray(releases)) throw Error('The release service returned an invalid response.');
  let latest = null;
  for (const release of releases) {
    const next = versionParts(release?.tag_name);
    if (!next || release.draft || compare(next, current) <= 0 || (latest && compare(next, latest.parts) <= 0)) continue;
    const name = `Mandala-${release.tag_name.replace(/^v/, '')}-${os}-${arch}.${os === 'mac' ? 'dmg' : 'exe'}`;
    const url = `${RELEASES}/releases/download/${encodeURIComponent(release.tag_name)}/${name}`;
    if (!release.assets?.some(asset => asset.name === name && asset.state === 'uploaded' && asset.size > 0 && asset.browser_download_url === url)) continue;
    latest = { version: release.tag_name.replace(/^v/, ''), url, parts: next };
  }
  return latest && { version: latest.version, url: latest.url };
}
function createUpdateChecker({ showMessage, openExternal, isActive = () => true, ...options }) {
  let busy = false;
  const notified = new Set();
  return async function check(manual = false) {
    if (busy || !isActive()) return;
    busy = true;
    try {
      const update = await checkForUpdate(options);
      if (!isActive()) return;
      if (update && (manual || !notified.has(update.version))) {
        notified.add(update.version);
        const answer = await showMessage({ type: 'info', title: 'Mandala update available', message: `Mandala ${update.version} is available`, detail: 'Download the installer, then stop the runtime before replacing Mandala. Your current work will keep running.', buttons: ['Later', 'Download update'], defaultId: 0, cancelId: 0 });
        if (answer.response === 1 && isActive()) await openExternal(update.url);
      } else if (manual) {
        await showMessage({ type: 'info', title: 'Mandala updates', message: 'No newer installer is available for this computer.', buttons: ['OK'] });
      }
    } catch {
      if (manual && isActive()) await showMessage({ type: 'warning', title: 'Could not check for updates', message: 'Check your connection and try again later. You can keep using Mandala.', buttons: ['OK'] });
    } finally { busy = false; }
  };
}
module.exports = { checkForUpdate, createUpdateChecker };
