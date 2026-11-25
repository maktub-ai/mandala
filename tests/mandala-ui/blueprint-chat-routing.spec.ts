import {expect,type APIRequestContext} from '@playwright/test';
import {test} from '../e2e/helpers/isolated-authority';

const projectId='atlas-studio',observers=['atlas-editor','atlas-reviewer'];
async function prepare(request:APIRequestContext){
 const {directory}=await(await request.post('/__test__/execution-directory')).json();
 const {config,revision}=await(await request.get('/api/config')).json();
 const agents=observers.map((id,i)=>({id,name:['图层观察者','导出观察者'][i],defaultCli:'codex',models:{},skills:[],mcp:[],instructions:''}));
 const project={id:projectId,name:'星图工坊',cwd:directory,agentIds:observers,resources:[],skills:[],mcp:[]};
 expect((await request.put('/api/config',{data:{revision,config:{...config,agents:[...config.agents,...agents],projects:[...config.projects,project]}}})).ok()).toBe(true);
 const blueprint='/api/projects/'+projectId+'/blueprint';
 expect((await request.post(blueprint,{data:{action:'enable'}})).ok()).toBe(true);
 const draft=await(await request.post(blueprint,{data:{action:'draft'}})).json();
 expect((await request.post(blueprint,{data:{action:'confirm',draftId:draft.draftId,modules:['画布','图层导出']}})).ok()).toBe(true);
}

test('a bound Mandala command waits for review, retries a lost confirmation, and reopens one durable task',async({page,isolatedAuthority:{request,baseURL}},info)=>{
 test.setTimeout(90000);
 const goal='验证星图的导出图层';
 await prepare(request);
 await page.addInitScript(()=>{localStorage.setItem('mana-language','zh-CN');localStorage.setItem('mana-theme','light');});
 await page.goto(baseURL+'/mandala');
 let offline=true;const reviewRequests='**/api/v2/tasks/route-reviews/*';
 await page.route(reviewRequests,route=>offline?route.fulfill({status:503,json:{error:'暂时无法读取建议'}}):route.continue());
 const firstRead=page.waitForResponse(r=>r.url().includes('/api/v2/tasks/route-reviews/'));
 await page.getByRole('textbox',{name:'消息',exact:true}).fill('请创建任务：'+goal);
 await page.getByRole('button',{name:'发送消息',exact:true}).click();
 const card=page.getByRole('region',{name:'蓝图分派建议'});
 await firstRead;await expect(card.getByRole('alert')).toContainText('暂时无法读取建议');offline=false;await page.unroute(reviewRequests);
 const reviewResponse=page.waitForResponse(r=>r.request().method()==='GET'&&r.url().includes('/api/v2/tasks/route-reviews/'));
 await card.getByRole('button',{name:/重试|重新读取/}).click();
 const review=await(await reviewResponse).json();
 await expect(card).toContainText(goal);await expect(card.getByRole('combobox',{name:'建议模块'})).toContainText('画布');
 const tasks=async()=>await(await request.get('/api/v2/tasks?projectId='+projectId)).json();
 expect(await tasks()).toHaveLength(0);
 await page.reload();await expect(card.getByRole('button',{name:'确认并创建任务'})).toBeVisible();
 for(const [name,value] of [['建议模块','图层导出'],['建议负责人','导出观察者']]){
  await card.getByRole('combobox',{name}).click();await page.getByRole('option',{name:value,exact:true}).click();
 }
 const reviewPath='/api/v2/tasks/route-reviews/'+review.id;
 await page.route('**'+reviewPath,async route=>{
  if(route.request().method()!=='POST')return route.continue();
  const saved=await route.fetch();expect(saved.ok(),await saved.text()).toBe(true);
  await route.fulfill({status:503,json:{error:'确认回执暂不可用'}});
 },{times:1});
 const confirm=card.getByRole('button',{name:'确认并创建任务'});
 await confirm.click();await expect(card.getByRole('alert')).toHaveText('确认回执暂不可用');
 expect(await tasks()).toHaveLength(1);
 await page.screenshot({path:info.outputPath('blueprint-chat-retry.png'),animations:'disabled'});
 await confirm.click();
 const open=card.getByRole('link',{name:'查看已创建的任务'});await expect(open).toBeVisible();
 await page.reload();await expect(open).toBeVisible();await expect(confirm).toHaveCount(0);
 const list=await tasks();expect(list).toHaveLength(1);
 expect(list[0]).toMatchObject({goal,assigneeAgentId:observers[1],moduleRef:{projectId,lane:'图层导出'}});
 const audit=await(await request.get(reviewPath)).json();expect(audit).toMatchObject({status:'confirmed',taskId:list[0].id,matched:false,selection:{projectId,lane:'图层导出',assigneeAgentId:observers[1]}});
 await expect(open).toHaveAttribute('href','/tasks/'+list[0].id);await open.click();
 await expect(page.getByRole('dialog')).toContainText(goal);
});

test('task editor preserves the form after a preview error and resumes a committed task after a read error',async({page,isolatedAuthority:{request,baseURL}})=>{
 test.setTimeout(90000);await prepare(request);
 await page.addInitScript(()=>localStorage.setItem('mana-language','zh-CN'));
 await page.goto(baseURL+'/tasks?project='+projectId+'&action=create');
 await page.getByRole('button',{name:'手动填写',exact:true}).click();
 const form=page.getByRole('form',{name:'新建任务',exact:true}),title=form.getByRole('textbox',{name:'任务标题'}),goal='复核素材导出';
 await title.fill(goal);
 await page.route('**/api/v2/tasks/route-preview',route=>route.fulfill({status:503,json:{error:'分派建议暂不可用'}}),{times:1});
 const save=form.getByRole('button',{name:'创建任务',exact:true});await save.click();
 await expect(form.getByRole('alert')).toContainText('分派建议暂不可用');await expect(title).toHaveValue(goal);
 const list=async()=>await(await request.get('/api/v2/tasks?projectId='+projectId)).json();
 expect(await list()).toHaveLength(0);
 await save.click();const card=page.getByRole('region',{name:'蓝图分派建议'});
 await expect(card.getByRole('button',{name:'确认并创建任务'})).toBeVisible();
 await page.route(/\/api\/v2\/tasks\/[a-f0-9-]{36}$/,route=>route.fulfill({status:503,json:{error:'详情暂时离线'}}),{times:1});
 await card.getByRole('button',{name:'确认并创建任务'}).click();
 await expect(card.getByRole('alert')).toContainText('详情暂时离线');
 const saved=await list();expect(saved).toHaveLength(1);
 await card.getByRole('button',{name:'继续'}).click();
 await expect(page).toHaveURL(baseURL+'/tasks/'+saved[0].id);expect(await list()).toHaveLength(1);
});
