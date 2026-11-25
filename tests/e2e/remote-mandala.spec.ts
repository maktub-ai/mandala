import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createBlueprintService} from '../../server/blueprint';
import {test,expect,type Page} from '@playwright/test';
import {remoteMobileFixture} from './remote-mobile-fixture';
import {openAccountConnection} from './helpers/navigation';
import {ensureMandalaConfig,readConfig,writeConfig} from '../../server/config';
import {ensureMandalaConversation} from '../../server/mandala';

async function pairRemote(page:Page,computer:Page,fixture:Awaited<ReturnType<typeof remoteMobileFixture>>){
 const signIn=async(target:Page,url:string)=>{await target.addInitScript(()=>localStorage.setItem('mana-language','zh-CN'));await target.goto(url);await target.getByLabel('账号',{exact:true}).fill('mobile');await target.getByLabel('密码',{exact:true}).fill(fixture.password);await target.getByRole('button',{name:'登录',exact:true}).click();};
 await signIn(computer,fixture.localUrl);await openAccountConnection(computer);await computer.locator('summary').filter({hasText:'高级：自部署连接服务'}).click();await computer.getByLabel('账号服务地址',{exact:true}).fill(fixture.relayUrl);await computer.getByLabel('电脑名称',{exact:true}).fill('Remote Mandala computer');await computer.getByLabel('服务账号',{exact:true}).fill('mobile');await computer.getByLabel('服务密码',{exact:true}).fill(fixture.password);await computer.getByRole('button',{name:'连接账号服务',exact:true}).click();
 const code=await computer.getByLabel('电脑配对码',{exact:true}).textContent();await signIn(page,fixture.relayUrl);await page.getByRole('button',{name:'请求授权',exact:true}).click();await computer.getByRole('button',{name:'批准',exact:true}).click();await page.getByRole('button',{name:'刷新',exact:true}).click();await page.getByRole('button',{name:'连接',exact:true}).click();await page.getByLabel('电脑配对码',{exact:true}).fill(code!);await page.getByRole('button',{name:'确认配对',exact:true}).click();
}

test('the Mandala tab opens the one primary chat with owned goals and in-chat proposal decisions',async({page,browser})=>{
 test.setTimeout(120000);
 const fixture=await remoteMobileFixture(),context=await browser.newContext(),computer=await context.newPage();const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 try{
  const {config}=await ensureMandalaConfig(fixture.home),primary=ensureMandalaConversation(fixture.store,config),mandalaId=config.mandala!.agentId;
  fixture.store.appendEvent(primary.id,'user',{text:'Prepare the synthetic launch checklist'});fixture.store.appendEvent(primary.id,'text',{text:'I created a goal and proposed one reviewer Agent.'});
  const source={agentId:mandalaId,conversationId:primary.id,invocationId:'synthetic-invocation'};
  const goal=await fixture.manager.coordination.create(source,{goal:'合成发布清单 · Synthetic launch checklist',criteria:[{id:'evidence',text:'Return verifiable evidence',checkRef:null}],projectId:null},'synthetic-goal');
  await fixture.manager.coordination.configure(source,{kind:'agent',action:'create',values:{id:'remote-proposed-agent',name:'Proposed reviewer',instructions:'Synthetic review',defaultCli:'codex',models:{},mcp:[],skills:[]}},'propose','synthetic-proposal',()=>{});
  const background=fixture.store.createConversation({projectId:'',agentId:mandalaId,cli:'codex',model:null,purpose:'mandala-background'});fixture.store.renameConversation(background.id,'Mandala background synthetic run');
  await page.setViewportSize({width:1280,height:850});await pairRemote(page,computer,fixture);
  await expect(page.locator('.remote-tabs [aria-current=page]')).toHaveText('Mandala');
  await expect(page.getByRole('heading',{name:config.agents.find(agent=>agent.id===mandalaId)!.name,exact:true})).toBeVisible();
  await expect(page.getByText('I created a goal and proposed one reviewer Agent.',{exact:true})).toBeVisible();
  const goals=page.getByRole('complementary',{name:'Mandala 负责的目标'});await expect(goals.getByRole('heading',{name:goal.goal,exact:true})).toBeVisible();
  const proposal=page.getByRole('region',{name:/配置变更 · Proposed reviewer/});await expect(proposal).toContainText('待确认');await page.screenshot({path:'/tmp/remote-mandala-1280.png'});
  await proposal.getByRole('button',{name:'确认此变更',exact:true}).click();await expect(proposal).toContainText('已应用');
  expect((await readConfig(fixture.home)).config.agents.some(agent=>agent.id==='remote-proposed-agent')).toBe(true);
  await page.getByLabel('消息',{exact:true}).fill('Remote follow-up for Mandala');await page.getByRole('button',{name:'发送',exact:true}).click();
  await expect.poll(()=>fixture.store.listEvents(primary.id,0).some(event=>event.kind==='user'&&(event.data as {text?:string}).text==='Remote follow-up for Mandala')).toBe(true);
  await page.getByRole('button',{name:'对话',exact:true}).click();const list=page.locator('.remote-chat-list');
  await expect(list.getByRole('button',{name:/手机端合成对话/})).toBeVisible();await expect(list.getByRole('button',{name:/Mandala background synthetic run/})).toHaveCount(0);
  await list.getByRole('button',{name:/Mandala 后台执行/}).click();await expect(list.getByRole('button',{name:/Mandala background synthetic run/})).toBeVisible();
  await expect(page.getByRole('combobox',{name:'智能体',exact:true})).toBeVisible();await page.getByRole('combobox',{name:'智能体',exact:true}).click();await expect(page.getByRole('option',{name:new RegExp(config.agents.find(agent=>agent.id===mandalaId)!.name)})).toHaveCount(0);await page.keyboard.press('Escape');
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Mandala',exact:true}).click();
  await expect(page.getByText('I created a goal and proposed one reviewer Agent.',{exact:true})).toBeVisible();await page.screenshot({path:'/tmp/remote-mandala-390-chat.png'});
  await page.getByRole('button',{name:/^目标/}).click();await expect(goals.getByRole('heading',{name:goal.goal,exact:true})).toBeVisible();await page.screenshot({path:'/tmp/remote-mandala-390-goals.png'});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);
 }finally{await context.close();await fixture.close();}
});

test('remote ordinary and Mandala chats load five turns and catch up after a disconnect', async ({ page, browser }) => {
 test.setTimeout(90000);
 const fixture = await remoteMobileFixture(), context = await browser.newContext(), computer = await context.newPage();
 try {
  const { config } = await ensureMandalaConfig(fixture.home);
  const primary = ensureMandalaConversation(fixture.store, config);
  for (const chat of [fixture.conversation, primary]) for (let i = 1; i <= 12; i++) {
   fixture.store.appendEvent(chat.id, 'user', { text: 'Remote history request ' + i });
   fixture.store.appendEvent(chat.id, 'text', { text: 'Remote history answer ' + i + '\n\n' + 'Example transcript text. '.repeat(16) });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await pairRemote(page, computer, fixture);
  const messages = page.locator('.remote-messages');
  const transport = '**/api/remote/transport';
  let offline = false;
  const historyReads: string[] = [];
  await page.route(transport, async route => {
   const { path } = fixture.inspectRequest(route.request().postDataBuffer()!.toString('utf8'));
   if (path.includes('/history')) historyReads.push(path);
   if (offline) await route.abort('internetdisconnected');
   else await route.continue();
  });
  for (const id of [primary.id, fixture.conversation.id]) {
   if (id !== primary.id) {
    await page.getByRole('button', { name: '对话列表', exact: true }).click();
    await page.getByRole('button', { name: /手机端合成对话/ }).click();
   }
   const request = (n: number) => messages.getByText('Remote history request ' + n, { exact: true });
   await expect(request(12)).toBeVisible();
   await expect(request(8)).toBeAttached();
   await expect(request(7)).toHaveCount(0);
   const scroller = page.locator('.remote-chat-main');
   const distanceFromBottom = () => scroller.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight);
   await expect.poll(distanceFromBottom).toBeLessThan(4);
   if (id === primary.id) {
    await scroller.evaluate(el => { el.scrollTop = el.scrollHeight - el.clientHeight - 45; });
    await expect.poll(distanceFromBottom).toBeGreaterThan(40);
    const refreshed=page.waitForResponse(response=>{
     const request=response.request();
     return response.ok()&&request.url().endsWith('/api/remote/transport')&&
      fixture.inspectRequest(request.postData()!).path.includes('/history?recent=5&since=');
    });
    await page.getByRole('button', { name: '刷新远程工作区', exact: true }).click();
    await refreshed;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await distanceFromBottom()).toBeGreaterThan(40);
   }
   await scroller.evaluate(el => { el.scrollTop = 0; });
   await expect(request(3)).toBeAttached();
   await expect(request(2)).toHaveCount(0);
   const live = fixture.store.appendEvent(id, 'user', { text: 'Remote live message ' + id });
   await expect(messages.getByText('Remote live message ' + id, { exact: true })).toHaveCount(1);
   offline = true;
   await expect(page.locator('.remote-connection')).toHaveAttribute('data-state', 'offline');
   fixture.store.database.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify({ text: 'Updated live message ' + id }), live.id);
   for (let i = 1; i <= 7; i++) fixture.store.appendEvent(id, 'user', { text: 'Remote missed message ' + i });
   offline = false;
   await expect(messages.getByText('Remote missed message 7', { exact: true })).toHaveCount(1);
   await expect(messages.getByText('Remote missed message 1', { exact: true })).toHaveCount(1);
   await expect(messages.getByText('Updated live message ' + id, { exact: true })).toHaveCount(1);
   await expect(request(3)).toHaveCount(1);
   expect(historyReads.some(path => path.startsWith('/api/conversations/' + id + '/history?recent=5&since='))).toBe(true);
  }
  expect(historyReads.every(path => !path.endsWith('/history'))).toBe(true);
 } finally {
  await context.close();
  await fixture.close();
 }
});

test('a paired browser decides only its primary chat blueprint suggestion and reads the same result after reload',async({page,browser,request},info)=>{
 test.setTimeout(150000);
 const fixture=await remoteMobileFixture(async()=>JSON.stringify({projectId:'star-atlas',lane:'绘制',assigneeAgentId:null}));
 const context=await browser.newContext(),computer=await context.newPage();
 const previous=process.env.OMINO_HOME;process.env.OMINO_HOME=join(fixture.home,'plans');
 try{
  const {config,revision}=await ensureMandalaConfig(fixture.home),primary=ensureMandalaConversation(fixture.store,config);
  const projectId='star-atlas',cwd=join(fixture.home,'atlas');await mkdir(cwd);
  config.projects.push({id:projectId,name:'离线星图',cwd,agentIds:[],mcp:[],skills:[],resources:[]});await writeConfig(fixture.home,config,revision);
  const service=createBlueprintService(fixture.home,{draft:async()=>['绘制','同步']});await service.enable(projectId);
  const draft=await service.draft(projectId);await service.confirm(projectId,draft.draftId,draft.modules);
  const goal='检查星图同步',input={goal,criteria:[{id:'check',text:'验证往返同步',checkRef:null}],projectId};
  const sourceEvent=fixture.store.appendEvent(primary.id,'user',{text:goal});
  const source={agentId:primary.agentId,conversationId:primary.id,humanEventId:sourceEvent.id,invocationId:'paired-suggestion'};
  const review=await fixture.manager.coordination.requestCreation(source,input,'paired-goal') as {reviewId:string};
  fixture.store.appendEvent(primary.id,'text',{text:'请确认模块和负责人。'});
  const routes=fixture.manager.coordination.routes;
  const form=await routes.preview(input,'separate-form');
  const other=await routes.preview(input,'another-chat',{...source,conversationId:fixture.conversation.id,managed:false});
  const path=(id:string)=>fixture.localUrl+'/api/remote/mandala/route-reviews/'+id;
  expect((await request.get(path(review.reviewId))).status()).toBe(401);
  const operations:{method:string;path:string}[]=[];
  page.on('request',r=>{if(r.url().endsWith('/api/remote/transport')&&r.postData()){const {method,path}=fixture.inspectRequest(r.postData()!);operations.push({method,path});}});
  await pairRemote(page,computer,fixture);
  for(const id of [form!.id,other!.id]){
   expect((await computer.request.get(path(id))).status()).toBe(404);
   expect((await computer.request.post(path(id),{data:{selection:null}})).status()).toBe(404);
  }
  const card=page.getByRole('region',{name:'蓝图分派建议'});
  await expect(card.getByRole('combobox',{name:'建议模块'})).toContainText('绘制');
  await card.getByRole('combobox',{name:'建议模块'}).click();await page.getByRole('option',{name:'同步',exact:true}).click();
  await card.getByRole('button',{name:'确认并创建任务'}).click();await expect(card.getByText('任务已创建',{exact:true})).toBeVisible();
  await page.reload();await expect(card.getByText('任务已创建',{exact:true})).toBeVisible();await expect(card.getByRole('button',{name:'确认并创建任务'})).toHaveCount(0);
  const saved=routes.read(review.reviewId);expect(saved).toMatchObject({status:'confirmed',matched:false,selection:{projectId,lane:'同步'}});
  const list=fixture.manager.coordination.list().filter(g=>g.taskId===saved.taskId);expect(list).toHaveLength(1);
  expect(fixture.manager.taskService.getTask(fixture.principal,saved.taskId!).moduleRef).toEqual({projectId,lane:'同步'});
  const scoped='/api/remote/mandala/route-reviews/'+review.reviewId;
  expect(operations.filter(r=>r.path===scoped&&r.method==='POST')).toHaveLength(1);
  expect(operations.filter(r=>r.path===scoped&&r.method==='GET').length).toBeGreaterThanOrEqual(2);
  await page.screenshot({path:info.outputPath('paired-blueprint.png'),animations:'disabled'});
 }finally{await context.close();await fixture.close();if(previous===undefined)delete process.env.OMINO_HOME;else process.env.OMINO_HOME=previous;}
});

test('a paired browser captures a task offline and reconciles a lost reply exactly once', async ({ page, browser }) => {
 test.setTimeout(120000);
 const fixture=await remoteMobileFixture(), context=await browser.newContext(), computer=await context.newPage();
 const goal='Offline encrypted task '+Date.now();
 let offline=false,loseReply=true;
 const saves:string[]=[],checks:string[]=[];
 const tasks=()=>fixture.store.database.prepare('SELECT id FROM work_tasks WHERE goal=?').all(goal);
 try {
  await pairRemote(page,computer,fixture);
  await page.route('**/api/remote/transport',async route=>{
   if(offline)return route.abort('internetdisconnected');
   const op=fixture.inspectRequest(route.request().postData()!);
   if(op.method==='POST'&&op.path==='/api/remote/tasks'){
    saves.push(JSON.parse(op.body).commandKey);
    if(loseReply){loseReply=false;await route.fetch();return route.abort('failed');}
   }
   if(op.method==='GET'&&op.path.startsWith('/api/remote/tasks/'))checks.push(op.path);
   await route.continue();
  });
  const nav=page.locator('.remote-tabs'), connection=page.locator('.remote-connection'),refresh=page.getByRole('button',{name:'刷新远程工作区'});
  const capture=page.getByLabel('记录新事情'), save=page.getByRole('button',{name:'保存任务',exact:true});
  await nav.getByRole('button',{name:'配置概览'}).click();
  const cache=page.getByLabel('缓存已读内容（7 天）');await expect(cache).not.toBeChecked();await cache.check();
  await nav.getByRole('button',{name:'任务',exact:true}).click();await expect(capture).toBeEnabled();
  const other=await page.context().newPage();
  try {
   await other.goto(page.url());await expect(other.getByRole('status').filter({hasText:'本页只读'})).toBeVisible();
   await other.locator('.remote-tabs').getByRole('button',{name:'任务',exact:true}).click();
   await expect(other.getByLabel('记录新事情')).toBeDisabled();
  }finally{await other.close();}
  offline=true;await refresh.click();await expect(connection).toHaveAttribute('data-state','offline');
  await capture.fill(goal);await expect(save).toBeDisabled();
  await page.reload();await nav.getByRole('button',{name:'任务',exact:true}).click();await expect(capture).toHaveValue(goal);
  await expect(page.getByText('合成持久任务',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>JSON.stringify(localStorage))).not.toContain(goal);
  expect(await page.evaluate(()=>JSON.stringify(localStorage))).not.toContain('合成持久任务');
  expect(tasks()).toHaveLength(0);expect(saves).toHaveLength(0);
  offline=false;await refresh.click();await expect(save).toBeEnabled();expect(saves).toHaveLength(0);
  await save.click();await expect.poll(tasks).toHaveLength(1);
  await page.reload();await nav.getByRole('button',{name:'任务',exact:true}).click();
  const check=page.getByRole('button',{name:'核对保存结果',exact:true});await expect(check).toBeEnabled();
  expect(saves).toHaveLength(1);await check.click();await expect(capture).toHaveValue('');
  expect(checks).toContain('/api/remote/tasks/'+saves[0]);expect(saves).toHaveLength(1);
  expect(fixture.store.database.prepare('SELECT COUNT(*) AS n FROM task_runs WHERE task_id=?').get(tasks()[0].id)?.n).toBe(0);
  await nav.getByRole('button',{name:'配置概览'}).click();
  await page.getByRole('button',{name:'清除本设备缓存'}).click();await expect(cache).not.toBeChecked();
  expect(await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.includes(':cache:')))).toEqual([]);
 } finally {await context.close();await fixture.close();}
});
