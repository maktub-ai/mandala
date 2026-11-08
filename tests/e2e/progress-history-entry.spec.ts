import {createTaskWithExecutionChats} from './helpers/task-executions';
import {test,expect} from '@playwright/test';
test('T3 an idle default Progress offers history recovery instead of claiming the user has no work',async({page,request})=>{
 const response=await createTaskWithExecutionChats(request,{headers:{'Idempotency-Key':crypto.randomUUID()},data:{goal:'六小时前的独立任务',projectId:null}},[]);expect(response.ok()).toBe(true);const task=await response.json();
 await request.post('/__test__/progress-age-task',{data:{id:task.id,ageMinutes:361}});
 // Show only this scenario's real persisted Task. Other scenarios share the synthetic server home.
 await page.route(url=>url.pathname==='/api/v2/tasks',async route=>{if(route.request().method()!=='GET'){await route.continue();return;}const response=await route.fetch();await route.fulfill({response,json:(await response.json()).filter((t:{id:string})=>t.id===task.id)});});
 await page.route('**/api/conversation-progress?*',async route=>{const response=await route.fetch();await route.fulfill({response,json:[]});});
 await page.goto('/tasks');await expect(page.locator('[data-task-id="'+task.id+'"]')).toHaveCount(0);
 await page.getByRole('button',{name:'查看历史事项',exact:true}).click();await expect(page.locator('[data-task-id="'+task.id+'"]')).toBeVisible();
 expect((await(await request.get('/api/v2/tasks/'+task.id)).json()).task.state).toBe('todo');await expect(page).toHaveURL(/scope=all/);
});
