import {openNotifications} from './helpers/notifications';
// spec: specs/progress-acceptance-plan.md
// seed: tests/e2e/seed.spec.ts
import {test,expect} from '@playwright/test';
import {acceptanceMessagePair} from './helpers/progress-acceptance';
test.describe('Progress 用户目标验收',()=>{test('P41 mismatched private Run notice cannot expose or navigate the other execution conversation',async({page,request})=>{

 const d=await(await request.post('/__test__/progress-fixture')).json();await page.goto('/tasks');await page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v2/task-notifications');const before=await(await request.get('/api/v2/task-notifications')).json();const injected=await(await request.post('/__test__/progress-wrong-run-notice',{data:{taskId:d.task}})).json();
 const result=await(await request.get('/api/v2/task-notifications?after='+before.cursor)).json();const notice=result.items.find((n:{runId:string})=>n.runId===injected.runId);expect(notice).toBeTruthy();expect(notice.executionConversationId).toBeUndefined();expect(JSON.stringify(result)).not.toContain(injected.privateChatId);expect(JSON.stringify(result)).not.toContain('Private other user goal');
 await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));const notices=page.getByRole('dialog',{name:'通知',exact:true});await openNotifications(page);await expect(notices.getByRole('link',{name:'发布计划',exact:true})).toHaveAttribute('href','/tasks/'+d.task);expect(await notices.getByRole('link',{name:'查看审批',exact:true}).count()).toBe(0);await notices.getByRole('link',{name:'发布计划',exact:true}).click();await expect(page).toHaveURL(new RegExp('/tasks/'+d.task));
 // HTTP403 here validates the denied-content presentation only; real authorization is covered by security integration tests.
 await page.route('**/api/v2/tasks/'+d.task,route=>route.fulfill({status:403,json:{error:'forbidden'}}));await page.reload();await expect(page.getByRole('alert')).toContainText('来源权限已变更');await expect(page.locator('.task-detail')).not.toContainText('汇总上线范围');await expect(page.getByRole('button',{name:'开始任务',exact:true})).toHaveCount(0);

});});
