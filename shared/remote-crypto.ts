import nacl from 'tweetnacl';

export type RemoteKey = { publicKey: string; secretKey: string };
export const MAX_REMOTE_BODY = 20 * 1024 * 1024;
export const MAX_REMOTE_WIRE = 40 * 1024 * 1024;
export const MAX_REMOTE_RECORD = 128 * 1024;
export const REMOTE_CHUNK = 48 * 1024;
export const remoteHeaders = ['content-type', 'accept', 'last-event-id', 'range'];
export const responseHeaders = ['content-type', 'cache-control', 'content-disposition', 'etag', 'accept-ranges', 'content-range'];
export function toBase64(bytes: Uint8Array): string {
  let value = ''; for (let offset = 0; offset < bytes.length; offset += 8192) value += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(value);
}
export function fromBase64(value: string): Uint8Array {
  if (typeof value !== 'string' || (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))) throw new Error('Invalid base64');
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}
export function remotePublicKey(value: string): Uint8Array {
  if (typeof value !== 'string' || value.length !== 44) throw new Error('Invalid peer key');
  const key = fromBase64(value); if (key.length !== nacl.box.publicKeyLength) throw new Error('Invalid peer key'); return key;
}
export function newRemoteKey(): RemoteKey { const key = nacl.box.keyPair(); return { publicKey: toBase64(key.publicKey), secretKey: toBase64(key.secretKey) }; }
export function remoteKeyFingerprint(publicKey: string): string {
  return Array.from(nacl.hash(remotePublicKey(publicKey)).slice(0, 16), b => b.toString(16).padStart(2, '0')).join('').match(/.{4}/g)!.join('-');
}
export function sealRemote(value: unknown, peer: string, secret: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value)); if (bytes.length > MAX_REMOTE_WIRE / 4 * 3 - 256) throw new Error('Remote frame too large');
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  return JSON.stringify({ v: 1, nonce: toBase64(nonce), box: toBase64(nacl.box(bytes, nonce, remotePublicKey(peer), remotePublicKey(secret))) });
}
export function openRemote(wire: string, peer: string, secret: string, limit = MAX_REMOTE_WIRE): any {
  if (wire.length > limit) throw new Error('Remote frame too large');
  const envelope = JSON.parse(wire);
  if (envelope.v !== 1 || typeof envelope.nonce !== 'string' || envelope.nonce.length !== 32 || typeof envelope.box !== 'string') throw new Error('Invalid encrypted frame');
  const opened = nacl.box.open(fromBase64(envelope.box), fromBase64(envelope.nonce), remotePublicKey(peer), remotePublicKey(secret));
  if (!opened) throw new Error('Remote authentication failed');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(opened));
}
export class ReplayWindow {
  private ids = new Map<string, number>();
  constructor(private limit = 4096, saved: [string, number][] = []) {
    if (!Array.isArray(saved) || saved.length > limit || saved.some(row => !Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !/^[a-f0-9]{32}$/.test(row[0]) || !Number.isSafeInteger(row[1]))) throw new Error('Invalid replay ledger');
    this.ids = new Map(saved);
  }
  snapshot() { return [...this.ids]; }
  accept(id: string, timestamp: number) {
    const now = Date.now();
    for (const [key, expiry] of this.ids) if (expiry < now) this.ids.delete(key);
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id) || !Number.isSafeInteger(timestamp) || timestamp < now - 120_000 || timestamp > now + 30_000 || this.ids.has(id) || this.ids.size >= this.limit) throw new Error('Expired, replayed or excessive remote request');
    this.ids.set(id, timestamp + 120_000);
  }
}
export function remoteRequestId() { return Array.from(nacl.randomBytes(16), b => b.toString(16).padStart(2, '0')).join(''); }
export async function boundedBody(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > limit) throw new Error('Remote body too large'); chunks.push(value); } }
  catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result;
}
