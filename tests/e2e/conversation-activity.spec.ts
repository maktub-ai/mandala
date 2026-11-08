import {test,expect} from '@playwright/test';

test.beforeEach(async({request,page})=>{
 await page.addInitScript(()=>localStorage.setItem('mana-language','zh-CN'));
 const {revision,config}=await(await request.get('/api/config')).json();
 const saved=await request.put('/api/config',{data:{revision,config:{...config,projects:[{id:'activity',name:'数据工作区',cwd:'',agentIds:['inspector'],resources:[],mcp:[],skills:[]}],agents:[...config.agents.filter((agent:{systemRole?:string})=>agent.systemRole),{id:'inspector',name:'Mandala',instructions:'Synthetic activity fixture only.',defaultCli:'codex',models:{},mcp:[],skills:[]}]}}});
 expect(saved.ok(),await saved.text()).toBe(true);
});

test.afterEach(async({request})=>{
 const chats=await(await request.get('/api/conversations')).json();
 for(const chat of chats.filter((chat:{agentId:string;status:string})=>chat.agentId==='inspector'&&['running','approval'].includes(chat.status))){
  expect((await request.post('/api/conversations/'+chat.id+'/stop',{data:{}})).ok()).toBe(true);
 }
});

test('defaults to folded activity, opens tool bodies only on inspection, and folds again on reload',async({page,request},testInfo)=>{
 const fixture=await(await request.post('/__test__/conversation-activity-fixture',{data:{state:'running'}})).json();
 await page.goto('/?conversation='+fixture.id);
 const process=page.locator('.turn-process');
 await expect(process.getByRole('button',{name:'展开本轮过程',exact:true})).toHaveAttribute('aria-expanded','false');
 await expect(process.locator('.explicit-progress')).toContainText('接下来运行导出校验');
 const current=process.locator('.operation-card').last();
 await expect(current).not.toHaveAttribute('open','');
 await expect(process.locator('.operation-content')).toHaveCount(0);
 await expect(process.locator('.run-operation-group')).toHaveCount(0);
 for(const theme of ['light','dark'])for(const width of [1440,1024,768,390]){
  await page.evaluate(theme=>localStorage.setItem('mana-theme',theme),theme);await page.setViewportSize({width,height:1000});await page.reload();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath(`folded-${theme}-${width}.png`)});
 }
 await process.getByRole('button',{name:'展开本轮过程',exact:true}).click();
 await expect(current.locator('.operation-content')).toHaveCount(0);
 await expect(process.locator('.run-commentary')).toContainText('确认 CSV 编码和列顺序');
 await expect(process.locator('.run-operation-group')).toHaveCount(2);
 await expect(process.getByText('读取 3 个文件',{exact:true})).toBeVisible();
 await expect(process.getByText('搜索 2 次',{exact:true})).toBeVisible();
 await expect(process.getByText('Synthetic file contents',{exact:false})).toHaveCount(0);
 const group=process.locator('.run-operation-group').first();
 await group.locator(':scope > summary').focus();await page.keyboard.press('Enter');
 await expect(group.locator('.operation-card')).toHaveCount(3);
 await group.locator('.operation-card').first().locator(':scope > summary').click();
 await expect(group.locator('.operation-output')).toContainText('Synthetic file contents: src/export-billing.ts');
 await expect(page.locator('.composer-toolbar')).toContainText('Fixture');await expect(page.getByText('读取草稿…',{exact:true})).toHaveCount(0);await page.screenshot({path:testInfo.outputPath('grouped-active.png')});
 await page.getByRole('button',{name:'停止执行',exact:true}).click();
 await expect(page.getByTestId('chat-status')).toHaveText('已中断');
 await expect(current.locator('.operation-content')).toHaveCount(0);
 await current.locator(':scope > summary').click();
 await expect(current.locator('.operation-output')).toContainText('记录数校验：执行中');
 await expect(process.locator('[data-progress-event-id="'+fixture.reportId+'"]')).toContainText('上报步骤 · 2/3');
 await page.reload();
 await expect(process.getByRole('button',{name:'展开本轮过程',exact:true})).toHaveAttribute('aria-expanded','false');
 await expect(process.locator('.operation-content')).toHaveCount(0);
 await process.locator('.operation-card').last().locator(':scope > summary').click();
 await expect(process.locator('.operation-output')).toContainText('记录数校验：执行中');
 await process.locator('.operation-card').last().scrollIntoViewIfNeeded();
 await expect(page.locator('.composer-toolbar')).toContainText('Fixture');await expect(page.getByText('读取草稿…',{exact:true})).toHaveCount(0);await page.screenshot({path:testInfo.outputPath('stopped-output.png')});
});

test('keeps approval actions inline when folded and retains exact decisions and original context across retry and reload',async({page,request},testInfo)=>{
 const fixture=await(await request.post('/__test__/conversation-activity-fixture',{data:{state:'approval'}})).json();
 await page.goto('/?conversation='+fixture.id);
 const process=page.locator('.turn-process');
 await expect(process.locator('.approval-card')).toHaveCount(1);
 for(const theme of ['light','dark'])for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000});
  await page.evaluate(theme=>localStorage.setItem('mana-theme',theme),theme);await page.reload();
  await expect(process.getByRole('button',{name:'允许本次',exact:true})).toBeVisible();
  await expect(page.locator('.composer-toolbar')).toContainText('Fixture');await expect(page.getByText('读取草稿…',{exact:true})).toHaveCount(0);await page.screenshot({path:testInfo.outputPath('approval-'+theme+'-'+width+'.png')});
 }
 await expect(process.getByRole('button',{name:'展开本轮过程',exact:true})).toHaveAttribute('aria-expanded','false');
 await expect(process.getByRole('button',{name:'拒绝',exact:true})).toBeVisible();
 await process.getByRole('button',{name:'拒绝',exact:true}).click();
 await expect(page.locator('.approval-card')).toHaveCount(0);
 await process.getByRole('button',{name:'展开本轮过程',exact:true}).click();
 const resolved=process.locator('.run-approval-history');
 await expect(resolved).toContainText('已拒绝');
 await resolved.locator(':scope > summary').click();
 await expect(resolved).toContainText('node scripts/validate-export.mjs');
 await expect(resolved).toContainText('test-storage.example');
 await request.post('/__test__/conversation-activity-approval',{data:{conversationId:fixture.id}});
 await expect(process.locator('.approval-card')).toHaveCount(1);
 await expect(resolved).toHaveCount(1);
 await process.getByRole('button',{name:'允许本次',exact:true}).click();
 await expect(resolved).toHaveCount(2);
 await expect(resolved.last()).toContainText('已允许');
 await page.reload();
 await process.getByRole('button',{name:'展开本轮过程',exact:true}).click();
 await expect(page.locator('.run-approval-history')).toHaveCount(2);
 await expect(page.locator('.run-approval-history').first()).toContainText('已拒绝');
 await expect(page.locator('.run-approval-history').last()).toContainText('已允许');
 await page.locator('.run-approval-history').last().scrollIntoViewIfNeeded();
 await expect(page.locator('.composer-toolbar')).toContainText('Fixture');await expect(page.getByText('读取草稿…',{exact:true})).toHaveCount(0);await page.screenshot({path:testInfo.outputPath('approval-decisions-390.png')});
});

test('keeps the final answer separate and renders compact activity across themes and four widths',async({page,request},testInfo)=>{
 const fixture=await(await request.post('/__test__/conversation-activity-fixture',{data:{state:'ended'}})).json();
 for(const theme of ['light','dark'])for(const width of [1440,1024,768,390]){
  await page.setViewportSize({width,height:1000});
  await page.addInitScript(theme=>localStorage.setItem('mana-theme',theme),theme);
  await page.goto('/?conversation='+fixture.id);
  await expect(page.locator('.message.text')).toContainText('导出校验通过');
  await expect(page.locator('.turn-process .operation-card')).toHaveCount(0);
  await expect(page.locator('.composer-toolbar')).toContainText('Fixture');await expect(page.getByText('读取草稿…',{exact:true})).toHaveCount(0);
  if(width===1440||width===390)await page.screenshot({path:testInfo.outputPath('final-'+theme+'-'+width+'.png')});
  await page.getByRole('button',{name:'展开本轮过程',exact:true}).click();
  await expect(page.locator('.run-operation-group').first()).toContainText('读取 3 个文件');
  await expect(page.locator('[data-progress-event-id="'+fixture.reportId+'"]')).toContainText('历史进展');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const rows=await page.locator('.run-operation-group>summary').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().height));
  expect(rows.every(height=>height<56)).toBe(true);
  await expect(page.locator('.composer-toolbar')).toContainText('Fixture');await expect(page.getByText('读取草稿…',{exact:true})).toHaveCount(0);await page.screenshot({path:testInfo.outputPath('activity-'+theme+'-'+width+'.png')});
 }
});
test('folds failed and successful commands together and retains their details on expansion',async({page,request},testInfo)=>{
 const fixture=await(await request.post('/__test__/conversation-activity-fixture',{data:{state:'command-failure'}})).json();
 await page.goto('/?conversation='+fixture.id);
 const process=page.locator('.turn-process');
 for(const theme of ['light','dark'])for(const width of [1440,390]){
  await page.evaluate(theme=>localStorage.setItem('mana-theme',theme),theme);await page.setViewportSize({width,height:1000});await page.reload();
  await expect(process.locator('.operation-card')).toHaveCount(1);
  await expect(process.locator('.operation-state.failed')).toHaveCount(0);
  await expect(process).not.toContainText('Command exited with code 127');
  await process.getByRole('button',{name:'展开本轮过程',exact:true}).click();
  const failed=process.locator('.operation-card').filter({has:page.locator('.operation-state.failed')});
  await expect(failed).toHaveCount(1);
  await expect(process.getByText('node scripts/check-fields.mjs',{exact:true})).toBeVisible();
  await failed.locator(':scope > summary').click();
  await expect(failed.locator('.operation-content')).toContainText('missing-validation-command');
  await expect(failed.locator('.operation-output')).toContainText('Command exited with code 127');
  await process.getByRole('button',{name:'收起本轮过程',exact:true}).click();
  await expect(process.locator('.operation-card')).toHaveCount(1);
  await expect(process.locator('.operation-content')).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath(`command-failure-${theme}-${width}.png`)});
 }
});
test('keeps a later live request actionable when the runtime reuses a resolved native request ID',async({page,request})=>{
 const fixture=await(await request.post('/__test__/conversation-activity-fixture',{data:{state:'approval'}})).json();
 await page.goto('/?conversation='+fixture.id);
 await expect(page.locator('.approval-card')).toHaveCount(1);
 await request.post('/__test__/conversation-activity-approval',{data:{conversationId:fixture.id,state:'resolved'}});
 await expect(page.locator('.approval-card')).toHaveCount(0);
 await request.post('/__test__/conversation-activity-approval',{data:{conversationId:fixture.id}});
 await expect(page.locator('.approval-card')).toHaveCount(1);
 await page.getByRole('button',{name:'允许本次',exact:true}).click();
 await expect(page.locator('.approval-card')).toHaveCount(0);
 await page.getByRole('button',{name:'展开本轮过程',exact:true}).click();
 await expect(page.locator('.run-approval-history')).toHaveCount(2);
 await expect(page.locator('.run-approval-history').last()).toContainText('已允许');
});

test('offers 44px touch targets for the process, individual operation and reported steps',async({browser,request},testInfo)=>{
 const fixture=await(await request.post('/__test__/conversation-activity-fixture',{data:{state:'running'}})).json();
 const context=await browser.newContext({viewport:{width:390,height:1000},hasTouch:true});
 try{
  const page=await context.newPage();await page.goto('/?conversation='+fixture.id);
  await expect(page.locator('.operation-card')).toHaveCount(1);
  expect(await page.evaluate(()=>matchMedia('(pointer:coarse)').matches)).toBe(true);
  const targets=page.locator('.turn-process-toggle,.turn-process .operation-card>summary,.turn-process .explicit-progress>.ui-disclosure>summary');
  const sizes=await targets.evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().height));
  expect(sizes.length).toBe(3);expect(sizes.every(height=>height>=44)).toBe(true);
  await expect(page.locator('.composer-toolbar')).toContainText('Fixture');
  await page.locator('.operation-card').scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath('coarse-pointer-390.png')});
 }finally{await context.close();}
});

test('shows a single ACP approval heading with the native context and scope intact',async({page,request},testInfo)=>{
 const fixture=await(await request.post('/__test__/conversation-activity-fixture',{data:{state:'acp-approval'}})).json();
 await page.goto('/?conversation='+fixture.id);
 const card=page.locator('.approval-card');
 await expect(card.getByText('需要你的审批',{exact:true})).toHaveCount(1);
 await expect(card).toContainText('读取导出约定');await expect(card).toContainText('/synthetic/project/docs/billing-fields.md');
 await expect(card.getByRole('button',{name:'始终允许（原生范围）',exact:true})).toBeVisible();
 await expect(card).toContainText('长期授权由执行端按原生范围保存');
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000});await expect(page.locator('.composer-toolbar')).toContainText('Fixture');
  await card.scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath('acp-approval-'+width+'.png')});
 }
});

test('aligns commentary with activity icons and its first text line',async({page,request},testInfo)=>{
 const fixture=await(await request.post('/__test__/conversation-activity-fixture',{data:{state:'ended'}})).json();
 await page.goto('/?conversation='+fixture.id);
 await page.getByRole('button',{name:'展开本轮过程',exact:true}).click();
 for(const theme of ['light','dark'])for(const width of [1440,1024,768,390]){
  await page.setViewportSize({width,height:1000});
  await page.evaluate(theme=>localStorage.setItem('mana-theme',theme),theme);
  await page.reload();
  await page.getByRole('button',{name:'展开本轮过程',exact:true}).click();
  const commentary=page.locator('.run-commentary').first();
  await expect(commentary.getByText('过程说明',{exact:true})).toHaveCount(0);
  const icon=await commentary.locator('.run-commentary-label .progress-dot').boundingBox();
  const actionIcon=await page.locator('.run-operation-group .ui-disclosure-title > svg').first().boundingBox();
  expect(Math.abs((icon!.x+icon!.width/2)-(actionIcon!.x+actionIcon!.width/2))).toBeLessThanOrEqual(1);
  if(width>600){
   const labelTextX=(await commentary.locator('.markdown-text').boundingBox())!.x;
   const actionTitle=await page.locator('.run-operation-group .ui-disclosure-title > strong').first().boundingBox();
   expect(Math.abs(labelTextX-actionTitle!.x)).toBeLessThanOrEqual(1);
   const line=await commentary.locator('.markdown-text p').first().boundingBox();
   const label=await commentary.locator('.run-commentary-label').boundingBox();
   expect(Math.abs(label!.y-line!.y)).toBeLessThanOrEqual(1);
  }
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath(`commentary-${theme}-${width}.png`)});
 }
});

test('folds a Codex reasoning/action block once and keeps the active operation independently visible',async({page,request},testInfo)=>{
 const fixture=await(await request.post('/__test__/conversation-activity-fixture',{data:{state:'reasoning-groups'}})).json();
 await page.goto('/?conversation='+fixture.id);
 const process=page.locator('.turn-process');
 await expect(process.locator('.operation-card')).toHaveCount(1);
 await process.getByRole('button',{name:'展开本轮过程',exact:true}).click();
 const group=process.locator('.run-reasoning-group');
 await expect(group).toHaveCount(1);
 await expect(group.locator(':scope > summary')).toContainText('先核对字段与编码约定');
 await expect(group.locator(':scope > summary')).toContainText('3 次操作');
 await expect(group.locator('.operation-card')).toHaveCount(0);
 await group.locator(':scope > summary').focus();await page.keyboard.press('Enter');
 await expect(group.locator('.operation-card')).toHaveCount(3);
 await expect(group.locator('.operation-content')).toHaveCount(0);
 await group.locator('.operation-card').first().locator(':scope > summary').click();
 await expect(group.locator('.operation-output')).toContainText('Synthetic check output: fields');
 await group.locator(':scope > summary').click();
 await expect(group.locator('.operation-card')).toHaveCount(0);
 for(const theme of ['light','dark'])for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000});await page.evaluate(theme=>localStorage.setItem('mana-theme',theme),theme);await page.reload();
  await process.getByRole('button',{name:'展开本轮过程',exact:true}).click();
  await expect(group.locator('.operation-card')).toHaveCount(0);
  await expect(process.locator('.operation-card')).toHaveCount(1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath(`reasoning-group-${theme}-${width}.png`)});
 }
});
