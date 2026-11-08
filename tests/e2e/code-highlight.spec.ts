import { test, expect } from "@playwright/test";

for (const mode of ['missing', 'denied'] as const) test(`copies commands when Clipboard API is ${mode}`, async ({page, context}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const source = '  git -C ~/Documents/中文 show d761561 --stat\n\n echo "done"';
  await send(page, '```bash\n' + source + '\n```');
  await page.evaluate(mode => {
    (window as any).readClipboard = navigator.clipboard.readText.bind(navigator.clipboard);
    Object.defineProperty(navigator, 'clipboard', {configurable:true, value:mode === 'missing' ? undefined : {writeText:async()=>{throw new DOMException('Denied', 'NotAllowedError');}}});
  }, mode);
  const draft = page.getByLabel(/^(消息|Message)$/, {exact:true});
  await draft.fill('Unsent draft');
  const button = page.locator('.message.text .code-block').first().getByRole('button', {name:'复制代码',exact:true});
  await button.click();
  await expect(button).toHaveText('已复制');
  await expect.poll(()=>page.evaluate(()=>(window as any).readClipboard())).toBe(source);
  await expect(draft).toHaveValue('Unsent draft');
  await expect(button).toBeFocused();
});

test('reports failure when neither clipboard method succeeds and restores focus',async({page})=>{
  await send(page,'```bash\ngit status\n```');
  await page.evaluate(()=>{
    Object.defineProperty(navigator,'clipboard',{value:undefined});
    document.execCommand=()=>false;
  });
  const fields=await page.locator('textarea').count();
  const button=page.locator('.message.text .code-block').first().getByRole('button',{name:'复制代码',exact:true});
  await button.click();await expect(button).toHaveText('复制失败');await expect(button).toBeFocused();
  await expect(page.locator('textarea')).toHaveCount(fields);
});

async function send(page: import("@playwright/test").Page, text: string) {
  await page.goto('/?project=&agent=');
  await page.getByLabel(/^(消息|Message)$/, { exact: true }).fill('代码示例\n\n' + text);
  await page.getByRole('button', { name: /^(发送消息|Send message)$/, exact: true }).click();
  await expect(page.getByTestId('chat-status')).toHaveText(/^(就绪|Ready)$/);
}

test('highlights code, preserves exact copying and remains readable in both themes and narrow layouts', async ({ page, context }, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => localStorage.setItem('mana-theme', 'dark'));
  const source = '  const greeting: string = "中文 hello";\n\n  // <script>window.codeInjection = true</script>\n  const markup = \'<img src=x onclick="window.codeInjection=true">\';\n';
  await send(page, '```typescript\n' + source + '\n```');
  const block = page.locator('.message.text .code-block').first();
  await expect(block.locator('pre')).toHaveText(source + '\n', { useInnerText: false });
  expect(await block.locator('pre').textContent()).toBe(source + '\n');
  const keyword = block.locator('.hljs-keyword').first();
  await expect(keyword).toBeVisible();
  expect(await keyword.evaluate(el => getComputedStyle(el).color)).not.toBe(await block.locator('code').evaluate(el => getComputedStyle(el).color));
  const darkColor = await keyword.evaluate(el => getComputedStyle(el).color);
  await block.getByRole('button', { name: '复制代码', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(source);
  await expect(block.locator('script, img, [onclick]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).codeInjection)).toBeUndefined();
  await page.screenshot({ path: testInfo.outputPath('code-highlight-dark.png') });
  const conversationUrl = page.url();
  await page.goto('/settings/general');
  await page.getByRole('button', { name: '浅色', exact: true }).click();
  await page.goto(conversationUrl);
  await expect.poll(() => keyword.evaluate(el => getComputedStyle(el).color)).not.toBe(darkColor);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('code-highlight-light-mobile.png') });
});

test('keeps unknown and large fenced code as plain text beside highlighted diff', async ({ page }) => {
  const large = 'const value = true;\n'.repeat(2700);
  await send(page, '```unknown\nconst untouched = true;\n```\n\n```javascript\n' + large + '\n```\n\n```diff\n-old\n+new\n```');
  const blocks = page.locator('.message.text .code-block');
  await expect(blocks).toHaveCount(3);
  await expect(blocks.nth(0).locator('[class^="hljs-"]')).toHaveCount(0);
  await expect(blocks.nth(1).locator('[class^="hljs-"]')).toHaveCount(0);
  await expect(blocks.nth(1).locator('pre')).toHaveText(large + '\n', { useInnerText: false });
  await expect(blocks.nth(2).locator('.hljs-addition')).toHaveText('+new');
  await expect(blocks.nth(2).locator('.hljs-deletion')).toHaveText('-old');
});

test('supports English controls while preserving Mermaid diagram and source views', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => { localStorage.setItem('mana-language', 'en'); localStorage.setItem('mana-theme', 'light'); });
  const source = 'flowchart LR\n  A[Start] --> B[Done]';
  await send(page, '```json\n{"safe": true}\n```\n\n```mermaid\n' + source + '\n```');
  const blocks = page.locator('.message.text .code-block');
  await expect(blocks.first().locator('.hljs-attr')).toBeVisible();
  await expect(blocks.first().getByRole('button', { name: 'Copy code', exact: true })).toBeVisible();
  const chart = blocks.nth(1);
  await expect(chart.locator('.mermaid-stage > svg')).toBeVisible();
  await chart.getByRole('button', { name: 'View source', exact: true }).click();
  await expect(chart.locator('pre')).toHaveText(source + '\n', { useInnerText: false });
  await chart.getByRole('button', { name: 'Copy code', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(source);
  await chart.getByRole('button', { name: 'View diagram', exact: true }).click();
  await expect(chart.locator('.mermaid-stage > svg')).toBeVisible();
});
