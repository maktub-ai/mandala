import { expect, test } from '@playwright/test';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultPreferences, themeStorageKey } from '../../shared/themes';

for(const language of ['zh-CN','en'])test('previews interactive HTML from a chat link and opens the local file in '+language,async({page,request},testInfo)=>{
 const cwd=await realpath(await mkdtemp(join(tmpdir(),'html-preview-'))),path=join(cwd,'report one.html');
 const html=`<!doctype html><html><head><meta charset="utf-8"><style>body{font:16px sans-serif;padding:20px}button{padding:12px}</style></head><body><h1>GPU report</h1><button onclick="this.textContent='Opened details'">Show details</button><p id="isolation"></p><script>try{parent.document.body.dataset.escaped='yes'}catch{document.getElementById('isolation').textContent='Isolated preview'}</script></body></html>`;
 try{
  await writeFile(path,html);
  const chat=await(await request.post('/api/conversations',{data:{cwd,workspaceId:null}})).json();
  expect((await request.post('/api/conversations/'+chat.id+'/messages',{data:{text:`[HTML report](<${path}>)`}})).ok()).toBe(true);
  await page.addInitScript(value=>localStorage.setItem('mana-language',value),language);
  await page.goto('/?conversation='+chat.id+'&project=');
  await page.getByRole('link',{name:'HTML report',exact:true}).first().click();
  const panel=page.locator('#chat-environment-panel'),frame=panel.frameLocator('iframe[title="report one.html"]');
  await expect(frame.getByRole('heading',{name:'GPU report'})).toBeVisible();
  await expect(frame.getByText('Isolated preview')).toBeVisible();
  await frame.getByRole('button',{name:'Show details'}).click();await expect(frame.getByRole('button',{name:'Opened details'})).toBeVisible();
  expect(await page.locator('body').getAttribute('data-escaped')).toBeNull();
  await panel.getByRole('button',{name:language==='en'?'View source':'查看源码',exact:true}).click();await expect(panel.locator('code')).toContainText('<!doctype html>');
  await panel.getByRole('button',{name:language==='en'?'Preview':'预览',exact:true}).click();await expect(frame.getByRole('heading')).toHaveText('GPU report');
  await page.route('**/local-file/open',route=>{expect(route.request().postDataJSON()).toEqual({href:path});return route.fulfill({json:{ok:true}});});
  const open=panel.getByRole('button',{name:language==='en'?'Open in default app':'用默认应用打开',exact:true});
  await open.click();await expect(panel.getByRole('status')).toContainText(language==='en'?'Opened in default app':'已用默认应用打开');
  await page.route('**/local-file/open',route=>route.fulfill({status:503,json:{error:'Synthetic application unavailable'}}));await open.click();await expect(panel.getByRole('alert')).toContainText('Synthetic application unavailable');
  for(const theme of ['light','dark']){
   await page.evaluate(({key,raw})=>{localStorage.setItem(key,raw);window.dispatchEvent(new StorageEvent('storage',{key,newValue:raw}));},{key:themeStorageKey,raw:JSON.stringify({...defaultPreferences(),mode:theme})});
   await expect(page.locator('html')).toHaveAttribute('data-theme',theme);await page.screenshot({path:testInfo.outputPath('html-'+theme+'.png')});
  }
  await page.setViewportSize({width:390,height:844});await expect(open).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:testInfo.outputPath('html-narrow.png')});
  await panel.getByRole('tab',{name:language==='en'?'Files':'文件',exact:true}).click();await panel.getByRole('button',{name:'report one.html',exact:true}).click();
  await expect(frame.getByRole('heading')).toHaveText('GPU report');
  await page.route('**/workspace-file/open',route=>{expect(route.request().postDataJSON()).toEqual({path:'report one.html'});return route.fulfill({json:{ok:true}});});
  await open.click();await expect(panel.getByRole('status')).toContainText(language==='en'?'Opened in default app':'已用默认应用打开');
 }finally{await rm(cwd,{recursive:true,force:true});}
});
