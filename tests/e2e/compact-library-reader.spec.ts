import {expect,test,type APIRequestContext} from '@playwright/test';
import {storedUiState} from './helpers/preferences';
import {chooseOption} from './helpers/select';
test.use({storageState:storedUiState('en'),viewport:{width:1440,height:950}});
async function document(request:APIRequestContext,text:string){const stage=await(await request.post('/api/v2/assets/uploads?name=reader.txt',{data:text})).json();return await(await request.post('/api/v2/assets/imports',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{kind:'document',title:'Reader '+Date.now(),submissionId:stage.submissionId}})).json();}

test('real document edits lock navigation and fixed versions, retain conflicts, and publish only after explicit latest-base review',async({page,request})=>{
 const original='Original source\n\nExact first version.',saved=await document(request,original),path='/api/v2/assets/'+saved.asset.id;
 await page.goto('/library');await page.goto('/library/'+saved.asset.id+'?project=');
 await expect(page.locator('.asset-content')).toContainText(original);
 await page.getByRole('button',{name:'Edit file',exact:true}).click();const body=page.getByRole('textbox',{name:'Document body',exact:true});await body.fill('My retained edit');
 await expect(page.getByRole('combobox',{name:'Fixed version',exact:true})).toBeDisabled();
 await expect(page.locator('aside.sidebar [data-area=projects]')).toHaveAttribute('aria-disabled','true');
 await expect(page.getByRole('button',{name:'Cancel editing',exact:true})).toBeEnabled();
 const source=await document(request,'Latest provenance source'),refs=[{assetId:source.asset.id,versionId:source.version.id}];
 const stage=await(await request.post('/api/v2/assets/uploads?name=concurrent.txt',{data:'Concurrent saved edit'})).json();
 const next=await request.post(path+'/versions',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{expectedHeadVersionId:saved.version.id,submissionId:stage.submissionId,provenance:{sourceVersions:refs}}});expect(next.ok()).toBe(true);
 await page.getByRole('button',{name:'Publish new version',exact:true}).click();await expect(page.getByRole('alert')).toBeVisible();await expect(body).toHaveValue('My retained edit');
 await page.getByRole('button',{name:'Read latest version',exact:true}).click();await expect(page.locator('.asset-latest-preview')).toContainText('Concurrent saved edit');await expect(body).toHaveValue('My retained edit');
 await page.getByRole('button',{name:'Keep my draft and use this version as the base',exact:true}).click();await page.getByRole('button',{name:'Publish new version',exact:true}).click();
 await expect(body).toHaveCount(0);await expect(page.locator('.asset-content')).toContainText('My retained edit');const published=await(await request.get(path+'/versions')).json();expect(published).toHaveLength(3);expect(published[0].provenance.sourceVersions).toEqual(refs);expect(published[0].files[0].path).toBe('concurrent.txt');expect(await(await request.get(path+'/versions/'+saved.version.id+'/files/0')).text()).toBe(original);
 await page.goto('/assets/'+saved.asset.id+'?version='+saved.version.id);await expect(page.locator('.asset-content')).toContainText(original);await expect(page.getByRole('button',{name:'Edit file',exact:true})).toHaveCount(0);
});

test('Wiki page edits retain a fixed edit base and require explicit conflict readback while page/version navigation stays locked',async({page,request})=>{
 const seeded=await(await request.post('/__test__/wiki/seed')).json(),id=seeded.base.id;
 await page.goto('/library/'+id+'?page=retention');await expect(page.locator('.wiki-reader')).toContainText('记录已发布的保留策略');
 await page.getByRole('button',{name:'Edit body',exact:true}).click();const body=page.getByRole('textbox',{name:'Page body',exact:true});await body.fill('My Wiki draft');
 await expect(page.locator('.wiki-directory').getByRole('button').first()).toBeDisabled();await expect(page.locator('aside.sidebar [data-area=projects]')).toHaveAttribute('aria-disabled','true');
 const current=await(await request.get('/api/v2/knowledge-bases/'+id+'/pages/retention')).json();expect((await request.put('/api/v2/knowledge-bases/'+id+'/pages/retention',{data:{body:'Concurrent Wiki edit',expectedHeadVersionId:current.versionId}})).ok()).toBe(true);
 await page.getByRole('button',{name:'Save body',exact:true}).click();await expect(page.locator('.wiki-conflict-readback')).toBeVisible();await expect(body).toHaveValue('My Wiki draft');
 await page.getByRole('button',{name:'Read latest version',exact:true}).click();await expect(page.locator('.wiki-comparison')).toContainText('Concurrent Wiki edit');await expect(body).toHaveValue('My Wiki draft');
 await page.getByRole('button',{name:'Keep my draft and use this version as the base',exact:true}).click();await page.getByRole('button',{name:'Save body',exact:true}).click();await expect(page.locator('.wiki-reader')).toContainText('My Wiki draft');
 expect((await(await request.get('/api/v2/knowledge-bases/'+id)).json()).maintainerAgentId).toBe('wiki-maintainer');
});

test('Wiki creation requires an explicit Project and optional maintenance preserves Project ownership',async({page,request})=>{
 await request.post('/__test__/wiki/seed');await page.goto('/library');await page.getByRole('button',{name:'New',exact:true}).click();await page.getByRole('menuitem',{name:'New knowledge base',exact:true}).click();
 await page.getByRole('textbox',{name:'Knowledge base name',exact:true}).fill('Explicit ownership');await page.getByRole('textbox',{name:'Knowledge base purpose',exact:true}).fill('Keep verified review evidence.');
 await expect(page.getByRole('combobox',{name:'Owning Project',exact:true})).toHaveAttribute('data-value','');await expect(page.getByRole('combobox',{name:'Maintaining Agent (optional)',exact:true})).toHaveAttribute('data-value','');await expect(page.getByRole('button',{name:'Create knowledge base',exact:true})).toBeDisabled();
 await chooseOption(page,'Owning Project','wiki-fixture-project');await chooseOption(page,'Maintaining Agent (optional)','wiki-maintainer');await page.getByRole('button',{name:'Create knowledge base',exact:true}).click();await expect(page).toHaveURL(/\/library\/[^?]+\?project=wiki-fixture-project$/);await expect(page.locator('.wiki-reader')).toContainText('No sources yet.');
 const id=new URL(page.url()).pathname.split('/')[2],base=await(await request.get('/api/v2/knowledge-bases/'+id)).json(),asset=await(await request.get('/api/v2/assets/'+id)).json();expect(base.maintainerAgentId).toBe('wiki-maintainer');expect(asset.owner.projectId).toBe('wiki-fixture-project');expect(asset.owner.agentId).toBeUndefined();expect(base.reception.enabled).toBe(false);expect(base.automatic).toBe(false);
});

test('real source withdrawal blocks historical Wiki content instead of exposing the last rendered page',async({page,request})=>{
 const seeded=await(await request.post('/__test__/wiki/seed')).json(),id=seeded.base.id,version=seeded.base.headVersionId;
 await page.goto('/library/'+id+'?page=retention');await expect(page.locator('.wiki-reader')).toContainText('记录已发布的保留策略');await page.getByRole('button',{name:'Edit body',exact:true}).click();await page.getByRole('textbox',{name:'Page body',exact:true}).fill('Private unsaved knowledge');expect((await request.delete('/api/v2/knowledge-bases/'+id+'/sources/'+seeded.base.sources[0].id)).ok()).toBe(true);await expect(page.getByRole('textbox',{name:'Page body',exact:true})).toHaveCount(0);await expect(page.locator('.wiki-reader')).not.toContainText('日志保留 30 天。');
 await page.goto('/assets/'+id+'?page=retention&version='+version);await expect(page.getByRole('alert').first()).toBeVisible();await expect(page.locator('.wiki-reader')).not.toContainText('日志保留 30 天。');await expect(page.getByRole('link',{name:'Back to Library',exact:true})).toBeVisible();expect((await request.get('/api/v2/knowledge-bases/'+id+'/pages/retention?version='+version)).status()).toBe(403);
});

 test('late Library metadata cannot remount a reader with an unsaved edit',async({page,request})=>{
 const saved=await document(request,'Stable reader body');let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
 await page.route('**/api/v2/assets',async route=>{const response=await route.fetch();await gate;await route.fulfill({response});});
 await page.goto('/library/'+saved.asset.id);await page.getByRole('button',{name:'Edit file',exact:true}).click();const body=page.getByRole('textbox',{name:'Document body',exact:true});await body.fill('Keep this unsaved edit');release();
 await expect(page.locator('.library-resource-row').first()).toBeVisible();await expect(body).toHaveValue('Keep this unsaved edit');await page.getByRole('button',{name:'Cancel editing',exact:true}).click();
 });

 test('Wiki evidence is disclosed without rewriting immutable Markdown or legacy dialogue destinations',async({page,request})=>{
 const seeded=await(await request.post('/__test__/wiki/seed')).json(),id=seeded.base.id,path='/api/v2/knowledge-bases/'+id+'/pages/retention';const original=await(await request.get(path)).json();
 await page.route('**'+path,async route=>{const response=await route.fetch();const value=await response.json();value.body+='\n\n[Saved conversation](/chat/legacy-chat)';value.markdown=value.markdown.replace(original.body,value.body);await route.fulfill({response,json:value});});
 await page.goto('/library/'+id+'?page=retention');await expect(page.getByRole('status').filter({hasText:'Sources conflict'})).toBeVisible();await expect(page.getByText('日志保留 30 天。',{exact:true}).first()).not.toBeVisible();await expect(page.getByRole('link',{name:'Saved conversation',exact:true})).toHaveAttribute('href','/?conversation=legacy-chat');
 await page.getByText('Evidence · 2',{exact:true}).click();await expect(page.locator('.wiki-page-evidence blockquote').first()).toContainText('日志保留 30 天。');await expect(page.locator('.wiki-page-evidence a').first()).toHaveAttribute('href',/\/library\/[^?]+\?version=/);expect((await(await request.get(path)).json()).markdown).toBe(original.markdown);
 });
