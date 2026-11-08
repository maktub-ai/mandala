import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ownedPrivatePath } from '../cli/private-path.mjs';

// Local launcher credentials never enter the renderer or an unauthenticated HTTP response.
export type ServiceRecord = { pid: number; origin: string; secret: string; setupToken: string };
export const runtimeRecordPath = (home: string) => join(home, '.desktop-runtime.json');
export function readServiceRecord(home: string): ServiceRecord | undefined {
  const path = runtimeRecordPath(home);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isFile() || !ownedPrivatePath(path, stat, 4096)) {
    // The runtime can unlink its record while the Windows ACL check is running.
    if (!lstatSync(path, { throwIfNoEntry: false })) return;
    throw new Error('Desktop runtime discovery file is not private.');
  }
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !lstatSync(path, { throwIfNoEntry: false })) return;
    throw error;
  }
  const value = JSON.parse(contents) as ServiceRecord;
  if (!Number.isInteger(value.pid) || value.pid < 1 || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(value.origin) || Number(new URL(value.origin).port) > 65535 || !/^[a-f0-9]{64}$/.test(value.secret) || !/^[a-zA-Z0-9_-]{43}$/.test(value.setupToken)) throw new Error('Invalid desktop runtime discovery file.');
  return value;
}
export function serviceAlive(record: ServiceRecord): boolean {
  try { process.kill(record.pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
export function removeServiceRecord(home: string, record: ServiceRecord): void {
  if (readServiceRecord(home)?.secret === record.secret) unlinkSync(runtimeRecordPath(home));
}
export function claimServiceRecord(home: string, origin: string, setupToken: string): ServiceRecord {
  const previous = readServiceRecord(home);
  if (previous) {
    if (serviceAlive(previous)) throw new Error('Another desktop runtime is using this data directory.');
    removeServiceRecord(home, previous);
  }
  const record = { pid: process.pid, origin, secret: randomBytes(32).toString('hex'), setupToken };
  // Exclusive creation also arbitrates two launchers before either opens the Store.
  writeFileSync(runtimeRecordPath(home), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  return record;
}
export const serviceProof = (record: ServiceRecord, value: string) => createHmac('sha256', record.secret).update(value).digest('hex');
function matches(a: string, b: string): boolean {
  return /^[a-f0-9]{64}$/.test(a) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
export const serviceControlPath = '/__mandala_runtime';
export function handleServiceControl(record: ServiceRecord, req: IncomingMessage, res: ServerResponse, stop: () => void): boolean {
  if (req.url !== serviceControlPath) return false;
  const action = req.method === 'GET' ? 'probe' : req.method === 'POST' ? 'stop' : '';
  const nonce = String(req.headers['x-mandala-nonce'] ?? '');
  const proof = String(req.headers['x-mandala-proof'] ?? '');
  const timestamp = Number(nonce.split(':')[0]);
  if (!action || req.headers.origin || req.headers.host !== new URL(record.origin).host || !/^\d{13}:[a-f0-9]{64}$/.test(nonce) || Math.abs(Date.now() - timestamp) > 30000 || !matches(proof, serviceProof(record, `${action}:${nonce}`))) {
    res.writeHead(403); res.end(); return true;
  }
  res.writeHead(200, { 'x-mandala-proof': serviceProof(record, `reply:${action}:${nonce}`), 'Cache-Control': 'no-store' }); res.end();
  if (action === 'stop') setImmediate(stop);
  return true;
}
export class ServiceStartingError extends Error {}
export async function controlService(record: ServiceRecord, action: 'probe' | 'stop'): Promise<void> {
  const nonce = `${Date.now()}:${randomBytes(32).toString('hex')}`;
  const response = await fetch(record.origin + serviceControlPath, { method: action === 'probe' ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'x-mandala-nonce': nonce, 'x-mandala-proof': serviceProof(record, `${action}:${nonce}`) } });
  await response.body?.cancel();
  if (response.status === 503) throw new ServiceStartingError('The background runtime is still starting.');
  if (!response.ok || !matches(response.headers.get('x-mandala-proof') ?? '', serviceProof(record, `reply:${action}:${nonce}`))) throw new Error('Could not verify the existing desktop runtime. No service was taken over.');
}
