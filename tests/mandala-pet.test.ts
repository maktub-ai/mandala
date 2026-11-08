import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createMarket } from '../server/market';
import { advancePet, parsePetPack, parsePetPreference, petDoneMs, petImage, petSleepMs, summarizePet, type PetSignals } from '../shared/mandala-pet';

const svg = (body: string) => 'data:image/svg+xml;base64,' + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${body}</svg>`).toString('base64');
const dot = svg('<circle cx="5" cy="5" r="4"/>');
const pack = (states: Record<string, string> = { idle: dot, working: dot, waiting: dot, error: dot }, extra = {}) => ({ format: 'mandala-pet', version: 1, name: 'Dot', states, ...extra });
const row = (id: string, state: string, executionStatus: string | null, withinWindow = true) => ({ id, title: id, state, executionStatus, withinWindow }) as PetSignals['rows'][number];
const task = (id: string, state: string, waitingReason: string | null = null) => ({ id, goal: id, state, waitingReason }) as PetSignals['tasks'][number];

it('lets work waiting for the person outrank errors, lost contact and running work', () => {
  const rows = [row('a', 'running', 'running'), row('b', 'attention', 'error'), row('c', 'attention', 'approval')];
  expect(summarizePet({ rows, tasks: [] })).toMatchObject({ state: 'waiting', waiting: 1, errors: 1, running: 1, first: { kind: 'conversation', id: 'c' } });
  expect(summarizePet({ rows: rows.slice(0, 2), tasks: [] })).toMatchObject({ state: 'error', first: { id: 'b' } });
  expect(summarizePet({ rows: [row('a', 'running', 'running'), row('d', 'attention', null)], tasks: [] }).state).toBe('unknown');
  expect(summarizePet({ rows: [row('a', 'running', 'running')], tasks: [] })).toMatchObject({ state: 'working', running: 1 });
  expect(summarizePet({ rows: [], tasks: [], mandalaStatus: 'running' }).state).toBe('thinking');
  expect(summarizePet({ rows: [], tasks: [], offline: true }).state).toBe('unknown');
  expect(summarizePet({ rows: [], tasks: [] }).state).toBe('idle');
});

it('reads tasks waiting for review or input, ignores stopped work and settled rows', () => {
  expect(summarizePet({ rows: [], tasks: [task('t', 'review')] })).toMatchObject({ state: 'waiting', first: { kind: 'task', id: 't' } });
  expect(summarizePet({ rows: [], tasks: [task('t', 'waiting', 'run_failed')] }).state).toBe('error');
  expect(summarizePet({ rows: [], tasks: [task('t', 'waiting', 'host_offline')] }).state).toBe('unknown');
  expect(summarizePet({ rows: [row('s', 'attention', 'interrupted')], tasks: [task('t', 'waiting', 'interrupted')] }).state).toBe('idle');
  expect(summarizePet({ rows: [row('old', 'recent', 'running', false), row('done', 'completed', 'error')], tasks: [] }).state).toBe('working');
  expect(summarizePet({ rows: [row('done', 'completed', 'error')], tasks: [] }).state).toBe('idle');
});

it('celebrates briefly when work finishes and sleeps after a long idle', () => {
  const idle = summarizePet({ rows: [], tasks: [] }), busy = summarizePet({ rows: [row('a', 'running', 'running')], tasks: [] });
  let t = advancePet({ state: 'idle', since: 0, busyAt: 0 }, busy, 1000);
  expect(t.state).toBe('working');
  t = advancePet(t, idle, 2000); expect(t.state).toBe('done');
  t = advancePet(t, idle, 2000 + petDoneMs - 1); expect(t.state).toBe('done');
  t = advancePet(t, idle, 2000 + petDoneMs + 1); expect(t.state).toBe('idle');
  t = advancePet(t, idle, 1000 + petSleepMs); expect(t.state).toBe('sleep');
  expect(advancePet(t, busy, 2000 + petSleepMs).state).toBe('working');
});

it('accepts packs with the four required states and falls back for the rest', () => {
  const parsed = parsePetPack(pack());
  expect(parsed).toMatchObject({ name: 'Dot', tint: false });
  expect(petImage(parsed, 'sleep')).toBe(dot);
  expect(parsePetPack(pack(undefined, { tint: true })).tint).toBe(true);
  expect(() => parsePetPack(pack({ idle: dot, working: dot, waiting: dot }))).toThrow('missing required pet state');
  expect(() => parsePetPack(pack({ idle: dot, working: dot, waiting: dot, error: dot, dance: dot }))).toThrow('invalid pet states');
  expect(() => parsePetPack(pack({ idle: 'https://example.com/a.png', working: dot, waiting: dot, error: dot }))).toThrow('invalid pet image');
  for (const body of ['<script>alert(1)</script>', '<a href="javascript:x"/>', '<rect onload="x"/>', '<image href="https://example.com/x.png"/>', '<foreignObject/>'])
    expect(() => parsePetPack(pack({ idle: svg(body), working: dot, waiting: dot, error: dot }))).toThrow('unsafe pet image');
  expect(() => parsePetPack({ ...pack(), extra: 1 })).toThrow('invalid pet package');
});

it('keeps only valid preferences', () => {
  expect(parsePetPreference('{"figure":"pet:local-abc","placement":"desktop"}')).toEqual({ figure: 'pet:local-abc', placement: 'desktop' });
  expect(parsePetPreference('{"figure":"theme:x","placement":"desktop"}')).toEqual({ figure: 'official', placement: 'panel' });
  expect(parsePetPreference(null)).toEqual({ figure: 'official', placement: 'panel' });
});

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'market-pet-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

it('imports a pet from a file beside Market installs, replaces the same file and rejects stale or invalid writes', async () => {
  const market = createMarket(home, async () => { throw Error('offline'); });
  const initial = await market.extensions.read(), raw = JSON.stringify(pack());
  const imported = await market.extensions.importPet({ raw, revision: initial.revision });
  const id = 'pet:local-' + createHash('sha256').update(raw).digest('hex').slice(0, 12);
  expect(imported.items).toEqual([expect.objectContaining({ catalogId: id, kind: 'pet', name: 'Dot', publisher: 'Local', sourceUrl: '' })]);
  expect(imported.items[0].data).toMatchObject({ format: 'mandala-pet', name: 'Dot' });
  expect((await market.extensions.importPet({ raw, revision: imported.revision })).items).toHaveLength(1);
  await expect(market.extensions.importPet({ raw, revision: initial.revision })).rejects.toThrow('configuration changed');
  const current = await market.extensions.read();
  await expect(market.extensions.importPet({ raw: JSON.stringify(pack({ idle: dot })), revision: current.revision })).rejects.toThrow();
  expect((await createMarket(home, async () => { throw Error('offline'); }).extensions.read()).items[0].catalogId).toBe(id);
  expect((await market.extensions.uninstall(id, current.revision)).items).toEqual([]);
});

it('discovers and installs pets from the pinned Market catalog', async () => {
  const body = JSON.stringify(pack()), digest = createHash('sha256').update(body).digest('hex'), sha = 'b'.repeat(40);
  const entry = { id: 'dot', name: 'Dot', description: 'A dot pet', version: '1.0.0', publisher: 'Example', minAppVersion: '0.1.1', package: { repository: 'example/pets', revision: sha, path: 'dot.json', sha256: digest } };
  const market = createMarket(home, async (url: string) => {
    if (url === 'https://raw.githubusercontent.com/maktub-ai/mandala-pets/main/catalog.json') return Response.json({ format: 'mandala-catalog', version: 1, kind: 'pet', items: [entry] });
    if (url === `https://raw.githubusercontent.com/example/pets/${sha}/dot.json`) return new Response(body);
    throw Error('Unexpected request: ' + url);
  });
  const found = await market.search('pet', 'dot');
  expect(found.items).toEqual([expect.objectContaining({ catalogId: 'pet:dot', kind: 'pet' })]);
  const detail = await market.detail('pet:dot');
  const installed = await market.extensions.install({ catalogId: 'pet:dot', version: detail.version, digest, revision: (await market.extensions.read()).revision });
  expect(installed.items[0]).toMatchObject({ kind: 'pet', data: { format: 'mandala-pet' } });
});
