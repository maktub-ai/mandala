import {test,expect} from '@playwright/test';
import {defaultPreferences,themeStorageKey} from '../../src/themes';

test('completed tasks stay in the completed group while linked execution needs attention',async({page,request})=>{
 const response=await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{goal:'完成后仍有执行提醒'}});
 expect(response.ok()).toBe(true);const task=await response.json();
 const execution={id:'attention-execution',taskId:task.id,conversationId:'attention-chat',agentId:'',projectId:null,request:'处理执行提醒',criteria:[],createdByAgentId:null,commandKey:null,createdAt:new Date().toISOString(),title:'执行需要处理',latestRun:null};
 await page.route('**/api/v2/tasks',async route=>{const response=await route.fetch(),tasks=await response.json();await route.fulfill({json:tasks.map((item:{id:string})=>item.id===task.id?{...item,executions:[execution]}:item)});});
 await page.route('**/api/conversation-progress?*',route=>route.fulfill({json:[{id:'attention-chat',title:'执行需要处理',agentId:null,projectId:null,cli:'codex',state:'attention',reopenState:'attention',active:true,withinWindow:true,activityAt:new Date().toISOString(),completedAt:null,requestPreview:null,hasNewActivity:false,taskIds:[task.id],relatedConversationIds:[]}]}));
 await page.goto('/tasks?view=board&q='+encodeURIComponent(task.goal));
 const card=page.locator(`[data-task-id="${task.id}"]`);
 await expect(page.getByRole('region',{name:'需要你处理',exact:true}).locator(`[data-task-id="${task.id}"]`)).toBeVisible();
 await card.locator('.task-work-related > summary').click();
 await card.getByRole('combobox').click();await page.getByRole('option',{name:'已完成',exact:true}).click();
 const completed=page.getByRole('region',{name:'已完成',exact:true});
 await expect(completed.locator(`[data-task-id="${task.id}"]`)).toBeVisible();
 await expect(card.locator('.task-work-reason')).toContainText('需要你处理');
 await page.reload();
 await expect(completed.locator(`[data-task-id="${task.id}"]`)).toBeVisible();
 for(const theme of ['light','dark'] as const)for(const width of [1280,390]){
  await page.setViewportSize({width,height:850});
  await page.evaluate(({key,value})=>{localStorage.setItem(key,value);window.dispatchEvent(new StorageEvent('storage',{key,newValue:value}));},{key:themeStorageKey,value:JSON.stringify({...defaultPreferences(),mode:theme})});
  await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
  await card.scrollIntoViewIfNeeded();
  await expect(completed.locator(`[data-task-id="${task.id}"]`)).toBeVisible();
  await page.screenshot({path:test.info().outputPath(`completed-${theme}-${width}.png`)});
 }
 await page.goto('/tasks?view=list&q='+encodeURIComponent(task.goal));
 await page.getByRole('button',{name:'展开已完成任务',exact:true}).click();
 await expect(completed.locator(`[data-task-id="${task.id}"]`)).toBeVisible();
});
