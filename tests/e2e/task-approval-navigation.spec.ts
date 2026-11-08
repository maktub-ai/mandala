import {createTaskWithExecutionChats} from './helpers/task-executions';
import {openNotifications} from './helpers/notifications';
import {test,expect} from '@playwright/test';

test('dedicated Task approval is reachable directly from the task and its notification',async({page,request})=>{
 await page.addInitScript(()=>localStorage.setItem('mana-language','en'));
 const {config,revision}=await(await request.get('/api/config')).json(),{directory}=await(await request.post('/__test__/execution-directory')).json();
 const agentId='approval-navigation-agent',projectId='approval-navigation-project';
 await request.put('/api/config',{data:{revision,config:{...config,agents:[...config.agents,{id:agentId,name:'Approval example',defaultCli:'codex',models:{},instructions:'',mcp:[],skills:[]}],projects:[...config.projects,{id:projectId,name:'Approval example',cwd:directory,agentIds:[agentId],resources:[],mcp:[],skills:[]}]}}});
 const source=await(await request.post('/api/conversations',{data:{agentId,projectId}})).json();
 const task=await(await createTaskWithExecutionChats(request,{headers:{'Idempotency-Key':'approval-navigation'},data:{goal:'approval',assigneeAgentId:agentId,projectId}},[source.id])).json();
 const notices=page.waitForResponse(r=>r.url().includes('/api/v2/task-notifications'));
 await page.goto('/tasks/'+task.id);await notices;
 await page.getByRole('button',{name:'Start task',exact:true}).click();
 const detail=async()=>(await(await request.get('/api/v2/tasks/'+task.id)).json());
 await expect.poll(async()=>(await detail()).runs.at(-1)?.state).toBe('approval');
 const run=(await detail()).runs.at(-1),target='/?conversation='+run.routing.executionConversationId;
 expect(run.routing.executionConversationId).not.toBe(source.id);
 expect((await(await request.get('/api/conversations?origin=all')).json()).find((chat:{id:string})=>chat.id===run.routing.executionConversationId)).toMatchObject({origin:'task'});
 expect((await(await request.get('/api/conversations')).json()).some((chat:{id:string})=>chat.id===run.routing.executionConversationId)).toBe(false);
 expect((await(await request.get('/api/conversations?origin=task')).json()).every((chat:{origin:string})=>chat.origin==='task')).toBe(true);expect((await request.get('/api/conversations?origin=invalid')).status()).toBe(422);
 await expect(page.locator('.task-command-bar').getByRole('link',{name:'Review approval',exact:true})).toHaveAttribute('href',target);
 expect(await page.locator('.task-command-bar').getByRole('link',{name:'Review approval',exact:true}).evaluate(el=>{const style=getComputedStyle(el);return style.color!==style.backgroundColor;})).toBe(true);
 await page.locator('.task-execution-process > summary').click();await page.locator('.task-properties-disclosure > summary').click();await expect(page.getByRole('complementary',{name:'Task properties'}).getByRole('link',{name:'Open execution conversation',exact:true})).toHaveAttribute('href',target);
 const notice=page.getByRole('dialog',{name:'Notifications'});
 await page.locator('.task-dialog').getByRole('button',{name:'Close',exact:true}).click();
 await openNotifications(page);await expect(notice.getByRole('link',{name:'Review approval',exact:true})).toHaveAttribute('href',target);
 await notice.getByRole('link',{name:'Review approval',exact:true}).click();
 await expect(page).toHaveURL(new RegExp('conversation='+run.routing.executionConversationId));
 await expect(page.getByRole('button',{name:'Allow once',exact:true})).toBeVisible();
 const library=page.locator('.conversation-library');await expect(library.getByRole('combobox',{name:'Conversation source',exact:true})).toHaveCount(0);
 await expect(library.locator('button[aria-current="page"]')).toHaveCount(1);await page.reload();await expect(library.locator('button[aria-current="page"]')).toHaveAttribute('aria-describedby',new RegExp('library-context-'+run.routing.executionConversationId));
 expect((await(await request.get('/api/conversations/'+run.routing.executionConversationId)).json()).approvals).toHaveLength(1);
 await page.goto('/tasks?view=board');await expect(page.getByRole('region',{name:'Needs attention',exact:true}).locator('[data-task-id="'+task.id+'"]')).toBeVisible();
});

test('mixed progress puts linked conversations under their Task in board and list',async({page,request})=>{
 const {recent,task,running}=await(await request.post('/__test__/progress-fixture')).json();
 for(const view of ['board','list']){
  await page.goto('/tasks?view='+view);
  const parent=page.locator('[data-task-id="'+task+'"]');await expect(parent).toBeVisible();
  await expect(page.locator('[data-conversation-id="'+recent+'"]')).toHaveCount(0);
  await parent.locator('.progress-expand').click();await expect(parent.locator('[data-linked-conversation-id="'+recent+'"]')).toBeVisible();
  await expect(page.locator('[data-conversation-id="'+running+'"]')).toBeVisible();
 }
});
