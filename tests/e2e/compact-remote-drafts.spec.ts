import { test,expect,type Page } from '@playwright/test';
import { remoteMobileFixture } from './remote-mobile-fixture';
import { openAccountConnection } from './helpers/navigation';

test('real encrypted remote draft text and File bytes survive host-offline refresh without sending',async({page,browser})=>{
 test.setTimeout(90000);
 const fixture=await remoteMobileFixture(),context=await browser.newContext(),computer=await context.newPage();
 const signIn=async(target:Page,url:string)=>{await target.addInitScript(()=>localStorage.setItem('mana-language','zh-CN'));await target.goto(url);await target.getByLabel('账号',{exact:true}).fill('mobile');await target.getByLabel('密码',{exact:true}).fill(fixture.password);await target.getByRole('button',{name:'登录',exact:true}).click();};
 try{
  await signIn(computer,fixture.localUrl);await openAccountConnection(computer);await computer.locator('summary').filter({hasText:'高级：自部署连接服务'}).click();
  await computer.getByLabel('账号服务地址',{exact:true}).fill(fixture.relayUrl);await computer.getByLabel('电脑名称',{exact:true}).fill('Synthetic draft computer');await computer.getByLabel('服务账号',{exact:true}).fill('mobile');await computer.getByLabel('服务密码',{exact:true}).fill(fixture.password);await computer.getByRole('button',{name:'连接账号服务',exact:true}).click();
  const code=await computer.getByLabel('电脑配对码',{exact:true}).textContent();await page.setViewportSize({width:390,height:844});await signIn(page,fixture.relayUrl);await page.getByRole('button',{name:'请求授权',exact:true}).click();await computer.getByRole('button',{name:'批准',exact:true}).click();await page.getByRole('button',{name:'刷新',exact:true}).click();await page.getByRole('button',{name:'连接',exact:true}).click();await page.getByLabel('电脑配对码',{exact:true}).fill(code!);await page.getByRole('button',{name:'确认配对',exact:true}).click();
  await page.getByRole('button',{name:'对话列表',exact:true}).click();await page.getByRole('button',{name:/手机端合成对话/}).click();const message=page.getByLabel('消息',{exact:true});await expect(message).toBeEnabled();
  let sends=0;page.on('request',request=>{if(request.url().endsWith('/api/remote/transport')&&request.postDataBuffer()){try{const original=fixture.inspectRequest(request.postDataBuffer()!.toString('utf8'));if(original.method==='POST'&&/\/(queue|continue)$/.test(original.path))sends++;}catch{}}});
  await message.fill('Remote offline draft · 离线草稿');await page.locator('input[type=file]').setInputFiles({name:'retained-file.txt',mimeType:'text/plain',buffer:Buffer.from('Actual IndexedDB File bytes')});await expect(page.locator('.composer-draft-feedback')).toHaveCount(0);
  await fixture.disconnectHost();await page.reload();await expect(message).toHaveValue('Remote offline draft · 离线草稿');await expect(page.locator('.remote-attachment')).toContainText('retained-file.txt');
  const bytes=await page.evaluate(async()=>{const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open('mandala-composer-drafts',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});const values=await new Promise<any[]>((resolve,reject)=>{const request=db.transaction('drafts').objectStore('drafts').getAll();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});const file=values.flatMap(value=>value.files??[]).find(file=>file.name==='retained-file.txt');return file instanceof File?await file.text():null;});
  expect(bytes).toBe('Actual IndexedDB File bytes');expect(sends).toBe(0);await page.screenshot({path:'/tmp/compact-remote-offline-draft-390.png'});
 }finally{await context.close();await fixture.close();}
});
