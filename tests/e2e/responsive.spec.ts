import { test, expect } from './helpers/execution-fixture';
import { openArea } from './helpers/navigation';
import { chooseOption } from './helpers/select';
import { waitForAutosave } from './helpers/settings';

test.beforeEach(async ({ request, executionDirectory }, testInfo) => {
  const { revision } = await (await request.get('/api/config')).json();
  const response = await request.put('/api/config', { data: { revision, config: {
    version: 2, system: { cli: 'codex', memory: { language: testInfo.title === 'phone memory type counts and source snippets stay visible in en' ? 'en' : 'zh-CN' } },
    projects: [{ id: 'responsive', name: '个人移动工作区 · Personal workspace', cwd: executionDirectory,
      agentIds: ['responsive'], resources: [], mcp: [], skills: [] }],
    agents: [{ id: 'responsive', name: '个人助手 · Personal assistant', instructions: 'Synthetic responsive acceptance.',
      defaultCli: 'codex', models: { codex: 'model-fixture' }, mcp: [], skills: [] }],
  } } });
  expect(response.ok(), await response.text()).toBe(true);
});

for (const width of [320, 390, 768, 1280]) {
  test(`personal pages keep their content inside the viewport at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    for (const route of ['/?project=responsive&agent=responsive', '/tasks', '/agents?agent=responsive',
      '/agents?agent=responsive&tab=execution', '/projects/manage?project=responsive',
      '/projects/manage?project=responsive&tab=resources', '/assets', '/mana', '/market',
      '/settings/general', '/settings/runtimes', '/settings/mcp', '/settings/system']) {
      await test.step(route, async () => {
        await page.goto(route);
        await expect(page.locator('main h1').first()).toBeVisible();
        await expect(page.locator('main .ui-loading')).toHaveCount(0);
        const dimensions = await page.locator('main').evaluate(element => ({
          viewport: innerWidth, page: document.documentElement.scrollWidth,
          main: element.clientWidth, content: element.scrollWidth,
        }));
        expect.soft(dimensions.page, `${route}: page overflow`).toBeLessThanOrEqual(width + 1);
        expect.soft(dimensions.content, `${route}: main overflow ${JSON.stringify(dimensions)}`)
          .toBeLessThanOrEqual(dimensions.main + 1);
      });
    }
  });
}

for (const language of ['zh-CN', 'en']) test(`phone memory type counts and source snippets stay visible in ${language}`, async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.addInitScript(value => localStorage.setItem('mana-language', value), language);
  const records = Array.from({length:300}, (_,i) => ({recordId:'mobile-memory-'+i,collectionId:'personal',revision:1,layer:['L1','L2','L3'][i%3],text:'Synthetic mobile memory',status:'active',verification:'layer_summary',evidence:[{sourceId:'mobile-source-'+i,sourceRevision:1}],extractedAt:'2026-10-11T00:00:00Z',effectiveFrom:'2026-10-11T00:00:00Z'}));
  await page.route('**/api/v2/memory/records?*', route => route.fulfill({json:{records,collections:[]}}));
  await page.route('**/api/v2/memory/jobs', route => route.fulfill({json:[]}));
  await page.goto('/mana');
  const counts = page.getByRole('region',{name:language==='en'?'Memory types':'记忆类型',exact:true}).getByRole('button').locator('strong');
  await expect(counts).toHaveText(['100','100','100']);
  const sources=page.getByRole('button',{name:language==='en'?'Source snippets 300':'来源片段 300',exact:true});
  await expect(sources).toBeInViewport();
  expect(await page.locator('main').evaluate(element => element.scrollWidth-element.clientWidth)).toBeLessThanOrEqual(1);
  for (const count of await counts.all()) await expect(count).toBeInViewport();
});

test('phone task creation, editing and acceptance keep controls inside the content', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/tasks');
  await page.getByRole('button', { name: '新建任务', exact: true }).click();await page.getByRole('button',{name:'手动填写',exact:true}).click();
  const editor = page.getByRole('form', { name: '新建任务', exact: true });
  await editor.getByLabel('任务标题', { exact: true }).fill('在手机上创建并验收任务');
  await chooseOption(page, editor.getByRole('combobox', { name: '任务项目', exact: true }), 'responsive');
  await editor.locator('summary').filter({hasText:'关联与参与者'}).click();
  await editor.getByRole('checkbox', { name: '个人助手 · Personal assistant', exact: true }).check();
  await editor.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(page.getByRole('heading', { name: '在手机上创建并验收任务', exact: true })).toBeVisible();
  const main = page.locator('main');
  expect.soft(await main.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  const properties = page.getByRole('complementary', { name: '任务属性', exact: true });
  expect.soft(await properties.evaluate(element => element.scrollWidth - element.clientWidth), 'task properties overflow').toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: '编辑任务', exact: true }).click();
  await page.getByRole('form', { name: '编辑任务', exact: true }).getByLabel('任务标题', { exact: true }).fill('手机编辑后的任务');
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(page.getByRole('heading', { name: '手机编辑后的任务', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '提交验收', exact: true }).click();
  await page.getByRole('button', { name: '确认完成', exact: true }).click();
  await expect(page.getByText('用户已确认完成', { exact: false })).toBeVisible();
});

for (const width of [320, 844]) {
test(`chat stays operable at ${width}×320 through approval, stop and rotation`, async ({ page }) => {
  await page.setViewportSize({ width, height: 320 });
  await page.goto('/?project=responsive&agent=responsive');
  const composer = page.getByRole('textbox', { name: '消息', exact: true });
  await expect(composer).toBeVisible();
  await composer.fill('approval');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByRole('button', { name: '允许本次', exact: true }).click();
  await expect(page.getByTestId('chat-status')).toHaveText('就绪');
  await composer.fill('hold');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByTestId('chat-status')).toHaveText('执行中');
  await page.setViewportSize({ width: 320, height: 568 });
  await expect(page.getByRole('button', { name: '停止执行', exact: true })).toBeInViewport();
  await page.getByRole('button', { name: '停止执行', exact: true }).click();
  await expect(page.getByTestId('chat-status')).toHaveText('已中断');
  await composer.fill('保留手机草稿');
  await openArea(page, '任务');
  await openArea(page, '对话');
  await expect(composer).toHaveValue('保留手机草稿');
});
}

test('phone folder picker can search and select without horizontal clipping', async ({ page, executionDirectory }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/?project=&agent=responsive&workspace=');
  await page.getByRole('button', { name: '选择工作目录（可选）', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '选择文件夹', exact: true });
  await expect(picker.getByLabel('目录路径')).toBeEnabled();
  await picker.getByLabel('目录路径').fill(executionDirectory);
  await picker.getByRole('button', { name: '前往', exact: true }).click();
  await expect(picker.getByRole('button', { name: '使用此文件夹', exact: true })).toBeEnabled();
  expect.soft(await picker.evaluate(element => element.scrollWidth - element.clientWidth), 'folder dialog overflow').toBeLessThanOrEqual(1);
  const footer = picker.locator('.settings-footer');
  expect.soft(await footer.evaluate(element => element.scrollWidth - element.clientWidth), 'folder footer overflow').toBeLessThanOrEqual(1);
  await expect(picker.getByRole('button', { name: '使用此文件夹', exact: true })).toBeInViewport();
  await picker.getByRole('button', { name: '使用此文件夹', exact: true }).click();
  await expect(picker).toHaveCount(0);
});

test('phone Agent and project editors save changes that survive a reload', async ({ page, request }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/agents?agent=responsive');
  await page.getByLabel('职责与指令', { exact: true }).fill('在手机上编辑的长期职责');
  await waitForAutosave(page);
  await page.reload();
  await expect(page.getByLabel('职责与指令', { exact: true })).toHaveValue('在手机上编辑的长期职责');
  await page.goto('/projects/manage?project=responsive&tab=background');
  await page.getByLabel('项目背景', { exact: true }).fill('移动端项目背景');
  await waitForAutosave(page);
  await page.reload();
  await expect(page.getByLabel('项目背景', { exact: true })).toHaveValue('移动端项目背景');
  const { config } = await (await request.get('/api/config')).json();
  expect(config.agents[0].instructions).toBe('在手机上编辑的长期职责');
  expect(config.projects[0].background).toBe('移动端项目背景');
});

test.describe('touch tablet', () => {
  test.use({ hasTouch: true });
  test('message actions work without mouse hover', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/?project=responsive&agent=responsive');
    await page.getByLabel('消息', { exact: true }).fill('触摸消息操作');
    await page.getByRole('button', { name: '发送消息', exact: true }).tap();
    await expect(page.getByText('Fixture reply: 触摸消息操作', { exact: true })).toBeVisible();
    await expect(page.getByTestId('chat-status')).toHaveText('就绪');
    await page.getByRole('button', { name: '编辑消息', exact: true }).tap();
    await expect(page.getByLabel('修改消息内容', { exact: true })).toHaveValue('触摸消息操作');
    await page.locator('.message-editor').getByRole('button', { name: '取消', exact: true }).tap();
    await expect(page.getByLabel('修改消息内容', { exact: true })).toHaveCount(0);
  });
});
