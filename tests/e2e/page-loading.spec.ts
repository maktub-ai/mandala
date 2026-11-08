import {test,expect} from '@playwright/test';

test('starts task control and detail reads together',async({page,request})=>{
 const created=await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{goal:'Parallel task detail fixture'}});expect(created.ok()).toBe(true);const task=await created.json();
 let release!:()=>void;const held=new Promise<void>(resolve=>release=resolve);let detailStarted=false;
 await page.route('**/api/v2/tasks/'+task.id+'/control',async route=>{await held;await route.continue();});
 await page.route('**/api/v2/tasks/'+task.id,async route=>{detailStarted=true;await route.continue();});
 try{await page.goto('/tasks/'+task.id);await expect.poll(()=>detailStarted,{timeout:1500}).toBe(true);}finally{release();}
 await expect(page.locator('.task-title')).toContainText('Parallel task detail fixture');
});

test('file preview does not wait for the view receipt',async({page,request})=>{
 const stage=await(await request.post('/api/v2/assets/uploads?name=parallel.md',{data:'# Parallel preview body'})).json();
 const saved=await(await request.post('/api/v2/assets/imports',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{kind:'document',title:'Parallel preview',submissionId:stage.submissionId}})).json();
 let release!:()=>void;const held=new Promise<void>(resolve=>release=resolve);
 await page.route('**/api/v2/assets/'+saved.asset.id+'/activity',async route=>{await held;await route.continue();});
 try{await page.goto('/assets/'+saved.asset.id);await expect(page.locator('.asset-content')).toContainText('Parallel preview body',{timeout:2000});}finally{release();}
});

test('file preview does not wait for the version history',async({page,request})=>{
 const stage=await(await request.post('/api/v2/assets/uploads?name=history.md',{data:'# Preview before history'})).json();
 const saved=await(await request.post('/api/v2/assets/imports',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{kind:'document',title:'Deferred version history',submissionId:stage.submissionId}})).json();
 let release!:()=>void;const held=new Promise<void>(resolve=>release=resolve);
 await page.route('**/api/v2/assets/'+saved.asset.id+'/versions',async route=>{await held;await route.continue();});
 try{await page.goto('/assets/'+saved.asset.id);await expect(page.locator('.asset-content')).toContainText('Preview before history',{timeout:2000});}finally{release();}
});

for(const denied of ['source','activity'])test('ignores late file content after '+denied+' access is denied',async({page,request})=>{
 const stage=await(await request.post('/api/v2/assets/uploads?name=denied.md',{data:'# Must stay cleared'})).json();
 const saved=await(await request.post('/api/v2/assets/imports',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{kind:'document',title:'Access race',submissionId:stage.submissionId}})).json();
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/v2/assets/'+saved.asset.id+'/versions/'+saved.version.id+'/files/*',async route=>{await new Promise(resolve=>setTimeout(resolve,250));await route.fulfill({body:'# Must stay cleared'});});
 await page.route(denied==='source'?'**/api/v2/tasks/source?*':'**/api/v2/assets/'+saved.asset.id+'/activity',route=>route.fulfill({status:403,json:{error:'forbidden'}}));
 await page.goto('/assets/'+saved.asset.id);
 await expect(page.getByRole('alert').first()).toBeVisible();
 await page.waitForTimeout(400);
 await expect(page.getByRole('heading',{name:'Must stay cleared',exact:true})).toHaveCount(0);expect(errors).toEqual([]);
});

test('clears an open editor when a delayed view receipt is denied',async({page,request})=>{
 const stage=await(await request.post('/api/v2/assets/uploads?name=editor.md',{data:'# Editor body'})).json();
 const saved=await(await request.post('/api/v2/assets/imports',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{kind:'document',title:'Editor access race',submissionId:stage.submissionId}})).json();
 let release!:()=>void;const held=new Promise<void>(resolve=>release=resolve);
 await page.route('**/api/v2/assets/'+saved.asset.id+'/activity',async route=>{await held;await route.fulfill({status:403,json:{error:'forbidden'}});});
 try{await page.goto('/assets/'+saved.asset.id);await page.getByRole('button',{name:'编辑文件',exact:true}).click();await expect(page.getByRole('textbox',{name:'文档正文',exact:true})).toBeVisible();}finally{release();}
 await expect(page.getByRole('textbox',{name:'文档正文',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'发布新版本',exact:true})).toHaveCount(0);
});

for(const path of ['/tasks','/assets','/mana?tab=memory','/settings/general'])test('does not initialize a hidden chat on '+path,async({page,request})=>{
 const chat=await(await request.post('/api/conversations',{data:{projectId:'',agentId:'',cli:'codex',workspaceId:null}})).json();
 await page.addInitScript(id=>localStorage.setItem('mana-chat',id),chat.id);
 const background:string[]=[];
 page.on('request',req=>{const url=new URL(req.url());if(['/api/models','/api/cli/status','/api/composer-references','/api/knowledge'].includes(url.pathname)||url.pathname.endsWith('/events')||url.pathname.endsWith('/references'))background.push(url.pathname);});
 await page.goto(path);await expect(page.locator('main h1').first()).toBeVisible();await page.waitForTimeout(250);
 expect(background).toEqual([]);
});

test('starts the noncritical binding list after the preview body',async({page,request})=>{
 const stage=await(await request.post('/api/v2/assets/uploads?name=priority.md',{data:'# Priority preview'})).json();
 const saved=await(await request.post('/api/v2/assets/imports',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{kind:'document',title:'Preview priority',submissionId:stage.submissionId}})).json();
 let release!:()=>void;const held=new Promise<void>(resolve=>release=resolve);let bodyStarted=false,bindingsStarted=false;
 await page.route('**/api/v2/assets/'+saved.asset.id+'/versions/'+saved.version.id+'/files/*',async route=>{bodyStarted=true;await held;await route.continue();});
 await page.route('**/api/v2/assets/'+saved.asset.id+'/bindings',async route=>{bindingsStarted=true;await route.continue();});
 try{await page.goto('/assets/'+saved.asset.id);await expect.poll(()=>bodyStarted).toBe(true);expect(bindingsStarted).toBe(false);}finally{release();}
 await expect(page.locator('.asset-content')).toContainText('Priority preview');await expect.poll(()=>bindingsStarted).toBe(true);
});
