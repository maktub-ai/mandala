import {expect,test} from '@playwright/test';
import {chooseOption} from './helpers/select';
import {openArea,pickDirectoryProject} from './helpers/navigation';

const agents=['a','b','c','historical'].map(id=>({id,name:'Agent '+id,instructions:'Responsibility '+id,defaultCli:'codex',models:{},mcp:[],skills:[]}));
const projects=[{id:'p',name:'Project P',agentIds:['a','b']},{id:'q',name:'Project Q',agentIds:['c']},{id:'empty',name:'Empty project',agentIds:[]}].map(p=>({...p,cwd:'',resources:[],mcp:[],skills:[]}));
test.beforeEach(async({request})=>{
 const {revision}=await(await request.get('/api/config')).json();
 expect((await request.put('/api/config',{data:{revision,config:{version:2,projects,agents}}})).ok()).toBe(true);
});

test('quick start offers project collaborators and clears an invalid executor on project switch',async({page})=>{
 await page.goto('/');await chooseOption(page,'当前项目','p');
 const picker=page.getByRole('combobox',{name:'当前 智能体',exact:true});await picker.click();
 await expect(page.getByRole('option',{name:'Agent a',exact:true})).toBeVisible();
 await expect(page.getByRole('option',{name:'Agent b',exact:true})).toBeVisible();
 await expect(page.getByRole('option',{name:'Agent c',exact:true})).toHaveCount(0);
 await page.keyboard.press('Escape');await chooseOption(page,'当前 智能体','a');
 await chooseOption(page,'当前项目','q');await expect(picker).toHaveAttribute('data-value','');
 await picker.click();await expect(page.getByRole('option',{name:'Agent c',exact:true})).toBeVisible();await expect(page.getByRole('option',{name:'Agent a',exact:true})).toHaveCount(0);
 await page.keyboard.press('Escape');await chooseOption(page,'当前项目','empty');await picker.click();await expect(page.getByRole('option')).toHaveCount(1);
 await page.keyboard.press('Escape');await chooseOption(page,'当前项目','');await picker.click();await expect(page.getByRole('option')).toHaveCount(5);
});

test('project overview shows real collaborators in the main area and switches projects',async({page,request})=>{
 // A historical participant is deliberately absent from current project binding.
 const old=await(await request.post('/api/conversations',{data:{projectId:'p',agentId:'a',cli:'codex'}})).json();
 const {revision}=await(await request.get('/api/config')).json();await request.put('/api/config',{data:{revision,config:{version:2,projects:projects.map(p=>p.id==='p'?{...p,agentIds:['b']}:p),agents}}});
 await page.goto('/projects/p/workbench');
 const structure=page.locator('.project-associated-agents');await expect(structure).toBeVisible();
 await expect(page.locator('.workspace-page-heading')).toContainText('Project P');await expect(structure).toContainText('Agent b');await expect(structure).not.toContainText('Agent a');await page.getByRole('navigation',{name:'项目导航',exact:true}).getByRole('link',{name:'智能体',exact:true}).click();await expect(page.locator('.project-agent-rows')).toContainText('Responsibility b');await page.goBack();
 await expect(page.locator('.project-chat-row').filter({hasText:old.title||'新对话'})).toContainText('Agent a');
 await switchWorkbenchProject(page,'q');await expect(page).toHaveURL(/\/projects\/q\/workbench$/);await expect(structure).toContainText('Agent c');await expect(structure).not.toContainText('Agent b');
 await switchWorkbenchProject(page,'empty');await expect(structure).toContainText('尚未关联 智能体');await expect(page.getByRole('button',{name:'项目设置',exact:true})).toBeVisible();
 await page.goBack();await expect(structure).toContainText('Agent c');
});

test('team current membership excludes historical executors while their conversation stays accessible',async({page,request})=>{
 const chat=await(await request.post('/api/conversations',{data:{projectId:'p',agentId:'a',cli:'codex'}})).json();
 await request.patch('/api/conversations/'+chat.id,{data:{title:'Historical P conversation'}});
 const {revision}=await(await request.get('/api/config')).json();await request.put('/api/config',{data:{revision,config:{version:2,projects:projects.map(p=>p.id==='p'?{...p,agentIds:['b']}:p),agents}}});
 await page.goto('/projects/p/agents');
 await expect(page.locator('.project-agent-rows')).toContainText('Agent b');await expect(page.locator('.project-agent-rows')).not.toContainText('Agent a');await expect(page.locator('.project-agent-rows')).not.toContainText('Agent c');
 await page.getByRole('navigation',{name:'项目导航',exact:true}).getByRole('link',{name:'概览',exact:true}).click();
 await page.locator('.project-chat-row').filter({hasText:'Historical P conversation'}).click();
 await expect(page).toHaveURL(new RegExp('conversation='+chat.id));
 await expect(page.locator('.topbar')).toContainText('Project P');
 await page.goto('/?project=p');const picker=page.getByRole('combobox',{name:'当前 智能体',exact:true});await picker.click();
 await expect(page.getByRole('option',{name:'Agent a',exact:true})).toHaveCount(0);await expect(page.getByRole('option',{name:'Agent b',exact:true})).toBeVisible();await page.keyboard.press('Escape');
 await chooseOption(page,'当前项目','q');await expect(picker).toHaveAttribute('data-value','');await picker.click();await expect(page.getByRole('option',{name:'Agent c',exact:true})).toBeVisible();await expect(page.getByRole('option',{name:'Agent b',exact:true})).toHaveCount(0);
});

test('Agent detail starts in the visible project rather than a retained conversation project',async({page,request})=>{
 const chat=await(await request.post('/api/conversations',{data:{projectId:'p',agentId:'a',cli:'codex'}})).json();
 await page.goto('/?project=p&conversation='+chat.id);
 await page.evaluate(()=>{history.pushState(null,'','/projects/q/workbench');dispatchEvent(new PopStateEvent('popstate'));});
 await page.locator('.project-associated-agents').getByRole('button',{name:'Agent c',exact:false}).click();
 await expect(page).toHaveURL(url=>url.pathname==='/agents/c'&&url.searchParams.get('project')==='q');await expect(page.locator('.agent-overview')).toBeVisible();
 await page.getByRole('button',{name:'开始对话',exact:true}).last().click();
 expect(new URL(page.url()).searchParams.get('agent')).toBe('c');expect(new URL(page.url()).searchParams.get('project')).toBe('q');
});

test('Progress combines project and owner filters without dropping a selected historical assignee',async({page,request})=>{
 const response=await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':crypto.randomUUID()},data:{goal:'Past assignee task',projectId:'p',assigneeAgentId:'historical'}});expect(response.ok()).toBe(true);const task=await response.json();
 await page.goto('/tasks?type=tasks&project=p');await page.getByRole('button',{name:'筛选',exact:true}).click();const picker=page.getByRole('combobox',{name:'进度负责人',exact:true});await picker.click();
 await expect(page.getByRole('option',{name:'Agent c',exact:true})).toBeVisible();await expect(page.getByRole('option',{name:'Agent historical',exact:true})).toBeVisible();
 await page.keyboard.press('Escape');await chooseOption(page,'进度负责人','historical');const row=page.locator('.progress-item-title[href^="/tasks/'+task.id+'"]');await expect(row).toHaveText('Past assignee task');
 await chooseOption(page,'进度项目','q');await expect(picker).toHaveAttribute('data-value','historical');expect(new URL(page.url()).searchParams.get('agent')).toBe('historical');await expect(row).toHaveCount(0);await expect(page.getByRole('heading',{name:'没有匹配的事项',exact:true})).toBeVisible();
 await chooseOption(page,'进度项目','p');await expect(row).toBeVisible();await page.reload();await page.getByRole('button',{name:'筛选',exact:true}).click();await expect(picker).toHaveAttribute('data-value','historical');await expect(row).toBeVisible();
});

test('automation project filter keeps URL and navigation context consistent',async({page})=>{
 await page.goto('/tasks?rules=1&project=p');await chooseOption(page,'项目筛选','q');
 await expect(page).toHaveURL(/project=q/);expect(new URL(page.url()).searchParams.get('project')).toBe('q');
 await page.goBack();await expect(page.getByRole('combobox',{name:'项目筛选',exact:true})).toHaveAttribute('data-value','p');
});

test('memory project switch clears source-specific filters from another scope',async({page})=>{
 await page.goto('/mana?tab=memory&project=p&conversationId=old-chat&taskId=old-task');await chooseOption(page,'项目范围','q');
 const query=new URL(page.url()).searchParams;expect(query.get('project')).toBe('q');expect(query.has('conversationId')).toBe(false);expect(query.has('taskId')).toBe(false);
});

for(const theme of ['dark','light'])for(const width of [390,1440])test('project relationship and browse controls remain visible in '+theme+' '+width,async({page},testInfo)=>{
 await page.setViewportSize({width,height:900});await page.addInitScript(({theme,width})=>{localStorage.setItem('mana-theme',theme);localStorage.setItem('mana-language',width===1440?'en':'zh-CN');},{theme,width});
 await page.goto('/projects/p/workbench');const english=width===1440;
 await expect(page.locator('.project-associated-agents')).toBeVisible();await page.getByText(english?'Switch project':'切换项目',{exact:true}).click();
 await expect(page.getByRole('combobox',{name:english?'Current project':'当前项目',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:testInfo.outputPath('project.png'),fullPage:true});
 await page.goto('/usage?project=p');await expect(page.getByRole('combobox',{name:english?'Current project':'当前项目',exact:true})).toHaveAttribute('data-value','p');
 await expect(page.getByRole('heading',{name:english?'Usage':'用量',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:testInfo.outputPath('usage.png'),fullPage:true});
});

test('project management opens settings and tracks current project membership',async({page})=>{
 const errors:string[]=[];page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
 await page.goto('/projects/manage?project=p');await expect(page.getByRole('textbox',{name:'项目背景',exact:true})).toBeVisible();await expect(page.getByRole('region',{name:'项目协作者',exact:true})).toHaveCount(0);
 await page.getByRole('tab',{name:'参与者',exact:true}).click();await expect(page.getByRole('checkbox',{name:'Agent a',exact:true})).toBeChecked();await expect(page.getByRole('checkbox',{name:'Agent b',exact:true})).toBeChecked();await expect(page.getByRole('checkbox',{name:'Agent c',exact:true})).not.toBeChecked();
 await pickDirectoryProject(page,'q','参与者');await expect(page.locator('.object-detail-heading h2')).toHaveText('Project Q');await expect(page.getByRole('checkbox',{name:'Agent c',exact:true})).toBeChecked();await expect(page.getByRole('checkbox',{name:'Agent a',exact:true})).not.toBeChecked();
 await pickDirectoryProject(page,'empty','参与者');await expect(page.locator('.object-detail-heading h2')).toHaveText('Empty project');await expect(page.locator('.check-list input[type=checkbox]')).toHaveCount(4);await expect(page.locator('.check-list input:checked')).toHaveCount(0);expect(errors).toEqual([]);
});

for(const destination of ['/projects/q/workbench','/tasks?project=q','/usage?project=q'])test('sidebar start respects visible scope at '+destination,async({page,request})=>{
 const chat=await(await request.post('/api/conversations',{data:{projectId:'p',agentId:'a',cli:'codex'}})).json();await page.goto('/?project=p&conversation='+chat.id);
 await expect(page.locator('.topbar')).toContainText('Project P');
 await page.evaluate(destination=>{history.pushState(null,'',destination);dispatchEvent(new PopStateEvent('popstate'));},destination);
 if(destination.startsWith('/projects/'))await expect(page.locator('main .workspace-page-heading h1')).toHaveText('Project Q');
 else if(destination.startsWith('/tasks'))expect(new URL(page.url()).searchParams.get('project')).toBe('q');
 else await expect(page.getByRole('combobox',{name:'当前项目',exact:true})).toHaveAttribute('data-value','q');
 await page.locator('aside.sidebar').getByRole('button',{name:'开始对话',exact:true}).click();
 await expect(page.getByRole('combobox',{name:'当前项目',exact:true})).toHaveAttribute('data-value','q');await expect(page.getByRole('combobox',{name:'当前 智能体',exact:true})).not.toHaveAttribute('data-value','a');
});

test('explicit project selection starts in its selected project instead of a retained chat',async({page,request})=>{
 const chat=await(await request.post('/api/conversations',{data:{projectId:'q',agentId:'c',cli:'codex'}})).json();await page.goto('/?project=q&conversation='+chat.id);
 await expect(page.locator('.topbar')).toContainText('Project Q');await openArea(page,'项目');await projectDirectorySelection(page,'p');await expect(page.locator('.workspace-page-heading h1')).toHaveText('Project P');
 await page.locator('aside.sidebar').getByRole('button',{name:'开始对话',exact:true}).click();await expect(page.getByRole('combobox',{name:'当前项目',exact:true})).toHaveAttribute('data-value','p');
});

async function projectDirectorySelection(page:import('@playwright/test').Page,id:string){await page.locator('.workspace-directory-row[href="/projects/'+id+'/overview"]').click();}

async function switchWorkbenchProject(page:import('@playwright/test').Page,id:string){await page.getByText('切换项目',{exact:true}).click();await page.getByRole('combobox',{name:'当前项目',exact:true}).click();await page.getByRole('listbox').locator('[role=option][data-value="'+id+'"]').click();await expect(page).toHaveURL(new RegExp('/projects/'+id+'/workbench$'));}
