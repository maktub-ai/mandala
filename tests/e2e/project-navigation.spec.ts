import { storedUiState } from './helpers/preferences';
import { openProjectOverview } from './helpers/navigation';
import {pickDirectoryProject, openProjectBackground} from "./helpers/navigation";
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { openSidebar, openArea, openProject } from './helpers/navigation';
import { expectSelection } from './helpers/select';

for (const locale of ['zh-CN', 'en-US']) for (const width of [1280, 390]) {
 test.describe(`${locale} ${width}`, () => {
  test.use({locale, storageState: storedUiState(locale.startsWith("zh") ? "zh-CN" : "en"), viewport:{width,height:850}});
  test('project tree preserves running chat and scopes tasks, materials and memory after reload', async ({page,request}) => {
   const zh=locale==='zh-CN', key=`tree-${locale}-${width}`, a=key+'-a', b=key+'-b', worker=key+'-worker';
   const root=mkdtempSync(join(tmpdir(),'openmana-navigation-'));for(const id of [a,b])mkdirSync(join(root,id));
   const {revision}=await(await request.get('/api/config')).json();
   expect((await request.put('/api/config',{data:{revision,config:{version:2,projects:[a,b].map((id,i)=>({id,name:`Tree ${i?'B':'A'}`,cwd:join(root,id),agentIds:[worker,id+'-only'],resources:[],mcp:[],skills:[]})),agents:[{id:worker,name:'Tree worker',instructions:'',defaultCli:'codex',models:{},mcp:[],skills:[]},...[a,b].map(id=>({id:id+'-only',name:'Agent '+id,instructions:'Synthetic navigation identity',defaultCli:'codex',models:{},mcp:[],skills:[]}))]}}})).ok()).toBe(true);
   for(const projectId of [a,b]) {
    expect((await request.post('/api/v2/tasks',{headers:{'Idempotency-Key':projectId},data:{goal:'Task '+projectId,criteria:[],acceptance:'delivery',projectId,assigneeAgentId:null}})).ok()).toBe(true);
    const stage=await(await request.post('/api/v2/assets/uploads?name=note.md',{data:'Synthetic '+projectId})).json();
    const saved=await(await request.post('/api/v2/assets/imports',{headers:{'Idempotency-Key':'asset-'+projectId},data:{kind:'document',title:'Material '+projectId,submissionId:stage.submissionId}})).json();
    expect((await request.post('/api/v2/assets/'+saved.asset.id+'/bindings',{data:{ownerType:'project',ownerId:projectId,versionPolicy:'latest'}})).ok()).toBe(true);
    expect((await request.post('/api/knowledge',{data:{kind:'memory',title:'Memory '+projectId,content:'Synthetic memory',scope:'project',projectId,level:'L2',status:'active'}})).ok()).toBe(true);
   }
   const source=await(await request.post('/api/conversations',{data:{projectId:a,agentId:worker,model:'model-fixture',cli:'codex'}})).json();
   const sent=await request.post('/api/conversations/'+source.id+'/messages',{data:{text:'hold'}});expect(sent.ok(),await sent.text()).toBe(true);
   await expect.poll(async()=>(await(await request.get('/api/conversations/'+source.id)).json()).conversation.status).toBe('running');
   const ids=(await(await request.get('/api/conversations')).json()).map((c:any)=>c.id);
   try {
    await page.goto('/?project='+a+'&conversation='+source.id);
    await expect(page.getByTestId('chat-status')).toHaveText(zh?'执行中':'Running');
    await expect(page.getByText('Fixture reply: hold',{exact:true})).toBeVisible();
    const before=await(await request.get('/api/conversations/'+source.id)).json();
    await openProject(page,b);await openProjectOverview(page);
    await expect(page.locator('main .project-content-navigation a')).toHaveText(zh?['概览','任务','资料库','智能体','设置']:['Overview','Tasks','Library','Agents','Settings']);
    await page.locator('main').getByRole('navigation',{name:zh?'项目导航':'Project navigation',exact:true}).getByRole('link',{name:zh?'概览':'Overview',exact:true}).click();
    await expect(page).toHaveURL(new RegExp('/projects/'+b+'/overview$'));
    for(const [name,path,content,hidden] of [
     [zh?'任务':'Tasks','/projects/'+b+'/tasks','Task '+b,'Task '+a],
     [zh?'资料库':'Library','/projects/'+b+'/library','Material '+b,'Material '+a],
     [zh?'智能体':'Agents','/projects/'+b+'/agents','Agent '+b,'Agent '+a],
    ]) {
     await page.locator('main').getByRole('navigation',{name:zh?'项目导航':'Project navigation',exact:true}).getByRole('link',{name,exact:true}).click();
     expect(new URL(page.url()).pathname+new URL(page.url()).search).toBe(path);
     await expect(page.locator('main').getByText(content,{exact:true})).toBeVisible();
     await expect(page.locator('main').getByText(hidden,{exact:true})).toHaveCount(0);
     await page.reload();await expect(page.locator('main').getByText(content,{exact:true})).toBeVisible();
     await expect(page.locator('main .project-content-navigation a')).toHaveText(zh?['概览','任务','资料库','智能体','设置']:['Overview','Tasks','Library','Agents','Settings']);
     await openProject(page,a);await openProjectOverview(page);
     await page.locator('main').getByRole('navigation',{name:zh?'项目导航':'Project navigation',exact:true}).getByRole('link',{name,exact:true}).click();
     await expect(page.locator('main').getByText(hidden,{exact:true})).toBeVisible();await expect(page.locator('main').getByText(content,{exact:true})).toHaveCount(0);
     await openProject(page,b);await openProjectOverview(page);await page.locator('main').getByRole('navigation',{name:zh?'项目导航':'Project navigation',exact:true}).getByRole('link',{name,exact:true}).click();
     await expect(page.locator('main').getByText(content,{exact:true})).toBeVisible();
     expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    }
    for(const [projectId,other] of [[b,a],[a,b]]){await page.goto('/mana?tab=memory&project='+projectId);await expect(page.locator('main').getByRole('article',{name:'Memory '+projectId,exact:true})).toBeVisible();await expect(page.locator('main').getByRole('article',{name:'Memory '+other,exact:true})).toHaveCount(0);await page.reload();await expect(page.locator('main').getByRole('article',{name:'Memory '+projectId,exact:true})).toBeVisible();await expect(page.locator('main .project-content-navigation a')).toHaveText(zh?['概览','任务','资料库','智能体','设置']:['Overview','Tasks','Library','Agents','Settings']);}
    expect(await(await request.get('/api/conversations/'+source.id,{maxRetries:2})).json()).toEqual(before);
    expect((await(await request.get('/api/conversations')).json()).map((c:any)=>c.id)).toEqual(ids);
   } finally {await request.post('/api/conversations/'+source.id+'/stop');rmSync(root,{recursive:true,force:true});}
  });
  test('global start keeps the current project and Agent choice',async({page,request},testInfo)=>{
   const zh=locale==='zh-CN';const {config}=await(await request.get('/api/config')).json();const project=config.projects[0], agent=project.agentIds[0];
   await page.goto('/?project='+project.id+'&agent='+agent);await openArea(page,zh?'任务':'Tasks');await openSidebar(page);
   await expect(page.getByRole('button',{name:zh?'开始对话':'Start chat',exact:true})).toBeVisible();
   await page.getByRole('button',{name:zh?'开始对话':'Start chat',exact:true}).click();
   expect(new URL(page.url()).searchParams.get('project')).toBe(project.id);
   await expectSelection(page.getByRole('combobox',{name:zh?'当前项目':'Current project',exact:true}),project.id);
   await expectSelection(page.getByRole('combobox',{name:zh?'当前 智能体':'Current agent',exact:true}),agent);
   await page.reload();await expectSelection(page.getByRole('combobox',{name:zh?'当前项目':'Current project',exact:true}),project.id);
   if(locale==='zh-CN'&&width===1280){await page.evaluate(()=>localStorage.setItem('mana-theme','light'));await page.reload();}
   if(width===390)await openSidebar(page);
   await page.screenshot({path:testInfo.outputPath('navigation-'+locale+'-'+width+'.png')});
   await page.evaluate(()=>{localStorage.removeItem('mana-project');localStorage.removeItem('mana-chat');});await page.goto('/');
   await expect(page.getByRole('region',{name:zh?'新对话准备':'New chat setup',exact:true})).toBeVisible();
   await expect(page.locator('.global-workbench')).toHaveCount(0);
  });
 });
}

test('shared project navigation preserves memory edits but allows abandoning task creation',async({page,request})=>{
 expect((await request.post('/api/knowledge',{data:{kind:'memory',title:'Synthetic navigation memory',content:'Original navigation memory',scope:'global',status:'active',level:'L3'}})).ok()).toBe(true);
 await page.goto('/mana?tab=memory');await page.getByRole('article',{name:'Synthetic navigation memory',exact:true}).getByRole('button',{name:'纠正',exact:true}).click();
 await page.getByRole('textbox',{name:'纠正内容',exact:true}).fill('Keep memory editor');
 await expect(page.getByRole('button',{name:'开始对话',exact:true})).toBeDisabled();
 await page.getByRole('navigation',{name:'主导航',exact:true}).locator('[data-area=tasks]').press('Enter');
 await expect(page).toHaveURL(/\/mana\?tab=memory$/);await expect(page.getByRole('textbox',{name:'纠正内容',exact:true})).toHaveValue('Keep memory editor');
 await page.getByRole('button',{name:'取消',exact:true}).click();
 await page.goto('/tasks');await page.getByRole('button',{name:'新建任务',exact:true}).click();await page.getByRole('button',{name:'手动填写',exact:true}).click();
 await page.getByRole('textbox',{name:'任务标题',exact:true}).fill('Keep schedule editor');
 await expect(page.getByRole('button',{name:'开始对话',exact:true})).toBeEnabled();
 await openArea(page,'资料库');
 await expect(page).toHaveURL(/\/library$/);await expect(page.getByRole('textbox',{name:'任务标题',exact:true})).toHaveCount(0);
});

test('late project materials response cannot overwrite the current project',async({page,request})=>{
 const {revision}=await(await request.get('/api/config')).json();
 expect((await request.put('/api/config',{data:{revision,config:{version:2,projects:['race-a','race-b'].map(id=>({id,name:id,cwd:'/tmp',agentIds:[],resources:[],mcp:[],skills:[]})),agents:[]}}})).ok()).toBe(true);
 for(const projectId of ['race-a','race-b']) {
  const stage=await(await request.post('/api/v2/assets/uploads?name=note.md',{data:'Synthetic '+projectId})).json();
  const saved=await(await request.post('/api/v2/assets/imports',{headers:{'Idempotency-Key':'race-'+projectId},data:{kind:'document',title:'Material '+projectId,submissionId:stage.submissionId}})).json();
  expect((await request.post('/api/v2/assets/'+saved.asset.id+'/bindings',{data:{ownerType:'project',ownerId:projectId,versionPolicy:'latest'}})).ok()).toBe(true);
 }
 let release!:()=>void, seen!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>seen=resolve);
 await page.route('**/api/v2/assets/bindings?**',async route=>{if(new URL(route.request().url()).searchParams.get('ownerId')==='race-a'){const response=await route.fetch();seen();await gate;await route.fulfill({response});}else await route.continue();});
 await page.goto('/assets?project=race-a');await started;
 await openProject(page,'race-b');await openProjectOverview(page);
 await page.locator('main').getByRole('navigation',{name:'项目导航',exact:true}).getByRole('link',{name:'资料库',exact:true}).click();
 await expect(page.locator('main').getByText('Material race-b',{exact:true})).toBeVisible();
 const stale=page.waitForResponse(response=>new URL(response.url()).searchParams.get('ownerId')==='race-a');release();await(await stale).finished();
 await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
 await expect(page.locator('main').getByText('Material race-b',{exact:true})).toBeVisible();
 await expect(page.locator('main').getByText('Material race-a',{exact:true})).toHaveCount(0);
});

test('global start and project links preserve automatically saved configuration without a leave dialog',async({page,request})=>{
 const {revision}=await(await request.get('/api/config')).json();
 expect((await request.put('/api/config',{data:{revision,config:{version:2,projects:['guard-a','guard-b'].map(id=>({id,name:id,cwd:'/tmp',agentIds:[],resources:[],mcp:[],skills:[]})),agents:[]}}})).ok()).toBe(true);
 await page.goto('/projects/manage');await pickDirectoryProject(page);await openProjectBackground(page);
 await page.getByRole('textbox',{name:'项目名称',exact:true}).fill('Automatically saved project');
 let dialogs=0;page.on('dialog',async dialog=>{dialogs++;await dialog.dismiss();});
 await page.getByRole('button',{name:'开始对话',exact:true}).click();await expect(page).toHaveURL(/\/\?project=/);
 await expect.poll(async()=>(await(await request.get('/api/config')).json()).config.projects[0].name).toBe('Automatically saved project');
 await openProject(page,'guard-b');await openProject(page,'guard-a');
 await page.getByRole('button',{name:'项目设置',exact:true}).click();await openProjectBackground(page);await expect(page.getByRole('textbox',{name:'项目名称',exact:true})).toHaveValue('Automatically saved project');expect(dialogs).toBe(0);
});

test('fix1 returning to the selected chat from tasks assets and rules restores its URL and draft',async({page,request})=>{
 const root=mkdtempSync(join(tmpdir(),'openmana-return-'));
 const {revision}=await(await request.get('/api/config')).json();
 expect((await request.put('/api/config',{data:{revision,config:{version:2,projects:[{id:'return-project',name:'Return project',cwd:root,agentIds:['return-worker'],resources:[],mcp:[],skills:[]}],agents:[{id:'return-worker',name:'Return worker',instructions:'Synthetic navigation only',defaultCli:'codex',models:{},mcp:[],skills:[]}]}}})).ok()).toBe(true);
 const sourceResponse=await request.post('/api/conversations',{data:{projectId:'return-project',agentId:'return-worker',model:'model-fixture',cli:'codex'}});expect(sourceResponse.ok()).toBe(true);
 const source=(await sourceResponse.json()).id;
 expect((await request.post('/api/conversations/'+source+'/messages',{data:{text:'Synthetic return navigation'}})).ok()).toBe(true);
 await expect.poll(async()=>(await(await request.get('/api/conversations/'+source)).json()).conversation.status).toBe('idle');
 const timestamp=new Date().toISOString();
 // This read fixture drives the existing history callback to the real, selected canonical chat.
 await page.route('**/api/automations',route=>route.fulfill({json:{version:1,automations:[],runs:[{id:'return-run',automationId:'return-rule',name:'Return rule',projectId:'return-project',agentId:'return-worker',cli:'codex',instructions:'Synthetic return navigation',scheduledAt:timestamp,createdAt:timestamp,status:'succeeded',conversationId:source}]}}));
 const state=async()=>await(await request.get('/api/automations')).json();
 try {
  await page.goto('/?project=return-project&conversation='+source);
  await expect(page.getByText('Fixture reply: Synthetic return navigation',{exact:true})).toBeVisible();
  const detail=await(await request.get('/api/conversations/'+source)).json(),conversations=await(await request.get('/api/conversations')).json(),rules=await state(),tasks=await(await request.get('/api/v2/tasks')).json();
  for(const area of ['tasks','assets','rules']) {
   await page.getByRole('textbox',{name:'消息',exact:true}).fill('Keep same-chat draft '+area);
   await openArea(page,area==='assets'?'资产库':'任务');
   if(area==='rules') {
    await page.locator('.task-legacy-rules > summary').click();await page.locator('.automation-history > summary').click();
    await page.locator('.automation-run').filter({hasText:'Return rule'}).getByRole('button',{name:'查看对话',exact:true}).click();
   } else {
    await page.locator('#navigation-chat').getByRole('button',{name:detail.conversation.title,exact:true}).click();
   }
   await expect(page).toHaveURL(new RegExp('/\\?project=return-project&conversation='+source+'$'));
   await expect(page.getByRole('textbox',{name:'消息',exact:true})).toHaveValue('Keep same-chat draft '+area);
   await expect(page.getByText('Fixture reply: Synthetic return navigation',{exact:true})).toBeVisible();
   await page.reload();await expect(page.getByText('Fixture reply: Synthetic return navigation',{exact:true})).toBeVisible();
   expect(await(await request.get('/api/conversations/'+source)).json()).toEqual(detail);
   expect(await(await request.get('/api/conversations')).json()).toEqual(conversations);
   expect(await state()).toEqual(rules);
   expect(await(await request.get('/api/v2/tasks')).json()).toEqual(tasks);
  }
 } finally {
  try {
   const {config,revision}=await(await request.get('/api/config')).json();
   const cleaned={...config,projects:config.projects.filter((p:any)=>p.id!=='return-project'),agents:config.agents.filter((a:any)=>a.id!=='return-worker')};
   const response=await request.put('/api/config',{data:{revision,config:cleaned}});expect(response.ok(),await response.text()).toBe(true);
  } finally {rmSync(root,{recursive:true,force:true});}
 }
});

test('mobile focus wraps through permanent navigation and restores its trigger',async({page})=>{
 await page.setViewportSize({width:390,height:844});await page.goto('/tasks');
 await expect(page.locator('.task-workspace .workspace-page-heading h1')).toHaveText('任务');
 const trigger=page.getByRole('button',{name:'打开侧栏',exact:true});await trigger.click();
 const sidebar=page.locator('aside.sidebar'),first=sidebar.getByRole('button',{name:'关闭侧栏',exact:true});
 await expect(first).toBeFocused();
 const last=sidebar.locator('button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]').filter({visible:true}).last();
 await last.focus();await page.keyboard.press('Tab');await expect(first).toBeFocused();
 await page.keyboard.press('Shift+Tab');await expect(last).toBeFocused();await page.keyboard.press('Escape');
 await expect(sidebar).not.toBeVisible();await expect(trigger).toBeFocused();
});


test('mobile sidebar restores the replacement trigger when startup completes while it is open',async({page})=>{
 let release!:()=>void,started!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;}),pending=new Promise<void>(resolve=>{started=resolve;});
 await page.route('**/api/config',async route=>{if(route.request().method()==='GET'){started();await gate;}await route.continue();});
 await page.setViewportSize({width:390,height:844});await page.goto('/tasks');await pending;
 const trigger=page.getByRole('button',{name:'打开侧栏',exact:true}),sidebar=page.locator('aside.sidebar');
 const first=sidebar.getByRole('button',{name:'关闭侧栏',exact:true});
 const last=sidebar.locator('button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]').filter({visible:true}).last();
 const initialSidebar=await sidebar.elementHandle();
 try{
  await expect(page.getByRole('status',{name:'正在读取配置…',exact:true})).toBeVisible();
  await trigger.click();await expect(first).toBeFocused();
  await last.focus();await page.keyboard.press('Tab');await expect(first).toBeFocused();
  await page.keyboard.press('Shift+Tab');await expect(last).toBeFocused();
 }finally{release();}
 await expect(page.locator('.task-workspace .workspace-page-heading h1')).toHaveText('任务');
 expect(await initialSidebar!.evaluate(element=>element.isConnected)).toBe(false);
 await expect(page.locator('main')).toHaveAttribute('inert');await expect(first).toBeFocused();
 await last.focus();await page.keyboard.press('Tab');await expect(first).toBeFocused();
 await page.keyboard.press('Shift+Tab');await expect(last).toBeFocused();
 await page.keyboard.press('Escape');await expect(sidebar).not.toBeVisible();await expect(page.locator('main')).not.toHaveAttribute('inert');await expect(trigger).toBeFocused();
 await page.screenshot({path:test.info().outputPath('startup-sidebar-focus-restored.png')});
});
