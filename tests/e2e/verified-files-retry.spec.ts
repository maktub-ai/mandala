import {expect,test} from '@playwright/test';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('a transient scope revision conflict retries once and previews only server-verified transcript files',async({page,request},testInfo)=>{
 const cwd=await realpath(await mkdtemp(join(tmpdir(),'mana-file-retry-')));
 try{
  await writeFile(join(cwd,'report.md'),'# Recovered report\n\nVerified after a transient revision conflict.');
  await writeFile(join(cwd,'.env'),'synthetic secret');
  const created=await request.post('/api/conversations',{data:{cwd,projectId:'',agentId:''}});expect(created.ok()).toBe(true);const chat=await created.json();
  expect((await request.post(`/api/conversations/${chat.id}/messages`,{data:{text:'Delivered `./report.md`. Missing `./missing.md`. Secret `./.env`.'}})).ok()).toBe(true);
  let attempts=0;
  await page.route(`**/api/conversations/${chat.id}/local-files/resolve`,async route=>{
   attempts++;
   if(attempts===1){await route.fulfill({status:409,json:{error:'Conversation scope changed'}});return;}
   await route.continue();
  });
  await page.addInitScript(()=>localStorage.setItem('mana-language','en'));
  await page.goto(`/?conversation=${chat.id}&project=&agent=`);
  const message=page.locator('.message.text'),link=message.getByRole('link',{name:'./report.md',exact:true});
  await expect(link).toBeVisible();expect(attempts).toBe(2);await expect(message.locator('[data-source=local]')).toHaveCount(1);
  await link.click();await expect(page.getByRole('heading',{name:'Recovered report',exact:true})).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('verified-retry-preview.png')});
  const other=await(await request.post('/api/conversations',{data:{cwd,projectId:'',agentId:''}})).json();
  const denied=await request.post(`/api/conversations/${other.id}/local-files/resolve`,{data:{hrefs:['./report.md']}});expect(denied.ok()).toBe(true);expect(await denied.json()).toEqual({hrefs:[]});
 }finally{await rm(cwd,{recursive:true,force:true});}
});
