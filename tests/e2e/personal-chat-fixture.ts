import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from '../../server/store';

const histories = new Set<string>();
const streams = new Map<string, Set<ServerResponse>>();
export async function personalChatFixture(req: IncomingMessage, res: ServerResponse, store: Store) {
  const seed = req.url?.match(/^\/__test__\/personal-history\/([^/]+)$/);
  if (req.method === 'POST' && seed) {
    const id = seed[1]; histories.add(id);
    for (let index = 0; index < 80; index++) {
      store.appendEvent(id, 'user', { text: `History request ${index}` });
      store.appendEvent(id, 'text', { text: `History reply ${index}: ${'Synthetic history paragraph. '.repeat(10)}`, itemId: `reply-${index}` });
      store.appendEvent(id, 'status', { status: 'idle' });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return true;
  }
  const live = req.url?.match(/^\/__test__\/personal-live\/([^/]+)$/);
  if (req.method === 'POST' && live) {
    const event = store.appendEvent(live[1], 'text', { text: 'Live synthetic update', itemId: 'live-update' });
    for (const stream of streams.get(live[1]) ?? []) stream.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return true;
  }
  const match = req.url?.match(/^\/api\/conversations\/([^/]+)\/events$/);
  if (!match || !histories.has(match[1])) return false;
  const id = match[1], events = store.listEvents(id, 0);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  let closed = false; const clients = streams.get(id) ?? new Set<ServerResponse>(); streams.set(id, clients); clients.add(res);
  res.on('close', () => { closed = true; clients.delete(res); });
  for (let start = 0; start < events.length && !closed; start += 30) {
    for (const event of events.slice(start, start + 30)) res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  if (!closed) res.write(`event: history-ready\ndata: ${JSON.stringify({ cursor: events.at(-1)?.id ?? 0 })}\n\n`);
  return true;
}
