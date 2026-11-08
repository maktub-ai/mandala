import { expect, test } from '@playwright/test';

// These workflows start after an explicit CLI choice; first-use coverage keeps empty preferences.
test.beforeEach(async ({ page }) => {
 await page.addInitScript(() => localStorage.setItem('mana-chat-preferences', JSON.stringify({projectId:'',agentId:'',cli:'codex',model:'',effort:'',onboardingCompleted:true})));
});

test('copies only the selected table with exact strings, blank cells and all columns', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem('mana-language', 'en');
    localStorage.setItem('mana-theme', 'dark');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as any).tableClipboard = text; } } });
  });
  const markdown = 'Before table\n\n| Name | Blank | Value | Final column |\n| --- | --- | --- | --- |\n| **alpha** | | 001.20 | last one |\n| `beta` | | 9007199254740993 | last two |\n\nBetween tables\n\n| Second | Empty |\n| --- | --- |\n| target | |\n\nAfter table';
  await page.goto('/?project=&agent=');
  const draft = page.getByLabel(/^(消息|Message)$/, { exact: true });
  await draft.fill(markdown);
  await page.getByRole('button', { name: /^(发送消息|Send message)$/, exact: true }).click();
  await expect(page.getByTestId('chat-status')).toHaveText(/^(就绪|Ready)$/);
  const tables = page.locator('.message.text .markdown-table');
  await expect(tables).toHaveCount(2);
  await draft.fill('Keep this unsent draft');
  expect(await tables.first().getByRole('button').evaluate(el => getComputedStyle(el).opacity)).toBe('0');
  const layout=await tables.first().evaluate(el=>({table:el.querySelector('table')!.getBoundingClientRect().top, wrapper:el.getBoundingClientRect().top}));
  expect(layout.table-layout.wrapper).toBeLessThan(2);
  await tables.first().hover();
  await tables.first().getByRole('button', { name: 'Copy table', exact: true }).click();
  await expect(tables.first().getByRole('button')).toHaveText('Copied');
  expect(await page.evaluate(() => (window as any).tableClipboard)).toBe('Name\tBlank\tValue\tFinal column\nalpha\t\t001.20\tlast one\nbeta\t\t9007199254740993\tlast two');
  await tables.nth(1).hover();
  await tables.nth(1).getByRole('button', { name: 'Copy table', exact: true }).click();
  expect(await page.evaluate(() => (window as any).tableClipboard)).toBe('Second\tEmpty\ntarget\t');
  await expect(draft).toHaveValue('Keep this unsent draft');
  await page.screenshot({ path: testInfo.outputPath('markdown-table-dark.png') });
  const conversationUrl = page.url();
  await page.goto('/settings/general');
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await page.goto(conversationUrl);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.setViewportSize({ width: 390, height: 844 });
  await tables.first().scrollIntoViewIfNeeded();
  expect(await tables.first().locator('.table-scroll').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await tables.first().locator('.table-scroll').evaluate(element => element.scrollLeft = element.scrollWidth);
  await tables.first().hover();
  await tables.first().getByRole('button', { name: 'Copy table', exact: true }).click();
  expect(await page.evaluate(() => (window as any).tableClipboard)).toBe('Name\tBlank\tValue\tFinal column\nalpha\t\t001.20\tlast one\nbeta\t\t9007199254740993\tlast two');
  await tables.first().evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
  await page.screenshot({ path: testInfo.outputPath('markdown-table-light-mobile.png') });
  const overflow = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, elements: Array.from(document.querySelectorAll('body *')).filter(element => element.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(element).position !== 'fixed').slice(0, 12).map(element => ({ tag: element.tagName, class: element.className, width: element.getBoundingClientRect().width, right: element.getBoundingClientRect().right })) }));
  expect(overflow.scrollWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.width);
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }); document.execCommand = () => false; });
  const button = tables.first().getByRole('button', { name: 'Copy table', exact: true });
  await button.click();
  await expect(button).toHaveText('Copy failed');
  await expect(button).toBeFocused();
});

test('opens an inline delivered file through the scoped conversation preview', async ({ page }) => {
  let requested = '';
  let batches=0;
  await page.route('**/api/conversations/*/local-files/resolve', route => { batches++; return route.fulfill({json:{hrefs:['outputs/report one.md']}}); });
  await page.addInitScript(() => localStorage.setItem('mana-language', 'en'));
  await page.route('**/api/conversations/*/local-file', async route => {
    requested = route.request().postDataJSON().href;
    await route.fulfill({ json: { name: 'report one.md', path: '/synthetic/outputs/report one.md', text: '# Delivered content\n\nSynthetic preview.' } });
  });
  await page.goto('/?project=&agent=');
  await page.getByLabel(/^(消息|Message)$/, { exact: true }).fill('Delivered `outputs/report one.md`. Unknown `/tmp/missing.md`. Cloud `.../data/BILLING_PERIOD=YYYY-MM/*.parquet`. [External](https://example.com/report.md)\n\n`cat outputs/command.md`\n\n```text\noutputs/example.md\n```');
  await page.getByRole('button', { name: /^(发送消息|Send message)$/, exact: true }).click();
  await expect(page.getByTestId('chat-status')).toHaveText(/^(就绪|Ready)$/);
  const message = page.locator('.message.text');
  await expect(message.getByRole('link', { name: 'outputs/report one.md', exact: true })).toHaveCount(1);
  await expect(message.locator('[data-source=local]')).toHaveCount(1);
  await expect(message.getByRole('link',{name:'External',exact:true})).toHaveAttribute('href','https://example.com/report.md');
  expect(batches).toBeLessThanOrEqual(2);
  await message.getByRole('link', { name: 'outputs/report one.md', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Delivered content', exact: true })).toBeVisible();
  expect(decodeURIComponent(requested)).toBe('outputs/report one.md');
});

test('verifies real scoped files in one transcript batch and fails closed across conversations', async ({ page, request }, testInfo) => {
  const { mkdtemp, writeFile, rm, realpath } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'mana-delivery-e2e-')));
  try {
    await writeFile(join(cwd, 'report one.md'), '# Verified report\n\nActual synthetic file.');
    await writeFile(join(cwd, '.env'), 'synthetic secret');
    await writeFile(join(cwd, '报告 one.md'), '# Mixed space report');
    await writeFile(join(cwd, '报告%20one.md'), '# Literal encoded report');
    await writeFile(join(cwd, '报告%one.md'), '# Literal percent report');
    const created = await request.post('/api/conversations', { data: { cwd, projectId: '', agentId: '' } });
    expect(created.ok()).toBe(true);
    const chat = await created.json();
    expect(chat.cwd).toBe(cwd);
    const markdown = 'Delivered `./report one.md`. Missing `./missing.md`. Secret `./.env`. Cloud `.../data/BILLING_PERIOD=YYYY-MM/*.parquet`.\n\n[Website](https://example.com/report.md) [Mixed](<./报告%20one.md>) [Literal](<./报告%2520one.md>) [Percent](<./报告%25one.md>)';
    expect((await request.post(`/api/conversations/${chat.id}/messages`, { data: { text: markdown } })).ok()).toBe(true);
    let batchCount = 0;
    const resolutions: {status:number;request:string|null;response:string}[] = [];
    page.on('response', response => { if (response.url().endsWith('/local-files/resolve')) {
      const entry = { status: response.status(), request: response.request().postData(), response: '' }; resolutions.push(entry);
      void response.text().then(body => { entry.response = body; }).catch(error => { entry.response = String(error); });
    } });
    page.on('request', req => { if (req.url().endsWith('/local-files/resolve')) batchCount++; });
    await page.goto(`/?conversation=${chat.id}&project=&agent=`);
    const message = page.locator('.message.text');
    try { await expect(message.getByRole('link', { name: './report one.md', exact: true })).toBeVisible(); } finally { await writeFile(testInfo.outputPath('local-file-resolution.json'), JSON.stringify({cwd,chat,resolutions},null,2)); }
    await expect(message.locator('[data-source=local]')).toHaveCount(4);
    await expect(message.getByRole('link', { name: 'Website', exact: true })).toHaveAttribute('href', 'https://example.com/report.md');
    await message.getByRole('link', { name: './report one.md', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Verified report', exact: true })).toBeVisible();
    await message.getByRole('link', {name:'Mixed',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Mixed space report',exact:true})).toBeVisible();
    await message.getByRole('link', {name:'Literal',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Literal encoded report',exact:true})).toBeVisible();
    await message.getByRole('link', {name:'Percent',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Literal percent report',exact:true})).toBeVisible();
    expect(batchCount).toBeLessThanOrEqual(2);
    expect(resolutions.map(result=>result.status)).toEqual(batchCount===1?[200]:[409,200]);
    await page.screenshot({ path: testInfo.outputPath('verified-files-real-synthetic.png') });
    const other = await (await request.post('/api/conversations', { data: { cwd, projectId: '', agentId: '' } })).json();
    const result = await request.post(`/api/conversations/${other.id}/local-files/resolve`, { data: { hrefs: ['./report one.md'] } });
    expect(await result.json()).toEqual({ hrefs: [] });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test.describe('touch table affordance', () => {
 test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
 test('keeps copy discoverable without hover', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('mana-language', 'en'));
  await page.goto('/?project=&agent=');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Touch table\n\n| Name | Value |\n| --- | --- |\n| Touch | 001.20 |');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const copy = page.locator('.message.text').getByRole('button', { name: 'Copy table', exact: true });
  await expect(copy).toBeVisible();
  const state = await copy.evaluate(el => ({ opacity: getComputedStyle(el).opacity, height: el.getBoundingClientRect().height, width: el.getBoundingClientRect().width, hover: matchMedia('(hover: none)').matches }));
  expect(state).toMatchObject({ opacity: '1', hover: true });
  expect(state.height).toBeGreaterThanOrEqual(44);
  expect(state.width).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: testInfo.outputPath('table-touch-narrow.png') });
 });
});
