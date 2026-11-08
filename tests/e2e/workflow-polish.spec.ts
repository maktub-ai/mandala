import {openProject,openProjectBackground,pickDirectoryAgent,editAgentProfile} from "./helpers/navigation";
import {test,expect} from '@playwright/test';
import {chooseOption} from './helpers/select';

test.beforeEach(async({request})=>{
 const {revision}=await(await request.get('/api/config')).json();
 expect((await request.put('/api/config',{data:{revision,config:{version:2,projects:[],agents:[]}}})).ok()).toBe(true);
});

test('tasks show creation time, default newest first and persist sorting in the URL',async({page})=>{
 const row=(id:string,date:string)=>({id,goal:id,state:'todo',waitingReason:null,createdAt:date,criteria:[],revision:1,assigneeAgentId:null,projectId:null});
 await page.route('**/api/v2/tasks',route=>route.fulfill({json:[row('older','2026-10-01T10:00:00Z'),row('newer','2026-10-07T10:00:00Z')]}));
 await page.route('**/api/conversation-progress?*',route=>route.fulfill({json:[]}));
 await page.goto('/tasks?type=tasks&scope=all&view=list');await expect(page.locator('.progress-item-title')).toHaveText(['newer','older']);
 await expect(page.locator('.progress-item time').first()).toHaveAttribute('dateTime','2026-10-07T10:00:00Z');
 await page.getByRole('button',{name:'筛选',exact:true}).click();await chooseOption(page,'任务排序','oldest');await expect(page.locator('.progress-item-title')).toHaveText(['older','newer']);await page.reload();await page.getByRole('button',{name:'筛选',exact:true}).click();await expect(page.getByRole('combobox',{name:'任务排序'})).toHaveAttribute('data-value','oldest');
});

test('assets show update ordering rather than server array ordering',async({page})=>{
 const row=(id:string,date:string)=>({id,title:id,kind:'document',owner:{agentId:null},accessPolicy:{mode:'owner'},availability:'managed_local',source:'manual',versionOrdinal:1,updatedAt:date});
 await page.route('**/api/v2/assets',route=>route.fulfill({json:[row('older asset','2026-10-01T10:00:00Z'),row('newer asset','2026-10-07T10:00:00Z')]}));
 await page.goto('/assets');await expect(page.locator('.library-resource-row strong')).toHaveText(['newer asset','older asset']);await expect(page.locator('.library-resource-row time').nth(0)).toHaveAttribute('dateTime','2026-10-07T10:00:00Z');await expect(page.locator('.library-resource-row time').nth(1)).toHaveAttribute('dateTime','2026-10-01T10:00:00Z');await expect(page.locator('.library-resource-row time').first()).toHaveText(new Date('2026-10-07T10:00:00Z').toLocaleDateString('zh-CN',{month:'short',day:'numeric'}));
});

test('projects open settings directly and edits save without a global save action',async({page,request})=>{
 const {config,revision}=await(await request.get('/api/config')).json();
 await request.put('/api/config',{data:{revision,config:{...config,projects:[...config.projects,{id:'overview-project',name:'Overview project',cwd:'',resources:[],agentIds:[],mcp:[],skills:[]}]}}});
 await page.goto('/projects/manage?project=overview-project');await expect(page.getByRole('tab',{name:'背景',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.getByRole('button',{name:'保存配置',exact:true})).toHaveCount(0);
 await openProjectBackground(page);await page.getByRole('textbox',{name:'项目背景',exact:true}).fill('Autosaved project background');
 await expect.poll(async()=>(await(await request.get('/api/config')).json()).config.projects.find((p:any)=>p.id==='overview-project').background).toBe('Autosaved project background');
 await page.reload();await openProjectBackground(page);await expect(page.getByRole('textbox',{name:'项目背景',exact:true})).toHaveValue('Autosaved project background');
});

test('autosave keeps edits made during an in-flight save and leaves inputs enabled',async({page,request})=>{
 const current=await(await request.get('/api/config')).json();await request.put('/api/config',{data:{revision:current.revision,config:{...current.config,agents:[{id:'autosave-agent',name:'Autosave agent',defaultCli:'codex',models:{},instructions:'',mcp:[],skills:[]}]}}});
 await page.goto('/agents?agent=autosave-agent');await editAgentProfile(page);const field=page.getByRole('textbox',{name:'职责与指令',exact:true});await expect(field).toBeVisible();
 let entered!:()=>void,release!:()=>void;const enteredGate=new Promise<void>(r=>entered=r),saveGate=new Promise<void>(r=>release=r);
 await page.route('**/api/config',async route=>{if(route.request().method()==='PUT'){entered();await saveGate;await route.continue();}else await route.continue();},{times:1});
 await field.fill('First edit');await enteredGate;await expect(field).toBeEnabled();await field.fill('Later edit');release();
 await expect.poll(async()=>(await(await request.get('/api/config')).json()).config.agents[0].instructions).toBe('Later edit');await expect(field).toHaveValue('Later edit');
});

test('loading tasks uses a skeleton and never claims an empty list before the response',async({page})=>{
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>started=r);await page.route('**/api/v2/tasks',async route=>{started();await gate;await route.fulfill({json:[]});});
 await page.route('**/api/conversation-progress?*',route=>route.fulfill({json:[]}));const progress=page.waitForResponse(response=>response.url().includes('/api/conversation-progress?'));
 await page.goto('/tasks');await entered;await (await progress).finished();
 try{await expect(page.locator('.conversation-progress .ui-loading')).toBeVisible();await expect(page.locator('.progress-empty')).toHaveCount(0);}finally{release();}
 await expect(page.locator('.progress-empty')).toBeVisible();
});

test('a failed initial task load shows an error instead of empty work and recovers on refresh',async({page})=>{
 let fail=true;await page.route('**/api/v2/tasks',route=>fail?route.fulfill({status:503,json:{error:'Task list unavailable'}}):route.fulfill({json:[]}));
 await page.route('**/api/conversation-progress?*',route=>route.fulfill({json:[]}));await page.goto('/tasks');
 await expect(page.getByRole('alert')).toContainText('Task list unavailable');await expect(page.locator('.progress-empty')).toHaveCount(0);
 fail=false;await expect(page.locator('.progress-empty')).toBeVisible();await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a background task refresh failure preserves visible work and later clears the error',async({page})=>{
 const task={id:'retained-task',goal:'Retained during refresh failure',state:'todo',waitingReason:null,createdAt:new Date().toISOString(),criteria:[],revision:1,assigneeAgentId:null,projectId:null};
 let fail=false;await page.route('**/api/v2/tasks',route=>fail?route.fulfill({status:503,json:{error:'Task refresh unavailable'}}):route.fulfill({json:[task]}));
 await page.route('**/api/conversation-progress?*',route=>route.fulfill({json:[]}));await page.goto('/tasks');
 const card=page.locator('[data-task-id="retained-task"]');await expect(card).toBeVisible();fail=true;
 await expect(page.getByRole('alert')).toContainText('Task refresh unavailable');await expect(card).toBeVisible();await expect(page.locator('.progress-empty')).toHaveCount(0);await expect(page.locator('.conversation-progress .ui-loading')).toHaveCount(0);
 fail=false;await expect(page.getByRole('alert')).toHaveCount(0);await expect(card).toBeVisible();
});

test('conversation-only progress can resolve while the unrelated task list is pending',async({page})=>{
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);await page.route('**/api/v2/tasks',async route=>{await gate;await route.fulfill({json:[]});});
 await page.route('**/api/conversation-progress?*',route=>route.fulfill({json:[]}));await page.goto('/tasks?type=conversations');
 try{await expect(page.locator('.progress-empty')).toBeVisible();await expect(page.locator('.conversation-progress .ui-loading')).toHaveCount(0);}finally{release();}
});

test('memory keeps sorting in advanced filters and puts generation help last',async({page})=>{
 await page.route('**/api/v2/memory/records?*',route=>route.fulfill({json:{records:[],collections:[]}}));await page.route('**/api/v2/memory/jobs',route=>route.fulfill({json:[]}));
 await page.goto('/mana?tab=memory');await expect(page.locator('.memory-overview-card')).toHaveCount(3);await page.getByText('高级筛选',{exact:true}).click();await expect(page.getByRole('combobox',{name:'记忆排序'})).toHaveAttribute('data-value','newest');
 expect(await page.locator('.memory-explanation').evaluate(node=>node===document.querySelector('.memory-workspace')?.lastElementChild)).toBe(true);
});

test('memory records become usable while background job metadata is still loading',async({page})=>{
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 await page.route('**/api/v2/memory/records?*',route=>route.fulfill({json:{records:[{recordId:'fast-record',collectionId:'personal',revision:1,layer:'L1',text:'Visible without waiting for jobs',status:'active',verification:'evidence_extract',evidence:[],extractedAt:'2026-10-07T10:00:00Z'}],collections:[]}}));
 await page.route('**/api/v2/memory/jobs',async route=>{await gate;await route.fulfill({json:[]});});
 await page.goto('/mana?tab=memory');try{await expect(page.locator('[data-record-id="fast-record"]')).toBeVisible({timeout:2000});}finally{release();}
});

test('configuration conflicts preserve the draft and never overwrite external changes',async({page,request})=>{
 const current=await(await request.get('/api/config')).json();await request.put('/api/config',{data:{revision:current.revision,config:{...current.config,agents:[{id:'conflict-agent',name:'Conflict agent',defaultCli:'codex',models:{},instructions:'',mcp:[],skills:[]}]}}});
 await page.goto('/agents?agent=conflict-agent');await editAgentProfile(page);const field=page.getByRole('textbox',{name:'职责与指令',exact:true});await expect(field).toBeVisible();
 const external=await(await request.get('/api/config')).json();external.config.agents[0].instructions='External edit';await request.put('/api/config',{data:external});
 await field.fill('My local edit');await expect(page.locator('.settings-save-error')).toContainText('当前输入仍保留');await expect(field).toHaveValue('My local edit');
 expect((await(await request.get('/api/config')).json()).config.agents[0].instructions).toBe('External edit');await page.getByRole('button',{name:'重新读取配置',exact:true}).click();await expect(field).toHaveValue('External edit');
});

test('failed autosave retains input, waits for explicit retry and persists after retry',async({page,request})=>{
 const current=await(await request.get('/api/config')).json();await request.put('/api/config',{data:{revision:current.revision,config:{...current.config,agents:[{id:'retry-agent',name:'Retry agent',defaultCli:'codex',models:{},instructions:'Original instructions',mcp:[],skills:[]}]}}});
 await page.goto('/agents?agent=retry-agent');await editAgentProfile(page);const field=page.getByRole('textbox',{name:'职责与指令',exact:true});await expect(field).toBeVisible();
 let writes=0;await page.route('**/api/config',async route=>{if(route.request().method()==='PUT'){writes++;if(writes===1)return route.fulfill({status:500,json:{error:'Synthetic save failure'}});}await route.continue();});
 await field.fill('Retained after failure');await expect(page.locator('.settings-save-error')).toContainText('Synthetic save failure');await expect(field).toHaveValue('Retained after failure');
 expect((await(await request.get('/api/config')).json()).config.agents[0].instructions).toBe('Original instructions');expect(writes).toBe(1);
 await page.getByRole('button',{name:'重试自动保存',exact:true}).click();await expect.poll(async()=>(await(await request.get('/api/config')).json()).config.agents[0].instructions).toBe('Retained after failure');expect(writes).toBe(2);
});

test('settings become editable without waiting for unrelated conversations and task activity',async({page,request})=>{
 const current=await(await request.get('/api/config')).json();await request.put('/api/config',{data:{revision:current.revision,config:{...current.config,agents:[{id:'fast-agent',name:'Fast agent',defaultCli:'codex',models:{},instructions:'Editable immediately',mcp:[],skills:[]}]}}});
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 for(const pattern of [/\/api\/conversations(?:\?.*)?$/,'**/api/tasks?view=control'])await page.route(pattern,async route=>{await gate;await route.continue();});
 await page.goto('/agents?agent=fast-agent');await editAgentProfile(page);try{await expect(page.getByRole('textbox',{name:'职责与指令',exact:true})).toHaveValue('Editable immediately',{timeout:2000});}finally{release();}
});

test('leaving settings during the debounce still saves the edit without a confirmation dialog',async({page,request})=>{
 const current=await(await request.get('/api/config')).json();await request.put('/api/config',{data:{revision:current.revision,config:{...current.config,agents:[{id:'leave-agent',name:'Leave agent',defaultCli:'codex',models:{},instructions:'Original',mcp:[],skills:[]}]}}});
 await page.goto('/agents?agent=leave-agent');await editAgentProfile(page);const field=page.getByRole('textbox',{name:'职责与指令',exact:true});await expect(field).toBeVisible();
 let dialogs=0;page.on('dialog',async dialog=>{dialogs++;await dialog.dismiss();});await field.fill('Saved while leaving');await page.locator('nav[aria-label="主导航"]').getByRole('link',{name:'任务',exact:true}).click();await expect(page).toHaveURL(/\/tasks$/);
 await expect.poll(async()=>(await(await request.get('/api/config')).json()).config.agents[0].instructions).toBe('Saved while leaving');expect(dialogs).toBe(0);
});

test('project materials show loading until bindings resolve, then show a genuine empty state',async({page,request})=>{
 const current=await(await request.get('/api/config')).json();await request.put('/api/config',{data:{revision:current.revision,config:{...current.config,projects:[{id:'loading-materials',name:'Loading materials',cwd:'',agentIds:[],resources:[],mcp:[],skills:[]}]}}});
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);await page.route('**/api/v2/assets/bindings?*',async route=>{await gate;await route.fulfill({json:[]});});
 await page.goto('/projects/loading-materials/library');try{await expect(page.getByRole('region',{name:'项目资料库',exact:true}).locator('.ui-loading')).toBeVisible();await expect(page.getByText('尚无关联资料或项目交付物。',{exact:true})).toHaveCount(0);}finally{release();}
 await expect(page.getByText('尚无关联资料或项目交付物。',{exact:true})).toBeVisible();
});

test('a late project material response cannot replace the newly selected project',async({page,request})=>{
 const current=await(await request.get('/api/config')).json();await request.put('/api/config',{data:{revision:current.revision,config:{...current.config,projects:['a','b'].map(id=>({id:'material-'+id,name:'Material project '+id,cwd:'',agentIds:[],resources:[],mcp:[],skills:[]}))}}});
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>started=r);
 await page.route('**/api/v2/assets/bindings?*',async route=>{const owner=new URL(route.request().url()).searchParams.get('ownerId');if(owner==='material-a'){started();await gate;}await route.fulfill({json:[{ownerType:'project',ownerId:owner,assetId:owner,versionPolicy:'latest'}]});});
 await page.route('**/api/v2/assets?*',route=>{const id=new URL(route.request().url()).searchParams.get('ownerId');return route.fulfill({json:[{id,title:'Document '+id,kind:'document',headVersionId:null,revision:1,owner:{userId:'local'},accessPolicy:{mode:'owner'},availability:'unpublished',source:'manual'}]});});
 await page.goto('/projects/material-a/library');await entered;await openProject(page,'material-b');await page.getByRole('navigation',{name:'项目导航',exact:true}).getByRole('link',{name:'资料库',exact:true}).click();await expect(page.getByRole('region',{name:'项目资料库',exact:true})).toContainText('Document material-b');
 const lateAsset=page.waitForResponse(r=>r.url().includes('/api/v2/assets/bindings?')&&new URL(r.url()).searchParams.get('ownerId')==='material-a');release();await (await lateAsset).finished();await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));await expect(page.getByRole('region',{name:'项目资料库',exact:true})).not.toContainText('Document material-a');await expect(page.getByRole('region',{name:'项目资料库',exact:true})).toContainText('Document material-b');
});


test('leaving a failed autosave does not silently retry the failed write',async({page,request})=>{
 const current=await(await request.get('/api/config')).json();await request.put('/api/config',{data:{revision:current.revision,config:{...current.config,system:{...current.config.system,cli:'codex',memory:{...current.config.system?.memory,language:'zh-CN'}},agents:[{id:'failed-leave-agent',name:'Failed leave agent',defaultCli:'codex',models:{},instructions:'Original',mcp:[],skills:[]}]}}});
 let writes=0;await page.route('**/api/config',async route=>{if(route.request().method()==='PUT'){writes++;return route.fulfill({status:500,json:{error:'Synthetic save failure'}});}await route.continue();});
 await page.goto('/agents?agent=failed-leave-agent');await editAgentProfile(page);await page.getByRole('textbox',{name:'职责与指令',exact:true}).fill('Keep failed draft');await expect(page.locator('.settings-save-error')).toContainText('Synthetic save failure');
 await page.locator('nav[aria-label="主导航"]').getByRole('link',{name:'任务',exact:true}).click();await expect(page).toHaveURL(/\/tasks$/);await expect(page.getByRole('button',{name:'新建任务',exact:true})).toBeVisible();
 await page.locator('nav[aria-label="主导航"]').getByRole('link',{name:'智能体',exact:true}).click();await pickDirectoryAgent(page,'failed-leave-agent');await expect(page.getByRole('textbox',{name:'职责与指令',exact:true})).toHaveValue('Keep failed draft');expect(writes).toBe(1);
});
