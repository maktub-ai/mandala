import {test,expect} from '@playwright/test';
import {storedUiState} from './helpers/preferences';

test.use({storageState:storedUiState('en')});

for(const entry of ['tasks','conversations','project','legacy conversations'])test(`task workspace keeps ${entry} search focus and draft across background refresh`,async({page,request})=>{
 const kind=entry.includes('conversations')?'conversations':'tasks';
 await request.post('/__test__/progress-fixture');
 await page.goto('/projects');
 await page.locator('.sidebar-destination[data-area="tasks"]').click();
 if(kind==='conversations'){
  await page.goto(entry==='legacy conversations'?'/tasks?tab=conversations':'/tasks?type=conversations');
 }else if(entry==='project'){
  await page.goto('/projects/progress-demo/overview');
  await page.locator('.object-summary-item').filter({hasText:'Associated tasks'}).click();
 }
 const search=page.locator('.conversation-progress').getByRole('searchbox',{name:kind==='tasks'?'Search tasks':'Search chats',exact:true});
 await expect(search).toBeVisible();
 await page.getByText('Capture a to-do',{exact:true}).click();
 await page.getByRole('textbox',{name:'Capture task',exact:true}).fill('Unsubmitted to-do stays here');
 await search.fill('发布');
 const poll=await Promise.all(['/api/conversations','/api/tasks'].map(path=>page.waitForResponse(response=>{
  const url=new URL(response.url());
  return url.pathname===path&&response.request().method()==='GET'&&(path!=='/api/tasks'||url.searchParams.get('view')==='control');
 })));
 await Promise.all(poll.map(response=>response.finished()));
 // Observe after the response has reached React, not just after the network event.
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await expect(search).toBeFocused();
 await expect(page.getByRole('textbox',{name:'Capture task',exact:true})).toHaveValue('Unsubmitted to-do stays here');
 await search.pressSequentially('方案');
 await expect(search).toHaveValue('发布方案');
 await expect(page).toHaveURL(/q=/);
 await page.reload();
 await expect(search).toHaveValue('发布方案');
});
