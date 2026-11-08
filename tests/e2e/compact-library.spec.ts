import {test,expect} from '@playwright/test';

test('Library creates a real document and keeps legacy fixed-version routes readable',async({page,request})=>{
 await page.goto('/library');
 await page.getByRole('button',{name:'新建',exact:true}).click();
 await page.getByRole('menuitem',{name:'新建文档',exact:true}).click();
 await page.getByLabel('文件名称',{exact:true}).fill('Compact library 文档');
 await page.getByLabel('文档正文',{exact:true}).fill('# Actual document\n\n真实正文与中文阅读。');
 await page.getByRole('button',{name:'创建文档',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Compact library 文档',exact:true})).toBeVisible();
 const id=new URL(page.url()).pathname.split('/').at(-1)!;
 const asset=await (await request.get('/api/v2/assets/'+id)).json();
 expect(asset.kind).toBe('document');expect(asset.owner.agentId).toBeUndefined();
 await page.goto('/assets/'+id+'?version='+asset.headVersionId);
 await expect(page.getByText('真实正文与中文阅读。',{exact:true})).toBeVisible();
 await page.goto('/library');await page.getByLabel('搜索资料库',{exact:true}).fill('no-such-library-title');
 await expect(page.locator('.ui-empty')).toContainText('没有匹配的资料。');
 await page.getByRole('button',{name:'清除筛选',exact:true}).click();
 await expect(page.getByRole('link',{name:'Compact library 文档',exact:true})).toBeVisible();
});

test('Project Library opens pinned content and narrow association actions leave titles readable',async({page,request})=>{
 const response=await request.get('/api/config'),{config,revision}=await response.json();
 const project={id:'compact-library-project',name:'Library scope',cwd:'/tmp',agentIds:[],resources:[],mcp:[],skills:[]};
 expect((await request.put('/api/config',{data:{revision,config:{...config,projects:[...config.projects,project]}}})).ok()).toBeTruthy();
 const title='项目长标题 Long bilingual document for readable association controls';
 const stage=await (await request.post('/api/v2/assets/uploads?name=scope.md',{data:'Pinned project original'})).json();
 const saved=await (await request.post('/api/v2/assets/imports',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{kind:'document',title,submissionId:stage.submissionId}})).json();
 expect((await request.post('/api/v2/assets/'+saved.asset.id+'/bindings',{data:{ownerType:'project',ownerId:project.id,versionPolicy:'pinned',versionId:saved.version.id}})).ok()).toBeTruthy();
 await page.goto('/library?project='+project.id);
 await page.getByRole('link',{name:title,exact:true}).click();
 expect(new URL(page.url()).searchParams.get('version')).toBe(saved.version.id);
 await expect(page.getByText('Pinned project original',{exact:true})).toBeVisible();
 for(const width of [768,390]){
  await page.setViewportSize({width,height:844});await page.goto('/projects/'+project.id+'/library');
  const row=page.locator('.library-resource-row').filter({hasText:title});await expect(row).toBeVisible();
  const link=await row.getByRole('link',{name:title,exact:true}).boundingBox();
  const action=await row.getByRole('button',{name:'移除关联 · '+title,exact:true}).boundingBox();
  expect(link!.width).toBeGreaterThan(240);expect(action!.y).toBeGreaterThanOrEqual(link!.y+link!.height-1);
 }
});
