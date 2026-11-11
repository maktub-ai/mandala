import { afterEach, expect, test, vi } from 'vitest';
import { api, requestJson } from '../src/api';
afterEach(() => vi.unstubAllGlobals());

test('API errors retain status for JSON, non-JSON and null error bodies', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('{"error":"revision_conflict"}', { status: 409 }))
    .mockResolvedValueOnce(new Response('<h1>Unavailable</h1>', { status: 503 }))
    .mockResolvedValueOnce(new Response('null', { status: 400 })));
  await expect(api('/test')).rejects.toMatchObject({ message: 'revision_conflict', status: 409 });
  await expect(api('/test')).rejects.toMatchObject({ message: 'HTTP 503', status: 503 });
  await expect(api('/test')).rejects.toMatchObject({ message: 'HTTP 400', status: 400 });
});

test('API cancellation signal reaches the request without changing JSON payloads', async () => {
  const controller = new AbortController(), fetcher = vi.fn().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetcher);
  await api('/cancel', 'POST', { text: '中文🙂' }, controller.signal);
  expect(fetcher).toHaveBeenCalledWith('/api/cancel', expect.objectContaining({ method: 'POST', signal: controller.signal, body: '{"text":"中文🙂"}' }));
});

test('shared requests retain mutation headers, signal and payload', async () => {
  const controller = new AbortController(), headers = { 'Idempotency-Key': 'synthetic-mutation', 'X-CSRF-Token': 'synthetic-csrf' };
  const fetcher = vi.fn().mockResolvedValue(new Response('{"id":"saved"}'));
  vi.stubGlobal('fetch', fetcher);
  await expect(requestJson('/api/v2/assets/id', { method: 'POST', headers, signal: controller.signal, body: '{"revision":2}' })).resolves.toEqual({ id: 'saved' });
  expect(fetcher).toHaveBeenCalledWith('/api/v2/assets/id', { method: 'POST', headers, signal: controller.signal, body: '{"revision":2}' });
});
test('aborted request keeps its original cancellation error', async () => {
  const error = new DOMException('cancelled', 'AbortError');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));
  await expect(api('/cancel')).rejects.toBe(error);
});

test('opt-in request timeout bounds a stalled response body and preserves caller cancellation', async () => {
  vi.useFakeTimers();
  const stalled = new ReadableStream();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stalled)));
  const timed = requestJson('/slow', {}, 50);
  const rejection = expect(timed).rejects.toMatchObject({ message: 'Request timed out. Check the result before trying again.' });
  await vi.advanceTimersByTimeAsync(51); await rejection;
  const controller = new AbortController();
  vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)))));
  const cancelled = requestJson('/cancel', {signal:controller.signal}, 50), reason=new DOMException('left page','AbortError');
  const cancelledCheck=expect(cancelled).rejects.toBe(reason);controller.abort(reason);await cancelledCheck;
  vi.useRealTimers();
});

test('concurrent panel lists share work but renew after completion and cancel independently',async()=>{
 let finish!:(response:Response)=>void;
 const fetcher=vi.fn((_url,options)=>new Promise<Response>((resolve,reject)=>{finish=resolve;options.signal.addEventListener('abort',()=>reject(options.signal.reason));}));
 vi.stubGlobal('fetch',fetcher);
 const a=new AbortController(),b=new AbortController();
 const first=api('/v2/tasks','GET',undefined,a.signal),second=api('/v2/tasks','GET',undefined,b.signal);
 expect(fetcher).toHaveBeenCalledTimes(1);
 const cancelled=expect(first).rejects.toMatchObject({name:'AbortError'});a.abort();await cancelled;
 expect(fetcher.mock.calls[0][1].signal.aborted).toBe(false);
 finish(new Response('[{"id":"fresh"}]'));await expect(second).resolves.toEqual([{id:'fresh'}]);
 const next=api('/v2/tasks');expect(fetcher).toHaveBeenCalledTimes(2);finish(new Response('[]'));await expect(next).resolves.toEqual([]);
});

test('abandoning all list readers aborts their fetch and the next reader starts fresh',async()=>{
 const fetcher=vi.fn((_url,options)=>new Promise<Response>((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason))));vi.stubGlobal('fetch',fetcher);
 const a=new AbortController(),first=api('/conversation-progress','GET',undefined,a.signal);
 const cancelled=expect(first).rejects.toMatchObject({name:'AbortError'});a.abort();await cancelled;
 expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
 const b=new AbortController(),next=api('/conversation-progress','GET',undefined,b.signal);
 expect(fetcher).toHaveBeenCalledTimes(2);const again=expect(next).rejects.toMatchObject({name:'AbortError'});b.abort();await again;
});
