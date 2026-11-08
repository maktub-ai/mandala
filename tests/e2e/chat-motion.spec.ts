// Plan: audit/2026-10-26-chat-motion/acceptance.md (AC1–AC5)
import { test, expect } from './helpers/execution-fixture';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

test.beforeEach(async ({ request, page }) => {
  const { revision } = await (await request.get('/api/config')).json();
  expect((await request.put('/api/config', { data: { revision, config: { version: 2, projects: [], agents: [] } } })).ok()).toBe(true);
  await page.addInitScript(() => {
    const originalExec = document.execCommand.bind(document);
    document.execCommand = (...args: Parameters<Document['execCommand']>) => sessionStorage.getItem('fail-copy') ? false : originalExec(...args);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => {
        if (sessionStorage.getItem('fail-copy')) throw new Error('Synthetic clipboard failure');
        sessionStorage.setItem('copied-text', text);
      },
    } });
  });
});

test('AC2 copy feedback expires, repeated copy renews it, failures persist', async ({ page }) => {
  await page.goto('/?project=&agent=');
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('copy timing');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByTestId('chat-status')).toHaveText('就绪');
  const copy = page.locator('.reply-actions').getByRole('button', { name: '复制消息', exact: true });
  await page.clock.install();
  await copy.click();
  await expect(copy).toHaveAttribute('title', '已复制');
  expect(await page.evaluate(() => sessionStorage.getItem('copied-text'))).toBe('Fixture reply: copy timing');
  await page.clock.runFor(2000);
  await copy.getByRole('status').evaluate(node => node.getAnimations().forEach(animation => animation.finish()));
  await copy.click();
  await page.clock.runFor(1000);
  await expect(copy).toHaveAttribute('title', '已复制');
  await expect(copy.getByRole('status')).toHaveCSS('opacity', '1');
  await page.clock.runFor(1500);
  await expect(copy).toHaveAttribute('title', '复制消息');
  await page.evaluate(() => sessionStorage.setItem('fail-copy', '1'));
  await copy.click();
  await page.clock.runFor(3500);
  await expect(page.getByRole('alert').filter({ hasText: '复制失败' })).toBeVisible();
});

for (const reducedMotion of ['no-preference', 'reduce'] as const) test(`AC1/3/5 live prose is bounded, history is static, motion=${reducedMotion}`, async ({ page }) => {
  await page.emulateMedia({ reducedMotion });
  await page.goto('/?project=&agent=');
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('stream-reading');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const reply = page.locator('.agent-reply > .message .markdown-text').last();
  await expect(reply).toContainText('更新 2');
  await expect.poll(() => reply.locator('.stream-character').count()).toBeGreaterThan(0);
  const motion = await reply.locator('.stream-character').evaluateAll(nodes => nodes.map(node => {
    const style = getComputedStyle(node); return { duration: style.animationDuration, delay: style.animationDelay, animation: style.animationName };
  }));
  expect(motion.length).toBeLessThanOrEqual(32);
  if (reducedMotion === 'reduce') expect(motion.every(item => item.animation === 'none')).toBe(true);
  else expect(motion.every(item => parseFloat(item.delay) + parseFloat(item.duration) <= .151)).toBe(true);
  await expect(page.getByTestId('chat-status')).toHaveText('就绪');
  await expect(reply).toContainText('更新 15');
  await page.reload();
  await expect(reply).toContainText('更新 15');
  await expect(reply.locator('.stream-character')).toHaveCount(0);
});

test('AC1 same-paragraph appends each start a fresh reveal without splitting text', async ({ page, request, executionDirectory }) => {
  const gate = join(executionDirectory, 'inline-stream-step');
  await writeFile(gate, '0');
  const chat = await (await request.post('/api/conversations', { data: { projectId: '', agentId: '' } })).json();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/?project=&conversation=' + chat.id);
  await expect(page.getByRole('button', { name: '重命名对话', exact: true })).toBeVisible();
  await page.evaluate(() => {
    (window as any).streamStarts = [];
    document.addEventListener('animationstart', event => {
      const target = event.target as HTMLElement;
      if (target.matches('.stream-character')) (window as any).streamStarts.push(target.textContent);
    }, true);
  });
  const stages = [
    { text: '同段', reveal: [] },
    { text: '新增', reveal: ['新', '增'] },
    { text: '文字', reveal: ['文', '字'] },
    { text: ' & ', reveal: ['&'] },
    { text: 'Z', reveal: ['Z'] },
    { text: ' 👨‍👩‍👧‍👦é', reveal: ['👨‍👩‍👧‍👦', 'é'] },
    { text: ' 完成。', reveal: ['完', '成', '。'] },
  ];
  try {
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('stream-inline:' + gate);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const reply = page.locator('.agent-reply > .message .markdown-text').last();
    let text = '';
    const starts: string[] = [];
    for (const [index, stage] of stages.entries()) {
      await writeFile(gate, String(index + 1));
      text += stage.text;
      await expect(reply).toHaveText(text);
      await expect(reply.locator('.stream-character')).toHaveText(stage.reveal);
      starts.push(...stage.reveal);
      await expect.poll(() => page.evaluate(() => (window as any).streamStarts)).toEqual(starts);
    }
    await writeFile(gate, String(stages.length + 1));
    await expect(page.getByTestId('chat-status')).toHaveText('就绪');
    await expect(reply).toHaveText('同段新增文字 & Z 👨‍👩‍👧‍👦é 完成。');
    await expect(reply.locator('.stream-character')).toHaveCount(0);
  } finally { await request.post('/api/conversations/' + chat.id + '/stop'); }
});

for (const scene of [{ width: 1280, theme: 'light' }, { width: 768, theme: 'dark' }, { width: 390, theme: 'light' }]) test(`AC2/4 code copy and responsive prose ${scene.width} ${scene.theme}`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: scene.width, height: 850 });
  await page.addInitScript(theme => localStorage.setItem('mana-theme', theme), scene.theme);
  await page.goto('/?project=&agent=');
  const text = '阅读摘要 [参考资料](https://example.com)\n\n```js\nconsole.log(12345)\n```\n\n| 项目 | 数值 |\n| --- | --- |\n| Reading progress 阅读进度 | 12345 |\n\n' + '用于检查长中文与英文 responsive reading 的自然换行。'.repeat(5);
  await page.getByRole('textbox', { name: '消息', exact: true }).fill(text);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByTestId('chat-status')).toHaveText('就绪');
  const reply = page.locator('.agent-reply > .message').last();
  const copy = reply.getByRole('button', { name: '复制代码', exact: true });
  await copy.click();
  await expect(copy).toHaveText('已复制');
  expect(await page.evaluate(() => sessionStorage.getItem('copied-text'))).toBe('console.log(12345)');
  await expect(copy).toHaveText('复制代码');
  await page.clock.install();
  await page.evaluate(() => sessionStorage.setItem('fail-copy', '1'));
  await copy.click();
  await page.clock.runFor(3500);
  await expect(copy).toHaveText('复制失败');
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`prose-${scene.width}-${scene.theme}.png`) });
});

test('AC3 timer reserves its width across seconds and minutes', async ({ page, request }) => {
  const chat = await (await request.post('/api/conversations', { data: { projectId: '', agentId: '' } })).json();
  try {
    await page.goto('/?project=&conversation=' + chat.id);
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('hold');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByTestId('chat-status')).toHaveText('执行中');
    await page.clock.install();
    const timer = page.locator('.turn-process-time').last();
    const width = (await timer.boundingBox())!.width;
    await page.clock.runFor(10_000);
    expect((await timer.boundingBox())!.width).toBe(width);
    await page.clock.runFor(50_000);
    expect((await timer.boundingBox())!.width).toBe(width);
  } finally { await request.post('/api/conversations/' + chat.id + '/stop'); }
});

test('AC2 diff copy shares the success deadline and preserves failure feedback', async ({ page, request, executionDirectory }, testInfo) => {
  const chat = await (await request.post('/api/conversations', { data: { projectId: '', agentId: '', cwd: executionDirectory } })).json();
  const patch = '--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old\n+new';
  await page.route('**/api/conversations/' + chat.id + '/workspace{,?*}', route => route.fulfill({ json: { cwd: executionDirectory, git: true, files: [{ path: 'example.ts', status: ' M' }] } }));
  await page.route('**/api/conversations/' + chat.id + '/workspace-file', route => route.fulfill({ json: { name: 'example.ts', path: 'example.ts', text: 'new', language: 'typescript', diff: patch } }));
  await page.goto('/?project=&conversation=' + chat.id);
  await page.getByRole('button', { name: '展开右侧栏', exact: true }).click();
  const panel = page.locator('#chat-environment-panel');
  await panel.getByRole('tab', { name: '改动', exact: true }).click();
  await panel.getByRole('button', { name: 'example.ts', exact: true }).click();
  const copy = panel.locator('.diff-toolbar > button').last();
  await page.clock.install();
  await copy.click();
  await expect(copy).toHaveText('已复制');
  await page.screenshot({ path: testInfo.outputPath('diff-copy.png') });
  expect(await page.evaluate(() => sessionStorage.getItem('copied-text'))).toBe(patch);
  await page.clock.runFor(2500);
  await expect(copy).toHaveText('复制 diff');
  await page.evaluate(() => sessionStorage.setItem('fail-copy', '1'));
  await copy.click();
  await page.clock.runFor(3500);
  await expect(copy).toHaveText('复制失败');
});
