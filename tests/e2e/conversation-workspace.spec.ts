import { openChatContext } from './helpers/navigation';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

async function fixture(request: APIRequestContext) {
 const suffix=crypto.randomUUID(),projectId='inspect-project-'+suffix,agentId='inspect-agent-'+suffix;
 const {config,revision}=await(await request.get('/api/config')).json();
 expect((await request.put('/api/config',{data:{revision,config:{...config,
  projects:[...config.projects,{id:projectId,name:'Inspector project',cwd:'/tmp',agentIds:[agentId],resources:[],mcp:[],skills:[]}],
  agents:[...config.agents,{id:agentId,name:'Inspector agent',instructions:'Read only inspector',defaultCli:'codex',models:{},mcp:[],skills:[]}],
 }}})).ok()).toBe(true);
 const conversation=await(await request.post('/api/conversations',{data:{projectId,agentId,workspaceId:null}})).json();
 return {projectId,agentId,conversation};
}

async function openPanel(page: Page, f: Awaited<ReturnType<typeof fixture>>, language='zh-CN') {
 await page.addInitScript(value=>localStorage.setItem('mana-language',value),language);
 await page.goto('/?conversation='+f.conversation.id+'&project='+f.projectId);
 await page.getByRole('button',{name:language==='en'?'Expand right sidebar':'展开右侧栏',exact:true}).click();
 return page.locator('#chat-environment-panel');
}

async function workspaceRoutes(page:Page,id:string) {
 await page.route('**/api/conversations/'+id+'/workspace{,?*}',route=>route.fulfill({json:{cwd:'/tmp/inspector-fixture',git:true,truncated:false,files:[
  {path:'src/example.ts',status:' M'},{path:'notes/new.md',status:'??'},{path:'removed.ts',status:' D'},
 ]}}));
 await page.route('**/api/conversations/'+id+'/workspace-file',route=>{
  const path=route.request().postDataJSON().path;
  return route.fulfill({json:{name:path.split('/').at(-1),path,text:path==='removed.ts'?'':'export const answer = 42;',language:'typescript',diff:path==='removed.ts'?'--- a/removed.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old value':path==='notes/new.md'?'--- /dev/null\n+++ b/notes/new.md\n@@ -0,0 +1 @@\n+New document':'--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old value\n+export const answer = 42;'}});
 });
}

test('Context popover summarizes tasks, fixed documents and memory delivery in both themes and a narrow window',async({page,request})=>{
 const f=await fixture(request),summary={tasks:[{id:'linked',goal:'验收数据链路诊断结果',state:'review'}],documents:[{assetId:'report',versionId:'fixed',title:'数据链路诊断报告',ordinal:2,relations:['output']}],memories:[{recordId:'provided',revision:2,suppliedRevision:1,text:'排查数据链路时使用 Archify 说明流程，保留关键来源与排查结论。',relation:'provided'},{recordId:'generated',revision:1,text:'本项目需要持续维护路线图；完成验收后更新验证状态，保留原有规划。',relation:'generated'},{recordId:'available',revision:1,text:'当前智能体已有的长期约定',relation:'available'}],truncated:false};
 await page.route('**/api/conversations/'+f.conversation.id+'/reference-summary',route=>route.fulfill({json:summary}));
 await page.addInitScript(()=>localStorage.setItem('mana-language','zh-CN'));await page.goto('/?conversation='+f.conversation.id+'&project='+f.projectId);const draft=page.getByRole('textbox',{name:'消息',exact:true});await draft.fill('Keep the summary review draft');
 const context=await openChatContext(page);
 await expect(context.getByRole('link',{name:/验收数据链路诊断结果/})).toHaveAttribute('href','/tasks/linked');
 await expect(context.getByRole('link',{name:/排查数据链路时使用 Archify/})).toHaveAttribute('href','/mana?recordId=provided');
 await expect(context.getByRole('link',{name:/排查数据链路时使用 Archify/})).toContainText('已提供');await expect(context).toContainText('本次生成');
 await expect(context.getByRole('link',{name:/当前智能体已有的长期约定/})).toContainText('尚未提供');
 await expect(context.getByRole('button',{name:/数据链路诊断报告/})).toContainText('产出 v2');
 mkdirSync('/tmp/mandala-reference-visual',{recursive:true});
 for(const theme of ['light','dark']){await page.evaluate(value=>{document.documentElement.dataset.theme=value;},theme);await page.screenshot({path:'/tmp/mandala-reference-visual/reference-'+theme+'.png',fullPage:true});}
 await page.setViewportSize({width:390,height:850});await page.screenshot({path:'/tmp/mandala-reference-visual/reference-narrow.png',fullPage:true});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.keyboard.press('Escape');await expect(context).toBeHidden();await expect(draft).toHaveValue('Keep the summary review draft');
});

for (const width of [1280, 390]) test('has one right sidebar control at the workspace edge at '+width+'px', async ({page,request}) => {
 const f=await fixture(request);await page.setViewportSize({width,height:850});
 await page.goto('/?conversation='+f.conversation.id+'&project='+f.projectId);
 const trigger=page.getByRole('button',{name:'展开右侧栏',exact:true});
 await expect(trigger).toBeVisible();
 const bounds=await trigger.boundingBox(),main=await page.locator('.workspace-main').boundingBox();
 expect(main!.x+main!.width-bounds!.x-bounds!.width).toBeLessThanOrEqual(24);
 expect(bounds!.y).toBeLessThanOrEqual(24);
 const engine=await page.getByRole('button',{name:'执行端状态',exact:true}).boundingBox();
 expect(engine!.x+engine!.width).toBeLessThanOrEqual(bounds!.x);
 const draft=page.getByRole('textbox',{name:'消息',exact:true});await draft.fill('Unsent sidebar draft');
 await trigger.click();
 await expect(trigger).not.toBeVisible();
 const close=page.getByRole('button',{name:'收起右侧栏',exact:true});await expect(close).toHaveCount(1);
 await close.click();await expect(trigger).toBeFocused();await expect(draft).toHaveValue('Unsent sidebar draft');
 await trigger.click();await page.keyboard.press('Escape');await expect(trigger).toBeFocused();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('reads files and workspace Git changes in the right pane without losing the chat draft',async({page,request})=>{
 const f=await fixture(request);await workspaceRoutes(page,f.conversation.id);
 let assetLoads=0,workspaceLoads=0;
 page.on('request',req=>{if(req.url().includes('/api/v2/assets'))assetLoads++;if(req.url().endsWith('/workspace'))workspaceLoads++;});
 const panel=await openPanel(page,f);
 const draft=page.getByRole('textbox',{name:'消息',exact:true});await draft.fill('Keep this unsent draft');
 await panel.getByRole('tab',{name:'文件',exact:true}).click();
 await panel.getByRole('searchbox',{name:'筛选文件',exact:true}).fill('example');
 await expect(panel.getByRole('button',{name:'notes/new.md',exact:true})).toHaveCount(0);
 await panel.getByRole('searchbox',{name:'筛选文件',exact:true}).fill('');
 await expect(panel.locator('summary[aria-label="src"]')).toBeVisible();if (await panel.locator('summary[aria-label="src"]').locator('..').getAttribute('open') === null) await panel.locator('summary[aria-label="src"]').click();await panel.getByRole('button',{name:'src/example.ts',exact:true}).click();
 await expect(panel.getByRole('tabpanel')).toContainText('export const answer = 42;');
 const url=page.url();await panel.getByRole('tab',{name:'改动',exact:true}).click();
 await expect(panel.getByRole('combobox',{name:'改动范围',exact:true})).toHaveAttribute('data-value','all');
 await panel.getByRole('button',{name:'removed.ts',exact:true}).click();
 await expect(panel.getByRole('tabpanel')).toContainText('old value');
 await panel.getByRole('button',{name:'返回改动',exact:true}).click();
 await panel.locator('summary[aria-label="未跟踪文件"]').click();
 await panel.locator('summary[aria-label="notes"]').click();await panel.getByRole('button',{name:'notes/new.md',exact:true}).click();
 await expect(panel.getByRole('tabpanel')).toContainText('New document');
 await expect(panel.getByRole('tabpanel')).not.toContainText('本轮改动');
 expect(assetLoads).toBe(0);expect(workspaceLoads).toBe(1);
 await expect(draft).toHaveValue('Keep this unsent draft');await expect(page).toHaveURL(url);
});

test('only exposes a document after acknowledged context, opens its fixed version and downloads that version without leaving chat',async({page,request})=>{
 const f=await fixture(request);await workspaceRoutes(page,f.conversation.id);
 const stage=await(await request.post('/api/v2/assets/uploads?name=report.md',{data:'# Pinned original\nOriginal fixed body'})).json();
 const imported=await(await request.post('/api/v2/assets/imports',{headers:{'Idempotency-Key':'inspector-'+f.projectId},data:{kind:'document',title:'Pinned inspector report',submissionId:stage.submissionId}})).json();
 expect((await request.post('/api/v2/assets/'+imported.asset.id+'/bindings',{data:{ownerType:'project',ownerId:f.projectId,versionPolicy:'pinned',versionId:imported.version.id}})).ok()).toBe(true);
 expect((await request.put('/api/v2/assets/'+imported.asset.id+'/access',{data:{policy:{mode:'all'},expectedRevision:imported.asset.revision}})).ok()).toBe(true);
 const newerStage=await(await request.post('/api/v2/assets/uploads?name=report.md',{data:'Newer head must not appear'})).json();
 expect((await request.post('/api/v2/assets/'+imported.asset.id+'/versions',{headers:{'Idempotency-Key':'newer-'+f.projectId},data:{expectedHeadVersionId:imported.version.id,submissionId:newerStage.submissionId,provenance:{sourceVersions:[]}}})).ok()).toBe(true);
 const panel=await openPanel(page,f),draft=page.getByRole('textbox',{name:'消息',exact:true});await draft.fill('Still discussing this document');
 const url=page.url();await expect((await openChatContext(page)).getByRole('button',{name:/Pinned inspector report/})).toHaveCount(0);await page.keyboard.press('Escape');
 expect((await request.post('/api/conversations/'+f.conversation.id+'/messages',{data:{text:'Read the pinned document'}})).ok()).toBe(true);
 await expect.poll(async()=> (await (await request.get('/api/conversations/'+f.conversation.id+'/reference-summary')).json()).documents).toEqual(expect.arrayContaining([expect.objectContaining({assetId:imported.asset.id,versionId:imported.version.id})]));
 await (await openChatContext(page)).getByRole('button',{name:/Pinned inspector report/}).click();
 await expect(panel.getByRole('tabpanel')).toContainText('Original fixed body');await expect(panel).not.toContainText('Newer head must not appear');await expect(panel).toContainText('固定版本 · v1');
 const link=panel.getByRole('link',{name:'下载固定版本',exact:true});await expect(link).toHaveAttribute('href','/api/v2/assets/'+imported.asset.id+'/versions/'+imported.version.id+'/files/0');
 const downloaded=page.waitForEvent('download');await link.click();expect((await downloaded).suggestedFilename()).toBe('report.md');
 await expect(page).toHaveURL(url);await expect(draft).toHaveValue('Still discussing this document');
 await panel.getByRole('tab',{name:'能力',exact:true}).click();
 await page.getByRole('button',{name:'收起右侧栏',exact:true}).click();
 await page.getByRole('button',{name:'展开右侧栏',exact:true}).click();
 await expect(panel.getByRole('tab',{name:'能力',exact:true})).toHaveAttribute('aria-selected','true');
 await panel.getByRole('tab',{name:'文件',exact:true}).click();await expect(panel.getByRole('tab',{name:'文件',exact:true})).toHaveAttribute('aria-selected','true');
});

test('discards a late file response after the reader switches files',async({page,request})=>{
 const f=await fixture(request);await workspaceRoutes(page,f.conversation.id);
 let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
 let started!:()=>void;const requested=new Promise<void>(resolve=>{started=resolve;});
 let complete!:()=>void;const completed=new Promise<void>(resolve=>{complete=resolve;});
 await page.route('**/api/conversations/'+f.conversation.id+'/workspace-file',async route=>{
  const path=route.request().postDataJSON().path;
  if(path==='src/example.ts'){started();await held;await route.fulfill({json:{name:'example.ts',path,text:'STALE PRIVATE BODY',diff:null}}).catch(()=>{});complete();}
  else await route.fulfill({json:{name:'new.md',path,text:'Current selected file',diff:null}});
 });
 const panel=await openPanel(page,f);await panel.getByRole('tab',{name:'文件',exact:true}).click();await expect(panel.locator('summary[aria-label="src"]')).toBeVisible();if (await panel.locator('summary[aria-label="src"]').locator('..').getAttribute('open') === null) await panel.locator('summary[aria-label="src"]').click();await panel.getByRole('button',{name:'src/example.ts',exact:true}).click();await requested;
 await panel.getByRole('button',{name:'返回文件',exact:true}).click();
 await panel.locator('summary[aria-label="notes"]').click();await panel.getByRole('button',{name:'notes/new.md',exact:true}).click();await expect(panel).toContainText('Current selected file');release();
 await completed;await expect(panel).toContainText('Current selected file');await expect(panel).not.toContainText('STALE PRIVATE BODY');
});

test('clears private file content before switching to another conversation',async({page,request})=>{
 const f=await fixture(request),other=await(await request.post('/api/conversations',{data:{projectId:f.projectId,agentId:f.agentId,workspaceId:null}})).json();
 expect((await request.patch('/api/conversations/'+other.id,{data:{title:'Another inspector conversation'}})).ok()).toBe(true);
 await workspaceRoutes(page,f.conversation.id);
 await page.route('**/api/conversations/'+other.id+'/workspace{,?*}',route=>route.fulfill({json:{cwd:'/tmp/other-inspector',git:false,files:[],truncated:false}}));
 const panel=await openPanel(page,f);await panel.getByRole('tab',{name:'文件',exact:true}).click();await expect(panel.locator('summary[aria-label="src"]')).toBeVisible();if (await panel.locator('summary[aria-label="src"]').locator('..').getAttribute('open') === null) await panel.locator('summary[aria-label="src"]').click();await panel.getByRole('button',{name:'src/example.ts',exact:true}).click();await expect(panel).toContainText('export const answer = 42;');
 await page.locator('.conversation-library').getByRole('button',{name:'Another inspector conversation',exact:true}).click();
 if(!await panel.isVisible())await page.getByRole('button',{name:'展开右侧栏',exact:true}).click();
 await panel.getByRole('tab',{name:'文件',exact:true}).click();await expect(panel).toContainText('暂无可查看的文件');await expect(panel).not.toContainText('export const answer = 42;');
});

for(const language of ['zh-CN','en'])test('right pane stays within 390px and reports errors in '+language,async({page,request})=>{
 const f=await fixture(request);await page.setViewportSize({width:390,height:844});
 await page.route('**/api/conversations/'+f.conversation.id+'/workspace{,?*}',route=>route.fulfill({status:403,json:{error:'Synthetic file access denied'}}));
 const panel=await openPanel(page,f,language);await panel.getByRole('tab',{name:language==='en'?'Files':'文件',exact:true}).click();await expect(panel.getByRole('alert')).toContainText('Synthetic file access denied');
 expect(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await expect(panel.getByRole('tab')).toHaveText(language==='en'?['Capabilities','Files','Changes','Terminal']:['能力','文件','改动','终端']);
 await page.keyboard.press('Escape');await expect(panel).not.toBeVisible();await expect(page.getByRole('button',{name:language==='en'?'Expand right sidebar':'展开右侧栏',exact:true})).toBeFocused();
});

test('reuses loaded workspace views across tabs and refreshes explicitly',async({page,request})=>{
 const f=await fixture(request);await workspaceRoutes(page,f.conversation.id);
 let files=0,changes=0;
 page.on('request',req=>{if(req.url().endsWith('/workspace'))files++;if(req.url().includes('/workspace?scope=all'))changes++;});
 const panel=await openPanel(page,f);
 await panel.getByRole('tab',{name:'文件',exact:true}).click();
 await expect(panel.getByRole('searchbox',{name:'筛选文件',exact:true})).toBeVisible();
 await panel.getByRole('tab',{name:'改动',exact:true}).click();
 await expect(panel.getByRole('combobox',{name:'改动范围',exact:true})).toBeVisible();
 await expect(panel.getByRole('searchbox',{name:'筛选文件',exact:true})).toBeVisible();
 await panel.getByRole('tab',{name:'文件',exact:true}).click();
 await expect(panel.getByRole('searchbox',{name:'筛选文件',exact:true})).toBeVisible();
 expect(files).toBe(1);expect(changes).toBe(1);
 await panel.getByRole('button',{name:'刷新',exact:true}).click();
 await expect.poll(()=>files).toBe(2);
});

test('does not restore cached workspace paths after a denied view',async({page,request})=>{
 const f=await fixture(request);await workspaceRoutes(page,f.conversation.id);const panel=await openPanel(page,f);
 await panel.getByRole('tab',{name:'文件',exact:true}).click();
 await expect(panel.getByRole('searchbox',{name:'筛选文件',exact:true})).toBeVisible();
 await page.route('**/api/conversations/'+f.conversation.id+'/workspace{,?*}',route=>route.fulfill({status:403,json:{error:'forbidden'}}));
 await panel.getByRole('tab',{name:'改动',exact:true}).click();
 await expect(panel.getByRole('alert')).toBeVisible();
 await panel.getByRole('tab',{name:'文件',exact:true}).click();
 await expect(panel.getByRole('alert')).toBeVisible();
 await expect(panel.locator('.workspace-root-path')).toHaveCount(0);
});

test('invalidates cached tabs without collapsing the active workspace tree on new activity',async({page,request})=>{
 const f=await fixture(request);await workspaceRoutes(page,f.conversation.id);let updated=false,files=0,changes=0;
 await page.addInitScript(()=>{const Native=window.EventSource;window.EventSource=class extends Native{constructor(url:string|URL,options?:EventSourceInit){super(url,options);(window as any).__workspaceStream=this;}};});
 await page.route('**/api/conversations/'+f.conversation.id,route=>route.fulfill({json:{conversation:{...f.conversation,...updated?{updatedAt:'2026-10-20T00:00:00.000Z',title:'Workspace activity updated'}:{}},approvals:[]}}));
 page.on('request',req=>{if(req.url().endsWith('/workspace'))files++;if(req.url().includes('/workspace?scope=all'))changes++;});
 const panel=await openPanel(page,f);
 for(const name of ['文件','改动','文件']){await panel.getByRole('tab',{name,exact:true}).click();await expect(panel.getByRole('searchbox',{name:'筛选文件',exact:true})).toBeVisible();}
 const folder=panel.locator('summary[aria-label="src"]').locator('..');await folder.locator('summary').click();
 const search=panel.getByRole('searchbox',{name:'筛选文件',exact:true});await search.focus();updated=true;
 await page.evaluate(id=>(window as any).__workspaceStream.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:100000,conversationId:id,kind:'metadata',data:{synthetic:true},createdAt:'2026-10-20T00:00:00.000Z'})})),f.conversation.id);
 await expect(page.getByText('Workspace activity updated',{exact:true}).first()).toBeVisible();
 await expect(folder).toHaveAttribute('open','');await expect(search).toBeFocused();expect(files).toBe(1);
 await panel.getByRole('tab',{name:'改动',exact:true}).click();await expect.poll(()=>changes).toBe(2);
 await panel.getByRole('tab',{name:'文件',exact:true}).click();await expect.poll(()=>files).toBe(2);
});

test('keeps open files across tab switches and leaves untracked files out of line totals',async({page,request})=>{
 const f=await fixture(request);await workspaceRoutes(page,f.conversation.id);
 await page.route('**/api/conversations/'+f.conversation.id+'/workspace?scope=all',route=>route.fulfill({json:{cwd:'/tmp/inspector-fixture',git:true,truncated:true,untracked:2400,files:[
  {path:'src/example.ts',status:' M',additions:3,deletions:2},{path:'notes/new.md',status:'??',additions:900,deletions:0},
 ]}}));
 const panel=await openPanel(page,f);
 await panel.getByRole('tab',{name:'文件',exact:true}).click();
 await panel.locator('summary[aria-label="src"]').click();await panel.getByRole('button',{name:'src/example.ts',exact:true}).click();
 await expect(panel.getByRole('tabpanel')).toContainText('export const answer = 42;');
 await panel.getByRole('tab',{name:'改动',exact:true}).click();
 await expect(panel.locator('.change-summary').first()).toContainText('1 个文件');
 await expect(panel.locator('.change-summary').first()).toContainText('+3');
 await expect(panel.locator('.change-summary').first()).not.toContainText('+903');
 await expect(panel.locator('summary[aria-label="未跟踪文件"]')).toContainText('未跟踪 2400 个文件');
 await panel.getByRole('tab',{name:'文件',exact:true}).click();
 await expect(panel.getByRole('tabpanel')).toContainText('export const answer = 42;');
 const tabs=panel.getByRole('group',{name:'打开的文件'});
 await expect(tabs.getByRole('button',{name:'example.ts',exact:true})).toHaveAttribute('aria-pressed','true');
 await tabs.getByRole('button',{name:'文件列表',exact:true}).click();
 await expect(panel.getByRole('searchbox',{name:'筛选文件',exact:true})).toBeVisible();
 await tabs.getByRole('button',{name:'example.ts',exact:true}).click();
 await expect(panel.getByRole('tabpanel')).toContainText('export const answer = 42;');
 await tabs.getByRole('button',{name:'关闭 example.ts',exact:true}).click();
 await expect(panel.getByRole('group',{name:'打开的文件'})).toHaveCount(0);
 await expect(panel.getByRole('searchbox',{name:'筛选文件',exact:true})).toBeVisible();
});

test('context popover shows where the chat works, jumps to changes and titles memories readably',async({page,request})=>{
 const f=await fixture(request);await workspaceRoutes(page,f.conversation.id);
 await page.route('**/api/conversations/'+f.conversation.id+'/environment',route=>route.fulfill({json:{cwd:'/Users/example/Workspace/notes',git:true,branch:'main',changes:{files:41,additions:5777,deletions:4506},worktrees:[{path:'/Users/example/Workspace/notes-fix',branch:'fix-notes',createdHere:true},{path:'/Users/example/Workspace/notes-old',branch:'old-spike',createdHere:false}]}}));
 await page.route('**/api/conversations/'+f.conversation.id+'/reference-summary',route=>route.fulfill({json:{tasks:[{id:'t1',goal:'创建阅读笔记知识库',state:'running'}],documents:[{assetId:'in',versionId:'v',title:'读书笔记分类说明',ordinal:1,relations:['context']},{assetId:'out',versionId:'v',title:'阅读笔记与书目知识库',ordinal:1,relations:['output']}],memories:[{recordId:'m',revision:10,suppliedRevision:6,text:'-----META-START-----\ncreated: 2026-11-01\nsummary: 阅读笔记审核与验证边界\n-----META-END-----\n正文',relation:'available'}],truncated:false}}));
 await page.addInitScript(()=>localStorage.setItem('mana-language','zh-CN'));await page.goto('/?conversation='+f.conversation.id+'&project='+f.projectId);
 const context=await openChatContext(page),place=context.getByRole('region',{name:'工作区'});
 await expect(place).toContainText('notes');await expect(place).toContainText('main');await expect(place).toContainText('+5777');
 await expect(context.getByRole('region',{name:'任务'})).toContainText('创建阅读笔记知识库');
 await expect(context.getByRole('link',{name:/阅读笔记审核与验证边界/})).toBeVisible();await expect(context).not.toContainText('META-START');
 await expect(context.getByRole('button',{name:/阅读笔记与书目知识库/})).toContainText('产出 v1');
 await expect(place).toContainText('fix-notes');await expect(place).not.toContainText('old-spike');
 await place.getByRole('button',{name:/41 个文件/}).click();
 const panel=page.locator('#chat-environment-panel');
 await expect(panel.getByRole('tab',{name:'改动',exact:true})).toHaveAttribute('aria-selected','true');
});
