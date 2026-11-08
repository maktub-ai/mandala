import { boundedBody, fromBase64, MAX_REMOTE_BODY, MAX_REMOTE_RECORD, newRemoteKey, openRemote, remoteHeaders, remotePublicKey, remoteRequestId, sealRemote, toBase64, type RemoteKey } from '../shared/remote-crypto';
export { remoteKeyFingerprint } from '../shared/remote-crypto';

let browserKey: Promise<RemoteKey> | undefined;
export function getRemoteBrowserKey(): Promise<RemoteKey> {
  return browserKey ??= new Promise<RemoteKey>((resolve, reject) => {
    const request = indexedDB.open('mandala-remote-identity', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('keys');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, transaction = db.transaction('keys', 'readwrite'), store = transaction.objectStore('keys'), read = store.get('identity');
      let key: RemoteKey;
      read.onsuccess = () => { key = read.result ?? newRemoteKey(); if (!read.result) store.put(key, 'identity'); };
      transaction.oncomplete = () => { db.close(); resolve(key); };
      transaction.onerror = () => { db.close(); reject(transaction.error); };
      transaction.onabort = () => { db.close(); reject(transaction.error ?? new Error('Browser key storage aborted')); };
    };
  }).catch(error => { browserKey = undefined; throw error; });
}

export function createRemoteFetch(hostPublicKey: string, keyPair: RemoteKey): (path: string, init?: RequestInit) => Promise<Response> {
  remotePublicKey(hostPublicKey); remotePublicKey(keyPair.publicKey); remotePublicKey(keyPair.secretKey);
  return async (path, init = {}) => {
    if (!path.startsWith('/api/') || path.startsWith('//') || /[\\#]/.test(path)) throw new Error('Invalid remote path');
    const request = new Request('http://remote.invalid' + path, init), id = remoteRequestId();
    const bytes = await boundedBody(request.body, MAX_REMOTE_BODY);
    const envelope = sealRemote({ id, timestamp: Date.now(), method: request.method, path, headers: Object.fromEntries(remoteHeaders.filter(k => request.headers.has(k)).map(k => [k, request.headers.get(k)!])), body: toBase64(bytes) }, hostPublicKey, keyPair.secretKey);
    const response = await fetch('/api/remote/transport', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: envelope, signal: init.signal, credentials: 'same-origin', redirect: 'error' });
    if (!response.ok || !response.body) throw new Error(`Remote transport unavailable (${response.status})`);
    const reader = response.body.getReader(); let buffer: Uint8Array = new Uint8Array(), offset = 0, sequence = 0, ended = false;
    async function record(): Promise<any> {
      const parts: Uint8Array[] = []; let length = 0;
      for (;;) {
        if (offset === buffer.length) {
          const next = await reader.read(); if (next.done) throw new Error('Remote response truncated');
          buffer = next.value; offset = 0;
        }
        const newline = buffer.indexOf(10, offset), end = newline < 0 ? buffer.length : newline;
        const part = buffer.subarray(offset, end); length += part.length;
        if (length > MAX_REMOTE_RECORD) throw new Error('Remote record too large');
        parts.push(part); offset = newline < 0 ? end : end + 1;
        if (newline >= 0) {
          const bytes = new Uint8Array(length); let position = 0;
          for (const piece of parts) { bytes.set(piece, position); position += piece.length; }
          const value = openRemote(new TextDecoder('utf-8', { fatal: true }).decode(bytes), hostPublicKey, keyPair.secretKey, MAX_REMOTE_RECORD);
          if (value.id !== id || value.seq !== sequence++) throw new Error('Remote response order or identity mismatch');
          return value;
        }
      }
    }
    try {
      const first = await record();
      if (first.type !== 'headers' || !Number.isInteger(first.status) || first.status < 200 || first.status > 599) throw new Error('Invalid remote response headers');
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await record();
            if (next.type === 'end') {
              ended = true;
              if (offset !== buffer.length || !(await reader.read()).done) throw new Error('Data after remote end');
              controller.close(); reader.releaseLock();
            } else if (next.type === 'data' && typeof next.body === 'string') controller.enqueue(fromBase64(next.body));
            else throw new Error('Invalid remote response record');
          } catch (error) { controller.error(error); await reader.cancel().catch(() => {}); }
        },
        async cancel() { if (!ended) await reader.cancel(); },
      }, { highWaterMark: 1 });
      // These statuses cannot have a native Response body; still validate the authenticated end.
      if ([204, 205, 304].includes(first.status) || request.method === 'HEAD') {
        const empty = stream.getReader(); while (!(await empty.read()).done) {};
        return new Response(null, { status: first.status, headers: first.headers });
      }
      return new Response(stream, { status: first.status, headers: first.headers });
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  };
}
