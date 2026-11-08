import {accountServiceAvailable,createControlServer} from '../helpers/account-service';
import { openAccountConnection } from './helpers/navigation';
import { test, expect } from '@playwright/test';
import { once } from 'node:events';
test('phone requires account login and an approved computer before showing private workspace',async({page})=>{
 await page.setViewportSize({width:390,height:844});let logged=false,selected=false,approved=false;
 await page.route('**/auth/session',route=>route.fulfill({json:{mode:'control',user:logged?{id:'owner',username:'personal'}:null,csrfToken:logged?'verification':undefined,selectedDeviceId:selected?'computer':null,devices:logged?[{id:'computer',name:'Personal computer',online:true,grant:approved?'approved':'pending'}]:[]}}));
 await page.route('**/auth/login',route=>{logged=true;return route.fulfill({json:{user:{id:'owner',username:'personal'},csrfToken:'verification'}});});
 await page.route('**/connect/select',route=>{selected=true;return route.fulfill({json:{ok:true}});});
 await page.goto('/');
 await expect(page.getByRole('heading',{name:'登录 Mandala'})).toBeVisible();
 await page.getByLabel('账号',{exact:true}).fill('personal');await page.getByLabel('密码',{exact:true}).fill('personal-example-password');
 await page.getByRole('button',{name:'登录',exact:true}).click();
 await expect(page.getByText('等待电脑确认')).toBeVisible();
 await expect(page.getByRole('button',{name:'连接',exact:true})).toBeDisabled();
 approved=true;await page.getByRole('button',{name:'刷新',exact:true}).click();
 await expect(page.getByRole('button',{name:'连接',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'连接',exact:true}).click();
 await expect(page.getByRole('heading',{name:'配对这台电脑',exact:true})).toBeVisible();
 await expect(page.locator('.remote-workspace')).toHaveCount(0);
 await page.getByLabel('电脑配对码',{exact:true}).fill('not-a-host-key');await page.getByRole('button',{name:'确认配对',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('配对码无效');await expect(page.locator('.remote-workspace')).toHaveCount(0);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('real local and account services complete phone request, computer approval, history read and revocation',async({page,browser})=>{
 test.skip(!accountServiceAvailable,'Set MANDALA_ACCOUNT_SERVICE_SOURCE for cross-repository relay integration');
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join,resolve}=await import('node:path');
 const {openAccountStore}=await import('../../server/account-store');const {openStore}=await import('../../server/store');const {readConfig}=await import('../../server/config');const {createSessionManager}=await import('../../server/sessions');const {createHttpServer}=await import('../../server/http');
 const home=mkdtempSync(join(tmpdir(),'mana-personal-browser-')),controlHome=mkdtempSync(join(tmpdir(),'mana-account-browser-')),password='synthetic-personal-password';
 await openAccountStore(home).createUser('personal',password);await openAccountStore(controlHome).createUser('personal',password);
 const store=openStore(home),conversation=store.createConversation({projectId:'',agentId:'',cli:'codex',model:null});store.appendEvent(conversation.id,'user',{text:'Retained personal conversation'});store.appendEvent(conversation.id,'text',{text:'Local history remains on computer'});
 const manager=createSessionManager(store,async()=>(await readConfig(home)).config),local=createHttpServer({home,store,manager,requireIdentity:true}),control=createControlServer({home:controlHome,dist:resolve('dist')});
 local.listen(0,'127.0.0.1');control.listen(0,'127.0.0.1');await Promise.all([once(local,'listening'),once(control,'listening')]);
 const url=(server:typeof local)=>`http://127.0.0.1:${(server.address() as {port:number}).port}`,computerContext=await browser.newContext(),computer=await computerContext.newPage();
 const signIn=async(p:typeof page,origin:string)=>{await p.addInitScript(()=>localStorage.setItem('mana-language','zh-CN'));await p.goto(origin);await p.getByLabel('账号',{exact:true}).fill('personal');await p.getByLabel('密码',{exact:true}).fill(password);await p.getByRole('button',{name:'登录',exact:true}).click();};
 try{
  await signIn(computer,url(local));await openAccountConnection(computer);
  await expect(computer.getByText('官方连接服务尚未开放。',{exact:true})).toBeVisible();await expect(computer.getByRole('button',{name:'官方连接服务尚未开放',exact:true})).toHaveCount(0);
  await computer.locator('summary').filter({hasText:'高级：自部署连接服务'}).click();
  await computer.getByLabel('账号服务地址',{exact:true}).fill(url(control));await computer.getByLabel('电脑名称',{exact:true}).fill('Personal computer');await computer.getByLabel('服务账号',{exact:true}).fill('personal');await computer.getByLabel('服务密码',{exact:true}).fill('wrong-password');await computer.getByRole('button',{name:'连接账号服务',exact:true}).click();
  await expect(computer.getByRole('alert')).toContainText('连接服务失败');await expect(computer.getByRole('alert')).toBeFocused();await expect(computer.getByLabel('电脑名称',{exact:true})).toHaveValue('Personal computer');
  await computer.getByLabel('服务密码',{exact:true}).fill(password);await computer.getByRole('button',{name:'连接账号服务',exact:true}).click();
  await expect(computer.getByText('设备授权',{exact:true})).toBeVisible();
  await expect(computer.getByText(url(control),{exact:true})).toBeVisible();
  const pairingCode=await computer.getByLabel('电脑配对码',{exact:true}).textContent();
  await page.setViewportSize({width:390,height:844});await signIn(page,url(control));await page.getByRole('button',{name:'请求授权',exact:true}).click();await expect(page.getByText('等待电脑确认')).toBeVisible();
  await expect(computer.getByRole('button',{name:'批准',exact:true})).toBeVisible();await computer.getByRole('button',{name:'批准',exact:true}).click();await page.getByRole('button',{name:'刷新',exact:true}).click();await page.getByRole('button',{name:'连接',exact:true}).click();
  await expect(page.getByRole('heading',{name:'配对这台电脑',exact:true})).toBeVisible();await page.getByLabel('电脑配对码',{exact:true}).fill(pairingCode!);await page.getByRole('button',{name:'确认配对',exact:true}).click();
  await page.goto(url(control)+`/chat?conversation=${conversation.id}`);await expect(page.getByText('Local history remains on computer',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'配置概览',exact:true}).click();await expect(page.getByText('配置修改在电脑上完成；这里只展示获准读取的概览。')).toBeVisible();await expect(page.locator('input,textarea')).toHaveCount(0);
  await computer.getByRole('button',{name:'撤销',exact:true}).click();await expect(page.getByText('已撤销',{exact:false})).toBeVisible({timeout:10000});
  expect((await page.request.get(url(control)+`/api/conversations/${conversation.id}/history`)).status()).toBe(403);
  await page.getByRole('button',{name:'请求授权',exact:true}).click();await computer.getByRole('button',{name:'批准',exact:true}).click();await page.goto(url(control)+`/chat?conversation=${conversation.id}`);await expect(page.getByText('Local history remains on computer',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }finally{await computerContext.close();await Promise.all([new Promise<void>(r=>{local.close(()=>r());local.closeAllConnections();}),new Promise<void>(r=>{control.close(()=>r());control.closeAllConnections();})]);await manager.close();store.close();rmSync(home,{recursive:true,force:true});rmSync(controlHome,{recursive:true,force:true});}
});

test('a late focus session response cannot restore the signed-out identity',async({page})=>{
 const signedIn={mode:'control',user:{id:'owner',username:'synthetic'},csrfToken:'synthetic-csrf',selectedDeviceId:null,devices:[]};
 let logged=true,holdNext=false,release!:()=>Promise<void>,held!:()=>void;
 const heldRequest=new Promise<void>(resolve=>{held=resolve;});
 await page.addInitScript(()=>localStorage.setItem('mana-language','zh-CN'));
 await page.route('**/auth/session',route=>{
  if(holdNext){holdNext=false;release=()=>route.fulfill({json:signedIn});held();return;}
  return route.fulfill({json:{...signedIn,user:logged?signedIn.user:null}});
 });
 await page.route('**/auth/logout',route=>{logged=false;return route.fulfill({json:{ok:true}});});
 await page.goto('/');await expect(page.getByRole('button',{name:'退出登录',exact:true})).toBeVisible();
 holdNext=true;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await heldRequest;
 await page.getByRole('button',{name:'退出登录',exact:true}).click();
 await expect(page.getByRole('heading',{name:'登录 Mandala',exact:true})).toBeVisible();
 const delivered=page.waitForEvent('requestfinished',request=>request.url().endsWith('/auth/session'));
 await release();await delivered;
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await expect(page.getByRole('heading',{name:'登录 Mandala',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'退出登录',exact:true})).toHaveCount(0);
 await page.screenshot({path:test.info().outputPath('signed-out-after-stale-response.png'),fullPage:true});
});
