import { expect,test } from '@playwright/test';
import { storedUiState } from './helpers/preferences';
test.use({storageState:storedUiState('en')});
test.beforeEach(async({request})=>{const snapshot=await(await request.get('/api/config')).json();expect((await request.put('/api/config',{data:{revision:snapshot.revision,config:{version:2,projects:[],agents:[{id:'chat-draft-agent',name:'Draft Agent',instructions:'Inspect synthetic evidence',defaultCli:'codex',models:{},mcp:[],skills:[]}]}}})).ok()).toBe(true);});
test('first Chat handoff retains original unknown recovery and later checks without a second POST',async({page,request})=>{
 await page.goto('/?agent=chat-draft-agent');const composer=page.getByRole('textbox',{name:'Message',exact:true});await expect(composer).toBeEnabled();await composer.fill('First Chat unknown draft');
 let online=false,posts=0;await page.route('**/api/conversations/*/queue',async route=>{if(route.request().method()==='POST'){posts++;await route.fetch();await route.abort();}else if(!online)await route.abort();else await route.continue();});
 const send=page.getByRole('button',{name:'Send message',exact:true});await expect(send).toBeEnabled();await send.click();await expect(page).toHaveURL(/conversation=/);
 await expect(page.getByRole('button',{name:'Check previous send',exact:true})).toBeEnabled();await page.reload();await expect(composer).toHaveValue('First Chat unknown draft');await expect(page.getByRole('button',{name:'Check previous send',exact:true})).toBeEnabled();
 const rows=await(await request.get('/api/drafts')).json();expect(rows.entries.some((entry:any)=>entry.scope.conversationId===''&&entry.draft.text==='First Chat unknown draft')).toBe(false);
 online=true;await page.getByRole('button',{name:'Check previous send',exact:true}).click();await expect(composer).toHaveValue('');expect(posts).toBe(1);
});
test('first Chat preserves input typed after handoff while its original queue acknowledgment is delayed',async({page})=>{
 await page.goto('/?agent=chat-draft-agent');const composer=page.getByRole('textbox',{name:'Message',exact:true});await expect(composer).toBeEnabled();await composer.fill('Original first Chat request');
 let release:()=>void=()=>{};const acknowledgment=new Promise<void>(resolve=>{release=resolve;});let posted=false;
 await page.route('**/api/conversations/*/queue',async route=>{if(route.request().method()==='POST'){posted=true;const response=await route.fetch();await acknowledgment;await route.fulfill({response});}else await route.continue();});
 await page.getByRole('button',{name:'Send message',exact:true}).click();await expect.poll(()=>posted).toBe(true);await expect(page).toHaveURL(/conversation=/);await composer.fill('New input after Chat handoff');release();
 await expect(page.getByRole('button',{name:'Send message',exact:true})).toBeEnabled();await expect(composer).toHaveValue('New input after Chat handoff');await page.reload();await expect(composer).toHaveValue('New input after Chat handoff');
});
for(const autosaved of [true,false])test(`background first Chat completes with ${autosaved?'saved':'buffered'} target edits and File bytes intact`,async({page,request})=>{
 let releaseCreation:()=>void=()=>{},releaseAck:()=>void=()=>{};const creation=new Promise<void>(resolve=>{releaseCreation=resolve;}),ack=new Promise<void>(resolve=>{releaseAck=resolve;});let creating=false,posted=false,id='',posts=0,blockDraft=!autosaved;
 await page.route('**/api/conversations',async route=>{if(route.request().method()==='POST'){creating=true;await creation;}await route.continue();});
 await page.route('**/api/conversations/*/queue',async route=>{if(route.request().method()==='POST'){posts++;id=new URL(route.request().url()).pathname.split('/')[3];const response=await route.fetch();posted=true;await ack;await route.fulfill({response});}else await route.continue();});
 await page.route('**/api/drafts/entry',async route=>{if(blockDraft&&route.request().method()==='PUT'&&route.request().postDataJSON().draft.text==='New background target input')await route.abort();else await route.continue();});
 await page.goto('/?agent=chat-draft-agent');const composer=page.getByRole('textbox',{name:'Message',exact:true});await expect(composer).toBeEnabled();await composer.fill('Background original request');await page.getByRole('button',{name:'Send message',exact:true}).click();await expect.poll(()=>creating).toBe(true);
 await page.evaluate(()=>{history.pushState(null,'','/settings/general');dispatchEvent(new PopStateEvent('popstate'));});await expect(page).toHaveURL(/settings\/general$/);releaseCreation();await expect.poll(()=>posted).toBe(true);await expect(page).toHaveURL(/settings\/general$/);
 await page.evaluate(path=>{history.pushState(null,'',path);dispatchEvent(new PopStateEvent('popstate'));},'/?conversation='+id);await expect(composer).toBeEnabled();await composer.fill('New background target input');await page.locator('input[type=file]').setInputFiles({name:'background-new.txt',mimeType:'text/plain',buffer:Buffer.from('New target File bytes')});
 if(autosaved)await expect.poll(async()=>{const data=await(await request.get('/api/drafts')).json();return data.entries.some((entry:any)=>entry.scope.conversationId===id&&entry.draft.text==='New background target input'&&entry.draft.attachments?.length===1);}).toBe(true);
 blockDraft=false;releaseAck();await expect.poll(async()=>{const data=await(await request.get('/api/drafts')).json();return data.pending.some((entry:any)=>entry.scope.conversationId===id);}).toBe(false);
 await expect(page.getByRole('button',{name:'Check previous send',exact:true})).toHaveCount(0);await expect(page.locator('.composer-recovery-notice')).toHaveCount(0);await expect(composer).toHaveValue('New background target input');expect(posts).toBe(1);
 await page.reload();await expect(composer).toHaveValue('New background target input');await expect(page.locator('.composer-attachments')).toContainText('background-new.txt');await expect(page.getByText('Reselect attachments:',{exact:false})).toHaveCount(0);
});
