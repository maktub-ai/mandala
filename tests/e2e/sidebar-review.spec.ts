import { chooseOption } from "./helpers/select";
import { openChatContext } from './helpers/navigation';

test.beforeEach(async ({page}) => {
 await page.route('**/api/conversations/*/local-files/resolve', route => route.fulfill({json:{hrefs:route.request().postDataJSON().hrefs.filter((href:string)=>href==='/tmp/report.md')}}));
});
import { expect, test } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('reviews committed branch changes independently of untracked files',async({page,request},testInfo)=>{
 const cwd=mkdtempSync(join(tmpdir(),'mana-branch-review-'));
 const projectId='branch-'+crypto.randomUUID();
 try {
  const git=(...args:string[])=>execFileSync('git',['-C',cwd,...args]);
  git('init','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.test');
  writeFileSync(join(cwd,'code.txt'),'before\n');git('add','.');git('commit','-m','base');
  git('branch','baseline');writeFileSync(join(cwd,'code.txt'),'committed\n');git('add','.');git('commit','-m','change');
  git('checkout','--orphan','unrelated');git('add','.');git('commit','-m','unrelated');git('checkout','main');
  writeFileSync(join(cwd,'code.txt'),'uncommitted\n');writeFileSync(join(cwd,'unrelated.md'),'noise\n');
  const {config,revision}=await(await request.get('/api/config')).json();
  expect((await request.put('/api/config',{data:{revision,config:{...config,projects:[...config.projects,{id:projectId,name:'Branch review',cwd,agentIds:[],resources:[],mcp:[],skills:[]}]}}})).ok()).toBe(true);
  const chat=await(await request.post('/api/conversations',{data:{projectId}})).json();
  await page.goto('/?project='+projectId+'&conversation='+chat.id);
  await page.getByRole('button',{name:'展开右侧栏',exact:true}).click();
  const panel=page.locator('#chat-environment-panel');await panel.getByRole('tab',{name:'改动',exact:true}).click();
  await expect(panel).toContainText('已提交的改动请选');
  await chooseOption(page,panel.getByRole('combobox',{name:'改动范围',exact:true}),'branch');
  await expect(panel.getByRole('alert')).toBeVisible();
  await chooseOption(page,panel.getByRole('combobox',{name:'比较基线',exact:true}),'refs/heads/baseline');
  await expect(panel.getByRole('combobox',{name:'比较基线',exact:true})).toHaveAttribute('data-value','refs/heads/baseline');
  await expect(panel).toContainText('不等同于本次对话改动');
  await expect(panel.getByRole('button',{name:'unrelated.md',exact:true})).toHaveCount(0);
  await expect(panel.locator('.change-summary').first()).toContainText('1 个文件');
  await page.screenshot({path:testInfo.outputPath('branch-light.png')});
  await panel.getByRole('button',{name:'code.txt',exact:true}).click();
  await expect(panel.locator('.diff-add code')).toHaveText('committed');
  await panel.getByRole('button',{name:'查看文件',exact:true}).click();
  await expect(panel.locator('.code-preview')).toHaveText('committed\n');
  await panel.getByRole('button',{name:'返回改动',exact:true}).click();
  await chooseOption(page,panel.getByRole('combobox',{name:'比较基线',exact:true}),'refs/heads/main');
  await expect(panel).toContainText('当前没有 Git 改动');
  await chooseOption(page,panel.getByRole('combobox',{name:'比较基线',exact:true}),'refs/heads/unrelated');
  await expect(panel.getByRole('alert')).toBeVisible();
  await expect(panel.getByRole('combobox',{name:'比较基线',exact:true})).toHaveAttribute('data-value','refs/heads/unrelated');
  await chooseOption(page,panel.getByRole('combobox',{name:'比较基线',exact:true}),'refs/heads/baseline');
  await expect(panel.getByRole('button',{name:'code.txt',exact:true})).toBeVisible();
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');await page.setViewportSize({width:390,height:844});
  expect(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('branch-dark-mobile.png')});
  await panel.getByRole('tab',{name:'文件',exact:true}).click();
  await panel.getByRole('button',{name:'code.txt',exact:true}).click();
  await expect(panel.locator('.code-preview')).toHaveText('uncommitted\n');
 } finally {
  const {config,revision}=await(await request.get('/api/config')).json();
  await request.put('/api/config',{data:{revision,config:{...config,projects:config.projects.filter((project:{id:string})=>project.id!==projectId)}}});
  rmSync(cwd,{recursive:true,force:true});
 }
});

test('reviews actual scoped Git changes, counts additions and deletions and opens the corresponding file',async({page,request})=>{
 const cwd=mkdtempSync(join(tmpdir(),'mana-review-e2e-'));
 try {
  const git=(...args:string[])=>execFileSync('git',['-C',cwd,...args]);
  git('init');git('config','user.name','Fixture');git('config','user.email','fixture@example.test');
  const prefix=Array.from({length:64},(_,i)=>'// context '+i+'\n').join('');
  mkdirSync(join(cwd,'src'));writeFileSync(join(cwd,'src/example.ts'),prefix+'export const value = 1;\n');git('add','.');git('commit','-m','fixture');
  writeFileSync(join(cwd,'src/example.ts'),prefix+'export const value = 2;\n');git('add','.');
  writeFileSync(join(cwd,'src/example.ts'),prefix+'export const value = 3;\nexport const ready = true;\n');writeFileSync(join(cwd,'new.md'),'# New document\nSecond line\n');
  const projectId='review-'+crypto.randomUUID(),{config,revision}=await(await request.get('/api/config')).json();
  expect((await request.put('/api/config',{data:{revision,config:{...config,projects:[...config.projects,{id:projectId,name:'Review fixture',cwd,agentIds:[],resources:[],mcp:[],skills:[]}]}}})).ok()).toBe(true);
  const created=await request.post('/api/conversations',{data:{projectId}});expect(created.ok()).toBe(true);const chat=await created.json();
  await page.goto('/?project='+projectId+'&conversation='+chat.id);
  const draft=page.getByRole('textbox',{name:'消息',exact:true});await draft.fill('Keep my draft');
  const trigger=page.getByRole('button',{name:'展开右侧栏',exact:true});await expect(trigger).toHaveText('');await trigger.click();
  const panel=page.locator('#chat-environment-panel');
  await expect(panel.getByRole('heading',{name:'内容',exact:true})).toHaveCount(0);
  await expect(panel.getByRole('tab',{name:'文件',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.locator('.sidebar-collapse svg')).toHaveClass(/lucide-panel-left/);
  await panel.getByRole('tab',{name:'改动',exact:true}).click();
  await expect(panel.locator('.change-summary')).toContainText('+4');await expect(panel.locator('.change-summary')).toContainText('−1');
  const file=panel.getByRole('button',{name:'src/example.ts',exact:true});await expect(file).toContainText('+2');await expect(file).toContainText('−1');await file.click();
  await expect(panel.locator('.diff-remove code')).toHaveText('export const value = 1;');
  await expect(panel.locator('.diff-add code')).toHaveText(['export const value = 3;','export const ready = true;']);
  const lineNumber=panel.locator('.diff-add .diff-number').last();
  await expect(lineNumber).toHaveText('66');
  expect(await lineNumber.evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);return range.getClientRects().length;})).toBe(1);
  await panel.getByRole('button',{name:'并排',exact:true}).click();await expect(panel.locator('.diff-table.split')).toBeVisible();
  await panel.getByRole('button',{name:'查看文件',exact:true}).click();await expect(panel.locator('.code-preview')).toContainText('export const value = 3;');
  await panel.getByRole('button',{name:'返回改动',exact:true}).click();
  await chooseOption(page, panel.getByRole('combobox',{name:'改动范围',exact:true}), 'staged');
  await expect(panel.getByRole('button',{name:'new.md',exact:true})).toHaveCount(0);
  await panel.getByRole('button',{name:'src/example.ts',exact:true}).click();await expect(panel.locator('.diff-add code')).toHaveText('export const value = 2;');
  await panel.getByRole('button',{name:'返回改动',exact:true}).click();await chooseOption(page, panel.getByRole('combobox',{name:'改动范围',exact:true}), 'unstaged');
  await panel.getByRole('button',{name:'new.md',exact:true}).click();await expect(panel.locator('.diff-add code')).toHaveText(['# New document','Second line']);
  await panel.getByRole('button',{name:'收起右侧栏',exact:true}).click();await expect(draft).toHaveValue('Keep my draft');
 } finally {
  const {config,revision}=await(await request.get('/api/config')).json();
  const saved=await request.put('/api/config',{data:{revision,config:{...config,projects:config.projects.filter((project:{cwd:string})=>project.cwd!==cwd)}}});
  expect(saved.ok(),await saved.text()).toBe(true);
  rmSync(cwd,{recursive:true,force:true});
 }
});

test('shows the origin of chat links and lists chat references separately from directory files',async({page})=>{
 await page.route('**/local-file',route=>route.fulfill({json:{name:'report.md',path:'/tmp/report.md',text:'# Report body'}}));
 await page.goto('/?project=&agent=');
 await page.getByRole('textbox',{name:'消息',exact:true}).fill('[排查记录](/tmp/report.md) [官网](https://openai.com) [源码](https://github.com/example/repo) [资料]('+new URL('/assets/fixture?version=v1',page.url()).href+')');
 await page.getByRole('button',{name:'发送消息',exact:true}).click();await expect(page.getByTestId('chat-status')).toHaveText('就绪');
 await expect(page.locator('.message.user').getByRole('link',{name:'排查记录',exact:true})).toHaveAttribute('data-source','local');
 await expect(page.getByRole('link',{name:'官网',exact:true}).first()).toHaveAttribute('data-source','web');
 await expect(page.getByRole('link',{name:'源码',exact:true}).first()).toHaveAttribute('data-source','repository');
 await expect(page.getByRole('link',{name:'资料',exact:true}).last()).toHaveAttribute('data-source','material');
 const context=await openChatContext(page),local=context.getByRole('button',{name:/排查记录/});await expect(local).toContainText('本地文件');
 await local.click();const panel=page.locator('#chat-environment-panel');await expect(panel.getByRole('heading',{name:'Report body',exact:true})).toBeVisible();
});

test('opens a sent document attachment in the sidebar and keeps a download available on narrow screens',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.goto('/?project=&agent=');
 await page.locator('input[type="file"]').setInputFiles({name:'brief.md',mimeType:'text/markdown',buffer:Buffer.from('# Uploaded brief\n\nRead this next to the chat.')});
 await page.getByRole('textbox',{name:'消息',exact:true}).fill('Review this document');
 await page.getByRole('button',{name:'发送消息',exact:true}).click();await expect(page.getByTestId('chat-status')).toHaveText('就绪');
 await page.locator('.message.user .message-attachments').getByRole('button',{name:'brief.md',exact:true}).click();
 const panel=page.locator('#chat-environment-panel');await expect(panel.getByRole('heading',{name:'Uploaded brief',exact:true})).toBeVisible();
 await expect(panel.getByRole('link',{name:'下载附件',exact:true})).toHaveAttribute('download','brief.md');
 await panel.getByRole('button',{name:'返回文件',exact:true}).click();
 expect(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
 await page.keyboard.press('Escape');await expect(panel).not.toBeVisible();
 const context=await openChatContext(page);await expect(context.getByRole('button',{name:/brief.md/})).toBeVisible();
});
