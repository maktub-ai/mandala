import {createTaskWithExecutions} from './helpers/task-executions';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { openStore } from '../server/store';
import { readConfig } from '../server/config';
import { createSessionManager } from '../server/sessions';
import { createHttpServer } from '../server/http';
import { bindWorkspaceOwner } from '../server/workspace-identity';
import { remoteRequestAllowed } from '../server/remote-policy';
import { DomainError } from '../shared/workspace-contracts';
let home:string,store:ReturnType<typeof openStore>,manager:ReturnType<typeof createSessionManager>,server:ReturnType<typeof createHttpServer>,url:string;
async function start(){store=openStore(home);manager=createSessionManager(store,async()=>(await readConfig(home)).config);server=createHttpServer({requireIdentity:false,home,store,manager});server.listen(0,'127.0.0.1');await once(server,'listening');url='http://127.0.0.1:'+(server.address() as {port:number}).port;}
async function stop(){await manager.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();}
beforeEach(async()=>{home=mkdtempSync(join(tmpdir(),'mandala-drafts-'));await start();});
afterEach(async()=>{vi.restoreAllMocks();await stop();rmSync(home,{recursive:true,force:true});});
const scope={kind:'chat',conversationId:'',projectId:'',agentId:'a'};
const request=(path:string,method='GET',data?:unknown,headers:Record<string,string>={})=>fetch(url+path,{method,headers:{'Content-Type':'application/json',...headers},...(data===undefined?{}:{body:JSON.stringify(data)})});
const get=(scope:unknown,pending=false)=>request('/api/drafts/'+(pending?'pending':'entry')+'?scope='+encodeURIComponent(JSON.stringify(scope)));
const put=(scope:unknown,expectedRevision:number,draft:unknown)=>request('/api/drafts/entry','PUT',{scope,expectedRevision,draft});
const chat=()=>store.createConversation({projectId:'',agentId:'a',cli:'codex',model:null});
const pending=(conversationId:string)=>({conversationId,commandKey:'send-1',action:'queue',body:{text:'Keep submission',attachments:['attachment-1'],references:['skill-1']},recovery:{attempted:true,stopAttempted:false,stopConfirmed:false}});
test('persists bilingual drafts and stable device identity across a different loopback port',async()=>{
 const before=url,meta=await(await request('/api/drafts/meta')).json();
 expect((await put(scope,0,{text:'草稿 🙂',references:[{id:'skill-1'}],attachments:[{name:'资料.txt',size:4,type:'text/plain',lastModified:1}]})).status).toBe(200);
 await stop();await start();expect(url).not.toBe(before);
 expect(await(await request('/api/drafts/meta')).json()).toEqual(meta);
 expect(await(await get(scope)).json()).toMatchObject({revision:1,draft:{text:'草稿 🙂',attachments:[{name:'资料.txt'}]}});
});
test('persists the inquiry intent of a conversation card',async()=>{
 const reference={id:'chat:'+'a'.repeat(64),kind:'chat',objectId:'target',intent:'inquiry',name:'Earlier discussion',source:'Chat',detail:'Reader',status:'available'};
 expect((await put(scope,0,{text:'Ask about the decision',references:[reference]})).status).toBe(200);
 expect(await(await get(scope)).json()).toMatchObject({draft:{references:[reference]}});
});
test.each([{kind:'skill',intent:'inquiry'},{kind:'chat',intent:'execute'},{intent:'inquiry'}])('rejects invalid reference intent %j',async reference=>{
 expect((await put(scope,0,{text:'Draft',references:[{id:'reference',...reference}]})).status).toBe(422);
});
test('uses independent revisions and tombstones; clearing editable text never discards an unknown receipt',async()=>{
 const c=chat(),target={kind:'chat',conversationId:c.id},submission=pending(c.id);
 expect((await put(target,0,{text:'Editable'})).status).toBe(200);
 expect((await request('/api/drafts/pending','PUT',{scope:target,expectedRevision:0,pending:submission})).status).toBe(200);
 expect((await put(target,0,{text:'stale'})).status).toBe(409);
 expect(await(await request('/api/drafts/entry','DELETE',{scope:target,expectedRevision:1})).json()).toMatchObject({revision:2,draft:null});
 expect(await(await get(target,true)).json()).toMatchObject({revision:1,pending:submission});
 expect((await put(target,0,{text:'stale initial'})).status).toBe(409);
 expect((await request('/api/drafts/pending','PUT',{scope:target,expectedRevision:1,pending:{...submission,commandKey:'new-key'}})).status).toBe(409);
 expect((await request('/api/drafts/pending','PUT',{scope:target,expectedRevision:1,pending:{...submission,recovery:{...submission.recovery,stopConfirmed:true}}})).status).toBe(200);
 expect((await request('/api/drafts/pending','DELETE',{scope:target,expectedRevision:1})).status).toBe(409);
});
test('normalizes existing chat identity and keeps new-chat project/Agent combinations separate',async()=>{
 const c=chat();await put({kind:'chat',conversationId:c.id,projectId:'transient',agentId:'loading'},0,{text:'One chat'});
 expect(await(await get({kind:'chat',conversationId:c.id})).json()).toMatchObject({revision:1,draft:{text:'One chat'}});
 await put({...scope,agentId:'first'},0,{text:'First'});await put({...scope,agentId:'second'},0,{text:'Second'});
 expect(await(await get({...scope,agentId:'first'})).json()).toMatchObject({draft:{text:'First'}});
 expect(await(await get({...scope,agentId:'second'})).json()).toMatchObject({draft:{text:'Second'}});
});
test('accepts only associated readable task targets, without guessing a Run destination',async()=>{
 const allowed=chat(),other=chat(),task=createTaskWithExecutions(store,manager.taskService,{userId:store.ownerUserId},{goal:'Task'},[allowed.id],'draft-task');
 const target={kind:'task',taskId:task.id,conversationId:allowed.id};
 expect((await put(target,0,{text:'Scoped'})).status).toBe(200);
 expect((await put({...target,conversationId:other.id},0,{text:'Wrong target'})).status).toBe(403);
 expect((await put({...target,taskId:'missing'},0,{text:'Missing task'})).status).toBe(404);
 expect((await put({...target,conversationId:''},0,{text:'No target selected'})).status).toBe(200);
 const authorize=vi.spyOn(manager,'authorizeConversationRead').mockImplementation(()=>{throw new DomainError('forbidden',403,'No access');});
 expect((await get(target)).status).toBe(403);expect(await(await request('/api/drafts')).json()).toMatchObject({entries:[{draft:{text:'No target selected'}}]});authorize.mockRestore();
});
test('isolates owner rows and transfers only legacy local drafts on first workspace claim',async()=>{
 await put(scope,0,{text:'Legacy local'});const {deviceId}=await(await request('/api/drafts/meta')).json();
 store.database.prepare('INSERT INTO local_composer_drafts VALUES(?,?,?,?,?,?,?)').run('other-owner',deviceId,JSON.stringify(scope),'draft',1,JSON.stringify({text:'Private other owner'}),new Date().toISOString());
 bindWorkspaceOwner(store,'claimed-owner');
 expect(await(await get(scope)).json()).toMatchObject({draft:{text:'Legacy local'}});
 expect(JSON.stringify(await(await request('/api/drafts')).json())).not.toContain('Private other owner');
 expect(store.database.prepare('SELECT owner_user_id FROM local_composer_drafts WHERE data LIKE ?').get('%Legacy local%')).toEqual({owner_user_id:'claimed-owner'});
 expect((await put({...scope,ownerUserId:'other-owner'},0,{text:'forged'})).status).toBe(422);
});
test('bounds UTF8 body content and metadata and rejects unknown shape or pending mismatch',async()=>{
 expect((await put(scope,0,{text:'a'.repeat(300000)})).status).toBe(200);
 expect((await put(scope,1,{text:'中'.repeat(350000)})).status).toBe(422);
 expect((await put(scope,1,{text:'test',attachments:[{name:'file',size:-1,type:'',lastModified:1}]})).status).toBe(422);
 expect((await put(scope,1,{text:'test',fileBytes:'not allowed'})).status).toBe(422);
 const c=chat();expect((await request('/api/drafts/pending','PUT',{scope:{kind:'chat',conversationId:c.id},expectedRevision:0,pending:pending('another-chat')})).status).toBe(422);
 expect((await request('/api/drafts/entry?scope={}&scope={}')).status).toBe(422);
});
test('keeps drafts local-only and denies invocation credentials and foreign origins',async()=>{
 for(const path of ['/api/drafts','/api/drafts/meta','/api/drafts/entry','/api/drafts/pending'])for(const method of ['GET','PUT','DELETE'])expect(remoteRequestAllowed(method,path,{})).toBe(false);
 expect((await request('/api/drafts/meta','GET',undefined,{Authorization:'Bearer invocation-token'})).status).toBe(403);
 expect((await request('/api/drafts/meta','GET',undefined,{Origin:'https://foreign.example'})).status).toBe(403);
});
test('projects only readable associated Chats with explicit Chat Agent and no unrelated execution target',async()=>{
 const readable=chat(),denied=chat(),unrelated=chat();store.renameConversation(readable.id,'Readable target');
 const task=createTaskWithExecutions(store,manager.taskService,{userId:store.ownerUserId},{goal:'Select a Chat'},[readable.id,denied.id],'associated-targets');
 const authorize=manager.authorizeConversationRead.bind(manager);
 vi.spyOn(manager,'authorizeConversationRead').mockImplementation(id=>{if(id===denied.id)throw new DomainError('forbidden',403,'Revoked source');authorize(id);});
 const detail=await(await request('/api/v2/tasks/'+task.id)).json();
 expect(detail.readableAssociatedChats).toEqual([{id:readable.id,title:'Readable target',agentId:readable.agentId,projectId:readable.projectId,cli:readable.cli,status:readable.status,updatedAt:store.getConversation(readable.id)!.updatedAt}]);
 expect(detail.task.conversationIds).toEqual([readable.id]);expect(detail.executions.map((e:any)=>e.conversationId)).toEqual([readable.id]);
 expect(JSON.stringify(detail.readableAssociatedChats)).not.toContain(unrelated.id);
 expect(Object.keys(detail.readableAssociatedChats[0]).sort()).toEqual(['agentId','cli','id','projectId','status','title','updatedAt']);
 expect(await(await request('/api/v2/tasks?conversationId='+denied.id)).json()).toEqual([]);
 const edited=await(await request('/api/v2/tasks/'+task.id,'PATCH',{expectedRevision:task.revision,goal:'Updated readable task'},{'Idempotency-Key':'safe-metadata-edit'})).json();expect(edited.conversationIds).toEqual([readable.id]);expect(edited.executions.map((e:any)=>e.conversationId)).toEqual([readable.id]);
});
test('enforces local authentication before revealing the device identity',async()=>{
 const protectedServer=createHttpServer({home,store,manager});protectedServer.listen(0,'127.0.0.1');await once(protectedServer,'listening');
 try {expect((await fetch('http://127.0.0.1:'+(protectedServer.address() as {port:number}).port+'/api/drafts/meta')).status).toBe(401);}
 finally {protectedServer.closeAllConnections();await new Promise<void>(resolve=>protectedServer.close(()=>resolve()));}
});
test('preserves readback and explicit clearing of unknown submission after a task target is unlinked',async()=>{
 const c=chat(),task=createTaskWithExecutions(store,manager.taskService,{userId:store.ownerUserId},{goal:'Unlink target'},[c.id],'unlink-recovery');
 const target={kind:'task',taskId:task.id,conversationId:c.id},submission=pending(c.id);
 expect((await put(target,0,{text:'Editable text'})).status).toBe(200);
 expect((await request('/api/drafts/pending','PUT',{scope:target,expectedRevision:0,pending:submission})).status).toBe(200);
 manager.taskService.removeExecution({userId:store.ownerUserId},task.id,task.revision,task.executions[0].id,'remove-chat');
 expect((await get(target)).status).toBe(200);
 expect(await(await get(target,true)).json()).toMatchObject({revision:1,pending:submission});
 expect(await(await request('/api/drafts')).json()).toMatchObject({entries:[],pending:[{scope:target,pending:submission}]});
 expect((await put(target,1,{text:'New text to unlinked target'})).status).toBe(403);
 expect((await request('/api/drafts/pending','PUT',{scope:target,expectedRevision:1,pending:submission})).status).toBe(403);
 const authorize=vi.spyOn(manager,'authorizeConversationRead').mockImplementation(()=>{throw new DomainError('forbidden',403,'Chat no longer readable');});
 expect((await get(target,true)).status).toBe(403);
 expect((await request('/api/drafts/pending','DELETE',{scope:target,expectedRevision:1})).status).toBe(403);
 authorize.mockRestore();
 expect(await(await request('/api/drafts/pending','DELETE',{scope:target,expectedRevision:1})).json()).toMatchObject({revision:2,pending:null});
});
test('preserves the established 2000-byte composer reference identity bound in drafts and pending state',async()=>{
 const id='reference:'+'x'.repeat(1990);expect(Buffer.byteLength(id)).toBe(2000);
 expect((await put(scope,0,{text:'Reference draft',references:[{id}]})).status).toBe(200);
 expect((await put(scope,1,{text:'Reference draft',references:[{id:id+'x'}]})).status).toBe(422);
 const c=chat(),target={kind:'chat',conversationId:c.id},submission=pending(c.id);submission.body.references=[id];
 expect((await request('/api/drafts/pending','PUT',{scope:target,expectedRevision:0,pending:submission})).status).toBe(200);
 expect(await(await get(target,true)).json()).toMatchObject({pending:{body:{references:[id]}}});
});

test('pending recovery flags cannot roll back even with the current revision and unchanged command body',async()=>{
 const c=chat(),target={kind:'chat',conversationId:c.id},submission={...pending(c.id),action:'interrupt',recovery:{attempted:true,stopAttempted:true,stopConfirmed:true}};
 expect((await request('/api/drafts/pending','PUT',{scope:target,expectedRevision:0,pending:submission})).status).toBe(200);
 for(const flag of ['attempted','stopAttempted','stopConfirmed']) {
  const response=await request('/api/drafts/pending','PUT',{scope:target,expectedRevision:1,pending:{...submission,recovery:{...submission.recovery,[flag]:false}}});
  expect(response.status).toBe(409);expect(await response.json()).toMatchObject({error:'Submission recovery cannot roll back attempted or confirmed actions'});
 }
 expect(await(await get(target,true)).json()).toMatchObject({revision:1,pending:submission});
 expect((await request('/api/drafts/pending','DELETE',{scope:target,expectedRevision:1})).status).toBe(200);
});
test('atomically hands a new-composer draft to a created Chat without touching recovery',async()=>{
 const c=chat(),target={kind:'chat',conversationId:c.id},draft={text:'Original new Chat input'};
 await put(scope,0,draft);
 const receipt={...pending(c.id),draftFingerprint:'b'.repeat(128)};
 await request('/api/drafts/pending','PUT',{scope:target,expectedRevision:0,pending:receipt});
 const moved=await request('/api/drafts/handoff','POST',{scope,expectedRevision:1,targetConversationId:c.id,targetExpectedRevision:0,draft});
 expect(moved.status).toBe(200);expect(await(await get(scope)).json()).toMatchObject({revision:2,draft:null});expect(await(await get(target)).json()).toMatchObject({revision:1,draft});expect(await(await get(target,true)).json()).toMatchObject({pending:receipt});
 expect((await request('/api/drafts/handoff','POST',{scope,expectedRevision:1,targetConversationId:c.id,targetExpectedRevision:1,draft})).status).toBe(409);
});
test('handoff does not overwrite an existing destination draft or accept remote/Bearer authority',async()=>{
 const c=chat(),target={kind:'chat',conversationId:c.id};await put(scope,0,{text:'Source'});await put(target,0,{text:'Other window'});
 const input={scope,expectedRevision:1,targetConversationId:c.id,targetExpectedRevision:1,draft:{text:'Source'}};
 expect((await request('/api/drafts/handoff','POST',input)).status).toBe(409);expect(await(await get(scope)).json()).toMatchObject({draft:{text:'Source'}});
 expect((await request('/api/drafts/handoff','POST',input,{Authorization:'Bearer invocation'})).status).toBe(403);expect(remoteRequestAllowed('POST','/api/drafts/handoff',input)).toBe(false);
});
test('handoff atomically stores its initial immutable submission recovery before the source disappears',async()=>{
 const c=chat(),target={kind:'chat',conversationId:c.id},draft={text:'New Chat before send'},submission={...pending(c.id),draftFingerprint:'c'.repeat(128),recovery:{attempted:false,stopAttempted:false,stopConfirmed:false}};
 await put(scope,0,draft);
 expect((await request('/api/drafts/handoff','POST',{scope,expectedRevision:1,targetConversationId:c.id,targetExpectedRevision:0,targetPendingExpectedRevision:0,draft,pending:submission})).status).toBe(200);
 expect(await(await get(scope)).json()).toMatchObject({draft:null});expect(await(await get(target,true)).json()).toMatchObject({pending:submission});
});

test('persists new typed object references and exact Unicode message excerpts across draft reload',async()=>{
 const references=[{id:'project:'+'a'.repeat(64),kind:'project',objectId:'p',name:'Project',source:'Project',detail:'Summary',status:'available'},{id:'chat:'+'b'.repeat(64),kind:'chat',objectId:'c',name:'Chat',source:'Chat',detail:'Summary',status:'available'},{id:'message:'+'c'.repeat(400),kind:'message',objectId:'c:12',name:'Selected message',source:'Message',detail:'精确中文。'.repeat(1000),status:'available'}];
 expect((await put(scope,0,{text:'Keep existing draft',references})).status).toBe(200);
 expect(await(await get(scope)).json()).toMatchObject({draft:{text:'Keep existing draft',references}});
});
