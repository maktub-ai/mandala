import {mkdir,readdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {expect, type APIRequestContext} from '@playwright/test';
import {test} from '../e2e/helpers/isolated-authority';

async function addProject(request:APIRequestContext,name:string){
 const {directory,ominoHome}=await (await request.post('/__test__/execution-directory')).json();
 const {config,revision}=await (await request.get('/api/config')).json();
 const project={id:crypto.randomUUID(),name,cwd:directory,agentIds:[],skills:[],mcp:[],resources:[]};
 const saved=await request.put('/api/config',{data:{revision,config:{...config,projects:[...config.projects,project]}}});
 expect(saved.ok(),await saved.text()).toBe(true);
 return {project,ominoHome};
}

test.describe.configure({timeout:60000});

test.beforeEach(async({page})=>{
 await page.setViewportSize({width:1440,height:900});
 await page.addInitScript(()=>{localStorage.setItem('mana-language','zh-CN');localStorage.setItem('mana-theme','light');});
});

test('the global blueprint default persists without changing existing projects',async({page,isolatedAuthority:{request,baseURL}})=>{
 const {project}=await addProject(request,'星图编辑器');
 await page.goto(baseURL+'/settings/general');
 const toggle=page.getByRole('switch',{name:'新项目默认开启蓝图'});
 await expect(toggle).not.toBeChecked();await toggle.check();
 await expect.poll(async()=>(await(await request.get('/api/config')).json()).config.blueprintDefaultEnabled).toBe(true);
 await page.reload();await expect(toggle).toBeChecked();
 await page.goto(baseURL+'/projects/'+project.id+'/settings');
 await expect(page.getByRole('switch',{name:'项目蓝图'})).not.toBeChecked();
});

test('observer draft is editable and only confirmation creates a plan; disable and reopen retain it',async({page,isolatedAuthority:{request,baseURL}},info)=>{
 const {project,ominoHome}=await addProject(request,'星图编辑器');
 const path='/projects/'+project.id;
 await page.goto(baseURL+path+'/settings');
 const toggle=page.getByRole('switch',{name:'项目蓝图',exact:true});
 await expect(toggle).toBeEnabled();await toggle.check();
 const draft=page.getByRole('textbox',{name:'初始模块草案'});
 await expect(draft).toHaveValue('编辑器\n同步服务');
 expect(await readdir(join(ominoHome,'projects')).catch(()=>[])).toEqual([]);
 await draft.fill('画布编辑\n图层存储');
 await page.screenshot({path:info.outputPath('blueprint-confirm.png'),animations:'disabled'});
 await page.getByRole('button',{name:'确认模块并创建蓝图'}).click();
 await expect(page.getByText('已连接蓝图',{exact:false})).toBeVisible();
 const state=async()=>(await(await request.get('/api'+path+'/blueprint')).json());
 const first=await state();expect(first.summary.modules.map((m:{lane:string})=>m.lane)).toEqual(['画布编辑','图层存储']);
 await toggle.uncheck();await expect.poll(async()=>(await state()).status).toBe('disabled');
 await page.getByRole('navigation',{name:'项目导航'}).getByRole('link',{name:'概览'}).click();
 await expect(page.getByRole('region',{name:'项目任务',exact:true})).toBeVisible();
 await expect(page.getByRole('region',{name:'项目蓝图',exact:true})).toHaveCount(0);
 await expect(page.getByRole('navigation',{name:'项目导航'}).getByRole('link',{name:'蓝图'})).toHaveCount(0);
 await page.getByRole('navigation',{name:'项目导航'}).getByRole('link',{name:'设置'}).click();
 await toggle.check();await expect(page.getByText('已连接蓝图',{exact:false})).toBeVisible();
 expect((await state()).planId).toBe(first.planId);await expect(draft).toHaveCount(0);
});

async function externalPlan(ominoHome:string,cwd:string,id:string){
 const root=join(ominoHome,'projects',id);
 await mkdir(join(root,'work'),{recursive:true});
 await mkdir(join(root,'stages'));
 await writeFile(join(root,'stages','s1.md'),'---\nid: s1\nkind: stage\ntitle: 离线绘图\nlevel: 1\nstatus: active\n---\n');
 await writeFile(join(cwd,'.omino.json'),JSON.stringify({project:id}));
 await writeFile(join(root,'project.md'),'---\nid: project\nkind: intent\ntitle: 星图绘制\n---\n\n## Purpose\n绘制离线星图。\n');
 for(const [id,lane,status,title,body] of [
  ['painter','画布编辑','doing','渲染增量图层','保留笔刷的边缘纹理。'],
  ['cache','离线存储','done','离线队列恢复','重启后可以继续提交缓存图层。'],
  ['export','图像导出','planned','导出预设',''],
 ])await writeFile(join(root,'work',id+'.md'),`---\nid: ${id}\nkind: work\ntitle: ${title}\nstage: s1\nstatus: ${status}\nlane: ${lane}\n---\n\n## Progress\n${body}\n`);
 return root;
}

test('an adopted plan shows external records, live module tasks and native deep links; a read error can be retried',async({page,isolatedAuthority:{request,baseURL}},info)=>{
 const {project,ominoHome}=await addProject(request,'星图编辑器');
 const path='/projects/'+project.id,root=await externalPlan(ominoHome,project.cwd,'star-atlas');
 await page.goto(baseURL+path+'/settings');
 await page.getByRole('switch',{name:'项目蓝图'}).check();
 await expect(page.getByText('已连接蓝图 · 星图绘制')).toBeVisible();
 const response=await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{goal:'完善笔刷预览',projectId:project.id,moduleRef:{projectId:project.id,lane:'画布编辑'}}});
 expect(response.ok(),await response.text()).toBe(true);const task=await response.json();
 expect((await request.post('/__test__/project-task-groups/takeover',{data:[task.id]})).ok()).toBe(true);
 await page.goto(baseURL+'/mandala');
 const panel=page.locator('.mandala-panels');const tag=panel.getByRole('link',{name:'星图编辑器 · 画布编辑'});
 await expect(tag).toHaveAttribute('href',path+'/blueprint?'+new URLSearchParams({lane:'画布编辑'}));
 await page.screenshot({path:info.outputPath('blueprint-collab-tag.png'),animations:'disabled'});
 await tag.click();
 const board=page.getByRole('region',{name:'项目蓝图',exact:true});const lane=board.getByRole('region',{name:'画布编辑'});
 await expect(lane).toBeFocused();await expect(lane.getByRole('link',{name:task.goal})).toBeVisible();await expect(lane.getByText('渲染增量图层')).toBeVisible();
 await page.screenshot({path:info.outputPath('blueprint-lanes.png'),animations:'disabled'});
 // The blueprint is its own tab; the overview keeps the project's own information and activity.
 await expect(page.getByRole('navigation',{name:'项目导航'}).getByRole('link',{name:'蓝图'})).toHaveAttribute('aria-current','page');
 await page.goto(baseURL+path+'/overview');await expect(board).toHaveCount(0);await expect(page.getByRole('region',{name:'项目任务',exact:true})).toBeVisible();
 await page.goto(baseURL+path+'/overview?'+new URLSearchParams({lane:'画布编辑'}));await expect(page).toHaveURL(baseURL+path+'/blueprint?'+new URLSearchParams({lane:'画布编辑'}));
 const selected=path+'/blueprint?'+new URLSearchParams({lane:'离线存储',record:'cache'});
 await page.goto(baseURL+selected);await expect(board.getByText('重启后可以继续提交缓存图层。')).toBeVisible();
 await expect(board.locator('details[data-record="cache"] summary')).toBeFocused();
 await writeFile(join(root,'work','cache.md'),(await readFile(join(root,'work','cache.md'),'utf8')).replace('重启后可以继续提交缓存图层。','新增跨设备恢复校验。'));
 await page.route('**/api'+path+'/blueprint',route=>route.fulfill({status:503,json:{error:'Offline'}}),{times:1});
 await page.reload();await expect(board.getByText('暂时无法读取蓝图。',{exact:false})).toBeVisible();await board.getByRole('button',{name:'重试'}).click();
 await expect(board.getByText('新增跨设备恢复校验。')).toBeVisible();
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('ambiguous repository plans require the user to select a binding',async({page,isolatedAuthority:{request,baseURL}})=>{
 const {project,ominoHome}=await addProject(request,'星图工作组');
 const second=(await(await request.post('/__test__/execution-directory')).json()).directory;
 for(const [id,cwd] of [['atlas-editor',project.cwd],['atlas-archive',second]])await externalPlan(ominoHome,cwd,id);
 const settings=await(await request.get('/api/config')).json();
 const team=settings.config.projects.find((p:{id:string})=>p.id===project.id);
 team.workspaces=[project.cwd,second].map((cwd,i)=>({id:'repo-'+i,name:'Workspace '+i,cwd,resources:[]}));
 expect((await request.put('/api/config',{data:settings})).ok()).toBe(true);
 const path='/projects/'+project.id;
 await page.goto(baseURL+path+'/settings');await page.getByRole('switch',{name:'项目蓝图'}).check();
 const choices=page.getByRole('group',{name:'选择已有蓝图'}),adopt=choices.getByRole('button',{name:'绑定所选蓝图'});
 await expect(adopt).toBeDisabled();await expect(choices.getByRole('radio')).toHaveCount(2);
 await choices.getByRole('radio',{name:'atlas-archive'}).check();await adopt.click();
 await expect(page.getByText('已连接蓝图 · 星图绘制')).toBeVisible();
 expect((await(await request.get('/api'+path+'/blueprint')).json()).planId).toBe('atlas-archive');
 await expect(page.getByRole('textbox',{name:'初始模块草案'})).toHaveCount(0);
});

test('leaving a pending observer draft keeps the destination project independent',async({page,isolatedAuthority:{request,baseURL}})=>{
 const {project:first}=await addProject(request,'待确认的星图');
 const {project:second}=await addProject(request,'素材索引');
 const path=(id:string)=>'/projects/'+id;
 let started!:()=>void,release!:()=>void;
 const requested=new Promise<void>(resolve=>{started=resolve;}),hold=new Promise<void>(resolve=>{release=resolve;});
 await page.route('**/api'+path(first.id)+'/blueprint',async route=>{
  if(route.request().method()!=='POST'||route.request().postDataJSON().action!=='draft')return route.continue();
  started();await hold;await route.continue();
 });
 await page.goto(baseURL+path(first.id)+'/settings');
 const toggle=page.getByRole('switch',{name:'项目蓝图',exact:true});
 try{
  await toggle.check();await requested;
  await expect(page.getByRole('button',{name:'正在生成模块草案…'})).toBeVisible();
  await page.getByRole('combobox',{name:'切换项目'}).click();
  await page.getByRole('option',{name:second.name}).click();
  await expect(page).toHaveURL(baseURL+path(second.id)+'/settings');
 }finally{release();}
 await expect(toggle).toBeEnabled();await expect(toggle).not.toBeChecked();
 await expect(page.getByRole('textbox',{name:'初始模块草案'})).toHaveCount(0);
 const previous=await(await request.get('/api'+path(first.id)+'/blueprint')).json();
 expect(previous.status).toBe('uninitialized');expect(previous.planId).toBeNull();
});
