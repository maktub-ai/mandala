import {expect,test} from '@playwright/test';
test('each task appears as one live row; later operations update it in place and execution chats stay on the task',async({page,request})=>{
 const fixture=await(await request.post('/__test__/task-operation-cards')).json();await page.goto('/mandala');
 const card=page.locator('.turn-change[data-task-id="'+fixture.goalId+'"]');
 await expect(card).toHaveCount(1);await expect(card.getByRole('link',{name:'任务：验证关联卡片',exact:true})).toHaveAttribute('href','/tasks/'+fixture.goalId);
 await expect(page.locator('.turn-changes').filter({hasText:'任务已取消'})).toHaveCount(0);
 await expect(page.locator('.turn-change[data-task-id="'+fixture.otherId+'"]')).toContainText('已取消');
 await expect(card.locator('.operation-row,.task-work-child,.operation-card')).toHaveCount(0);
 await expect(card.locator('.execution-marks .status-mark')).toHaveCount(1);
 await page.reload();await expect(card).toHaveCount(1);await expect(card).toContainText('待办');
});
for(const mode of ['light','dark'] as const)for(const width of [1440,390])test(`operation cards group by originating request and survive replies and refresh ${mode} ${width}`,async({page,request},info)=>{
 const fixture=await(await request.post('/__test__/operation-cards')).json();
 await page.addInitScript(mode=>localStorage.setItem('mana-theme',mode),mode);await page.setViewportSize({width,height:1000});await page.goto('/mandala');
 const messages=page.getByRole('region',{name:'消息委派与回报',exact:true}).last();
 await expect(messages.getByText('查看原始委派',{exact:true})).toHaveCount(1);await expect(messages).toContainText('已收到 2/3 个回复');await expect(messages).toContainText('Billing Domain');await expect(messages).toContainText('排队中');
 const config=page.getByRole('region',{name:'配置操作结果',exact:true}).last();
 await expect(config).toContainText('已创建 3 个智能体');await expect(config).toContainText('资料整理助手 1');
 const summary=messages.locator(':scope > details > summary');const avatarCount=await summary.locator('[data-identity-kind=agent]').count();await summary.click();await expect(summary.locator('[data-identity-kind=agent]')).toHaveCount(avatarCount);
 const reply=messages.getByText('查看回复',{exact:true}).first();await reply.focus();await page.keyboard.press('Enter');await expect(messages).toContainText('检查已返回；来源覆盖仍需确认。');
 await request.post('/__test__/operation-card-reply',{data:fixture});
 await expect(messages).toContainText('已收到 3/3 个回复');await expect(messages).not.toContainText('任务已完成');
 await page.reload();await expect(messages).toContainText('已收到 3/3 个回复');await expect(config).toContainText('已创建 3 个智能体');
 await messages.locator(':scope > details > summary').click();
 const link=messages.getByRole('link',{name:'查看接收对话',exact:true}).last();await expect(link).toHaveAttribute('href','/?conversation='+fixture.message.targetConversationId);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await messages.scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath(`operation-cards-${mode}-${width}.png`),fullPage:true});
});
for(const mode of ['light','dark'] as const)for(const width of [1440,390])test(`only actual changes appear below the Agent answer and survive refresh ${mode} ${width}`,async({page,request},info)=>{
 await page.addInitScript(mode=>localStorage.setItem('mana-theme',mode),mode);await page.setViewportSize({width,height:1000});
 const fixture=await(await request.post('/__test__/operation-outcomes')).json();await page.goto('/mandala');
 await expect(page.locator('html')).toHaveAttribute('data-theme',mode);
 const turn=page.locator(`.chat-turn[data-run-id="${fixture.invocationId}"]`),cards=turn.locator('.turn-change');
 const rule=cards.filter({hasText:'账单检查'});await expect(rule).toContainText('未启用');await expect(rule).toContainText('09:00');await expect(rule).toContainText('Asia/Singapore');
 await expect(cards).toHaveCount(2);
 await expect(cards.filter({hasText:/能力发现已返回|结果待确认|失败任务|未更改项目/})).toHaveCount(0);
 const reply=turn.locator('.agent-reply').filter({hasText:'已保存账单计划和核对报告。'});
 await expect(reply.locator('.turn-change')).toHaveCount(2);await expect(reply.getByRole('region',{name:'本轮改动',exact:true})).toContainText('本轮改动 · 2');
 const checkOrder=async()=>{
  const boxes=await reply.evaluate(node=>{
   const answer=node.querySelector('.message.text')!.getBoundingClientRect(),cards=[...node.querySelectorAll('.turn-changes')].map(card=>card.getBoundingClientRect()),footer=node.querySelector('.turn-footer')!.getBoundingClientRect();
   return {answerBottom:answer.bottom,answerLeft:answer.left,firstCardTop:cards[0].top,firstCardLeft:cards[0].left,lastCardBottom:cards.at(-1)!.bottom,footerTop:footer.top,footerBottom:footer.bottom};
  });
  expect(boxes.firstCardTop).toBeGreaterThanOrEqual(boxes.answerBottom);
  expect(Math.abs(boxes.firstCardLeft-boxes.answerLeft)).toBeLessThanOrEqual(1);
  expect(boxes.footerTop).toBeGreaterThanOrEqual(boxes.lastCardBottom);
  const next=page.locator(`[data-message-key="${fixture.nextEventId}"]`);await expect(next).toBeAttached();
  expect((await next.boundingBox())!.y).toBeGreaterThanOrEqual(boxes.footerBottom);
 };
 await checkOrder();
 await page.reload();await expect(cards).toHaveCount(2);await expect(rule).toContainText('未启用');
 await checkOrder();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await turn.scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath(`change-summary-${mode}-${width}.png`),fullPage:true,animations:'disabled'});
});
test('configuration summaries contain applied changes without failed or unchanged writes after refresh',async({page,request})=>{
 const fixture=await(await request.post('/__test__/operation-cards-partial')).json();await page.setViewportSize({width:390,height:1000});await page.goto('/mandala');
 const turn=page.locator('.chat-turn').filter({has:page.locator(`[data-message-key="${fixture.sourceEventId}"]`)}),card=turn.getByRole('region',{name:'配置操作结果',exact:true});
 await expect(card).toContainText('已创建 3 个智能体');
 await expect(card.locator('.operation-rows > .operation-row')).toHaveCount(3);
 await expect(card).toHaveCount(1);
 await expect(card).not.toContainText('重复标识的助手');
 await page.reload();await expect(card).toContainText('已创建 3 个智能体');await expect(card.locator('.operation-rows > .operation-row')).toHaveCount(3);
});
test('tool-only Agent turns retain actual changes and actionable proposals before text arrives',async({page,request})=>{
 const fixture=await(await request.post('/__test__/operation-outcomes-only')).json();await page.goto('/mandala');
 const turn=page.locator(`.chat-turn[data-run-id="${fixture.invocationId}"]`);
 await expect(turn.locator('.turn-change')).toHaveCount(3);
 const skill=turn.locator('.turn-change').filter({hasText:'Skill 更新建议已提交'});
 await expect(skill.getByRole('link')).toHaveAttribute('href','/settings/skills?skill=pending-skill');
 const proposal=turn.getByRole('region',{name:'配置变更提案',exact:true});await expect(proposal).toHaveCount(1);
 await expect(proposal.getByRole('button',{name:'确认此变更',exact:true})).toBeVisible();
 await page.reload();await expect(turn.locator('.turn-change')).toHaveCount(3);await expect(proposal).toHaveCount(1);
});
test('a Skill outcome link selects the referenced Skill rather than the first library entry',async({page,request})=>{
 const current=await(await request.get('/api/config')).json(),prefix=crypto.randomUUID();
 const skills=['first','second'].map(name=>({id:prefix+'-'+name,name:'review-'+name,path:'',content:'---\nname: review-'+name+'\ndescription: Review evidence\n---\n'+name+' skill body'}));
 const saved=await request.put('/api/config',{data:{revision:current.revision,config:{...current.config,skillLibrary:[...(current.config.skillLibrary??[]),...skills]}}});expect(saved.ok()).toBe(true);
 await page.goto('/settings/skills?skill='+skills[1].id);
 await expect(page.getByRole('textbox',{name:'SKILL.md 内容',exact:true})).toHaveValue(/second skill body/);
});
