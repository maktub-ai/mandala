import { expect, test } from '@playwright/test';
import { storedUiState } from './helpers/preferences';
test.use({storageState:storedUiState('en'),viewport:{width:1440,height:950}});

test('quick capture creates a to-do directly and never starts execution or asks a model for a draft',async({page,request})=>{
 const mutations:string[]=[];page.on('request',req=>{if(req.method()==='POST')mutations.push(new URL(req.url()).pathname);});
 await page.goto('/tasks?type=tasks&scope=all');
 await expect(page.getByRole('button',{name:'List',exact:true})).toHaveAttribute('aria-pressed','true');
 const goal='Compact capture '+Date.now();await page.getByRole('textbox',{name:'Capture task',exact:true}).fill(goal);
 await page.getByRole('button',{name:'Save to-do',exact:true}).click();
 await expect(page).toHaveURL(/\/tasks\/[^?]+\?type=tasks&scope=all/);
 await expect(page.locator('.task-dialog').getByRole('heading',{name:goal,exact:true})).toBeVisible();
 expect(mutations.filter(path=>path==='/api/v2/tasks')).toHaveLength(1);
 expect(mutations.some(path=>path.endsWith('/draft')||path.endsWith('/start')||path.includes('/conversations/'))).toBe(false);
 const id=new URL(page.url()).pathname.split('/')[2],detail=await(await request.get('/api/v2/tasks/'+id)).json();
 expect(detail.task.state).toBe('todo');expect(detail.runs).toEqual([]);
});

test('selection retains filters, switches to a single detail on narrow screens, and respects an explicit board preference',async({page,request})=>{
 const goal='Compact filter '+Date.now(),saved=await(await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':'compact-filter-'+Date.now()},data:{goal,acceptance:'human'}})).json();
 await page.goto('/tasks?type=tasks&scope=all&q='+encodeURIComponent(goal));
 await page.locator('.progress-item-title').filter({hasText:goal}).click();
 await expect(page).toHaveURL(new RegExp('/tasks/'+saved.id+'\\?'));
 expect(new URL(page.url()).searchParams.get('q')).toBe(goal);
 await expect(page.locator('.task-list-detail > .workspace-list')).toBeVisible();
 await expect(page.locator('.task-dialog')).toBeVisible();
 await page.reload();await expect(page.locator('.task-dialog').getByRole('heading',{name:goal,exact:true})).toBeVisible();
 await page.locator('.task-dialog').getByRole('button',{name:'Close',exact:true}).click();
 await page.getByRole('button',{name:'Board',exact:true}).click();
 await expect(page.getByRole('button',{name:'Board',exact:true})).toHaveAttribute('aria-pressed','true');
 await page.goto('/tasks');await expect(page.getByRole('button',{name:'Board',exact:true})).toHaveAttribute('aria-pressed','true');
 await page.goto('/tasks/'+saved.id+'?type=tasks&scope=all&q='+encodeURIComponent(goal));
 await expect(page.locator('.progress-overview-board')).toHaveCount(0);
 await expect(page.locator('.progress-groups')).toBeVisible();
 await page.setViewportSize({width:390,height:900});
 await expect(page.locator('.task-list-detail > .workspace-list')).toBeHidden();
 await expect(page.locator('.task-dialog').getByRole('heading',{name:goal,exact:true})).toBeVisible();
 await page.locator('.task-dialog').getByRole('button',{name:'Close',exact:true}).click();
 await expect(page.locator('.task-list-detail > .workspace-list')).toBeVisible();
 await expect(page.getByRole('button',{name:'Board',exact:true})).toHaveAttribute('aria-pressed','true');
 expect(new URL(page.url()).searchParams.get('q')).toBe(goal);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('manual review, acceptance and reopening remain separate from native execution',async({page,request})=>{
 const goal='Compact acceptance '+Date.now(),saved=await(await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':'compact-accept-'+Date.now()},data:{goal,acceptance:'human'}})).json();
 const detail=async()=>await(await request.get('/api/v2/tasks/'+saved.id)).json();
 await page.goto('/tasks/'+saved.id);
 await page.getByRole('button',{name:'Submit for review',exact:true}).click();
 await expect.poll(async()=>(await detail()).task.state).toBe('review');
 await page.getByRole('button',{name:'Confirm completion',exact:true}).click();
 await expect.poll(async()=>(await detail()).task.state).toBe('completed');
 await page.getByRole('button',{name:'Reopen task',exact:true}).click();
 await expect.poll(async()=>(await detail()).task.state).toBe('todo');
 expect((await detail()).runs).toEqual([]);
});

test('a failed capture keeps its text and idempotency key until the user explicitly retries',async({page,request})=>{
 const keys:string[]=[],goal='Compact retry '+Date.now();
 page.on('request',req=>{if(req.method()==='POST'&&new URL(req.url()).pathname==='/api/v2/tasks')keys.push(req.headers()['idempotency-key']);});
 await page.goto('/tasks');let failed=false;await page.route('**/api/v2/tasks',route=>{if(route.request().method()==='POST'&&!failed){failed=true;return route.abort('failed');}return route.continue();});
 await page.getByRole('textbox',{name:'Capture task',exact:true}).fill(goal);await page.getByRole('button',{name:'Save to-do',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Capture task',exact:true})).toHaveValue(goal);await expect(page.getByRole('alert')).toBeVisible();
 await page.getByRole('button',{name:'Save to-do',exact:true}).click();await expect(page).toHaveURL(/\/tasks\/[^?]+/);
 expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);
 const id=new URL(page.url()).pathname.split('/')[2];expect((await(await request.get('/api/v2/tasks/'+id)).json()).task).toMatchObject({goal,state:'todo'});
});
