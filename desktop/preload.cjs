const { ipcRenderer, contextBridge, webUtils } = require('electron');
function preferenceRequest(channel, request) {
  const reply = ipcRenderer.sendSync(channel, request);
  if (!reply?.ok) throw Error(reply?.error ?? 'Desktop appearance storage unavailable');
  return reply.value;
}
async function petRequest(action, path) {
  const reply = await ipcRenderer.invoke('mandala:pet', path === undefined ? { action } : { action, path });
  if (!reply?.ok) throw Error(reply?.error ?? 'Pet window unavailable');
}
function subscribe(channel, listener, accept) {
  const handler = (_event, value) => { if (accept(value)) listener(value); };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}
async function cliRequest(action) {
  const reply = await ipcRenderer.invoke('mandala:cli', { action });
  if (!reply?.ok) throw Error(reply?.error ?? 'Desktop command registration unavailable');
  return reply.value;
}
contextBridge.exposeInMainWorld('mandalaDesktop', Object.freeze({ platform: process.platform, account: Object.freeze({partition:process.argv.find(v=>v.startsWith('--mandala-account-partition='))?.split('=')[1],restart:()=>ipcRenderer.invoke('mandala:account-restart')}), files: Object.freeze({
  directoryPath: file => {
    const path = webUtils.getPathForFile(file);
    return path ? preferenceRequest('mandala:directory-path', path) : null;
  },
}), cli: Object.freeze({ status: () => cliRequest('status'), install: () => cliRequest('install') }), appearance: Object.freeze({
  read: () => preferenceRequest('mandala:appearance', { action: 'read' }),
  write: value => preferenceRequest('mandala:appearance', { action: 'write', value }),
}), pet: Object.freeze({
  show: () => petRequest('show'),
  hide: () => petRequest('hide'),
  open: path => petRequest('open', String(path)),
  interactive: value => ipcRenderer.send('mandala:pet-input', { action: 'interactive', value: value === true }),
  move: (x, y) => ipcRenderer.send('mandala:pet-input', { action: 'move', x: Math.round(Number(x)), y: Math.round(Number(y)) }),
  settle: () => ipcRenderer.send('mandala:pet-input', { action: 'settle' }),
  onVisibility: listener => subscribe('mandala:pet-visibility', listener, value => typeof value === 'boolean'),
  onNavigate: listener => subscribe('mandala:navigate', listener, value => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')),
}), preferences: Object.freeze({
  read: () => preferenceRequest('mandala:preferences', { action: 'read' }),
  write: (key, value) => preferenceRequest('mandala:preferences', { action: 'write', key, value }),
}) }));
// Only selected-file paths, bounded command registration and allowlisted UI preferences are callable; opening external links still requires an actual user click.
window.addEventListener('click', event => {
  if (!event.isTrusted || event.button !== 0 || !(event.target instanceof Element)) return;
  const link = event.target.closest('a[href]');
  if (!link) return;
  let url;
  try { url = new URL(link.href); } catch { return; }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin === window.location.origin || url.username || url.password) return;
  event.preventDefault(); event.stopImmediatePropagation();
  ipcRenderer.send('mandala:open-external', url.href);
}, true);
