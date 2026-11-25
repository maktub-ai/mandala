import {expect,test} from '@playwright/test';
import {openNotifications} from '../e2e/helpers/notifications';

test('notifications arrive quietly without moving the conversation or stealing focus',async({page,request})=>{
 const fixture=await(await request.post('/__test__/execution-results')).json();
 const first=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v2/task-notifications');await page.goto('/mandala');await first;
 const composer=page.getByRole('textbox',{name:'消息',exact:true}),viewport=page.locator('.conversation-viewport');await composer.fill('保留正在编辑的草稿');await composer.focus();const before=await viewport.boundingBox();
 const notice=await(await request.post('/__test__/notification-inbox/completed')).json();
 const inbox=page.getByRole('button',{name:'通知',exact:true});await expect(inbox).toContainText('1');
 await expect(page.getByRole('dialog',{name:'通知',exact:true})).toHaveCount(0);await expect(composer).toBeFocused();expect(await viewport.boundingBox()).toEqual(before);
 await inbox.click();const panel=page.getByRole('dialog',{name:'通知',exact:true});await expect(panel.getByRole('link',{name:notice.title,exact:true})).toBeVisible();await expect(panel).not.toContainText('用户问');
 await page.keyboard.press('Escape');await expect(inbox).toBeFocused();await expect(inbox).not.toContainText('1');
 await page.getByRole('link',{name:'任务',exact:true}).click();await inbox.click();await expect(panel.getByRole('link',{name:notice.title,exact:true})).toHaveAttribute('href','/tasks/'+notice.taskId);
 await page.keyboard.press('Escape');await page.getByRole('link',{name:'Mandala',exact:true}).click();await expect(composer).toHaveValue('保留正在编辑的草稿');
 expect(fixture.mainId).toBeTruthy();
});

for(const mode of ['light','dark'])for(const width of [1440,1024,768,390])test(`quiet inbox states ${mode} ${width}`,async({page,request},info)=>{
 await request.post('/__test__/execution-results');await page.addInitScript(mode=>localStorage.setItem('mana-theme',mode),mode);await page.setViewportSize({width,height:850});
 const first=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v2/task-notifications');await page.goto('/mandala');await first;
 await expect(page.getByRole('textbox',{name:'消息',exact:true})).toBeVisible();let panel=await openNotifications(page);await expect(panel).toContainText('暂无通知');await page.keyboard.press('Escape');
 const longTitle='跨项目账单核验与资产采集记录验证'.repeat(4),notice=await(await request.post('/__test__/notification-inbox/approval')).json();
 const refresh=page.waitForResponse(r=>r.url().includes('/api/v2/task-notifications?after='));await refresh;
 await request.post('/__test__/notification-inbox/completed');await request.post('/__test__/notification-inbox/failed');
 await expect(page.getByRole('button',{name:'通知',exact:true})).toContainText('3');panel=await openNotifications(page);
 await expect(panel.getByRole('link',{name:'查看审批',exact:true})).toHaveAttribute('href','/?conversation='+notice.executionId);await expect(panel.getByRole('link',{name:'查看审批',exact:true}).locator('strong')).toHaveText(longTitle);
 await expect(panel).toContainText('允许读取账单目录以核对采集结果？');await expect(panel).toContainText('执行失败');await expect(panel).toContainText('任务已完成');
 const bounds=await panel.boundingBox();expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(width);expect(bounds!.y).toBeGreaterThanOrEqual(0);expect(bounds!.y+bounds!.height).toBeLessThanOrEqual(850);
 await page.screenshot({path:info.outputPath(`inbox-${mode}-${width}.png`),fullPage:true,animations:'disabled'});
 await panel.getByRole('link',{name:'查看审批',exact:true}).click();await expect(page).toHaveURL(new RegExp('conversation='+notice.executionId));await expect(panel).not.toBeVisible();
});

test('save failures stay quiet and explicit retry recovers inside the inbox',async({page,request})=>{
 await request.post('/__test__/execution-results');await page.goto('/mandala');
 await expect(page.getByRole('textbox',{name:'消息',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'通知',exact:true})).toBeVisible();
 await page.evaluate(()=>{let attempts=0;window.dispatchEvent(new CustomEvent('mandala-task-save-failed',{detail:{id:'save-example',goal:'保存账单核验任务',message:'连接暂时中断',retry:async()=>{if(++attempts===1)throw new Error('仍未连接，请重试');return true;}}}));});
 await expect(page.getByRole('dialog',{name:'通知',exact:true})).toHaveCount(0);const panel=await openNotifications(page);await expect(panel).toContainText('连接暂时中断');
 await panel.getByRole('button',{name:'重试保存',exact:true}).click();await expect(panel).toContainText('仍未连接，请重试');await panel.getByRole('button',{name:'重试保存',exact:true}).click();await expect(panel).toContainText('暂无通知');
});

test('short windows keep multiple updates and polling recovery reachable',async({page,request},info)=>{
 await request.post('/__test__/execution-results');await page.setViewportSize({width:1759,height:559});
 const first=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v2/task-notifications');await page.goto('/mandala');await first;await expect(page.getByRole('textbox',{name:'消息',exact:true})).toBeVisible();
 for(let index=0;index<6;index++)await request.post('/__test__/notification-inbox/completed');
 const trigger=page.getByRole('button',{name:'通知',exact:true});await expect(trigger).toContainText('6');const panel=await openNotifications(page);await expect(panel.locator('.notification-inbox-row')).toHaveCount(6);
 await expect(panel.getByRole('link',{name:'查看全部任务',exact:true})).toBeInViewport();
 expect(await panel.locator('.notification-inbox-list').evaluate(element=>element.scrollHeight>element.clientHeight)).toBe(true);
 await page.screenshot({path:info.outputPath('inbox-user-1759.png'),fullPage:true,animations:'disabled'});
 await page.keyboard.press('Escape');let offline=true;await page.route('**/api/v2/task-notifications?*',route=>offline?route.fulfill({status:503,json:{error:'Temporary interruption'}}):route.continue());
 const failed=page.waitForResponse(r=>r.url().includes('/api/v2/task-notifications?')&&r.status()===503);await failed;await expect(panel).not.toBeVisible();await openNotifications(page);await expect(panel).toContainText('通知暂时无法刷新');
 offline=false;await panel.getByRole('button',{name:'重试',exact:true}).click();await expect(panel).not.toContainText('通知暂时无法刷新');await expect(panel.locator('.notification-inbox-row')).toHaveCount(6);
});

test('one delivery keeps its read state across repeat events and acceptance retires the action',async({page,request})=>{
 await request.post('/__test__/execution-results');
 const initial=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v2/task-notifications');
 await page.goto('/mandala');await initial;
 await expect(page.getByRole('textbox',{name:'消息',exact:true})).toBeVisible({timeout:15000});
 await page.waitForResponse(r=>r.url().includes('/api/v2/task-notifications?after='));
 const notice=await(await request.post('/__test__/notification-inbox/review')).json(),trigger=page.getByRole('button',{name:'通知',exact:true});
 await expect(trigger).toContainText('1');const panel=await openNotifications(page);
 const link=panel.getByRole('link',{name:notice.title,exact:true});
 await expect(link).toContainText('已核对三张账单，请确认金额。');
 await expect(link).toContainText('核对交付并确认完成或要求修改');
 await expect(link).toHaveAttribute('href','/tasks/'+notice.taskId+'?action=review');
 await page.keyboard.press('Escape');
 const refresh=async()=>{
  const polled=page.waitForResponse(r=>r.url().includes('/api/v2/task-notifications?after='));
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await polled;
 };
 await request.post('/__test__/notification-inbox/repeat/'+notice.runId);await refresh();await expect(trigger).not.toContainText('1');
 await openNotifications(page);await expect(panel.locator('.notification-inbox-row')).toHaveCount(1);
 await link.click();await expect(page.getByRole('button',{name:'确认完成',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'确认完成',exact:true}).click();
 await expect.poll(async()=>(await(await request.get('/api/v2/tasks/'+notice.taskId)).json()).task.state).toBe('completed');
 await page.locator('.task-dialog').getByRole('button',{name:'关闭',exact:true}).click();
 await refresh();await openNotifications(page);await expect(panel).toContainText('暂无通知');
});
