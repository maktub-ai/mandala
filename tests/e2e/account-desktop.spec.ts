import { test,expect,_electron as electron } from '@playwright/test';
import { mkdtempSync,rmSync,readFileSync,mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve,join } from 'node:path';
import {createControlServer,accountServiceAvailable} from '../helpers/account-service';

test('packaged desktop gates access and restores only the signed-in account data and browser partition',async({browser})=>{
 test.skip(process.env.MANDALA_ACCOUNT_DESKTOP_TEST!=='1'||!accountServiceAvailable,'Requires an explicitly built isolated desktop package');test.setTimeout(180000);
 const {connectService,stopBackgroundService}=createRequire(import.meta.url)('../../desktop/.app/runtime.cjs') as typeof import('../../desktop/runtime');
 const root=mkdtempSync(join(tmpdir(),'mandala-account-desktop-')),home=join(root,'desktop'),controlHome=join(root,'control');let code='';
 const stopRuntime=async()=>{const runtime=await connectService(join(home,'account-gateway'));if(runtime)await stopBackgroundService(runtime);};
 const cloud=createControlServer({home:controlHome,dist:resolve('dist'),auth:{sendCode:async(_email,value)=>{code=value;}}});
 await new Promise<void>(r=>cloud.listen(0,'127.0.0.1',r));const cloudOrigin=`http://127.0.0.1:${(cloud.address() as any).port}`;
 const executablePath=resolve('release/desktop/mac-arm64/Mandala.app/Contents/MacOS/Mandala');
 const shots=process.env.MANDALA_ACCOUNT_SCREENSHOT_DIR;
 if(shots)mkdirSync(shots,{recursive:true});
 const browserStates=new Map<string,Awaited<ReturnType<import('@playwright/test').BrowserContext['storageState']>>>();
 let app:Awaited<ReturnType<typeof electron.launch>>|undefined;
 const launch=async()=>{app=await electron.launch({executablePath,env:{...process.env,MANDALA_HOME:home,OPEN_MANA_HOME:home,MANDALA_ACCOUNT_ORIGIN:cloudOrigin},timeout:30000});const page=await app.firstWindow();await page.waitForLoadState('domcontentloaded');return page;};
 const signIn=async(email:string)=>{
  const page=await launch();await expect(page.getByRole('heading',{name:'Sign in to Mandala'})).toBeVisible();
  expect(await page.evaluate(()=>fetch('/api/conversations').then(r=>r.status))).toBe(401);
  await page.getByRole('button',{name:'Start sign-in',exact:true}).click();const link=page.getByRole('link',{name:'Sign in and approve in your browser'});await expect(link).toBeVisible();
  await expect(page.getByRole('status').filter({hasText:'Waiting for approval in your browser'})).toBeVisible();
  if(shots&&!browserStates.size)await page.locator('.sign-in-card').screenshot({path:join(shots,'desktop-awaiting-approval.png')});
  const context=await browser.newContext({storageState:browserStates.get(email)}),web=await context.newPage();await web.goto((await link.getAttribute('href'))!);
  if(!browserStates.has(email)){
   const emailOption=web.getByRole('button',{name:'Continue with email'});
   const emailField=web.getByRole('textbox',{name:'Email',exact:true});
   await expect(emailOption.or(emailField)).toBeVisible();
   if(await emailOption.isVisible())await emailOption.click();
   await emailField.fill(email);await web.getByRole('button',{name:'Send code',exact:true}).click();await expect(web.getByRole('textbox',{name:'Verification code'})).toBeVisible();await web.getByRole('textbox',{name:'Verification code'}).fill(code);await web.getByRole('button',{name:'Verify and sign in'}).click();
  }
  const profile=web.getByRole('heading',{name:'Set up your profile'}),approve=web.getByRole('button',{name:'Allow this computer'});
  await expect(profile.or(approve)).toBeVisible();
  if(await profile.isVisible()){
   await web.getByRole('textbox',{name:'Username'}).fill(email.split('@')[0]);
   await web.getByRole('button',{name:'Save and continue'}).click();
  }
  await approve.click();browserStates.set(email,await context.storageState());
  await expect(page.getByRole('button',{name:'Open workspace',exact:true})).toBeVisible();
  await app!.evaluate(({app})=>{app.relaunch=()=>{};app.exit=()=>{};});
  await page.getByRole('button',{name:'Open workspace',exact:true}).click();
  await expect.poll(()=>{try{return JSON.parse(readFileSync(join(home,'account-gateway','desktop-accounts.json'),'utf8')).active?.user.email;}catch{return null;}}).toBe(email);
  await app!.close();app=undefined;await context.close();
  const signed=await launch();await expect.poll(()=>signed.evaluate(()=>fetch('/auth/session').then(r=>r.json()).then(s=>s.user?.email))).toBe(email);return signed;
 };
 try{
  const alice=await signIn('alice@example.com');
  await alice.locator('.sidebar-account').click();
  await alice.locator('.sidebar-account-identity').click();
  const png=await alice.evaluate(()=>document.createElement('canvas').toDataURL('image/png').split(',')[1]);
  await alice.locator('.account-avatar-editor input[type=file]').setInputFiles({name:'avatar.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
  await expect(alice.locator('.sidebar-account img')).toHaveAttribute('src',/^data:image\/jpeg;base64,/);
  const computerName=execFileSync('/usr/sbin/scutil',['--get','ComputerName'],{encoding:'utf8'}).trim().slice(0,128);
  const nameField=alice.getByRole('textbox',{name:'Computer name'});
  await expect(nameField).toHaveValue(computerName);
  await nameField.fill('Synthetic workstation');
  await alice.getByRole('button',{name:'Link this computer'}).click();
  await expect(alice.getByRole('heading',{name:'Synthetic workstation'})).toBeVisible();
  const deviceId=await alice.evaluate(()=>fetch('/auth/session').then(r=>r.json()).then(s=>s.connection.device.id));
  await alice.getByText('Rename computer',{exact:true}).click();
  await expect(nameField).toHaveValue('Synthetic workstation');
  await nameField.fill('Renamed workstation');
  await alice.getByRole('button',{name:'Save name'}).click();
  await expect(alice.getByRole('heading',{name:'Renamed workstation'})).toBeVisible();
  const cloudBrowser=await browser.newContext({storageState:browserStates.get('alice@example.com')});
  try{
   const cloudSession=await cloudBrowser.request.get(cloudOrigin+'/auth/session').then(r=>r.json());
   expect(cloudSession.devices).toEqual([expect.objectContaining({id:deviceId,name:'Renamed workstation'})]);
  }finally{await cloudBrowser.close();}
  await alice.evaluate(()=>localStorage.setItem('account-isolation-sentinel','alice only'));
  const chat=await alice.evaluate(async cwd=>{
   const {config,revision}=await fetch('/api/config').then(r=>r.json()),agentId='account-smoke-executor';
   const saved=await fetch('/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision,config:{...config,agents:[...config.agents,{id:agentId,name:'Account smoke executor',defaultCli:'codex',models:{},instructions:'Synthetic smoke',mcp:[],skills:[]}]}})});
   if(!saved.ok)throw Error('Cannot configure smoke Agent: '+saved.status);
   const created=await fetch('/api/conversations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({agentId,cwd,workspaceId:null})});
   if(!created.ok)throw Error('Cannot create smoke conversation: '+created.status);
   return created.json();
  },home);
  const aPartition=await alice.evaluate(()=> (window as any).mandalaDesktop.account.partition);
  await app!.evaluate(({app})=>{app.relaunch=()=>{};app.exit=()=>{};});
  expect(await alice.evaluate(async()=>{const s=await fetch('/auth/session').then(r=>r.json());return fetch('/auth/logout',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':s.csrfToken},body:'{}'}).then(r=>r.status);})).toBe(200);
  await app!.close();app=undefined;
  const bob=await signIn('bob@example.com');
  await expect(bob.locator('.sidebar-account > .sidebar-account-avatar')).toHaveText('B');
  expect(await bob.evaluate(()=>localStorage.getItem('account-isolation-sentinel'))).toBeNull();
  expect(await bob.evaluate(()=> (window as any).mandalaDesktop.account.partition)).not.toBe(aPartition);
  expect(await bob.evaluate(()=>fetch('/api/conversations').then(r=>r.json()))).toEqual([]);
  if(shots)await bob.screenshot({path:join(shots,'desktop-bob-empty.png')});
  await app!.evaluate(({app})=>{app.relaunch=()=>{};app.exit=()=>{};});
  expect(await bob.evaluate(async()=>{const s=await fetch('/auth/session').then(r=>r.json());return fetch('/auth/logout',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':s.csrfToken},body:'{}'}).then(r=>r.status);})).toBe(200);
  await app!.close();app=undefined;
  const returning=await signIn('alice@example.com');
  expect(await returning.evaluate(()=>fetch('/auth/session').then(r=>r.json()).then(s=>s.connection.device))).toMatchObject({id:deviceId,name:'Renamed workstation'});
  expect(await returning.evaluate(()=>localStorage.getItem('account-isolation-sentinel'))).toBe('alice only');
  expect(await returning.evaluate(()=>fetch('/api/conversations').then(r=>r.json()).then(v=>v.map((c:any)=>c.id)))).toContain(chat.id);
  await app!.close();app=undefined;
  await stopRuntime();
  cloud.closeAllConnections();await new Promise<void>(r=>cloud.close(()=>r()));
  const offline=await launch();
  await expect.poll(()=>offline.evaluate(()=>fetch('/auth/session').then(r=>r.json()).then(s=>s.user?.email))).toBe('alice@example.com');
  expect(await offline.evaluate(()=>fetch('/api/conversations').then(r=>r.json()).then(v=>v.map((c:any)=>c.id)))).toContain(chat.id);
  await expect(offline.locator('.sidebar-account img')).toHaveAttribute('src',/^data:image\/jpeg;base64,/);
 }finally{
  if(app)await app.close();await stopRuntime();
  cloud.closeAllConnections();await new Promise<void>(r=>cloud.close(()=>r()));rmSync(root,{recursive:true,force:true});
 }
});
