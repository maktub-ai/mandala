import { createHash } from 'node:crypto';
import { test, expect } from './helpers/execution-fixture';
import { storedUiState } from './helpers/preferences';
import { defaultPreferences } from '../../src/themes';

test.use({storageState:storedUiState('en')});
let sourceId:string,targetId:string,projectId:string,agentId:string;
test.beforeEach(async({request,executionDirectory},info)=>{
 const suffix=info.testId.replace(/[^a-zA-Z0-9]/g,'').slice(-16);projectId='chat-reference-'+suffix;agentId='reader-'+suffix;
 const {config,revision}=await(await request.get('/api/config')).json();
 const saved=await request.put('/api/config',{data:{revision,config:{...config,
  projects:[...config.projects,{id:projectId,name:'Chat reference project',cwd:executionDirectory,agentIds:[agentId],resources:[],mcp:[],skills:[]}],
  agents:[...config.agents,{id:agentId,name:'Reference reader',instructions:'Synthetic chat reference fixture',defaultCli:'codex',models:{},mcp:[],skills:[]}]}}});
 expect(saved.ok(),await saved.text()).toBe(true);
 sourceId=(await(await request.post('/api/conversations',{data:{projectId,agentId,cli:'codex'}})).json()).id;
 targetId=(await(await request.post('/api/conversations',{data:{projectId,agentId,cli:'codex'}})).json()).id;
 expect((await request.patch('/api/conversations/'+sourceId,{data:{title:'Current discussion'}})).ok()).toBe(true);
 expect((await request.patch('/api/conversations/'+targetId,{data:{title:'Earlier discussion'}})).ok()).toBe(true);
});

test('slash keeps commands while conversations stay in the sidebar',async({page})=>{
 const id='chat:'+createHash('sha256').update(JSON.stringify(targetId)).digest('hex');
 await page.route('**/api/conversations/'+sourceId+'/references',route=>route.fulfill({json:{items:[
  {id,kind:'chat',objectId:targetId,name:'Earlier discussion',source:'Chat',detail:targetId,status:'available'},
  {id:'command:'+'a'.repeat(64),kind:'command',name:'task',source:'/task',detail:'Create a task',status:'available'},
 ]}}));
 await page.goto('/?conversation='+sourceId);
 const input=page.getByRole('textbox',{name:'Message',exact:true});await input.fill('/');await input.click();
 const menu=page.getByRole('listbox',{name:'Context and references',exact:true});
 await expect(menu.getByRole('option',{name:/^Create task/})).toBeVisible();
 await expect(menu.getByRole('option',{name:/^Earlier discussion/})).toHaveCount(0);
 await expect(page.locator('[aria-describedby~="library-context-'+targetId+'"]')).toBeVisible();
 const forged=await page.evaluateHandle(()=>{const data=new DataTransfer();data.setData('application/x-mandala-conversation','../../unknown-conversation');return data;});
 await page.locator('.composer').dispatchEvent('drop',{dataTransfer:forged});await forged.dispose();
 await expect(page.locator('.composer-conversation-reference')).toHaveCount(0);await expect(page).toHaveURL('/?conversation='+sourceId);
});

for(const method of ['drag','menu'] as const)test(`${method} adds a conversation card without navigating or sending`,async({page,request},info)=>{
 const readId='chat:'+createHash('sha256').update(JSON.stringify(targetId)).digest('hex');
 const inquiryId='chat:'+createHash('sha256').update(JSON.stringify({id:targetId,intent:'inquiry'})).digest('hex');
 await page.route('**/api/conversations/'+sourceId+'/references',route=>route.fulfill({json:{items:[
  {id:readId,kind:'chat',objectId:targetId,name:'Earlier discussion',source:'Chat',detail:'Reference reader · Chat reference project',status:'available'},
  {id:inquiryId,kind:'chat',intent:'inquiry',objectId:targetId,name:'Earlier discussion',source:'Chat',detail:'Reference reader · Chat reference project',status:'available'},
 ]}}));
 await page.goto('/?conversation='+sourceId);
 const input=page.getByRole('textbox',{name:'Message',exact:true});await input.fill('Please check the earlier decision.');
 const inquirySaved=page.waitForResponse(response=>response.url().includes('/api/drafts/entry')&&response.request().method()==='PUT'&&response.request().postDataJSON().draft.references.some((item:{id:string})=>item.id===inquiryId));
 const row=page.locator('[aria-describedby~="library-context-'+targetId+'"]');
 if(method==='drag')await row.dragTo(page.locator('.composer'));
 else{await row.click({button:'right'});await page.getByRole('menuitem',{name:'Add to current input',exact:true}).click();}
 const card=page.getByRole('group',{name:'Conversation reference · Earlier discussion',exact:true});
 await expect(card).toBeVisible();await expect(card).toContainText('Ask this conversation');
 expect((await inquirySaved).ok()).toBe(true);
 if(method==='drag')for(const [mode,width] of [['light',1280],['dark',1280],['dark',390]] as const){
  await page.evaluate(value=>{localStorage.setItem('mandala-appearance-v1',value);dispatchEvent(new StorageEvent('storage',{key:'mandala-appearance-v1',newValue:value}));},JSON.stringify({...defaultPreferences(),mode}));
  await page.setViewportSize({width,height:850});await expect(card).toBeInViewport({ratio:1});
  await expect(card.getByRole('combobox',{name:'Conversation reference mode',exact:true})).toBeInViewport({ratio:1});
  await expect(card.getByRole('button',{name:'Remove reference Earlier discussion',exact:true})).toBeInViewport({ratio:1});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({animations:'disabled',path:info.outputPath(`conversation-card-${mode}-${width}.png`)});
 }
 await page.setViewportSize({width:1280,height:850});
 await expect(input).toHaveValue('Please check the earlier decision.');await expect(page).toHaveURL('/?conversation='+sourceId);
 for(const id of [sourceId,targetId])expect((await(await request.get('/api/conversations/'+id+'/history')).json()).filter((event:{kind:string})=>event.kind==='user')).toHaveLength(0);
 await page.reload();await expect(card).toBeVisible();await expect(card).toContainText('Ask this conversation');
 await card.getByRole('combobox',{name:'Conversation reference mode',exact:true}).click();
 const referenceSaved=page.waitForResponse(response=>response.url().includes('/api/drafts/entry')&&response.request().method()==='PUT'&&response.request().postDataJSON().draft.references.some((item:{id:string})=>item.id===readId));
 await page.getByRole('option',{name:'Reference content',exact:true}).click();await expect(card).toContainText('Read accessible history when needed');
 expect((await referenceSaved).ok()).toBe(true);
 await expect(card.getByRole('combobox',{name:'Conversation reference mode',exact:true})).toBeFocused();
 await row.dragTo(page.locator('.composer'));await expect(card).toHaveCount(1);await expect(card).toContainText('Reference content');
 await page.reload();await expect(card).toContainText('Reference content');
 await card.getByRole('button',{name:'Remove reference Earlier discussion',exact:true}).click();await expect(card).toHaveCount(0);
 await expect(input).toHaveValue('Please check the earlier decision.');
});
