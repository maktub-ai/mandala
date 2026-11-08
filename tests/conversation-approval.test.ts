import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../server/store';
import { createConversationApprovals } from '../server/conversation-approvals';
import { approvalChoices, nativeApprovalResponse, supportsConversationApproval } from '../shared/approvals';
import type { Approval } from '../shared/types';
const homes:string[]=[],stores:Store[]=[];
afterEach(()=>{stores.splice(0).forEach(s=>s.close());homes.splice(0).forEach(h=>rmSync(h,{recursive:true,force:true}));});
function setup(){const home=mkdtempSync(join(tmpdir(),'conversation-approval-'));homes.push(home);const store=openStore(home);stores.push(store);return {home,store,grants:createConversationApprovals(store)};}
const scope={conversationId:'c',agentId:'a',projectId:'p',cli:'omp' as const,cwd:'/tmp'};
const request=(method:string,params:unknown):Approval=>({id:'a',conversationId:'c',nativeRequestId:1,method,params});
it('persists and revokes grants scoped to the owner, chat, Agent, runtime, Project and directory',()=>{
 const {store,grants}=setup();expect(grants.has(scope)).toBe(false);grants.allow(scope);expect(grants.has(scope)).toBe(true);
 expect(createConversationApprovals(store).has(scope)).toBe(true);
 for(const change of [{conversationId:'other'},{agentId:'b'},{projectId:'other'},{cli:'codex' as const},{cwd:'/'}])expect(grants.has({...scope,...change})).toBe(false);
 grants.revoke('other');expect(grants.has(scope)).toBe(true);grants.revoke('c');expect(grants.has(scope)).toBe(false);
});
it('keeps approval grants scoped to their remote host and normalizes remote paths syntactically',()=>{
 const {store,grants}=setup();
 const remote={...scope,hostId:'build-host',cwd:'/srv/app/../work'};
 grants.allow(remote);
 expect(grants.has({...remote,cwd:'/srv/work'})).toBe(true);
 expect(grants.has({...remote,hostId:'different-host'})).toBe(false);
 expect(grants.has({...remote,hostId:undefined})).toBe(false);
 expect(createConversationApprovals(store).has({...remote,cwd:'/srv/work'})).toBe(true);
 expect(()=>grants.allow({...remote,cwd:'relative/work'})).toThrow();
});
it('migrates existing approval grants as local without granting access on a remote host',()=>{
 const {store}=setup();
 store.database.exec(`DROP TABLE conversation_tool_approvals;
  CREATE TABLE conversation_tool_approvals(owner_user_id TEXT NOT NULL,conversation_id TEXT NOT NULL,agent_id TEXT NOT NULL,project_id TEXT NOT NULL,cli TEXT NOT NULL,cwd TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(owner_user_id,conversation_id));`);
 store.database.prepare('INSERT INTO conversation_tool_approvals VALUES (?,?,?,?,?,?,?)').run(store.ownerUserId,'c','a','p','omp',realpathSync('/tmp'),new Date().toISOString());
 const grants=createConversationApprovals(store);
 expect(grants.has({...scope,hostId:'build-host'})).toBe(false);
 expect(grants.has(scope)).toBe(true);
});
it('an SSH alias named local cannot inherit a local conversation grant',()=>{
 const {home,grants}=setup(),local={...scope,cwd:realpathSync(home)};
 grants.allow(local);
 expect(grants.has({...local,hostId:'local'})).toBe(false);
 grants.allow({...local,hostId:'local'});
 expect(grants.has(local)).toBe(false);
});
it('only permits explicit native tool approvals, never questions, arbitrary confirmations or directory grants',()=>{
 expect(supportsConversationApproval(request('omp/confirm',{toolApproval:true}))).toBe(true);
 for(const a of [request('omp/confirm',{}),request('item/tool/requestUserInput',{}),request('item/commandExecution/requestApproval',{additionalPermissions:{}}),request('item/commandExecution/requestApproval',{networkApprovalContext:{host:'example.com'}}),request('item/commandExecution/requestApproval',{grantRoot:'/tmp'}),request('item/commandExecution/requestApproval',{availableDecisions:['cancel']})])expect(supportsConversationApproval(a)).toBe(false);
});
it.each([
 request('omp/confirm',{toolApproval:true}),request('item/commandExecution/requestApproval',{}),
 request('acp/permission',{options:[{kind:'allow_once',optionId:'once'}]}),
])('maps a platform conversation grant to an exact once response for $method',a=>{
 expect(approvalChoices(a)).not.toContain('approve-conversation');
 const allowed={...a,conversationApproval:true};expect(approvalChoices(allowed)).toContain('approve-conversation');
 expect(nativeApprovalResponse(allowed,'approve-conversation')).toEqual(nativeApprovalResponse(a,'approve'));
 expect(()=>nativeApprovalResponse(a,'approve-conversation')).toThrow();
});
