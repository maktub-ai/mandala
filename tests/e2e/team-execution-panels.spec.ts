import {test,expect} from '@playwright/test';
const config={version:2,projects:['one','two'].map(id=>({id,name:'Project '+id,cwd:'/tmp',agentIds:[id==='one'?'a':'b'],resources:[],mcp:[],skills:[]})),agents:['a','b'].map(id=>({id,name:'Agent '+id,instructions:'',defaultCli:'omp',models:{omp:'configured-model'},mcp:[],skills:[]}))};
test('team focus shows related identities, separates execution states and scopes usage',async({page,request})=>{
 const {revision}=await(await request.get('/api/config')).json();await request.put('/api/config',{data:{config,revision}});
 const execution={id:'r',kind:'run',conversationId:null,taskId:'task',projectId:'one',agentId:'a',state:'running',title:'Current task',href:'/tasks/task',time:new Date().toISOString(),accessible:true};
 await page.route('**/api/workbench',route=>route.fulfill({json:{agents:[{id:'a',name:'Agent a',executions:[execution,{...execution,id:'approval',state:'approval'},{...execution,id:'queue',state:'queued'}]}]}}));
 const usageScopes:string[]=[];
 await page.route('**/api/usage?**',route=>{usageScopes.push(route.request().url());return route.fulfill({status:503,json:{error:'Usage fixture unavailable'}});});
 await page.goto('/agents');
 await expect(page.locator('[data-node-id]')).toHaveCount(4);
 const agent=page.locator('[data-node-id="agent:a"]');await expect(agent.locator('[data-state=running]')).toHaveAttribute('aria-label','运行 1');await expect(agent.locator('[data-state=approval]')).toHaveAttribute('aria-label','等待审批 1');await expect(agent.locator('[data-state=queued]')).toHaveAttribute('aria-label','排队 1');
 await agent.focus();await page.keyboard.press('Enter');
 await expect(page.locator('[data-node-id]')).toHaveCount(2);
 await expect(page.locator('[data-node-id="project:one"]')).toBeVisible();await expect(page.locator('[data-node-id="project:two"]')).toHaveCount(0);await expect(page.locator('[data-node-id="agent:b"]')).toHaveCount(0);
 const panel=page.getByRole('complementary',{name:'节点详情'});await expect(panel).toContainText('configured-model');await expect(panel).toContainText('本次模型');await expect(panel).toContainText('未知');
 await expect.poll(()=>usageScopes.some(url=>new URL(url).searchParams.get('agentId')==='a'&&!new URL(url).searchParams.has('projectId'))).toBe(true);
 await page.getByRole('button',{name:'取消聚焦',exact:true}).click();await expect(page.locator('[data-node-id]')).toHaveCount(4);
 await page.locator('[data-node-id="project:one"]').focus();await page.keyboard.press('Enter');await expect.poll(()=>usageScopes.some(url=>new URL(url).searchParams.get('projectId')==='one'&&!new URL(url).searchParams.has('agentId'))).toBe(true);
 await panel.getByRole('button',{name:'完整配置',exact:true}).click();await expect(page).toHaveURL(/\/projects\/manage\?project=one&tab=background/);
});

for (const width of [1080,1440,390]) test(`selected team graph remains readable at ${width}px`,async({page,request})=>{
 await page.setViewportSize({width,height:900});
 const {revision}=await(await request.get('/api/config')).json();await request.put('/api/config',{data:{config,revision}});
 await page.goto('/agents');
 const node=page.locator('[data-node-id="agent:a"]');await node.focus();await page.keyboard.press('Enter');
 const viewport=page.locator('.organization-viewport');
 await expect.poll(async()=>{const card=await node.boundingBox();return card?.width??0;}).toBeGreaterThanOrEqual(width===390?176:180);
 if(width===390)expect(await node.locator('strong').evaluate(element=>parseFloat(getComputedStyle(element).fontSize)*element.closest('button')!.getBoundingClientRect().width/(element.closest('button') as HTMLElement).offsetWidth)).toBeGreaterThanOrEqual(14);
 const bounds=await viewport.boundingBox();const card=await node.boundingBox();
 expect(card!.x).toBeGreaterThanOrEqual(bounds!.x);expect(card!.x+card!.width).toBeLessThanOrEqual(bounds!.x+bounds!.width+1);
 const panel=page.getByRole('complementary',{name:'节点详情'});await expect(panel).toBeVisible();
 if(width===390){
  await viewport.scrollIntoViewIfNeeded();const frame=(await viewport.boundingBox())!,before=(await node.boundingBox())!;
  await page.mouse.move(frame.x+8,frame.y+20);await page.mouse.down();await page.mouse.move(frame.x+68,frame.y+50,{steps:5});await page.mouse.up();
  expect((await node.boundingBox())!.x-before.x).toBeGreaterThan(40);
  await page.getByRole('button',{name:'居中节点',exact:true}).click();const centered=(await node.boundingBox())!,canvas=(await viewport.boundingBox())!;
  expect(centered.width).toBe(176);expect(centered.x).toBeGreaterThanOrEqual(canvas.x);expect(centered.x+centered.width).toBeLessThanOrEqual(canvas.x+canvas.width);await node.scrollIntoViewIfNeeded();await expect(node).toBeInViewport();
 }
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:`audit/2026-10-17/screenshots/team-panel-layout-${width}.png`,fullPage:true});
});
