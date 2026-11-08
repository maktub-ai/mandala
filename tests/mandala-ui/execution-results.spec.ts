import {expect,test} from '@playwright/test';
test('result and execution headings show the execution conversation title instead of long instructions',async({page,request},info)=>{
 const fixture=await(await request.post('/__test__/execution-results')).json(),path='/api/v2/tasks/'+fixture.taskId;
 const original=(await(await request.get(path)).json()).task,title='海德拉巴预付账单核验';
 const setGoal=async(goal:string)=>{const {task}=await(await request.get(path)).json();expect((await request.patch(path,{headers:{'Idempotency-Key':crypto.randomUUID()},data:{expectedRevision:task.revision,goal}})).ok()).toBe(true);};
 const rename=async(title:string)=>expect((await request.patch('/api/conversations/'+fixture.executionId,{data:{title}})).ok()).toBe(true);
 try{
  await setGoal('用户问：请在账单项目授权上下文中做一次聚焦只读核验。'.repeat(30));await rename(title);
  await page.setViewportSize({width:1440,height:900});await page.goto('/mandala');
  const headings=page.locator('.execution-result').filter({has:page.locator('a[href*="conversation='+fixture.executionId+'"]')}).locator('.execution-result-heading strong'),chat=page.locator('.mandala-panels .execution-chats a[href="/?conversation='+fixture.executionId+'"]'),child=chat.locator('.execution-chat-title > span');
  await expect(headings).toHaveCount(2);await expect(headings.first()).toHaveText(title);await expect(headings.last()).toHaveText(title);
  await page.locator('.mandala-panels .task-work-card').filter({has:page.locator('a[href="/tasks/'+fixture.taskId+'"]')}).locator('.task-work-related > summary').click();
  await expect(child).toHaveText(title);await expect(chat).toHaveAttribute('href','/?conversation='+fixture.executionId);
  await page.screenshot({path:info.outputPath('execution-conversation-titles.png')});
  const longTitle='账单采集核验结果'.repeat(9);await rename(longTitle);await expect(headings.first()).toHaveText(longTitle);await expect(child).toHaveText(longTitle);
  expect(await child.evaluate(element=>element.scrollWidth>element.clientWidth&&getComputedStyle(element).textOverflow==='ellipsis')).toBe(true);
  await page.setViewportSize({width:390,height:900});
  expect(await headings.first().evaluate(element=>element.getBoundingClientRect().height<=2*parseFloat(getComputedStyle(element).lineHeight)+1&&element.scrollHeight>element.clientHeight)).toBe(true);
  await page.setViewportSize({width:1440,height:900});
  await rename('账单采集核验结果');await expect(headings.first()).toHaveText('账单采集核验结果');await expect(child).toHaveText('账单采集核验结果');
 }finally{await setGoal(original.goal);await rename(fixture.title);}
});
test('result replies stay readable when their task is completed or reopened',async({page,request})=>{
 const fixture=await(await request.post('/__test__/execution-results')).json();
 const move=async(id:string,state:string)=>{const {task}=await(await request.get('/api/v2/tasks/'+id)).json();expect((await request.post('/api/v2/tasks/'+id+'/move',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{expectedRevision:task.revision,state}})).ok()).toBe(true);};
 try{
  await move(fixture.taskId,'review');await page.goto('/mandala');
  const card=page.getByRole('article',{name:fixture.title+' · 执行结果',exact:true}).last();
  await expect(card).toBeVisible();
  await expect(card.locator('.execution-result-body')).toContainText('复查完成，两项配置差异仍然存在。');
  await move(fixture.taskId,'completed');
  await expect(card.locator('.execution-result-body')).toContainText('复查完成，两项配置差异仍然存在。');
  expect((await(await request.get('/api/v2/tasks/'+fixture.taskId)).json()).task.state).toBe('completed');
  await page.reload();await expect(card.locator('.execution-result-body')).toContainText('复查完成，两项配置差异仍然存在。');
  await move(fixture.taskId,'todo');await expect(card.locator('.execution-result-body')).toContainText('复查完成，两项配置差异仍然存在。');
 }finally{await move(fixture.taskId,'todo');}
});
for(const mode of ['light','dark'] as const)for(const width of [1440,1024,768,390])test(`execution results persist and link to the exact continuous turn ${mode} ${width}`,async({page,request},info)=>{
 const fixture=await(await request.post('/__test__/execution-results')).json();
 await page.addInitScript(mode=>localStorage.setItem('mana-theme',mode),mode);await page.setViewportSize({width,height:900});
 await page.goto('/mandala');
 const cards=page.getByRole('article',{name:fixture.title+' · 执行结果',exact:true});
 await expect(cards).toHaveCount(2);await expect(cards.first()).toContainText('执行结束');
 await expect(cards.first().locator('strong')).toHaveText('每日自动化检查');
 await expect(cards.first().locator('.execution-result-body')).toContainText('发现两项配置差异');
 await expect(cards.last().locator('time')).not.toHaveText(/\d{2}:\d{2}:\d{2}/);
 await expect(page.getByText('检查已结束，发现两处差异，需要确认。',{exact:true}).last()).toBeVisible();
 await expect(cards.last().locator('.execution-result-body')).toContainText('复查完成，两项配置差异仍然存在。');
 const composer=page.getByRole('textbox',{name:'消息',exact:true});await composer.fill('保留我的草稿');
 await page.locator('.conversation').evaluate(element=>{element.scrollTop=0;});
 await page.screenshot({path:info.outputPath(`results-${mode}-${width}.png`)});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.reload();await expect(cards).toHaveCount(2);await expect(composer).toHaveValue('保留我的草稿');
 await cards.first().getByRole('link',{name:'查看执行详情',exact:true}).click();
 await expect(page).toHaveURL(new RegExp('run='+fixture.runId));
 const turn=page.locator('[data-run-id="'+fixture.runId+'"]');await expect(turn).toBeFocused();await expect(turn).toContainText('第 1 次检查');
 expect(await page.locator('.topbar').evaluate(element=>element.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
 await page.goBack();await expect(cards).toHaveCount(2);await expect(composer).toHaveValue('保留我的草稿');
});

test('primary scheduled panel includes rules reported by other executors and exposes the destination',async({page,request})=>{
 const fixture=await(await request.post('/__test__/execution-results')).json();
 await page.setViewportSize({width:1440,height:900});await page.goto('/mandala');
 const panel=page.locator('.mandala-panels');await panel.getByRole('tab',{name:'定时',exact:true}).click();
 await expect(panel.getByText('委派的自动化检查',{exact:true})).toBeVisible();
 await panel.locator('.mandala-rule').filter({has:page.getByText('委派的自动化检查',{exact:true})}).getByRole('button',{name:'查看规则：委派的自动化检查',exact:true}).click();
 await expect(page).toHaveURL(new RegExp('schedule='+fixture.ruleId));
 await expect(page.getByText('结果回报到：',{exact:false})).toBeVisible();
});


test('result replies show long failure details directly and retain deliverable links without a body',async({page,request})=>{
 const fixture=await(await request.post('/__test__/execution-results')).json();
 let empty=false;
 await page.route('**/api/conversations/*/results',async route=>{
  const response=await route.fetch(),items=await response.json();
  const index=items.findIndex((item:{conversationId:string;runId:string})=>item.conversationId===fixture.executionId&&item.runId!==fixture.runId);
  items[index]={...items[index],state:'failed',title:'跨项目自动化检查：配置、数据同步与历史任务回执的完整性核对',summary:empty?'':'**检查未完成。** 部分项目的配置暂时无法读取。\n\n'+('已确认：备份配置可读取，未执行任何修改。\n\n').repeat(35)+'请恢复访问后重试。',artifactCount:1,awaitingReview:false};
  await route.fulfill({response,json:items});
 });
 await page.setViewportSize({width:390,height:900});await page.goto('/mandala');
 const card=page.getByRole('article').filter({hasText:'跨项目自动化检查'});
 await expect(card).toContainText('执行失败');
 await expect(card.getByText('请恢复访问后重试。',{exact:true})).toBeVisible();
 await expect(card.getByRole('link',{name:'查看产物（1）'})).toHaveAttribute('href',/^\/tasks\//);
 empty=true;await page.reload();await expect(card.locator('.execution-result-body')).toHaveCount(0);
 await expect(card.getByRole('button',{name:'展开结果'})).toHaveCount(0);
 await expect(card.getByRole('link',{name:'查看执行详情'})).toHaveAttribute('href',new RegExp('conversation='+fixture.executionId));
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('results received before the first loaded turn precede that turn',async({page,request})=>{
 const fixture=await(await request.post('/__test__/execution-results')).json();
 await page.route('**/api/conversations/*/results',async route=>{
  const response=await route.fetch(),items=await response.json();
  const index=items.findIndex((item:{conversationId:string;runId:string})=>item.conversationId===fixture.executionId&&item.runId!==fixture.runId);
  items[index]={...items[index],title:'更早返回的结果',createdAt:'2000-01-01T00:00:00.000Z'};
  await route.fulfill({response,json:items});
 });
 await page.goto('/mandala');
 const card=page.getByRole('article',{name:'更早返回的结果 · 执行结果',exact:true});
 await expect(card).toBeVisible();
 expect(await card.evaluate(element=>!!(element.compareDocumentPosition(document.querySelector('.chat-turn')!)&Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
});

test('completed result replies stay before later messages and keep their body visible',async({page,request})=>{
 const fixture=await(await request.post('/__test__/execution-results')).json(),topic='开始一个新的话题 '+crypto.randomUUID();
 const task=(await(await request.get('/api/v2/tasks/'+fixture.taskId)).json()).task;
 try{
 await page.goto('/mandala');
 const card=page.getByRole('article',{name:fixture.title+' · 执行结果',exact:true}).last();
 await expect(card).toBeVisible();
 await expect(card.locator('.execution-result-body')).toContainText('复查完成，两项配置差异仍然存在。');
 expect((await request.post('/api/v2/tasks/'+task.id+'/move',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{expectedRevision:task.revision,state:'completed'}})).ok()).toBe(true);
 await expect(card).toContainText('用户已验收');
 await expect(card.locator('.execution-result-body')).toContainText('复查完成，两项配置差异仍然存在。');
 await expect(card).toContainText('复查完成，两项配置差异仍然存在。');
 await request.post('/api/conversations/'+fixture.mainId+'/messages',{data:{text:topic}});
 await expect(page.getByText(topic,{exact:true})).toBeVisible();
 const beforeNewMessage=()=>card.evaluate((element,topic)=>{const message=[...document.querySelectorAll('.message.user')].find(item=>item.textContent?.includes(topic));return !!message&&!!(element.compareDocumentPosition(message)&Node.DOCUMENT_POSITION_FOLLOWING);},topic);
 expect(await beforeNewMessage()).toBe(true);
 await page.reload();
 await expect(card.locator('.execution-result-body')).toContainText('复查完成，两项配置差异仍然存在。');
 expect(await beforeNewMessage()).toBe(true);
 await expect(card.getByRole('link',{name:'查看执行详情',exact:true})).toHaveAttribute('href',new RegExp('conversation='+fixture.executionId));
 }finally{
  const current=(await(await request.get('/api/v2/tasks/'+task.id)).json()).task;
  expect((await request.post('/api/v2/tasks/'+task.id+'/move',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{expectedRevision:current.revision,state:task.state}})).ok()).toBe(true);
 }
});
