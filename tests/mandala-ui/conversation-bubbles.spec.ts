import {expect,test} from '@playwright/test';
import {defaultPreferences,themeStorageKey} from '../../shared/themes';

test('late Agent replies show their sender and body directly after the intervening request, including after reload',async({page,request},info)=>{
 const fixture=await(await request.post('/__test__/operation-cards')).json();
 expect((await request.post('/__test__/operation-card-reply',{data:fixture})).ok()).toBe(true);
 await page.goto('/mandala');
 const reply=page.getByRole('article',{name:'Data Ops Quality · 智能体回复',exact:true});
 for(let reload=0;reload<2;reload++){
  await expect(reply.getByText('覆盖清单已返回。',{exact:true})).toBeVisible();
  expect(await page.getByRole('region',{name:'消息委派与回报',exact:true}).first().evaluate(node=>!!node.closest('.agent-reply'))).toBe(true);
  await expect(reply).toContainText('Data Ops Quality');
  await expect(reply.getByRole('link',{name:'查看接收对话',exact:true})).toHaveAttribute('href','/?conversation='+fixture.message.targetConversationId);
  expect(await reply.evaluate((element,eventId)=>{
   const request=document.querySelector(`[data-message-key="${eventId}"]`);
   return !!request&&!!(request.compareDocumentPosition(element)&Node.DOCUMENT_POSITION_FOLLOWING);
  },fixture.sourceEventId)).toBe(true);
  await expect(reply).toHaveCount(1);
  await expect(reply.locator('.chat-reply-bubble .ui-disclosure,.chat-reply-bubble a')).toHaveCount(0);
  await page.reload();
 }
 await reply.scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath('agent-reply-desktop.png'),animations:'disabled'});
 await page.setViewportSize({width:390,height:1000});
 await page.getByRole('dialog',{name:'右侧栏',exact:true}).getByRole('button',{name:'收起右侧栏',exact:true}).click();
 await reply.scrollIntoViewIfNeeded();await expect(reply).toBeInViewport();await page.screenshot({path:info.outputPath('agent-reply-mobile.png'),animations:'disabled'});
});

test('task receipts show the actual executor and final result directly rather than a report notification',async({page,request})=>{
 const fixture=await(await request.post('/__test__/execution-results')).json();
 await page.goto('/mandala');
 const reply=page.getByRole('article',{name:fixture.title+' · 执行结果',exact:true}).last();
 await expect(reply.locator('.execution-result-sender')).toHaveText('Mandala');
 await expect(reply.locator('.chat-reply-bubble .execution-result-footer')).toHaveCount(0);
 await expect(reply.getByText('复查完成，两项配置差异仍然存在。未修改配置，等待你的确认。',{exact:true})).toBeVisible();
 await expect(reply.getByRole('link',{name:'查看执行详情',exact:true})).toHaveAttribute('href',new RegExp('conversation='+fixture.executionId));
 await page.reload();
 await expect(reply.getByText('复查完成，两项配置差异仍然存在。未修改配置，等待你的确认。',{exact:true})).toBeVisible();
});

for(const mode of ['light','dark'] as const)for(const width of [2560,1440,1024,768,390])test(`messages have separate left/right bubbles with applied changes outside the text bubble ${mode} ${width}`,async({page,request},info)=>{
 await page.addInitScript(mode=>localStorage.setItem('mana-theme',mode),mode);
 await page.setViewportSize({width,height:1000});
 const fixture=await(await request.post('/__test__/operation-outcomes')).json();await page.goto('/mandala');
 const turn=page.locator(`.chat-turn[data-run-id="${fixture.invocationId}"]`),user=turn.locator('.message.user'),reply=turn.locator('.agent-reply').filter({hasText:'已保存账单计划和核对报告。'});
 await expect(reply).toBeVisible();
 await expect(user.getByText('你',{exact:true})).toHaveCount(0);
 await expect(reply.locator(':scope > .agent-reply-header')).toHaveCount(0);
 const bubble=reply.locator(':scope > .chat-reply-bubble');
 await expect(bubble).toContainText('已保存账单计划和核对报告。');
 await expect(bubble.locator('.operation-card,.turn-process,.turn-footer')).toHaveCount(0);
 await expect(reply.locator('.turn-change')).toHaveCount(2);
 await expect(reply.locator('.turn-process .turn-changes')).toHaveCount(0);
 const layout=await turn.evaluate(node=>{
  const user=node.querySelector('.message.user')!,content=user.querySelector('.message-content')!,reply=node.querySelector('.agent-reply > .chat-reply-bubble')!;
  const u=user.getBoundingClientRect(),r=reply.getBoundingClientRect();
  return {userLeft:u.left,userRight:u.right,replyLeft:r.left,bg:getComputedStyle(content).backgroundColor,replyBg:getComputedStyle(reply).backgroundColor,radius:parseFloat(getComputedStyle(reply).borderTopLeftRadius),userRadius:parseFloat(getComputedStyle(content).borderTopLeftRadius),cardsOutside:[...node.querySelectorAll('.agent-reply > .turn-changes')].every(card=>card.getBoundingClientRect().top>=r.bottom)};
 });
 expect(layout.radius).toBeGreaterThanOrEqual(16);
 expect(layout.userRadius).toBeGreaterThanOrEqual(16);
 expect(layout.cardsOutside).toBe(true);
 expect(layout.userLeft).toBeGreaterThan(layout.replyLeft);
 expect(layout.bg).not.toBe(layout.replyBg);
 expect(layout.replyBg).not.toBe('rgba(0, 0, 0, 0)');
 await expect(user).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await turn.scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath(`bubbles-${mode}-${width}.png`),animations:'disabled'});
});

for(const radius of [5,0])test(`chat roundness preserves saved control radius ${radius} and message actions`,async({page,request},info)=>{
 const preferences=defaultPreferences();preferences.mode='dark';preferences.dark='github-dark';preferences.appearance.radius=radius;
 await page.addInitScript(({key,preferences})=>localStorage.setItem(key,JSON.stringify(preferences)),{key:themeStorageKey,preferences});
 const fixture=await(await request.post('/__test__/operation-outcomes')).json();await page.goto('/mandala');
 const turn=page.locator(`.chat-turn[data-run-id="${fixture.invocationId}"]`),user=turn.locator('.message.user'),bubble=turn.locator('.agent-reply > .chat-reply-bubble');
 await expect(bubble).toBeVisible();
 for(const element of [bubble,user.locator('.message-content')]){
  const actual=await element.evaluate(node=>parseFloat(getComputedStyle(node).borderTopLeftRadius));
  if(radius===0)expect(actual).toBe(0);else expect(actual).toBeGreaterThanOrEqual(16);
 }
 expect(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!).appearance.radius,themeStorageKey)).toBe(radius);
 await user.hover();
 await expect(user.getByRole('button',{name:'编辑消息',exact:true})).toHaveCount(0);
 const copy=user.getByRole('button',{name:'复制消息',exact:true}),box=(await copy.boundingBox())!,body=(await user.locator('.message-content').boundingBox())!;
 await page.mouse.move(box.x+box.width/2,body.y+body.height-2);
 await page.mouse.move(box.x+box.width/2,body.y+body.height+2);
 await expect(user.locator('.message-actions')).toHaveCSS('pointer-events','auto');
 await page.mouse.move(box.x+box.width/2,box.y+box.height/2,{steps:20});
 await expect(user.locator('.message-actions')).toHaveCSS('pointer-events','auto');
 await bubble.scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath(`saved-radius-${radius}.png`),animations:'disabled'});
});
