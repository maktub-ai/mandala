import { test, expect } from '@playwright/test';
import { storedUiState } from './helpers/preferences';
import { defaultPreferences } from '../../src/themes';
test.use({ storageState: storedUiState('en') });
let inputAgentId:string;
test.beforeEach(async ({ request }, testInfo) => {
 inputAgentId='input-agent-'+testInfo.testId.replace(/[^a-zA-Z0-9]/g,'').slice(-16);
 const snapshot = await (await request.get('/api/config')).json();
 expect((await request.put('/api/config', { data: { revision: snapshot.revision, config: { version: 2, projects: [], agents: [{ id: inputAgentId, name: 'Input Agent', instructions: 'Synthetic input test', defaultCli: 'codex', models: {}, mcp: [], skills: [] }] } } })).ok()).toBe(true);
});

test('directories remain folder cards and send their paths alongside ordinary attachments', async ({ page, request }) => {
 await page.addInitScript(() => { (window as any).mandalaDesktop = { files: { directoryPath: (file: File) => file.name === 'erp-backend' ? '/synthetic/erp backend' : null } }; });
 await page.goto('/?agent='+inputAgentId);
 const input = page.getByRole('textbox', { name: 'Message', exact: true }); await expect(input).toBeEnabled(); await input.fill('Inspect these paths');
 await page.locator('input[type=file]').setInputFiles([{ name: 'erp-backend', mimeType: '', buffer: Buffer.alloc(1024) }, { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Keep as file') }]);
 await expect(input).toHaveValue('Inspect these paths');
 const folder = page.getByRole('group', {name:'Folder erp-backend',exact:true});
 await expect(folder).toHaveAttribute('title','/synthetic/erp backend');
 await expect(page.locator('.composer-attachments')).toContainText('notes.txt');
 for (const [mode,width] of [['light',1440],['dark',390]] as const) {
  await page.evaluate(value=>{localStorage.setItem('mandala-appearance-v1',value);dispatchEvent(new StorageEvent('storage',{key:'mandala-appearance-v1',newValue:value}));},JSON.stringify({...defaultPreferences(),mode}));
  await page.setViewportSize({width,height:850}); await expect(folder).toBeInViewport();
  await page.screenshot({animations:'disabled',path:`/tmp/mandala-folder-card-${mode}-${width}.png`});
 }
 await page.setViewportSize({width:1280,height:850});
 await page.reload(); await expect(input).toHaveValue('Inspect these paths'); await expect(folder).toHaveAttribute('title','/synthetic/erp backend');
 const uploads:string[]=[]; page.on('request',request=>{if(request.method()==='POST'&&request.url().includes('/attachments?'))uploads.push(new URL(request.url()).searchParams.get('name')!);});
 const queued=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith('/queue'));
 await page.getByRole('button',{name:'Send message',exact:true}).click(); const response=await queued;
 expect(response.request().postDataJSON().text).toBe('Inspect these paths\n/synthetic/erp backend'); expect(uploads).toEqual(['notes.txt']);
 const id=new URL(response.url()).pathname.split('/')[3];
 await expect.poll(async()=>{const history=await(await request.get(`/api/conversations/${id}/history`)).json();return history.filter((event:any)=>event.kind==='user').at(-1)?.data.text;}).toBe('Inspect these paths\n/synthetic/erp backend');
 await expect(input).toHaveValue(''); await expect(folder).toHaveCount(0);
});

for (const mimeType of ['text/plain', '']) test(`text attachment ${mimeType || 'by extension'} edits persist and send full edited bytes`, async ({ page, request }) => {
 await page.goto('/?agent='+inputAgentId); const input = page.getByRole('textbox', { name: 'Message', exact: true }); await expect(input).toBeEnabled(); await input.fill('Read this quote');
 const original = 'Original quoted content\n' + 'full content '.repeat(6000);
 await page.locator('input[type=file]').setInputFiles({ name: 'quote.txt', mimeType, buffer: Buffer.from(original) });
 const preview = () => page.getByRole('button', { name: 'Preview text quote.txt', exact: true }); await preview().click();
 const dialog = page.getByRole('dialog', { name: 'Text preview', exact: true }); await expect(dialog.locator('pre')).toHaveText(original.slice(0, 64 * 1024));
 await dialog.getByRole('button', { name: 'Edit text', exact: true }).click();
 await dialog.getByRole('textbox', { name: 'Attachment text', exact: true }).fill('Cancelled edit'); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(dialog.locator('pre')).toHaveText(original.slice(0, 64 * 1024));
 await dialog.getByRole('button', { name: 'Edit text', exact: true }).click(); const prefix = 'Edited quote · 中文\n', edited = prefix + original;
 const editor = dialog.getByRole('textbox', { name: 'Attachment text', exact: true }); await expect(editor).toHaveValue(original); await editor.focus(); await editor.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 0)); await page.keyboard.insertText(prefix); await expect(editor).toHaveValue(edited);
 if (mimeType === 'text/plain') {
  for (const colorScheme of ['light', 'dark'] as const) for (const width of [1440, 390]) {
   await page.evaluate(value => { localStorage.setItem('mandala-appearance-v1',value); dispatchEvent(new StorageEvent('storage',{key:'mandala-appearance-v1',newValue:value})); }, JSON.stringify({...defaultPreferences(),mode:colorScheme})); await page.setViewportSize({ width, height: 850 });
   await expect.poll(async () => { const bounds=await dialog.boundingBox(); return !!bounds && bounds.x >= 8 && bounds.x + bounds.width <= width - 8; }).toBe(true);
   await expect(dialog.getByRole('button', { name: 'Save changes', exact: true })).toBeInViewport();
   expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
   await page.screenshot({ animations: 'disabled', path: `/tmp/mandala-text-editor-${colorScheme}-${width}.png` });
  }
  await page.setViewportSize({ width: 1280, height: 850 });
 }
 await dialog.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(dialog.getByRole('button', { name: 'Edit text', exact: true })).toBeEnabled(); await page.keyboard.press('Escape');
 await page.reload(); await preview().click(); await dialog.getByRole('button', { name: 'Edit text', exact: true }).click(); await expect(dialog.getByRole('textbox', { name: 'Attachment text', exact: true })).toHaveValue(edited); await page.keyboard.press('Escape');
 const upload = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/attachments?'));
 await page.getByRole('button', { name: 'Send message', exact: true }).click(); const response = await upload, attachment = await response.json();
 const id = new URL(response.url()).pathname.split('/')[3]; expect(await (await request.get(`/api/conversations/${id}/attachments/${attachment.id}?download=1`)).text()).toBe(edited);
});


for (const failure of ['server', 'browser']) test(`failed ${failure} text edit save retains the input and can be retried`, async ({ page }) => {
 await page.goto('/?agent='+inputAgentId); await expect(page.getByRole('textbox', {name:'Message',exact:true})).toBeEnabled();
 await page.locator('input[type=file]').setInputFiles({name:'quote.txt',mimeType:'text/plain',buffer:Buffer.from('Original quote')});
 await page.getByRole('button',{name:'Preview text quote.txt',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Text preview',exact:true}); await dialog.getByRole('button',{name:'Edit text',exact:true}).click();
 const editor=dialog.getByRole('textbox',{name:'Attachment text',exact:true}); await editor.fill(''); await expect(dialog.getByRole('button',{name:'Save changes',exact:true})).toBeDisabled();
 await editor.fill('Retained after failed save');
 if (failure === 'server') await page.route('**/api/drafts/entry',route=>route.request().method()==='PUT'?route.fulfill({status:503,json:{error:'Synthetic save failure'}}):route.continue());
 else await page.evaluate(() => { const put=IDBObjectStore.prototype.put; (window as any).__restoreDraftWrites=()=>{IDBObjectStore.prototype.put=put;}; IDBObjectStore.prototype.put=function(){throw new DOMException('Synthetic byte storage failure','QuotaExceededError');}; });
 await dialog.getByRole('button',{name:'Save changes',exact:true}).click(); await expect(dialog.getByRole('alert')).toContainText('Unable to save changes'); await expect(editor).toHaveValue('Retained after failed save');
 if (failure === 'server') await page.unroute('**/api/drafts/entry'); else await page.evaluate(()=>(window as any).__restoreDraftWrites()); await dialog.getByRole('button',{name:'Save changes',exact:true}).click(); await expect(dialog.getByRole('button',{name:'Edit text',exact:true})).toBeEnabled(); await expect(dialog.locator('pre')).toHaveText('Retained after failed save');
 await page.keyboard.press('Escape'); await page.reload(); await page.getByRole('button',{name:'Preview text quote.txt',exact:true}).click(); await expect(dialog.locator('pre')).toHaveText('Retained after failed save');
});

test('typing keeps routine draft feedback invisible and the composer height stable while saving', async ({ page }) => {
 await page.goto('/?agent='+inputAgentId); const input=page.getByRole('textbox',{name:'Message',exact:true}); await expect(input).toBeEnabled();
 const composer=page.locator('.composer'), height=(await composer.boundingBox())!.height;
 let release:()=>void=()=>{}, saving=false; const pending=new Promise<void>(resolve=>{release=resolve;});
 await page.route('**/api/drafts/entry',async route=>{if(route.request().method()==='PUT'){saving=true;await pending;}await route.continue();});
 try {
  await input.fill('字'); await expect.poll(()=>saving).toBe(true);
  await expect(page.locator('.composer-draft-feedback')).toHaveCount(0);
  expect((await composer.boundingBox())!.height).toBeCloseTo(height,0);
 } finally { release(); }
 await expect(page.locator('.composer-draft-feedback')).toHaveCount(0);
});

test('folder-only sends recover a lost acknowledgment without duplicating paths or uploading a directory', async ({ page, request }) => {
 await page.addInitScript(()=>{(window as any).mandalaDesktop={files:{directoryPath:()=>'/synthetic/data pipeline'}};});
 await page.goto('/?agent='+inputAgentId); const input=page.getByRole('textbox',{name:'Message',exact:true}); await expect(input).toBeEnabled();
 await page.locator('input[type=file]').setInputFiles({name:'data-pipeline',mimeType:'',buffer:Buffer.alloc(1024)});
 let online=false,posts=0,uploads=0,id='';
 page.on('request',request=>{if(request.method()==='POST'&&request.url().includes('/attachments?'))uploads++;});
 await page.route('**/api/conversations/*/queue',async route=>{
  if(route.request().method()==='POST'){posts++;id=new URL(route.request().url()).pathname.split('/')[3];await route.fetch();await route.abort();}
  else if(!online)await route.abort();else await route.continue();
 });
 await page.getByRole('button',{name:'Send message',exact:true}).click(); await expect(page.getByRole('button',{name:'Check previous send',exact:true})).toBeEnabled();
 await page.reload(); await expect(page.getByRole('group',{name:'Folder data-pipeline',exact:true})).toBeVisible();
 online=true;await page.getByRole('button',{name:'Check previous send',exact:true}).click();await expect(page.getByRole('group',{name:'Folder data-pipeline',exact:true})).toHaveCount(0);
 const history=await(await request.get(`/api/conversations/${id}/history`)).json();expect(history.filter((event:any)=>event.kind==='user').map((event:any)=>event.data.text)).toEqual(['/synthetic/data pipeline']);expect(posts).toBe(1);expect(uploads).toBe(0);
});
