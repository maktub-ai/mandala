import {test,expect} from '@playwright/test';
import {chooseOption} from './helpers/select';
test('T1 idle Tasks and Chats fade after six hours, history recovers unchanged states in both views',async({page,request})=>{
 const chats=await(await request.post('/__test__/progress-fixture')).json(),d=await(await request.post('/__test__/progress-closure-fixture')).json();
 const move=async(id:string,state:string)=>{const t=(await(await request.get('/api/v2/tasks/'+id)).json()).task;expect((await request.post('/api/v2/tasks/'+id+'/move',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{expectedRevision:t.revision,state}})).ok()).toBe(true);};
 await move(d.agentTask,'review');await move(d.systemTask,'completed');
 for(const id of [d.userTask,d.agentTask,d.systemTask])expect((await request.post('/__test__/progress-age-task',{data:{id,ageMinutes:361}})).ok()).toBe(true);
 await request.post('/api/conversation-progress/'+chats.long,{data:{action:'complete'}});await request.post('/__test__/progress-age',{data:{id:chats.long,ageMinutes:361}});
 await page.goto('/tasks');for(const id of [d.userTask,d.agentTask,d.systemTask])await expect(page.locator('[data-task-id="'+id+'"]')).toHaveCount(0);
 await expect(page.locator('[data-conversation-id="'+chats.long+'"]')).toHaveCount(0);
 await page.screenshot({path:'audit/2026-10-26-task-closure/six-hour-default.png',fullPage:true});
 await page.getByRole('button',{name:'筛选',exact:true}).click();await expect(page.getByRole('combobox',{name:'最近使用窗口',exact:true})).toHaveAttribute('data-value','360');
 await chooseOption(page,'可见范围','all');for(const id of [d.userTask,d.agentTask,d.systemTask])await expect(page.locator('[data-task-id="'+id+'"]')).toBeVisible();
 await expect(page.locator('[data-conversation-id="'+chats.long+'"]')).toContainText('已完成');
 await page.screenshot({path:'audit/2026-10-26-task-closure/six-hour-history.png',fullPage:true});
 await page.getByRole('button',{name:'列表',exact:true}).click();await expect(page).toHaveURL(/view=list/);await page.reload();for(const id of [d.userTask,d.agentTask,d.systemTask])await expect(page.locator('[data-task-id="'+id+'"]')).toBeVisible();
 await page.getByRole('button',{name:'筛选',exact:true}).click();
 await chooseOption(page,'可见范围','active');for(const id of [d.userTask,d.agentTask,d.systemTask])await expect(page.locator('[data-task-id="'+id+'"]')).toHaveCount(0);
 await chooseOption(page,'最近使用窗口','1440');await expect(page.locator('[data-task-id="'+d.agentTask+'"]')).toBeVisible();
 for(const [id,state] of [[d.userTask,'todo'],[d.agentTask,'review'],[d.systemTask,'completed']])expect((await(await request.get('/api/v2/tasks/'+id)).json()).task.state).toBe(state);
});
test('T2 recent real Task edits and pending input stay visible while old running labels expire',async({page,request})=>{
 await request.post('/__test__/progress-fixture');const d=await(await request.post('/__test__/progress-closure-fixture')).json();
 const state=async(id:string,value:string)=>{const t=(await(await request.get('/api/v2/tasks/'+id)).json()).task;expect((await request.patch('/api/v2/tasks/'+id,{headers:{'Idempotency-Key':crypto.randomUUID()},data:{expectedRevision:t.revision,state:value}})).ok()).toBe(true);};
 await state(d.userTask,'running');await state(d.agentTask,'waiting');for(const id of [d.userTask,d.agentTask,d.systemTask])await request.post('/__test__/progress-age-task',{data:{id,ageMinutes:361}});
 const t=(await(await request.get('/api/v2/tasks/'+d.systemTask)).json()).task;await request.patch('/api/v2/tasks/'+d.systemTask,{headers:{'Idempotency-Key':crypto.randomUUID()},data:{expectedRevision:t.revision,goal:t.goal+'（刚刚更新）'}});
 await page.goto('/tasks?type=tasks');await expect(page.locator('[data-task-id="'+d.userTask+'"]')).toHaveCount(0);await expect(page.locator('[data-task-id="'+d.agentTask+'"]')).toContainText('需要输入');await expect(page.locator('[data-task-id="'+d.systemTask+'"]')).toContainText('刚刚更新');
});
