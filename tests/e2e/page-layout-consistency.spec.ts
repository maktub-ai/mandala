import { openArea } from './helpers/navigation';
import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const projects = ['one', 'two'].map(id => ({id:'layout-'+id,name:'Layout Project '+id,cwd:'/tmp',agentIds:['layout-reader'],resources:[],mcp:[],skills:[]}));
const agents = ['reader','writer'].map(id=>({id:'layout-'+id,name:'Layout '+id,instructions:'Synthetic layout sample.',defaultCli:'codex',models:{},mcp:[],skills:[]}));
for (const language of ['zh-CN','en']) for (const width of [1440,1920,390]) test.describe(`${language} ${width}`,()=>{
 test.use({viewport:{width,height:900}});
 test.beforeEach(async({page,request})=>{
  const {revision}=await(await request.get('/api/config')).json();
  expect((await request.put('/api/config',{data:{revision,config:{version:2,projects,agents}}})).ok()).toBe(true);
  await page.addInitScript(value=>{localStorage.setItem('mana-language',value);localStorage.setItem('mana-theme','light');},language);
  await page.route('**/api/models?**',route=>route.fulfill({json:[]}));
  await page.route('**/api/status?**',route=>route.fulfill({json:{status:'ready',version:null}}));
 });
 test('module headings and content align while selections retain their identity',async({page})=>{
  const zh=language==='zh-CN',capture=process.env.OPEN_MANA_LAYOUT_CAPTURE;
  const rows=[['team','/agents',zh?'智能体':'Agents','.workspace-directory .workspace-page-header'],['usage','/usage',zh?'用量':'Usage','.workspace-page-header'],['tasks','/tasks',zh?'任务':'Tasks','.workspace-page-header'],['projects','/projects',zh?'项目':'Projects','.workspace-directory .workspace-page-header'],['agents','/agents/layout-reader','Layout reader','.object-detail-heading'],['memory','/mana?tab=memory',zh?'记忆':'Memory','.mana-frame .workspace-page-header'],['project-overview','/projects/layout-one/overview','Layout Project one','.workspace-page-header']];
  const geometry: {name:string;x:number;y:number;width:number;titleX:number;font:string;line:string;weight:string}[]=[];
  for(const [name,url,title,selector] of rows){
   await page.goto(url);
   const heading=page.locator('main '+selector).getByRole('heading').first();await expect(heading).toBeVisible();
   if(name==='projects'||name==='agents')await expect(page.locator('.settings-autosave')).toBeHidden();
   const header=page.locator('main '+selector),box=(await header.boundingBox())!;
   geometry.push({name,x:box.x,y:box.y,width:box.width,titleX:(await heading.boundingBox())!.x,...await heading.evaluate(node=>{const css=getComputedStyle(node);return {font:css.fontSize,line:css.lineHeight,weight:css.fontWeight};})});
   if(capture){mkdirSync(capture,{recursive:true});await page.screenshot({path:join(capture,`${language}-${width}-${name}.png`),fullPage:true});continue;}
   await expect(heading).toHaveText(title);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   if(name==='usage')expect((await page.getByRole('combobox',{name:zh?'当前项目':'Current project',exact:true}).boundingBox())!.width).toBeGreaterThanOrEqual(160);
   if(name==='tasks')await expect(page.locator('main .eyebrow')).toHaveCount(0);
   if(name==='memory'){await expect(page.getByRole('searchbox',{name:zh?'搜索记忆':'Search memories',exact:true})).toBeVisible();await expect(page.locator('.memory-overview small').first()).not.toBeEmpty();}
   if(name==='projects'||name==='agents'){
    await openArea(page,'智能体');const search=page.getByRole('searchbox',{name:zh?'智能体':'Agents',exact:true});await search.fill('writer');const result=page.locator('.workspace-directory-row');await expect(result).toHaveCount(1);await result.click();await expect(page.locator('.object-detail-heading h2')).toHaveText('Layout writer');await page.reload();await expect(page.locator('.object-detail-heading h2')).toHaveText('Layout writer');
   }
  }
  if(capture){console.log(JSON.stringify(geometry));return;}
  for(const current of geometry){expect(current.width,current.name+' width').toBeGreaterThan(width===390?300:450);expect(current.titleX,current.name+' heading inside content').toBeGreaterThanOrEqual(current.x);expect(current.titleX,current.name+' heading inside content').toBeLessThan(current.x+current.width);expect(parseFloat(current.font),current.name+' readable title').toBeGreaterThanOrEqual(16);}
  const shared=geometry.filter(item=>['team','projects','tasks','usage','project-overview'].includes(item.name)),baseline=shared[0];for(const current of shared.slice(1)){expect(current.font,current.name+' shared title size').toBe(baseline.font);expect(current.line,current.name+' shared title line height').toBe(baseline.line);expect(current.weight,current.name+' shared title weight').toBe(baseline.weight);}
  if(width===1920){const sidebar=(await page.locator('aside.sidebar').boundingBox())!;expect(baseline.x).toBeGreaterThanOrEqual(sidebar.x+sidebar.width);expect(baseline.x+baseline.width).toBeLessThanOrEqual(width);}

 });
 test('task list, board and detail preserve navigation in the aligned container',async({page,request})=>{
  const zh=language==='zh-CN';const response=await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{goal:'Layout personal reading\n\nKeep these synthetic notes.',criteria:[],acceptance:'human',projectId:'layout-one',assigneeAgentId:null}});expect(response.ok()).toBe(true);const task=await response.json();
  for(const query of ['', '?view=board']){await page.goto('/tasks'+query);await expect(page.locator('main  .progress-item-title[href^="/tasks/'+task.id+'"]')).toBeVisible();await page.locator('main  .progress-item-title[href^="/tasks/'+task.id+'"]').click();await expect(page.getByRole('heading',{name:'Layout personal reading',exact:true})).toBeVisible();await expect(page.locator('.task-description')).toContainText('Keep these synthetic notes.');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.getByRole('link',{name:zh?'返回任务列表':'Back to Tasks',exact:true}).click();await expect(page.locator('.task-workspace .workspace-page-heading h1')).toHaveText(zh?'任务':'Tasks');}
 });
});
