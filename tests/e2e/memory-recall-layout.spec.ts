import { test, expect } from './helpers/execution-fixture';

for (const language of ['zh-CN', 'en']) for (const theme of ['light', 'dark']) {
  test(`recalled entries keep labels and wrapped content aligned ${language} ${theme}`, async ({ page, request }, testInfo) => {
    const response = await request.post('/api/conversations', { data: { projectId: '', agentId: '', cli: 'codex', workspaceId: null } });
    expect(response.ok()).toBe(true);
    const chat = await response.json();
    const entries = [
      { kind: 'memory', title: '在阅读项目中，先核对资料来源、适用范围和日期，再整理结论。'.repeat(5) },
      { kind: 'memory', title: '使用中文回答。' },
      { kind: 'memory', title: 'Keep the source, date range and supporting evidence together when summarizing a long reading note. '.repeat(4) },
      { kind: 'memory', title: 'reference_' + 'abcdefghij'.repeat(30) },
      { kind: 'document', title: '阅读资料与来源说明 / Reading sources', assetId: 'asset-' + 'a'.repeat(80), versionId: 'version-' + 'b'.repeat(80) },
    ];
    const events = [
      { kind: 'user', data: { text: '整理阅读资料。' } },
      { kind: 'metadata', data: { memoryRecall: 'layout-fixture', status: 'completed', count: entries.length, entries } },
      { kind: 'text', data: { text: '已整理阅读资料。' } },
      { kind: 'status', data: { status: 'idle' } },
    ].map((event, index) => ({ ...event, id: index + 1, conversationId: chat.id, createdAt: '2026-11-16T00:00:00.000Z' }));
    await page.route(`**/api/conversations/${chat.id}/events`, route => route.fulfill({
      contentType: 'text/event-stream', body: events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'event: history-ready\ndata: {}\n\n',
    }));
    await page.addInitScript(({ language, theme }) => {
      localStorage.setItem('mana-language', language);
      localStorage.setItem('mana-theme', theme);
    }, { language, theme });
    await page.goto('/?conversation=' + chat.id);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.getByRole('button', { name: 'Hooks', exact: true }).click();
    const card = page.locator('.turn-hooks .operation-card');
    await card.locator(':scope > summary').click();
    await expect(card.locator('.recalled-records li')).toHaveCount(entries.length);
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await card.locator(':scope > summary').scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`recall-${width}.png`), fullPage: true });
      const rows = await card.locator('.recalled-records li').evaluateAll(elements => elements.map(row => {
        const label = row.querySelector('small')!, title = row.querySelector('span')!, code = row.querySelector('code');
        const range = document.createRange(); range.selectNodeContents(label);
        return { labelLines: range.getClientRects().length, titleX: title.getBoundingClientRect().x,
          titleBottom: title.getBoundingClientRect().bottom, codeX: code?.getBoundingClientRect().x, codeTop: code?.getBoundingClientRect().top,
          overflow: row.scrollWidth - row.clientWidth };
      }));
      for (const row of rows) {
        expect(row.labelLines).toBe(1);
        expect(Math.abs(row.titleX - rows[0].titleX)).toBeLessThanOrEqual(1);
        expect(row.overflow).toBeLessThanOrEqual(1);
        if (row.codeX !== undefined) {
          expect(Math.abs(row.codeX - row.titleX)).toBeLessThanOrEqual(1);
          expect(row.codeTop).toBeGreaterThanOrEqual(row.titleBottom);
        }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await card.locator('.recalled-records li').last().scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`recall-${width}-bottom.png`), fullPage: true });
    }
  });
}
