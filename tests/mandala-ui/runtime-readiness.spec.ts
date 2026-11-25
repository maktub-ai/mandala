import {expect,test} from '@playwright/test';

test('does not enumerate models before the selected native CLI can resume chats', async({page})=>{
 let compatible=false,models=0;
 await page.route('**/api/cli/status?**',async route=>{
  const url=new URL(route.request().url());
  if(url.searchParams.get('cli')!=='gemini')return route.continue();
  return route.fulfill({json:{status:compatible?'ready':'unavailable',version:'fixture',diagnostics:{host:'local',executable:'executable',probe:'acp',auth:'not-verified',...!compatible?{capabilityIssue:'durable-resume-unsupported'}:{}}}});
 });
 await page.route('**/api/models?**',async route=>{
  const url=new URL(route.request().url());
  if(url.searchParams.get('cli')!=='gemini')return route.continue();
  models++;await route.fulfill({json:[]});
 });
 await page.goto('/settings/runtimes/new?runtime=gemini');
 await expect(page.getByText(/无法恢复对话|cannot resume conversations/)).toBeVisible();
 await expect(page.getByText(/不需要单独安装适配器|no separate adapter installation/)).toBeVisible();
 expect(models).toBe(0);
 compatible=true;await page.reload();
 await expect.poll(()=>models).toBe(1);
 await expect(page.getByText(/未验证登录或任务执行|sign-in and task execution were not verified/)).toBeVisible();
});

test('the configured CLI can recheck in place and refresh its model list', async ({page}) => {
 let version = 1;
 let finishModels!: () => void;
 const modelsPending = new Promise<void>(resolve => { finishModels = resolve; });
 const isCodex = (url: string) => new URL(url).searchParams.get('cli') === 'codex';
 await page.route('**/api/cli/status?**', route => isCodex(route.request().url())
  ? route.fulfill({json:{status:'ready',version:`fixture-${version}`}}) : route.continue());
 await page.route('**/api/models?**', async route => {
  if (!isCodex(route.request().url())) return route.continue();
  if (version === 2) await modelsPending;
  return route.fulfill({json:[{id:`fixture-model-${version}`,label:`Fixture model ${version}`}]});
 });
 await page.goto('/settings/runtimes/codex');
 const row = page.locator('.runtime-status-row');
 const checkAgain = row.getByRole('button', {name:'重新检测'});
 await expect(row.getByRole('status')).toContainText('fixture-1');
 await expect(checkAgain).toBeEnabled();
 version = 2;
 await checkAgain.click();
 try {
  await expect(row.getByRole('status')).toContainText('fixture-2');
  await expect(checkAgain).toBeDisabled();
  await expect(page).toHaveURL(/\/settings\/runtimes\/codex$/);
 } finally { finishModels(); }
 await expect(checkAgain).toBeEnabled();
 await page.getByText('连接诊断',{exact:true}).click();
 await expect(page.getByText('Fixture model 2',{exact:false})).toBeVisible();
});

for (const [mode, width] of [['light', 1280], ['dark', 390]] as const) {
 test(`OpenCode explains missing CLI and can recheck after installation (${mode}, ${width}px)`, async ({page}) => {
  let installed=false;
  await page.setViewportSize({width,height:850});
  await page.addInitScript(theme=>localStorage.setItem('mana-theme',theme),mode);
  await page.route('**/api/cli/status?**', async route=>{
   if(new URL(route.request().url()).searchParams.get('cli')!=='opencode')return route.continue();
   await route.fulfill({json:{status:installed?'ready':'unavailable',version:installed?'2.4.1':null,diagnostics:{host:'local',executable:installed?'executable':'missing',probe:installed?'acp':'failed',auth:'not-verified',...!installed?{failureStage:'launch'}:{}}}});
  });
  await page.route('**/api/models?**', async route=>{
   if(new URL(route.request().url()).searchParams.get('cli')!=='opencode')return route.continue();
   await route.fulfill({json:[]});
  });
  await page.goto('/settings/runtimes/new?runtime=opencode');
  await expect(page.locator('html')).toHaveAttribute('data-theme',mode);
  const status=page.locator('.runtime-connection-status'), guide=page.locator('.runtime-setup-guide');
  await expect(status).toContainText('CLI 不可用');
  await expect(guide.getByText('执行机器的 PATH 中未找到启动命令。', {exact:false})).toBeVisible();
  expect((await status.boundingBox())!.y).toBeLessThan((await guide.boundingBox())!.y);
  await expect(page.getByText(/ACP 握手未完成/)).toHaveCount(0);
  await expect(page.getByText(/不需要单独安装适配器/)).toBeVisible();
  await expect(page.getByRole('link',{name:'OpenCode 官方 ACP 使用说明'})).toBeVisible();
  const layout = await guide.evaluate(el=>({ content:el.scrollWidth, available:el.clientWidth, display:getComputedStyle(el).display }));
  expect(layout.display).toBe('grid');
  expect(layout.content).toBeLessThanOrEqual(layout.available);
  await page.screenshot({path:test.info().outputPath('opencode-launcher-missing.png')});
  installed=true;
  const checkAgain=page.locator('.runtime-status-row').getByRole('button',{name:'重新检测'});
  await expect(checkAgain).toBeVisible();
  await checkAgain.click();
  await expect(status).toContainText('CLI 可启动');
  await expect(checkAgain).toBeEnabled();
  await expect(page.getByText(/未验证登录或任务执行/)).toBeVisible();
 });
}
