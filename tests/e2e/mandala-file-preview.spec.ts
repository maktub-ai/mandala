import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

test('Mandala reads files beside chat and restores both sidebar layouts', async ({page, request}) => {
  const {conversation} = await (await request.get('/api/mandala')).json();
  const folder = join(conversation.cwd, 'preview-fixture');
  await mkdir(folder, {recursive:true});
  await writeFile(join(folder, 'notes.md'), '# Preview notes');
  await page.setContent('<h1>Quarterly report</h1>');
  await page.pdf({path:join(folder, 'report.pdf')});
  await page.screenshot({path:join(folder, 'report.png')});
  const posted = await request.post('/api/conversations/'+conversation.id+'/messages', {data:{
    text:'[Notes](./preview-fixture/notes.md) [Report](./preview-fixture/report.pdf) [Image](./preview-fixture/report.png)'
  }});
  expect(posted.ok()).toBe(true);
  await page.goto('/mandala');
  const sidebar = page.locator('#chat-environment-panel');
  const teams = sidebar.getByRole('tab', {name:'智能体', exact:true});
  await teams.click();
  const draft = page.getByRole('textbox', {name:'消息', exact:true});
  await draft.fill('继续讨论');
  const notes = page.getByRole('link', {name:'Notes', exact:true}).first();
  const report = page.getByRole('link', {name:'Report', exact:true}).first();
  const reader = page.getByRole('region', {name:'文件预览', exact:true});
  await notes.click();
  await expect(reader.getByRole('heading', {name:'Preview notes'})).toBeVisible();
  await expect(sidebar).toBeHidden();
  await expect(reader.getByRole('tablist')).toHaveCount(0);
  expect((await reader.boundingBox())!.x).toBeGreaterThanOrEqual((await draft.boundingBox())!.x + (await draft.boundingBox())!.width);
  await draft.fill('阅读时也能输入');
  await page.getByRole('link',{name:'Image',exact:true}).first().click();
  await expect.poll(()=>reader.locator('img').evaluate((img:HTMLImageElement)=>img.naturalWidth)).toBeGreaterThan(0);
  await page.setViewportSize({width:1050,height:850});
  await report.click();
  await expect(reader.getByText('Quarterly report', {exact:true})).toBeAttached();
  await expect(reader.getByRole('img',{name:'PDF 预览'})).toBeVisible();
  await page.setViewportSize({width:1280,height:850});
  await reader.getByRole('button', {name:'关闭文件预览'}).click();
  await expect(teams).toHaveAttribute('aria-selected', 'true');
  await expect(draft).toHaveValue('阅读时也能输入');
  await sidebar.getByRole('button', {name:'收起右侧栏'}).click();
  await notes.click();
  await expect(reader.getByRole('heading', {name:'Preview notes'})).toBeVisible();
  await reader.getByRole('button', {name:'关闭文件预览'}).press('Escape');
  await expect(reader).toHaveCount(0);
  await expect(sidebar).toBeHidden();
  await expect(notes).toBeFocused();
  await page.setViewportSize({width:390,height:844});
  await notes.click();
  const mobilePreview = page.getByRole('dialog', {name:'文件预览'});
  await expect(mobilePreview.getByRole('heading', {name:'Preview notes'})).toBeVisible();
  await mobilePreview.getByRole('button', {name:'关闭文件预览'}).click();
  await expect(notes).toBeFocused();
});

test('a published file in the main reply opens its exact version', async ({page,request}) => {
  const {conversation} = await (await request.get('/api/mandala')).json();
  const seed = await request.post('/__test__/published-deliverable', {data:{conversationId:conversation.id}});
  expect(seed.ok()).toBe(true);
  const {name,asset,version} = await seed.json();
  await page.goto('/mandala');
  await page.locator('.message.text').getByRole('link',{name,exact:true}).click();
  const preview = page.getByRole('region',{name:'文件预览',exact:true});
  await expect(preview.getByRole('heading',{name,exact:true})).toBeVisible();
  await expect(preview.getByRole('link',{name:'下载固定版本'})).toHaveAttribute('href',
    '/api/v2/assets/'+asset.id+'/versions/'+version.id+'/files/0');
});
