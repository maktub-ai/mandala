import {createTaskWithExecutionChats} from './helpers/task-executions';
// spec: specs/progress-acceptance-plan.md P01/P02/P08
// seed: tests/e2e/seed.spec.ts
import {test,expect} from '@playwright/test';
import {chooseOption} from './helpers/select';
test.describe('Progress 用户目标验收',()=>{test('P01 P02 P08 execution conversations stay under Task roots and projections count visible work',async({page,request})=>{
 // Create distinct Tasks with one execution owner and an independent origin reference; restrict only list membership to this scenario.
 const d=await(await request.post('/__test__/progress-fixture')).json();const other=await(await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{goal:'Second independent task',originConversationId:d.recent}})).json();const tids=[d.task,other.id],cids=[d.recent,d.running,d.waiting,d.long];
 await page.route('**/api/v2/tasks',async r=>{const s=await r.fetch();await r.fulfill({response:s,json:(await s.json()).filter((v:{id:string})=>tids.includes(v.id))});});
 await page.route('**/api/conversation-progress?*',async r=>{const s=await r.fetch();await r.fulfill({response:s,json:(await s.json()).filter((v:{id:string})=>cids.includes(v.id))});});
 await page.goto('/');await page.getByRole('link',{name:'任务',exact:true}).click();
 for(const view of ['看板','列表']){
  await page.getByRole('button',{name:view,exact:true}).click();
  // All uses two Task roots and three independent conversations. Each parent retains the shared discussion.
  await chooseOption(page,'显示类型','all');await expect(page.locator('[data-task-id]')).toHaveCount(2);await expect(page.locator('[data-conversation-id]')).toHaveCount(3);await expect(page.locator('[data-conversation-id="'+d.recent+'"]')).toHaveCount(0);
  for(const id of tids){const t=page.locator('[data-task-id="'+id+'"]');if(await t.locator('.progress-expand').getAttribute('aria-expanded')!=='true')await t.locator('.progress-expand').click();await expect(t.locator('[data-linked-conversation-id="'+d.recent+'"]')).toBeVisible();}
  const counts=await page.locator('.progress-overview-board > section > h2 > span:last-child,.progress-groups > section > h2 > span:last-child').allTextContents();expect(counts.reduce((n,v)=>n+Number(v),0)).toBe(5);
  // Tasks-only removes child chat presentation; Chats-only contains unique conversations, including shared discussion once.
  await chooseOption(page,'显示类型','tasks');await expect(page.locator('[data-task-id]')).toHaveCount(2);await expect(page.locator('[data-conversation-id]')).toHaveCount(0);await expect(page.locator('[data-linked-conversation-id]')).toHaveCount(0);
  await chooseOption(page,'显示类型','conversations');await expect(page.locator('[data-task-id]')).toHaveCount(0);await expect(page.locator('[data-conversation-id]')).toHaveCount(4);await expect(page.locator('[data-conversation-id="'+d.recent+'"]')).toHaveCount(1);
 }
 // Every Task-status filter acts on Tasks alone, preserving all conversation identities and stable sorting.
 await chooseOption(page,'显示类型','all');await page.getByRole('button',{name:'筛选',exact:true}).click();for(const state of ['todo','running','waiting','review','completed','cancelled']){await chooseOption(page,'任务状态',state);await expect(page.locator('[data-task-id]')).toHaveCount(state==='todo'?2:0);await expect(page.locator('[data-conversation-id]')).toHaveCount(state==='todo'?3:4);}
 // Positive rules require an actual matching Task in every supported state, not only empty negatives.
 for(const state of ['todo','running','waiting','review','completed','cancelled']){const current=(await(await request.get('/api/v2/tasks/'+d.task)).json()).task;const moved=await request.post('/api/v2/tasks/'+d.task+'/move',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{expectedRevision:current.revision,state}});expect(moved.ok(),await moved.text()).toBe(true);await page.reload();await page.getByRole('button',{name:'筛选',exact:true}).click();await chooseOption(page,'任务状态',state);await expect(page.locator('[data-task-id="'+d.task+'"]')).toBeVisible();await expect(page.locator('[data-task-id]')).toHaveCount(state==='todo'?2:1);await expect(page.locator('[data-conversation-id]')).toHaveCount(3);await chooseOption(page,'显示类型','tasks');await expect(page.locator('[data-task-id="'+d.task+'"]')).toBeVisible();await expect(page.locator('[data-conversation-id]')).toHaveCount(0);await chooseOption(page,'显示类型','conversations');await expect(page.locator('[data-task-id]')).toHaveCount(0);await expect(page.locator('[data-conversation-id]')).toHaveCount(4);await chooseOption(page,'显示类型','all');}
 await chooseOption(page,'任务状态','all');await chooseOption(page,'任务排序','oldest');const first=await page.locator('[data-conversation-id]').evaluateAll(es=>es.map(e=>e.getAttribute('data-conversation-id')));await page.reload();await expect(page.locator('[data-conversation-id]')).toHaveCount(3);expect(await page.locator('[data-conversation-id]').evaluateAll(es=>es.map(e=>e.getAttribute('data-conversation-id')))).toEqual(first);
 for(const id of tids){const detail=await(await request.get('/api/v2/tasks/'+id)).json();expect(detail.runs).toHaveLength(0);expect(detail.task.conversationIds).toEqual(id===d.task?[d.recent]:[]);}
});});
