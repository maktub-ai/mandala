import { test, expect, type APIRequestContext, type Page, type Request } from '@playwright/test';
import type { Conversation } from '../../shared/types';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };

async function createChat(request: APIRequestContext, title: string) {
  const response = await request.post('/api/conversations', { data: { projectId: '', agentId: '', cli: 'codex', workspaceId: null } });
  expect(response.ok()).toBe(true);
  const chat = await response.json() as Conversation;
  expect((await request.patch('/api/conversations/' + chat.id, { data: { title } })).ok()).toBe(true);
  return { ...chat, title };
}

// Control event ordering without reconnect timers or native CLI work. Requests and UI use the real app.
async function controlledStream(page: Page) {
  await page.addInitScript(() => {
    const streams = new Map<string, any>();
    let nextId = 1;
    (window as any).__feedbackEmit = (id: string, kind: string, data: unknown) => {
      streams.get(id)?.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ id: nextId++, conversationId: id, kind, data, createdAt: new Date().toISOString() }) }));
    };
    (window as any).EventSource = class extends EventTarget {
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      constructor(url: string) {
        super();
        streams.set(url.split('/')[3], this);
        setTimeout(() => { this.onopen?.(new Event('open')); this.dispatchEvent(new MessageEvent('history-ready', { data: '{}' })); }, 0);
      }
      close() { for (const [id, stream] of streams) if (stream === this) streams.delete(id); }
    };
  });
}

async function emit(page: Page, chat: Conversation, kind: string, data: unknown) {
  await page.evaluate(({ id, kind, data }) => (window as any).__feedbackEmit(id, kind, data), { id: chat.id, kind, data });
}

async function ready(page: Page) {
  const composer = page.getByRole('textbox', { name: '消息', exact: true });
  await composer.fill('Readiness check');
  await expect(page.locator('.send-button')).toBeEnabled();
  await composer.clear();
}

test('initial history and stream open share bounded snapshot work', async ({ page, request }) => {
  const chat = await createChat(request, 'Initial feedback snapshot');
  await controlledStream(page);
  let reads = 0;
  await page.route('**/api/conversations/' + chat.id, async route => {
    reads++; await delay(150);
    await route.fulfill({ json: { conversation: chat, approvals: [], executionId: null } });
  });
  await page.goto('/?conversation=' + chat.id);
  await ready(page);
  expect(reads).toBeLessThanOrEqual(2);
});

test('continuous metadata cannot starve approval or a slower queue readback', async ({ page, request }) => {
  const chat = await createChat(request, 'Busy feedback stream');
  await controlledStream(page);
  let waiting = false;
  const approval = { id: 'feedback-approval', method: 'item/commandExecution/requestApproval', params: { command: 'pwd' } };
  await page.route('**/api/conversations/' + chat.id, async route => {
    const snapshot = { conversation: { ...chat, status: waiting ? 'approval' : 'idle' }, approvals: waiting ? [approval] : [], executionId: waiting ? 'feedback-run' : null };
    if (waiting) await delay(350);
    await route.fulfill({ json: snapshot });
  });
  await page.route('**/api/conversations/' + chat.id + '/queue', async route => {
    const inputs = waiting ? [{ id: 'feedback-queued', conversationId: chat.id, text: 'Slow queue readback is visible', state: 'queued', commandKey: 'feedback-queued', createdAt: new Date().toISOString() }] : [];
    if (waiting) await delay(500);
    await route.fulfill({ json: inputs });
  });
  await page.goto('/?conversation=' + chat.id); await ready(page);
  waiting = true;
  await emit(page, chat, 'status', { status: 'approval' });
  await page.evaluate(id => { (window as any).__feedbackTimer = setInterval(() => (window as any).__feedbackEmit(id, 'metadata', { synthetic: true }), 80); }, chat.id);
  try {
    await expect(page.getByRole('button', { name: '允许本次', exact: true })).toBeVisible({ timeout: 2000 });
    await expect(page.getByText('Slow queue readback is visible', { exact: true })).toBeVisible({ timeout: 2000 });
  } finally { await page.evaluate(() => clearInterval((window as any).__feedbackTimer)); }
});

test('a held old snapshot neither blocks newer execution nor overwrites it on arrival', async ({ page, request }) => {
  const chat = await createChat(request, 'Out of order feedback');
  await controlledStream(page);
  const old = gate(), captured = gate();
  let heldRequest!: Request;
  let holdNext = false, running = false;
  await page.route('**/api/conversations/' + chat.id, async route => {
    const snapshot = { conversation: { ...chat, status: running ? 'running' : 'idle' }, approvals: [], executionId: running ? 'new-run' : null };
    if (holdNext) { holdNext = false; heldRequest = route.request(); captured.release(); await old.promise; await route.fulfill({ json: snapshot }); }
    else await route.fulfill({ json: snapshot });
  });
  await page.goto('/?conversation=' + chat.id); await ready(page);
  holdNext = true; await emit(page, chat, 'metadata', { synthetic: 'old snapshot' }); await captured.promise;
  running = true; await emit(page, chat, 'status', { status: 'running' });
  try {
    await expect(page.getByRole('button', { name: '停止执行', exact: true })).toBeEnabled();
    const oldResponse = page.waitForResponse(response => response.request() === heldRequest);
    old.release(); await (await oldResponse).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByTestId('chat-status')).toHaveText('执行中');
    await expect(page.getByRole('button', { name: '停止执行', exact: true })).toBeEnabled();
  } finally { old.release(); }
});

test('completing an old queued send keeps a newer conversation submission pending', async ({ page, request }) => {
  const first = await createChat(request, 'Queued send origin'), second = await createChat(request, 'New pending destination');
  await controlledStream(page);
  const heldFirst = gate(), enteredFirst = gate(), readbackFirst = gate(), heldSecond = gate(), enteredSecond = gate();
  let firstSubmitted = false;
  const input = { id: 'prior-input', conversationId: first.id, text: 'Previously queued request', state: 'queued', commandKey: 'prior-input', createdAt: new Date().toISOString() };
  await page.route('**/api/conversations/' + first.id + '/queue', async route => {
    await route.fulfill({ json: firstSubmitted ? [] : [input] });
    if (firstSubmitted) readbackFirst.release();
  });
  await page.route('**/api/conversations/' + first.id + '/queue/' + input.id, async route => { enteredFirst.release(); await heldFirst.promise; firstSubmitted = true; await route.fulfill({ json: { ok: true } }); });
  await page.route('**/api/conversations/' + second.id + '/queue', async route => {
    if (route.request().method() !== 'POST') { await route.fulfill({ json: [] }); return; }
    enteredSecond.release(); await heldSecond.promise;
    await route.fulfill({ json: { ...input, ...route.request().postDataJSON(), conversationId: second.id } });
  });
  await page.goto('/?conversation=' + first.id);
  await page.getByRole('button', { name: '继续发送', exact: true }).click(); await enteredFirst.promise;
  try {
    await page.getByRole('button', { name: second.title, exact: true }).click(); await ready(page);
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('The second send stays pending');
    await page.locator('.send-button').click(); await enteredSecond.promise;
    const readbackResponse = page.waitForResponse(response => response.url().endsWith('/conversations/' + first.id + '/queue') && response.request().method() === 'GET');
    heldFirst.release(); await readbackFirst.promise; await (await readbackResponse).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByTestId('chat-status')).toHaveText('启动中');
    await expect(page.locator('.send-button')).toBeDisabled();
  } finally { heldFirst.release(); heldSecond.release(); }
});

for (const mutation of ['cancel', 'send', 'append'] as const) {
  test('a pre-mutation queue response cannot undo ' + mutation, async ({ page, request }) => {
    const chat = await createChat(request, 'Queue mutation ' + mutation);
    await controlledStream(page);
    const oldRead = gate(), oldCaptured = gate(), freshRead = gate(), freshCaptured = gate();
    let heldRequest!: Request;
    const input = { id: 'mutation-input', conversationId: chat.id, text: 'Queue item for ' + mutation, state: 'queued', commandKey: 'mutation-input', createdAt: new Date().toISOString() };
    const queuedItem = page.locator('.queued-input').filter({ hasText: input.text });
    let mutated = false, holdNext = false, oldReleased = false;
    const inputs = () => (mutation === 'append' ? mutated : !mutated) ? [input] : [];
    await page.route('**/api/conversations/' + chat.id + '/queue', async route => {
      if (route.request().method() === 'POST') { mutated = true; await route.fulfill({ json: { ...input, ...route.request().postDataJSON() } }); return; }
      const value = inputs();
      if (holdNext) { holdNext = false; heldRequest = route.request(); oldCaptured.release(); await oldRead.promise; oldReleased = true; }
      else if (oldReleased) { freshCaptured.release(); await freshRead.promise; }
      await route.fulfill({ json: value });
    });
    await page.route('**/api/conversations/' + chat.id + '/queue/' + input.id, async route => {
      mutated = true; await route.fulfill({ json: { ok: true } });
    });
    await page.goto('/?conversation=' + chat.id); await ready(page);
    if (mutation !== 'append') await expect(queuedItem).toBeVisible();
    holdNext = true; await emit(page, chat, 'metadata', { synthetic: 'read before queue mutation' }); await oldCaptured.promise;
    try {
      if (mutation === 'append') {
        await page.getByRole('textbox', { name: '消息', exact: true }).fill(input.text);
        await page.locator('.send-button').click();
        await expect(queuedItem).toBeVisible();
      } else {
        await page.getByRole('button', { name: mutation === 'cancel' ? '取消排队' : '继续发送', exact: true }).click();
        await expect(queuedItem).toHaveCount(0);
      }
      await emit(page, chat, 'metadata', { synthetic: 'queue changed' });
      // Hold the catch-up response so it cannot hide a stale response overwriting the queue.
      await expect(page.locator('.send-button')).toBeDisabled();
      const oldResponse = page.waitForResponse(response => response.request() === heldRequest);
      oldRead.release(); await (await oldResponse).finished(); await freshCaptured.promise;
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(queuedItem).toHaveCount(mutation === 'append' ? 1 : 0);
    } finally { oldRead.release(); freshRead.release(); }
  });
}

test('a held queue read cannot block newer background queue state', async ({ page, request }) => {
  const chat = await createChat(request, 'Queue background progress');
  await controlledStream(page);
  const oldRead = gate(), captured = gate();
  let heldRequest!: Request;
  let holdNext = false, queued = false;
  const input = { id: 'background-input', conversationId: chat.id, text: 'New background input', state: 'queued', commandKey: 'background-input', createdAt: new Date().toISOString() };
  await page.route('**/api/conversations/' + chat.id + '/queue', async route => {
    const inputs = queued ? [input] : [];
    if (holdNext) { holdNext = false; heldRequest = route.request(); captured.release(); await oldRead.promise; await route.fulfill({ json: inputs }); }
    else await route.fulfill({ json: inputs });
  });
  await page.goto('/?conversation=' + chat.id); await ready(page);
  holdNext = true; await emit(page, chat, 'metadata', { synthetic: 'held background read' }); await captured.promise;
  try {
    queued = true; await emit(page, chat, 'metadata', { synthetic: 'background input arrived' });
    await expect(page.getByText(input.text, { exact: true })).toBeVisible({ timeout: 2000 });
    const oldResponse = page.waitForResponse(response => response.request() === heldRequest);
    oldRead.release(); await (await oldResponse).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByText(input.text, { exact: true })).toBeVisible();
  } finally { oldRead.release(); }
});
