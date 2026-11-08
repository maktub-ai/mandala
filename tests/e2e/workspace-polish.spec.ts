import {createTaskWithExecutionChats} from './helpers/task-executions';
import { test, expect } from './helpers/execution-fixture';

for (const scene of [{width:1280,theme:'light'},{width:390,theme:'dark'}]) test(`task and composer workflow at ${scene.width}`, async ({page,request,executionDirectory},testInfo)=>{
 const {revision}=await(await request.get('/api/config')).json();
 const agent=(id:string,name:string)=>({id,name,instructions:'Review workspace changes',defaultCli:'codex',models:{},skills:[],mcp:[]});
 await request.put('/api/config',{data:{revision,config:{version:2,projects:[{id:'polish',name:'Workspace',cwd:executionDirectory,resources:[],agentIds:['author','reviewer'],skills:[],mcp:[]}],agents:[agent('author','Author'),agent('reviewer','Reviewer'),agent('outside','Outside')]}}});
 const chat=await(await request.post('/api/conversations',{data:{projectId:'polish',agentId:'author'}})).json();
 await page.addInitScript(theme=>{localStorage.setItem('mana-theme',theme);localStorage.setItem('mana-language','en');},scene.theme);
 await page.setViewportSize({width:scene.width,height:850});
 await page.goto('/?conversation='+chat.id+'&project=polish');
 const composer=page.getByRole('textbox',{name:'Message',exact:true});
 await composer.fill('@');
 const menu=page.locator('.composer-reference-menu');
 await expect(menu.getByRole('option')).toHaveCount(1);
 await expect(menu).not.toContainText('Outside');
 await menu.getByRole('option',{name:/Reviewer/}).click();
 await expect(page.locator('.composer-references')).toContainText('Reviewer');
 await composer.fill('Investigate CLI versions /task');
 await menu.getByRole('option',{name:/Create task/}).click();
 await expect(page.getByRole('form',{name:'New task',exact:true})).toHaveCount(0);
 await expect(page.getByRole('dialog')).toHaveCount(0);
 await expect(page.locator('.composer-references')).toContainText('Create task');
 await expect(composer).toHaveValue('Investigate CLI versions ');
 expect(await(await request.get('/api/v2/tasks?conversationId='+chat.id)).json()).toEqual([]);
 await composer.fill('/');
 await expect(menu.getByRole('option',{name:/Open terminal|All commands/})).toHaveCount(0);
 await composer.fill('Investigate CLI versions ');
 await createTaskWithExecutionChats(request,{headers:{'Idempotency-Key':'polish-task-'+scene.width},data:{goal:'Investigate CLI versions\n\nTrace version probes and report the evidence.',projectId:'polish'}},[chat.id]);
 await page.getByRole('button',{name:'Chat context',exact:true}).click();
 const related=page.getByRole('dialog',{name:'Chat context',exact:true}).getByRole('region',{name:'Tasks',exact:true});
 await expect(related).toContainText('Tasks');
 await expect(related).toContainText('Investigate CLI versions');
 const tasks=await(await request.get('/api/v2/tasks?conversationId='+chat.id)).json();
 expect(tasks).toHaveLength(1);expect(tasks[0].state).toBe('todo');
 expect(tasks[0].goal).toBe('Investigate CLI versions\n\nTrace version probes and report the evidence.');
 expect((await(await request.get('/api/v2/tasks/'+tasks[0].id)).json()).runs).toEqual([]);
 await page.screenshot({path:testInfo.outputPath('linked-task.png')});
 await related.getByRole('link').click();
 await expect(page.getByRole('heading',{name:'Investigate CLI versions',exact:true})).toBeVisible();
 await expect(page.locator('.task-description')).toHaveText('Trace version probes and report the evidence.');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:testInfo.outputPath('task-detail.png')});
 await page.goto('/?conversation='+chat.id+'&project=polish');
 await expect(composer).toBeVisible();await page.getByRole('button',{name:'Chat context',exact:true}).click();
 await expect(related.locator('a[href="/tasks/'+tasks[0].id+'"]')).toContainText('Investigate CLI versions');
});

test('nested workspace folders expand and search reveals files without losing the draft',async({page,request},testInfo)=>{
 const chat=await(await request.post('/api/conversations',{data:{workspaceId:null}})).json();
 await page.route('**/api/conversations/'+chat.id+'/workspace{,?**}',route=>route.fulfill({json:{cwd:'/tmp/example-project',git:true,truncated:false,directories:['empty'],files:[{path:'README.md',status:''},{path:'src/components/Panel.tsx',status:' M'}]}}));
 await page.route('**/api/conversations/'+chat.id+'/workspace-file',route=>route.fulfill({json:{name:'Panel.tsx',path:'src/components/Panel.tsx',text:'export const panel = true;',diff:null}}));
 await page.goto('/?conversation='+chat.id);
 await page.getByRole('textbox',{name:'消息',exact:true}).fill('Keep my draft');
 await page.getByRole('button',{name:'展开右侧栏',exact:true}).click();
 const panel=page.locator('#chat-environment-panel');
 await panel.getByRole('tab',{name:'文件',exact:true}).click();
 await expect(panel.getByRole('button',{name:'src/components/Panel.tsx',exact:true})).not.toBeVisible();
 await panel.locator('summary[aria-label="src"]').click();
 await panel.locator('summary[aria-label="src/components"]').click();
 await expect(panel.getByRole('button',{name:'src/components/Panel.tsx',exact:true})).toBeVisible();
 await expect(panel.locator('summary[aria-label="empty"]')).toBeVisible();
 await page.screenshot({path:testInfo.outputPath('file-tree.png')});
 await panel.getByRole('searchbox').fill('absent-file');
 await expect(panel).toContainText('没有匹配的文件。');
 await panel.getByRole('searchbox').fill('Panel');
 await panel.getByRole('button',{name:'src/components/Panel.tsx',exact:true}).click();
 await expect(panel).toContainText('export const panel = true;');
 await expect(page.getByRole('textbox',{name:'消息',exact:true})).toHaveValue('Keep my draft');
});

for(const width of [1280,390]) test(`unified Progress keeps semantic groups and readable hierarchy at ${width}`,async({page,request},testInfo)=>{
 // The unified Progress contract uses Task roots with linked chats; free chats remain roots.
 const fixture=await(await request.post('/__test__/progress-fixture')).json();
 await page.setViewportSize({width,height:850});
 await page.addInitScript(theme=>{localStorage.setItem('mana-theme',theme);localStorage.setItem('mana-language','en');},width===390?'dark':'light');
 await page.goto('/tasks?view=board&type=all');
 const board=page.getByRole('region',{name:'Progress board',exact:true}),columns=board.locator(':scope > section');
 await expect(columns).toHaveCount(3);
 expect(await columns.evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label')))).toEqual(['Needs attention','In progress & recent','Completed']);
 const task=board.locator('[data-task-id="'+fixture.task+'"]');await expect(task).toBeVisible();
 await expect(board.locator('[data-conversation-id="'+fixture.recent+'"]')).toHaveCount(0);
 await task.locator('.progress-expand').click();
 const child=task.locator('[data-linked-conversation-id="'+fixture.recent+'"]');await expect(child).toBeVisible();await expect(child).toHaveAttribute('href','/?conversation='+fixture.recent);
 const long=board.locator('[data-conversation-id="'+fixture.long+'"]'),longTitle=long.locator('.progress-item-title');
 await expect(longTitle).toHaveText(fixture.longTitle.slice(0,80)+'…');await expect(longTitle).toHaveAttribute('title',fixture.longTitle);
 const titleWidths=await task.locator('.progress-item-title').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().width));
 expect(titleWidths.length).toBeGreaterThan(0);expect(titleWidths.every(width=>width>=100)).toBe(true);
 const boxes=await columns.evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width};}));
 expect(boxes.every(box=>box.width>=220)).toBe(true);
 if(width===1280){expect(new Set(boxes.map(box=>box.y)).size).toBe(1);expect(boxes.every((box,index)=>index===0||box.x>boxes[index-1].x)).toBe(true);}
 else{
  // Narrow Board keeps readable columns in an internal horizontal scroller.
  expect(new Set(boxes.map(box=>box.y)).size).toBe(1);expect(boxes.every((box,index)=>index===0||box.x>boxes[index-1].x)).toBe(true);
  expect(await board.evaluate(node=>getComputedStyle(node).overflowX)).toBe('auto');
  const completed=columns.nth(2).getByRole('heading',{level:2});await completed.scrollIntoViewIfNeeded();await expect(completed).toBeInViewport();expect(await board.evaluate(node=>node.scrollLeft)).toBeGreaterThan(0);
 }
 await longTitle.scrollIntoViewIfNeeded();await expect(longTitle).toBeInViewport();expect((await longTitle.boundingBox())!.width).toBeGreaterThanOrEqual(100);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 expect((await(await request.get('/api/v2/tasks/'+fixture.task)).json()).runs).toEqual([]);
 await page.screenshot({path:testInfo.outputPath('progress-groups.png')});
});

test('opening a folder fetches contents missing from the initial file list and retries failures',async({page,request,executionDirectory},testInfo)=>{
 const {mkdir,writeFile}=await import('node:fs/promises');
 await mkdir(executionDirectory+'/quality-dashboard',{recursive:true});
 await writeFile(executionDirectory+'/quality-dashboard/index.html','Dashboard content');
 const {config,revision}=await(await request.get('/api/config')).json();
 await request.put('/api/config',{data:{revision,config:{...config,projects:[...config.projects,{id:'folder-test',name:'Folder test',cwd:executionDirectory,agentIds:[],resources:[],skills:[],mcp:[]}]}}});
 const chat=await(await request.post('/api/conversations',{data:{projectId:'folder-test'}})).json();
 await page.route('**/api/conversations/'+chat.id+'/workspace',route=>route.fulfill({json:{cwd:executionDirectory,git:false,truncated:true,directories:['quality-dashboard'],files:[]}}));
 await page.route('**/api/conversations/'+chat.id+'/workspace?directory=quality-dashboard',route=>route.fulfill({status:503,json:{error:'Folder temporarily unavailable'}}),{times:1});
 await page.goto('/?conversation='+chat.id);
 await page.getByRole('button',{name:'展开右侧栏',exact:true}).click();
 const panel=page.locator('#chat-environment-panel');
 await panel.getByRole('tab',{name:'文件',exact:true}).click();
 await panel.locator('summary[aria-label="quality-dashboard"]').click();
 await expect(panel.getByRole('alert')).toContainText('Folder temporarily unavailable');
 await panel.getByRole('button',{name:'重试',exact:true}).click();
 await expect(panel.getByRole('button',{name:'quality-dashboard/index.html',exact:true})).toBeVisible();
 await page.screenshot({path:testInfo.outputPath('loaded-subfolder.png')});
 await panel.getByRole('button',{name:'quality-dashboard/index.html',exact:true}).click();
 await expect(panel).toContainText('Dashboard content');
});
