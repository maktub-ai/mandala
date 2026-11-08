import {test,expect} from '@playwright/test';
import {mkdirSync} from 'node:fs';
const shots='/tmp/mandala-task2-ui';
test('chronological operations retain their first position and public reports survive reload in light/dark and narrow Chinese',async({page,request})=>{
 const f=await(await request.post('/__test__/explicit-progress-fixture')).json();
 await page.goto('/?conversation='+f.first);await page.getByRole('button',{name:'展开本轮过程',exact:true}).click();
 const timeline=page.locator('.run-process-timeline').last();
 await expect(timeline.locator(':scope > li')).toHaveCount(3);
 await expect(timeline.locator(':scope > li').nth(0)).toContainText('inspect 中文');
 await expect(timeline.locator(':scope > li').nth(1)).toContainText('已完成环境检查');
 await expect(timeline.locator(':scope > li').nth(1)).toHaveAttribute('data-timeline-key','operation::report-call');
 await expect(timeline.locator(':scope > li').nth(2)).toContainText('原生补充说明');
 await expect(page.locator('.message.text')).toContainText('中文最终答复独立展示');
 await expect(page.locator('[data-progress-event-id="'+f.reportId+'"]')).toHaveCount(1);
 const keys=await timeline.locator(':scope > li').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('data-timeline-key')));
 await page.reload();await page.getByRole('button',{name:'展开本轮过程',exact:true}).click();await expect(timeline.locator(':scope > li')).toHaveCount(3);
 expect(await timeline.locator(':scope > li').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('data-timeline-key')))).toEqual(keys);
 const steps=timeline.locator('summary').filter({hasText:'上报步骤'});await steps.focus();await page.keyboard.press('Enter');await expect(timeline.getByText('验证中文与键盘',{exact:true})).toBeVisible();
 mkdirSync(shots,{recursive:true});
 for(const theme of ['light','dark'])for(const width of [1440,1024,768,390]){
  await page.evaluate(theme=>localStorage.setItem('mana-theme',theme),theme);await page.reload();await page.getByRole('button',{name:'展开本轮过程',exact:true}).click();await page.setViewportSize({width,height:960});
  await expect(timeline).toContainText('已完成环境检查');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`${shots}/chat-${theme}-${width}.png`,fullPage:true});
 }
});
test('Task overview names report source, counts running chats and expands status-only chats without fabricated progress',async({page,request})=>{
 const f=await(await request.post('/__test__/explicit-progress-fixture')).json();
 await page.goto('/tasks/'+f.task);
 const detail=page.locator('.task-detail');
 const linked=page.locator('.task-linked-conversations');
 await expect(linked).toContainText('2 个运行对话');await expect(linked).toContainText('来自对话：中文检查对话');
 await expect(linked.locator('.explicit-progress').first()).toContainText('历史进展');
 const noReport=linked.locator('.task-progress-chat').filter({has:page.locator('[data-linked-conversation-id="'+f.empty+'"]')}).locator('details');
 await noReport.locator('summary').click();await expect(noReport.getByRole('link',{name:'打开对话'})).toBeVisible();await expect(noReport.locator('.explicit-progress')).toHaveCount(0);
 await page.getByRole('searchbox',{name:'搜索任务与对话'}).fill('检查进度');await expect(page.getByRole('searchbox',{name:'搜索任务与对话'})).toHaveValue('检查进度');
 for(const theme of ['light','dark']){await page.evaluate(theme=>localStorage.setItem('mana-theme',theme),theme);await page.reload();await page.setViewportSize({width:390,height:960});await expect(linked).toContainText('2 个运行对话');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);mkdirSync(shots,{recursive:true});await page.screenshot({path:`${shots}/task-${theme}-390.png`,fullPage:true});}
});
