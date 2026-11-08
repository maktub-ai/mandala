import {chooseOption} from './helpers/select';
import {test,expect} from '@playwright/test';
import {waitForAutosave} from './helpers/settings';

test('default chat replaces global workbench and exposes scoped usage without losing archived history',async({page,request})=>{
 const {revision}=await(await request.get('/api/config')).json();
 await request.put('/api/config',{data:{revision,config:{version:2,projects:[],agents:[],system:{cli:'codex',memory:{language:'zh-CN'}}}}});
 await page.goto('/');
 await expect(page.getByRole('textbox',{name:'消息',exact:true})).toBeVisible();
 await expect(page.locator('a[data-area="workbench"]')).toHaveCount(0);
 await expect(page.locator('.workbench')).toHaveCount(0);
 await page.getByRole('button',{name:'用户菜单',exact:true}).click();
 await page.getByRole('link',{name:'用量',exact:true}).click();
 await expect(page).toHaveURL(/\/usage$/);
 await expect(page.getByRole('region',{name:'已记录用量',exact:true})).toBeVisible();
 await page.goBack();
 await expect(page.getByRole('textbox',{name:'消息',exact:true})).toBeVisible();
});

test('opening settings after the initial configuration read uses the resulting config revision',async({page,request})=>{
 const {revision}=await(await request.get('/api/config')).json();
 await request.put('/api/config',{data:{revision,config:{version:2,projects:[],agents:[],system:{cli:'codex',memory:{language:'en'}}}}});
 let release!:()=>void,started!:()=>void;
 const held=new Promise<void>(resolve=>release=resolve),syncStarted=new Promise<void>(resolve=>started=resolve);
 let hold=true;
 await page.route('**/api/config',async route=>{
  if(route.request().method()==='GET'&&hold){hold=false;started();await held;}
  await route.continue();
 });
 await page.goto('/?project=&agent=');
 await syncStarted;
 // Navigation cannot hydrate a configuration editor before the initial configuration read settles.
 const team=page.locator('a[data-area="agents"]');
 try { await expect(team).toHaveAttribute('aria-disabled','true'); } finally { release(); }
 await expect(team).not.toHaveAttribute('aria-disabled','true');
 await team.click();
 await page.locator('.workspace-directory').getByRole('button',{name:'添加智能体',exact:true}).click();
 await page.getByRole('textbox',{name:'智能体 名称',exact:true}).fill('Race-proof Agent');
  await chooseOption(page,'执行端','codex');await page.getByRole('button',{name:'创建智能体',exact:true}).click();
 await waitForAutosave(page);
 const saved=await(await request.get('/api/config')).json();
 expect(saved.config.agents.some((agent:any)=>agent.name==='Race-proof Agent')).toBe(true);
 expect(saved.config.system.memory.language).toBe('en');
});


test('task completion notifies outside task pages and opens the exact task without repeating progress',async({page,request})=>{
 const response=await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':'notice-ui'},data:{goal:'检查交付证据'}}),task=await response.json();
 let calls=0;
 await page.route('**/api/v2/task-notifications*',route=>{calls++;return route.fulfill({json:{cursor:calls,items:calls===2?[{id:'notice-exact-run',taskId:task.id,runId:'run',goal:task.goal,state:'review',createdAt:new Date().toISOString()}]:[]}});});
 await page.goto('/?project=&agent=');
 const notices=page.getByRole('complementary',{name:'任务通知',exact:true});
 await expect(notices.getByText('交付待审阅',{exact:true})).toBeVisible();
 await expect(notices.getByRole('link',{name:'检查交付证据',exact:true})).toHaveAttribute('href','/tasks/'+task.id);
 await notices.getByRole('link').click();
 await expect(page).toHaveURL(new RegExp('/tasks/'+task.id+'$'));
 await notices.getByRole('button',{name:'关闭通知 检查交付证据',exact:true}).click();
 await expect(notices).toHaveCount(0);
});
