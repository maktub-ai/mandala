import { chooseOption } from "./helpers/select";
import { openArea, openNavigation, openProject } from './helpers/navigation';
import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
test('file formats have distinct icons, aligned filters and separated metadata',async({page,request},testInfo)=>{
 for(const name of ['Preview photo.png','Preview budget.xlsx','Preview report.pdf','Preview archive.zip']){
  const stage=await (await request.post('/api/v2/assets/uploads?name='+encodeURIComponent(name),{data:'fixture'})).json();
  await request.post('/api/v2/assets/imports',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{kind:'file',title:name,submissionId:stage.submissionId}});
 }
 await page.goto('/assets');await page.getByLabel('搜索资料库',{exact:true}).fill('Preview');
 const rows=page.locator('.asset-list article');await expect(rows).toHaveCount(4);
 const icons=await rows.locator('.asset-row-icon svg').evaluateAll(elements=>elements.map(el=>el.innerHTML));expect(new Set(icons).size).toBe(4);
 for(const row of await rows.all())expect(await row.innerText()).not.toContain(' · ');
 await expect(page.locator('.asset-list')).not.toContainText('仅归属方');
 const search=await page.getByLabel('搜索资料库',{exact:true}).boundingBox(),group=await page.getByLabel('排序',{exact:true}).boundingBox();
 expect(Math.abs(search!.y-group!.y)).toBeLessThanOrEqual(1);expect(Math.abs(search!.height-group!.height)).toBeLessThanOrEqual(1);
 await page.screenshot({path:testInfo.outputPath('formats-light.png'),fullPage:true});
 await page.evaluate(()=>localStorage.setItem('mana-theme','dark'));await page.reload();await page.getByLabel('搜索资料库',{exact:true}).fill('Preview');
 await page.screenshot({path:testInfo.outputPath('formats-dark.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:testInfo.outputPath('formats-narrow.png'),fullPage:true});
 expect(await page.locator('main').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
});
test('list hides owner permission but shows exceptional sharing and keeps all settings',async({page,request})=>{
 const stage=await (await request.post('/api/v2/assets/uploads?name=permission.txt',{data:'content'})).json();
 const saved=await (await request.post('/api/v2/assets/imports',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{kind:'file',title:'Permission fixture',submissionId:stage.submissionId}})).json();
 await page.goto('/assets');const row=page.locator('.asset-list article').filter({hasText:'Permission fixture'});await expect(row).toBeVisible();await expect(row).not.toContainText('仅归属方');
 for(const [mode,label] of [['private','不共享'],['selected','指定对象'],['all','全部 Agent']]){
  const asset=await (await request.get('/api/v2/assets/'+saved.asset.id)).json();
  await request.put('/api/v2/assets/'+asset.id+'/access',{data:{policy:{mode},expectedRevision:asset.revision}});
  await page.reload();await expect(row).toContainText(label);
 }
 await page.getByRole('link',{name:'Permission fixture',exact:true}).click();await page.getByRole('button',{name:'文件设置',exact:true}).click();
 await page.getByLabel('使用范围',{exact:true}).click();for(const label of ['仅归属方','不共享','指定对象','全部 智能体'])await expect(page.getByRole('option',{name:label,exact:true})).toBeVisible();
});
test('previews images and CSV, and offers local opening for unsupported files',async({page,request})=>{
 const make=async(name:string,data:Buffer|string)=>{
  const stage=await (await request.post('/api/v2/assets/uploads?name='+name,{data})).json();
  return (await (await request.post('/api/v2/assets/imports',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{kind:'file',title:name,submissionId:stage.submissionId}})).json());
 };
 const photo=await make('photo.png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=','base64'));
 await page.goto('/assets/'+photo.asset.id);await expect(page.getByRole('img',{name:'photo.png'})).toBeVisible();
 expect(await page.getByRole('img',{name:'photo.png'}).evaluate((el:HTMLImageElement)=>el.naturalWidth)).toBe(1);
 const csv=await make('budget.csv','name,total\n"Hosting, monthly",42\nStorage,8');
 await page.goto('/assets/'+csv.asset.id);await expect(page.getByRole('cell',{name:'Hosting, monthly',exact:true})).toBeVisible();await expect(page.getByRole('cell',{name:'42',exact:true})).toBeVisible();
 const html=await make('report.html','<!doctype html><h1 id="t">Sandboxed report</h1><script>document.getElementById("t").dataset.ran="1"</script>');
 await page.goto('/assets/'+html.asset.id);const frame=page.frameLocator('iframe[title="report.html"]');
 await expect(frame.locator('h1[data-ran="1"]')).toHaveText('Sandboxed report');
 await page.getByRole('button',{name:'查看源码',exact:true}).click();await expect(page.getByText('Sandboxed report').first()).toBeVisible();
 const office=await make('budget.xlsx','unsupported');await page.goto('/assets/'+office.asset.id);
 await expect(page.getByText('暂不支持此格式预览',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'用默认应用打开',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'在文件夹中显示',exact:true})).toBeVisible();
 await page.route('**/files/0/open',route=>route.fulfill({status:503,json:{error:'Synthetic application unavailable'}}));
 await page.getByRole('button',{name:'用默认应用打开',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Synthetic application unavailable');
});
test('imports a fixed version, binds it to a project and opens the same asset',async({page,request})=>{
 const original=Buffer.from('Asset report\n0123456789');
 await page.goto('/assets');await page.getByRole('button',{name:'导入文件',exact:true}).click();
 await page.getByLabel('文件名称').fill('Shared report');
 await page.getByLabel('选择文件').setInputFiles({name:'report.txt',mimeType:'text/plain',buffer:original});
 await page.getByRole('button',{name:'导入并发布'}).click();
 await expect(page.getByRole('heading',{name:'Shared report'})).toBeVisible();
 const id=new URL(page.url()).pathname.split('/').at(-1)!;
 const {config,revision}=await (await request.get('/api/config')).json();
 await request.put('/api/config',{data:{revision,config:{...config,projects:[...config.projects,{id:'asset-project',name:'Asset Project',cwd:'/tmp',agentIds:[],resources:[],mcp:[],skills:[]}]}}});
 await page.reload();
 await page.getByRole('button',{name:'文件设置',exact:true}).click();await chooseOption(page, page.getByLabel('关联项目'), 'asset-project');
 await page.getByRole('button',{name:'关联项目',exact:true}).click();
 await expect(page.getByText('已关联项目')).toBeVisible();
 const version=await (await request.get('/api/v2/assets/'+id)).json();
 const download=await request.get('/api/v2/assets/'+id+'/versions/'+version.headVersionId+'/files/0');
 expect(createHash('sha256').update(await download.body()).digest('hex')).toBe(createHash('sha256').update(original).digest('hex'));
 await page.goto('/projects/asset-project/library');
 await page.getByRole('link',{name:'Shared report'}).click();
 await expect(page).toHaveURL(new RegExp('/library/'+id));
 await expect(page.getByRole('heading',{name:'Shared report'})).toBeVisible();
 await page.goto('/projects/asset-project/library');
 await page.getByRole('button',{name:'移除关联 · Shared report',exact:true}).click();
 await expect(page.locator('.ui-empty').filter({hasText:'尚无关联资料或项目交付物。'})).toBeVisible();
 expect((await request.get('/api/v2/assets/'+id)).ok()).toBe(true);
});
test('edits a document into a new fixed version and keeps old content safe',async({page,request})=>{
 await page.goto('/assets');await page.getByRole('button',{name:'新建',exact:true}).click();await page.getByRole('menuitem',{name:'新建文档',exact:true}).click();
 await page.getByLabel('文件名称').fill('Versioned document');
 await page.getByLabel('文档正文').fill('<script>window.assetExecuted=true</script>Original');
 await page.getByRole('button',{name:'创建文档'}).click();
 await expect(page.getByRole('heading',{name:'Versioned document'})).toBeVisible();
 const id=new URL(page.url()).pathname.split('/').at(-1)!;
 const old=(await (await request.get('/api/v2/assets/'+id)).json()).headVersionId;
 await expect(page.locator('.asset-content')).toContainText('<script>');
 expect(await page.evaluate(()=>Boolean((window as any).assetExecuted))).toBe(false);
 await page.getByRole('button',{name:'编辑文件'}).click();
 await page.getByLabel('文档正文').fill('Revised');
 await page.getByRole('button',{name:'发布新版本',exact:true}).click();
 await expect(page.getByRole('status')).toHaveText('已发布新版本');
 await expect(page.locator('.asset-content .markdown-text')).toHaveText('Revised');
 await chooseOption(page, page.getByLabel('固定版本'), old);
 await expect(page.locator('.asset-content')).toContainText('Original');
 const navigation=await openNavigation(page);
 await expect(navigation.locator('[data-area=agents]')).toBeVisible();
});
test('retains failed import for a retry using the same publication key',async({page,request})=>{
 const before=await (await request.get('/api/v2/assets')).json();let first=true;
 await page.route('**/api/v2/assets/imports',async route=>{
  if(first){first=false;await route.fetch();await route.fulfill({status:503,json:{error:'Synthetic response lost after commit'}});}else await route.continue();
 });
 await page.goto('/assets');await page.getByRole('button',{name:'新建',exact:true}).click();await page.getByRole('menuitem',{name:'新建文档',exact:true}).click();await page.getByLabel('文件名称').fill('Retry report');await page.getByLabel('文档正文').fill('Retained content');await page.getByRole('button',{name:'创建文档'}).click();
 await expect(page.getByRole('alert')).toContainText('Synthetic response lost after commit');await expect(page.getByLabel('文件名称')).toHaveValue('Retry report');await expect(page.getByLabel('文档正文')).toHaveValue('Retained content');
 await page.getByRole('button',{name:'创建文档'}).click();await expect(page.getByRole('heading',{name:'Retry report'})).toBeVisible();
 const after=await (await request.get('/api/v2/assets')).json();expect(after.length-before.length).toBe(1);
});
test('keeps the chat draft through existing asset, source and project links and browser history',async({page,request})=>{
 const {config,revision}=await (await request.get('/api/config')).json();
 await request.put('/api/config',{data:{revision,config:{...config,projects:[...config.projects.filter((p:any)=>p.id!=='draft-project'),{id:'draft-project',name:'Draft project',cwd:'/tmp',agentIds:[],resources:[],mcp:[],skills:[]}]}}});
 const sourceStage=await (await request.post('/api/v2/assets/uploads?name=source.txt',{data:'source'})).json();
 const source=await (await request.post('/api/v2/assets/imports',{headers:{'Idempotency-Key':'draft-source'},data:{kind:'file',title:'Draft source',submissionId:sourceStage.submissionId}})).json();
 const derivedAsset=await (await request.post('/api/v2/assets',{data:{kind:'file',title:'Draft derived'}})).json();
 const stage=await (await request.post('/api/v2/assets/uploads?name=derived.txt',{data:'derived'})).json();
 const derived=await (await request.post('/api/v2/assets/'+derivedAsset.id+'/versions',{headers:{'Idempotency-Key':'draft-derived'},data:{expectedHeadVersionId:null,submissionId:stage.submissionId,provenance:{sourceVersions:[{assetId:source.asset.id,versionId:source.version.id}]}}})).json();
 await request.post('/api/v2/assets/'+derivedAsset.id+'/bindings',{data:{ownerType:'project',ownerId:'draft-project',versionPolicy:'pinned',versionId:derived.id}});
 await page.goto('/?project=draft-project&agent=');await page.getByRole('textbox',{name:'消息',exact:true}).fill('Draft survives asset browsing');
 const area=(name:string)=>openArea(page,name);
 await area('文件');await page.getByRole('link',{name:'Draft derived',exact:true}).click();await expect(page.getByRole('heading',{name:'Draft derived'})).toBeVisible();
 await page.goBack();await expect(page.getByRole('button',{name:'导入文件',exact:true})).toBeVisible();await page.goForward();await expect(page.getByRole('heading',{name:'Draft derived'})).toBeVisible();
 await page.locator('.asset-provenance > summary').click();await page.locator(`a[href="/assets/${source.asset.id}?version=${source.version.id}"]`).click();await expect(page.getByRole('heading',{name:'Draft source'})).toBeVisible();
 await page.goBack();await expect(page.getByRole('heading',{name:'Draft derived'})).toBeVisible();
 await area('对话');await expect(page.getByRole('textbox',{name:'消息',exact:true})).toHaveValue('Draft survives asset browsing');
 await openProject(page,'draft-project');await page.getByRole('navigation',{name:'项目导航',exact:true}).getByRole('link',{name:'资料库',exact:true}).click();await expect(page.getByRole('heading',{name:'Draft project',level:1,exact:true})).toBeVisible();
 await page.getByRole('link',{name:'Draft derived',exact:true}).click();await expect(page.getByRole('heading',{name:'Draft derived'})).toBeVisible();await area('对话');await expect(page.getByRole('textbox',{name:'消息',exact:true})).toHaveValue('Draft survives asset browsing');
});
test('keeps the chat draft after a successful asset import',async({page})=>{
 await page.goto('/?project=&agent=');await page.getByRole('textbox',{name:'消息',exact:true}).fill('Draft survives import');
 const area=(name:string)=>openArea(page,name);
 await area('文件');await page.getByRole('button',{name:'新建',exact:true}).click();await page.getByRole('menuitem',{name:'新建文档',exact:true}).click();await page.getByLabel('文件名称').fill('Draft import');await page.getByLabel('文档正文').fill('Imported document');await page.getByRole('button',{name:'创建文档'}).click();await expect(page.getByRole('heading',{name:'Draft import'})).toBeVisible();
 await page.goBack();await expect(page.getByRole('button',{name:'导入文件',exact:true})).toBeVisible();await page.goForward();await expect(page.getByRole('heading',{name:'Draft import'})).toBeVisible();
 await area('对话');await expect(page.getByRole('textbox',{name:'消息',exact:true})).toHaveValue('Draft survives import');
});
test('recent files track explicit opens and edit an uploaded text file preserving its filename',async({page,request},testInfo)=>{
 const make=async(title:string,bytes:string)=>{const staged=await (await request.post('/api/v2/assets/uploads?name=notes%2Fhistory.txt',{data:bytes})).json();return (await request.post('/api/v2/assets/imports',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{kind:'file',title,submissionId:staged.submissionId}})).json();};
 const first=await make('Recent older file','before'),second=await make('Recent newer file','newer');
 await page.goto('/assets');const rows=page.locator('.asset-list article');await expect(rows.first()).toContainText('Recent newer file');
 await page.getByRole('link',{name:'Recent older file',exact:true}).click();await page.getByRole('button',{name:'编辑文件',exact:true}).click();await page.getByLabel('文档正文').fill('after');await page.getByRole('button',{name:'发布新版本',exact:true}).click();await expect(page.getByRole('status')).toHaveText('已发布新版本');
 const current=await (await request.get('/api/v2/assets/'+first.asset.id)).json(),versions=await (await request.get('/api/v2/assets/'+first.asset.id+'/versions')).json();expect(versions[0].files[0].path).toBe('notes/history.txt');expect(versions[1].id).toBe(first.version.id);expect(await (await request.get('/api/v2/assets/'+first.asset.id+'/versions/'+first.version.id+'/files/0')).text()).toBe('before');
 await page.goto('/assets');await expect(rows.first()).toContainText('Recent older file');expect(current.headVersionId).not.toBe(first.version.id);expect(second.asset.id).not.toBe(first.asset.id);
 await page.getByLabel('排序',{exact:true}).click();await expect(page.getByRole('option',{name:'最近活动'})).toBeVisible();await page.keyboard.press('Escape');
 await page.screenshot({path:testInfo.outputPath('files-light.png'),fullPage:true});
 await page.evaluate(()=>localStorage.setItem('mana-theme','dark'));await page.reload();await expect(rows.first()).toContainText('Recent older file');await page.screenshot({path:testInfo.outputPath('files-dark.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:testInfo.outputPath('files-narrow.png'),fullPage:true});
 expect(await page.locator('main').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
});
