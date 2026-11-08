import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { once } from 'node:events';
import { fromBase64, MAX_REMOTE_BODY, MAX_REMOTE_RECORD, MAX_REMOTE_WIRE, openRemote, REMOTE_CHUNK, remoteHeaders, ReplayWindow, responseHeaders, sealRemote, toBase64, type RemoteKey } from '../shared/remote-crypto';
import { remoteRequestAllowed } from './remote-policy';

export type RemoteRequest = { method: string; path: string; headers: Record<string, string>; body: Uint8Array };
export function createRemoteTransport(options: {
  identity: RemoteKey;
  replayFile?: string;
  peer(req: IncomingMessage): string | undefined;
  dispatch(req: IncomingMessage, inner: RemoteRequest, signal: AbortSignal): Promise<Response>;
}) {
  const replay = new ReplayWindow(4096, options.replayFile && existsSync(options.replayFile) ? JSON.parse(readFileSync(options.replayFile, 'utf8')) : []); let active = 0;
  return async (req: IncomingMessage, res: ServerResponse) => {
    const peer = options.peer(req);
    if (!peer || req.method !== 'POST') { res.writeHead(403); res.end(); return; }
    if (active >= 32) { res.writeHead(429); res.end(); return; }
    active++;
    const controller = new AbortController();
    const stop = () => controller.abort();
    res.on('close', stop);
    const timer = setInterval(() => { if (options.peer(req) !== peer) { controller.abort(); res.destroy(); } }, 200); timer.unref();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) { size += chunk.length; if (size > MAX_REMOTE_WIRE) throw new Error('Remote request too large'); chunks.push(chunk); }
      const value = openRemote(Buffer.concat(chunks).toString('utf8'), peer, options.identity.secretKey);
      replay.accept(value.id, value.timestamp);
      if (options.replayFile) { writeFileSync(options.replayFile + '.tmp', JSON.stringify(replay.snapshot()), { mode: 0o600 }); renameSync(options.replayFile + '.tmp', options.replayFile); }
      if (typeof value.method !== 'string' || typeof value.path !== 'string' || value.path.length > 4096 || !value.path.startsWith('/api/') || /[\\#\r\n]/.test(value.path) || typeof value.body !== 'string' || value.body.length > Math.ceil(MAX_REMOTE_BODY / 3) * 4) throw new Error('Invalid remote request');
      const body = fromBase64(value.body); if (body.length > MAX_REMOTE_BODY) throw new Error('Remote request too large');
      const headers: Record<string, string> = {};
      for (const key of remoteHeaders) if (typeof value.headers?.[key] === 'string') { if (value.headers[key].length > 8192) throw new Error('Remote header too large'); headers[key] = value.headers[key]; }
      let jsonBody: unknown;
      if (headers['content-type']?.startsWith('application/json')) jsonBody = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
      let response: Response;
      if (!remoteRequestAllowed(value.method, value.path, jsonBody)) response = Response.json({ error: 'Remote operation forbidden' }, { status: 403 });
      else {
        if (options.peer(req) !== peer || controller.signal.aborted) throw new Error('Remote access revoked');
        response = await options.dispatch(req, { method: value.method, path: value.path, headers, body }, controller.signal);
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
      let seq = 0;
      async function send(record: Record<string, unknown>) {
        if (controller.signal.aborted || options.peer(req) !== peer) throw new Error('Remote access revoked');
        const frame = sealRemote({ ...record, id: value.id, seq: seq++ }, peer!, options.identity.secretKey);
        if (frame.length > MAX_REMOTE_RECORD) throw new Error('Remote record too large');
        if (!res.write(frame + '\n')) await once(res, 'drain', { signal: controller.signal });
      }
      await send({ type: 'headers', status: response.status, headers: Object.fromEntries(responseHeaders.filter(k => response.headers.has(k)).map(k => [k, response.headers.get(k)!])) });
      reader = response.body?.getReader();
      if (reader) for (;;) {
        const { done, value: bytes } = await reader.read(); if (done) break;
        for (let i = 0; i < bytes.length; i += REMOTE_CHUNK) await send({ type: 'data', body: toBase64(bytes.subarray(i, i + REMOTE_CHUNK)) });
      }
      await send({ type: 'end' }); res.end();
    } catch {
      if (res.headersSent) res.destroy(); else { res.writeHead(403, { 'Cache-Control': 'no-store' }); res.end(); }
    } finally {
      active--; clearInterval(timer); res.off('close', stop); controller.abort(); await reader?.cancel().catch(() => {});
    }
  };
}
