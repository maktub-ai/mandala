import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { productHome } from '../cli/product-env.mjs';
import { claimServiceHome } from './service-home-lock';
import { claimServiceRecord, handleServiceControl, readRuntimeBuild, removeServiceRecord } from '../desktop/service-discovery';
import { prepareDesktopHome } from '../desktop/runtime';
import { startAccountWorkspace } from './account-desktop-workspace';
import { createDesktopGateway } from './desktop-gateway';

// A running gateway keeps its identity even when the App is replaced in place.
const directory = dirname(fileURLToPath(import.meta.url));
const build = readRuntimeBuild(join(directory, '..'));
const root = productHome(), home = join(root, 'account-gateway'), setupToken = randomBytes(32).toString('base64url');
prepareDesktopHome(home);
const lock = claimServiceHome(home);
process.once('exit', () => { try { lock.release(); } catch {} });
const gateway = createDesktopGateway({
  root, setupToken, controlOrigin: process.env.MANDALA_ACCOUNT_ORIGIN ?? 'https://account.mandala.pub',
  dist: join(directory, '../dist'),
  startWorkspace: (profileHome, lease) => startAccountWorkspace(profileHome, lease, join(directory, 'main.mjs')),
});
let record: ReturnType<typeof claimServiceRecord> | undefined;
let shutdown: Promise<void> | undefined;
const stop = () => {
  shutdown ??= gateway.close().then(() => {
    if (record) removeServiceRecord(home, record);
    lock.release();
    if (process.connected) process.disconnect();
  }).catch(() => {
    // Keep ownership and the authenticated control endpoint available for a retry.
    shutdown = undefined;
  });
};
const requestListener = gateway.server.listeners('request')[0];
gateway.server.removeAllListeners('request');
gateway.server.on('request', (req, res) => {
  if (record && handleServiceControl(record, req, res, stop, { build, stopIfIdle: gateway.reserveIdleShutdown })) return;
  requestListener.call(gateway.server, req, res);
});
await new Promise<void>(r => gateway.server.listen(0, '127.0.0.1', r));
const port = (gateway.server.address() as { port: number }).port;
record = claimServiceRecord(home, `http://127.0.0.1:${port}`, setupToken);
process.on('message', message => { if ((message as { type?: string })?.type === 'mandala:stop') stop(); });
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
if (process.env.MANDALA_DESKTOP_LOGIN_START === '1') {
  void gateway.startSavedWorkspace().catch(() => console.error('Saved Mandala workspace could not start'));
}
process.send?.({ type: 'mandala:ready', port, setupToken });
