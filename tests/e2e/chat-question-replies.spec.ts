import { test, expect } from './helpers/execution-fixture';

for (const main of [false, true]) {
  test('submitted choice and ordinary text in ' + (main ? 'Mandala' : 'regular chat'), async ({ page, request, context, executionDirectory }, testInfo) => {
    const chat = main
      ? (await (await request.get('/api/mandala')).json()).conversation
      : await (await request.post('/api/conversations', { data: { cwd: executionDirectory, cli: 'codex' } })).json();
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(main ? '/mandala' : '/?conversation=' + chat.id);
    const prompt = '请确认使用的 Codex 界面。';
    await page.getByRole('textbox', { name: '消息', exact: true }).fill(prompt);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.getByRole('radio', { name: 'Codex 独立桌面 App' }).check();
    await page.getByRole('button', { name: '提交回答' }).click();

    const ordinary = page.locator('.message.user').filter({ hasText: prompt }).first();
    const reply = page.locator('.message.user').filter({ has: page.locator('.question-answers') });
    await expect(reply.locator('dt')).toHaveText('你说的是哪个 Codex 界面？');
    await expect(reply.locator('dd')).toHaveText('Codex 独立桌面 App');
    await expect(page.getByText('明白，我们讨论的是Codex 独立桌面 App。', { exact: true })).toBeVisible();
    await page.reload();
    await expect(ordinary.locator('.message-text')).toHaveText(prompt);
    await expect(ordinary.locator('dl')).toHaveCount(0);
    await expect(reply.locator('dd')).toBeVisible();
    await expect(reply).not.toContainText('questionItemId');
    for (const [width, theme] of [[1440, 'dark'], [390, 'light']] as const) {
      await page.evaluate(value => localStorage.setItem('mana-theme', value), theme);
      await page.setViewportSize({ width, height: 850 });
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await reply.scrollIntoViewIfNeeded();
      const box = await reply.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      await page.screenshot({ path: testInfo.outputPath(theme + '-chat.png') });
      await reply.locator('.message-content').screenshot({ path: testInfo.outputPath(theme + '-reply.png') });
    }
    await reply.hover();
    await reply.getByRole('button', { name: '复制消息', exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('你说的是哪个 Codex 界面？\nCodex 独立桌面 App');
    expect(errors).toEqual([]);
  });
}
