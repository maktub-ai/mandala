import { test, expect } from '@playwright/test';
import { openChatContext } from './helpers/navigation';

test('context popover and capabilities tab keep the message and do not mislabel discovery as usage', async ({page,request}) => {
 const {config,revision}=await(await request.get('/api/config')).json();
 const agentId='context-review-'+crypto.randomUUID();
 await request.put('/api/config',{data:{revision,config:{...config,agents:[...config.agents,{id:agentId,name:'Context reviewer',defaultCli:'codex',instructions:'Keep sources',models:{},mcp:[],skills:[]}]}}});
 const conversation=await(await request.post('/api/conversations',{data:{agentId,projectId:'',cwd:'/tmp'}})).json();
 await page.route('**/api/effective?*',route=>route.fulfill({json:{mcp:[{name:'discovered-tool',source:'native',scope:'codex',overridden:[],status:'available'}],skills:[],resources:[]}}));
 await page.route('**/reference-summary',route=>route.fulfill({json:{tasks:[],documents:[],memories:[{recordId:'available',revision:1,text:'Available preference',relation:'available'}],truncated:false}}));
 await page.goto('/?conversation='+conversation.id);
 await page.getByRole('textbox',{name:'消息',exact:true}).fill('Keep this draft');
 const context=await openChatContext(page);
 await expect(context).toContainText('Available preference');await expect(context).toContainText('尚未提供');await expect(context).toContainText('1 个 MCP');
 await context.getByRole('button',{name:/1 个 MCP/}).click();
 const panel=page.locator('#chat-environment-panel');
 await expect(panel.getByRole('tab')).toHaveText(['能力','文件','改动','终端']);
 const before=await panel.boundingBox();
 await expect(panel).toContainText('discovered-tool');
 await expect(panel).toContainText('已发现');
 await expect(panel).not.toContainText('本轮执行记录');
 expect((await panel.boundingBox())!.width).toBe(before!.width);
 await panel.getByRole('tab',{name:'文件',exact:true}).click();await panel.getByRole('tab',{name:'能力',exact:true}).click();
 await page.getByRole('button',{name:'收起右侧栏',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'消息',exact:true})).toHaveValue('Keep this draft');
});

test('file search distinguishes an empty result and lets the user clear the filter',async({page})=>{
 await page.route('**/api/v2/assets',route=>route.fulfill({json:[{id:'document-one',title:'Project brief',kind:'document',owner:{type:'user'},accessPolicy:{mode:'owner'},availability:'managed_local',source:'manual',versionOrdinal:1}]}));
 await page.goto('/assets');
 await page.getByRole('textbox',{name:'搜索文件',exact:true}).fill('missing');
 await expect(page.getByText('没有匹配的文件',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'清除搜索',exact:true}).click();
 await expect(page.getByRole('link',{name:'Project brief',exact:true})).toBeVisible();
});

test('capability filters, expanded results and scroll survive a context round trip',async({page,request})=>{
 const {config}=await(await request.get('/api/config')).json();
 const conversation=await(await request.post('/api/conversations',{data:{agentId:config.agents[0].id,projectId:'',cwd:'/tmp'}})).json();
 await page.route('**/api/effective?*',route=>route.fulfill({json:{mcp:Array.from({length:20},(_,i)=>({name:'review-tool-'+i,source:'native',scope:'codex',overridden:[],status:'available'})),skills:[],resources:[]}}));
 await page.goto('/?conversation='+conversation.id);
 await page.getByRole('button',{name:'展开右侧栏',exact:true}).click();
 await page.getByRole('tab',{name:'能力',exact:true}).click();
 await page.getByRole('button',{name:'搜索能力',exact:true}).click();
 await page.getByRole('searchbox',{name:'能力名称搜索',exact:true}).fill('review-tool');
 await page.getByRole('button',{name:'展开全部',exact:true}).click();
 const capability=page.locator('.chat-capabilities');
 await capability.evaluate(el=>el.scrollTop=240);
 const scroll=await capability.evaluate(el=>el.scrollTop);
 expect(scroll).toBeGreaterThan(0);
 await page.getByRole('tab',{name:'文件',exact:true}).click();
 await page.getByRole('tab',{name:'能力',exact:true}).click();
 await expect(page.getByRole('searchbox',{name:'能力名称搜索',exact:true})).toHaveValue('review-tool');
 await expect(page.getByRole('button',{name:'收起清单',exact:true})).toBeVisible();
 expect(await capability.evaluate(el=>el.scrollTop)).toBe(scroll);
});

for(const language of ['zh-CN','en'])test('runtime label stays readable beside the sidebar in '+language,async({page,request})=>{
 const {config}=await(await request.get('/api/config')).json();
 const conversation=await(await request.post('/api/conversations',{data:{agentId:config.agents[0].id,projectId:'',cwd:'/tmp'}})).json();
 await page.addInitScript(lang=>localStorage.setItem('mana-language',lang),language);
 await page.setViewportSize({width:1440,height:900});
 await page.goto('/?conversation='+conversation.id);
 await page.locator('.content-panel-trigger').click();
 const label=page.getByRole('button',{name:language==='en'?'CLI status':'执行端状态',exact:true});
 await expect(label).toHaveText('Codex');
 expect(await label.evaluate(el=>el.clientWidth>=el.scrollWidth)).toBe(true);
});

test('capabilities insert a skill into the message being written',async({page,request})=>{
 const {config}=await(await request.get('/api/config')).json();
 const conversation=await(await request.post('/api/conversations',{data:{agentId:config.agents[0].id,projectId:'',cwd:'/tmp'}})).json();
 await page.route('**/api/effective?*',route=>route.fulfill({json:{mcp:[{name:'docs-server',source:'agent',scope:'agent',overridden:[],status:'effective'}],skills:[{name:'review-skill',source:'agent',scope:'agent',overridden:[],status:'available'},{name:'native-only',source:'native',scope:'codex',overridden:[],status:'available'}],resources:[]}}));
 await page.route('**/api/conversations/'+conversation.id+'/references',route=>route.fulfill({json:{items:[{id:'skill:review-skill',kind:'skill',name:'review-skill',source:'Agent',detail:'/skills/review-skill',status:'available'}]}}));
 await page.goto('/?conversation='+conversation.id);
 await page.getByRole('button',{name:'展开右侧栏',exact:true}).click();
 await page.getByRole('tab',{name:'能力',exact:true}).click();
 const panel=page.locator('.chat-capabilities');
 await expect(panel.getByRole('button',{name:'Skills 2',exact:true})).toBeVisible();
 await expect(panel.getByRole('button',{name:'插入 native-only',exact:true})).toHaveCount(0);
 await panel.getByRole('button',{name:'MCP 1',exact:true}).click();
 await expect(panel.getByText('review-skill')).toHaveCount(0);
 await panel.getByRole('button',{name:'全部',exact:true}).click();
 await panel.getByRole('button',{name:'插入 review-skill',exact:true}).click();
 await expect(page.locator('.composer-references .composer-reference-tag')).toContainText('review-skill');
});
