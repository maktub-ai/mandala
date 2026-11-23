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
