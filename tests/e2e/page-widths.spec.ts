import {test,expect} from '@playwright/test';
test.beforeEach(async({request})=>{const s=await(await request.get('/api/config')).json();s.config={version:2,agents:[{id:'width-agent',name:'Width Agent',instructions:'Reader',defaultCli:'codex',models:{},mcp:[],skills:[]}],projects:[{id:'width-project',name:'Width Project',background:'Context',cwd:'/tmp',resources:[],agentIds:['width-agent'],mcp:[],skills:[]}]};await request.put('/api/config',{data:s});});
for(const width of [1920,1440,1024,768,390])test(`three page widths and stable tab canvas ${width}`,async({page},info)=>{
 await page.setViewportSize({width,height:1000});const groups=[
 {tier:'compact',paths:['/settings/general','/settings/runtimes','/settings/system','/settings/mcp','/mana/skills']},
 {tier:'compact',paths:['/agents/width-agent','/agents/width-agent?tab=settings','/agents/width-agent?tab=capabilities','/agents/width-agent?tab=execution','/agents/width-agent?tab=knowledge']},
 {tier:'compact',paths:['/projects/width-project/overview','/projects/width-project/library','/projects/width-project/settings']},
 {tier:'standard',paths:['/agents','/projects','/market','/market?tab=installed','/mana?tab=memory','/schedules','/usage']},
 {tier:'fluid',paths:['/tasks?view=list','/tasks?view=board','/library']}
 ];
 for(const group of groups){let reference:{x:number;width:number}|null=null;for(const path of group.paths){
  await page.goto(path);await expect(page.locator('main h1').first()).toBeVisible();const canvas=page.locator('[data-page-canvas]').first();await expect(canvas).toHaveAttribute('data-page-width',group.tier);
  const rect=(await canvas.boundingBox())!;const main=(await page.locator('main').boundingBox())!;const gutter=await page.locator('.product-frame').evaluate(e=>parseFloat(getComputedStyle(e).getPropertyValue('--workspace-gutter')));const expected=Math.min(group.tier==='compact'?960:group.tier==='standard'?1240:main.width,main.width-(group.tier==='fluid'?0:2*gutter));
  expect(rect.width).toBeLessThanOrEqual(expected+1);expect(rect.width).toBeCloseTo(expected,0);
  if(reference){expect(rect.x).toBeCloseTo(reference.x,0);expect(rect.width).toBeCloseTo(reference.width,0);}reference=rect;
  expect(await page.locator('main').evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);
  if(path===group.paths[0])await page.screenshot({path:info.outputPath(group.tier+'-'+path.replace(/[^a-z0-9]+/gi,'-')+'.png'),fullPage:true});
 }}
});
