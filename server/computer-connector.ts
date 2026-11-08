import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { boundedBody } from '../shared/remote-crypto';
import type { DeviceAccess } from './account-store';

export type ConnectorStatus = { state: 'connecting' | 'connected' | 'offline' | 'closed'; error?: string };
type RelayRequest = { id: string; method: string; path: string; headers: Record<string, string>; ownerId: string; clientId: string };
export function validateControlUrl(input: string) {
  const url = new URL(input);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Account service requires an HTTPS origin or HTTP loopback development origin');
  return url.origin;
}
export async function revokeComputer(controlUrl: string, credential: string) {
  try { const response = await fetch(validateControlUrl(controlUrl) + '/connector/disconnect', { method: 'POST', headers: { Authorization: `Bearer ${credential}` }, signal: AbortSignal.timeout(1500) }); return { revocationPending: !response.ok && response.status !== 401 }; }
  catch { return { revocationPending: true }; }
}
export function createComputerConnector({ controlUrl, credential, localUrl, bridgeKey, onStatus }: {
  controlUrl: string; credential: string; localUrl: string; bridgeKey: string; onStatus?: (status: ConnectorStatus) => void;
}) {
  const origin = validateControlUrl(controlUrl), local = new URL(localUrl);
  if (local.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(local.hostname) || local.username || local.password || local.pathname !== '/') throw new Error('Computer connector target must be an HTTP loopback origin');
  const controller = new AbortController(), active = new Set<ClientRequest>();
  let current: ConnectorStatus = { state: 'connecting' };
  const status = (next: ConnectorStatus) => { current = next; onStatus?.(next); };
  const headers = { Authorization: `Bearer ${credential}` };
  async function control(path: string, options: RequestInit = {}) {
    const response = await fetch(origin + path, { ...options, headers: { ...headers, ...options.headers }, signal: controller.signal });
    if (!response.ok) throw new Error(`Connection service returned ${response.status}`);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await boundedBody(response.body, 1024 * 1024)));
  }
  const request = (url: URL, options: Parameters<typeof httpRequest>[1]) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { ...options, signal: controller.signal });
    active.add(req); req.on('close', () => active.delete(req)); return req;
  };
  function relay(job: RelayRequest) {
    // A remote control server must never redirect the bridge credential away from loopback.
    if (job.path !== '/api/remote/transport' || job.method !== 'POST' || typeof job.clientId !== 'string' || !/^[a-zA-Z0-9_-]{32,64}$/.test(job.clientId)) return;
    const localTarget = new URL(local.origin + job.path), requestTarget = new URL(origin + `/connector/requests/${encodeURIComponent(job.id)}/request`);
    let localResponse: IncomingMessage | undefined, downloadResponse: IncomingMessage | undefined, upload: ClientRequest | undefined;
    const stop = () => { outbound.destroy(); download.destroy(); downloadResponse?.destroy(); localResponse?.destroy(); upload?.destroy(); };
    const outbound = request(localTarget, { method: job.method, headers: { 'Content-Type': 'application/octet-stream', 'x-mandala-client-id': job.clientId, Origin: local.origin, 'x-mandala-bridge-key': bridgeKey, 'x-openmana-bridge-key': bridgeKey, 'x-mandala-owner-id': job.ownerId, 'x-openmana-owner-id': job.ownerId } });
    const download = request(requestTarget, { method: 'GET', headers });
    download.on('response', response => {
      downloadResponse = response;
      if (response.statusCode !== 200) return stop();
      response.on('error', stop); response.pipe(outbound);
    });
    download.on('error', stop);
    outbound.on('error', () => {
      download.destroy();
      if (!upload && !controller.signal.aborted) {
        const metadata = Buffer.from(JSON.stringify({ status: 502, headers: { 'content-type': 'application/json' } })).toString('base64url');
        const failed = request(new URL(origin + `/connector/requests/${encodeURIComponent(job.id)}/response`), { method: 'POST', headers: { ...headers, 'x-mandala-response': metadata, 'x-openmana-response': metadata } });
        failed.on('error', () => {}); failed.on('response', r => r.resume()); failed.end('{"error":"Local computer service unavailable"}');
      }
      localResponse?.destroy(); upload?.destroy();
    });
    outbound.on('response', response => {
      localResponse = response;
      const metadata = Buffer.from(JSON.stringify({ status: response.statusCode ?? 502, headers: response.headers })).toString('base64url');
      upload = request(new URL(origin + `/connector/requests/${encodeURIComponent(job.id)}/response`), { method: 'POST', headers: { ...headers, 'x-mandala-response': metadata, 'x-openmana-response': metadata } });
      upload.on('response', ack => { if (ack.statusCode !== 200) stop(); ack.resume(); }); upload.on('error', stop); response.on('error', stop); response.pipe(upload);
    });
    download.end();
  }
  async function run() {
    while (!controller.signal.aborted) {
      try { const job: RelayRequest | null = await control('/connector/poll'); status({ state: 'connected' }); if (job) relay(job); }
      catch { if (controller.signal.aborted) break; status({ state: 'offline', error: 'Unable to connect to account service' }); await new Promise<void>(resolve => { const timer = setTimeout(done, 1000); function done() { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); } controller.signal.addEventListener('abort', done, { once: true }); }); }
    }
  }
  void run();
  return {
    status: () => current,
    async rename(name: string) {
      await control('/connector/name', { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    },
    close() { controller.abort(); for (const req of active) req.destroy(); status({ state: 'closed' }); },
    async disconnect() {
      controller.abort(); for (const req of active) req.destroy(); status({ state: 'closed' });
      return revokeComputer(origin, credential);
    },
    async listAccess(): Promise<DeviceAccess[]> { return control('/connector/access'); },
    async setAccess(clientId: string, decision: 'approved' | 'denied' | 'revoked') { await control('/connector/access', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId, status: decision }) }); },
  };
}
