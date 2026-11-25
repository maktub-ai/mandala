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
  let offline=false, sends=0;
  const uploadBodies:string[]=[];
  await page.route('**/api/remote/transport',async route=>{
   if(offline)return route.abort('internetdisconnected');
   const original=fixture.inspectRequest(route.request().postData()!);
   if(original.method==='POST'&&original.path.includes('/attachments?'))uploadBodies.push(original.body);
   if(original.method==='POST'&&/\/(queue|continue)$/.test(original.path))sends++;
   await route.continue();
  });
  const text='Remote offline draft · 离线草稿',contents='Actual IndexedDB File bytes',fileName='retained-file.txt';
  await message.fill(text);
  await page.locator('input[type=file]').setInputFiles({name:fileName,mimeType:'text/plain',buffer:Buffer.from(contents)});
  await expect.poll(()=>page.evaluate(async({text,contents,fileName})=>{
   const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('mandala-composer-drafts',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
   try{
    const values=await new Promise<any[]>((resolve,reject)=>{const r=db.transaction('drafts').objectStore('drafts').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    const record=values.find(value=>value.format==='remote-composer-v1'&&value.files?.length===1);
    if(!record)return false;
    const raw=JSON.stringify(values)+[record.manifest,...record.files].map(part=>new TextDecoder().decode(part.bytes)).join('');
    return record.files[0].bytes instanceof ArrayBuffer&&record.files[0].bytes.byteLength>contents.length&&[text,fileName,contents].every(secret=>!raw.includes(secret));
   }finally{db.close();}
  },{text,contents,fileName})).toBe(true);
  offline=true;await page.reload();await expect(message).toHaveValue(text);
  await expect(page.locator('.remote-attachment')).toContainText(fileName);
  expect(uploadBodies).toEqual([]);expect(sends).toBe(0);
  offline=false;
  await page.getByRole('button',{name:'刷新远程工作区'}).click();
  await page.getByRole('button',{name:'发送',exact:true}).click();
  await expect.poll(()=>uploadBodies).toEqual([contents]);await expect.poll(()=>sends).toBe(1);
 }finally{await context.close();await fixture.close();}
});
