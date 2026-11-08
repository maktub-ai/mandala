import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store';
import { createSessionManager } from '../server/sessions';
import { startAcp } from '../server/acp';
import type { CodexOptions } from '../server/codex';
import type { Config } from '../shared/types';
vi.mock('../server/acp',()=>({startAcp:vi.fn()}));
it('routes ACP auto approvals and resumes a fresh process while rejecting retired events',async()=>{
 const home=await mkdtemp(join(tmpdir(),'mana-acp-session-')),store=openStore(home);
 const callbacks:CodexOptions[]=[], modes:unknown[]=[], resumes:string[]=[], closes:number[]=[];
 vi.mocked(startAcp).mockImplementation(async(cli,options)=>{
  expect(cli).toBe('gemini');const generation=callbacks.push(options);
  return {getStatus:async()=>({status:'ready',version:'fixture'}),listModels:async()=>[],
   startThread:async()=> 'acp-session',resumeThread:async id=>{resumes.push(id);},
   startTurn:async(_id,_text,mode)=>{modes.push(mode);return 'turn-'+generation;},
   interrupt:async()=>{},replyApproval(){},close(){closes.push(generation);}};
 });
 const config:Config={version:2,runtimes:['gemini'],projects:[{id:'p',name:'P',cwd:home,agentIds:['a'],resources:[],mcp:[],skills:[]}],agents:[{id:'a',name:'A',instructions:'Review',defaultCli:'gemini',models:{},mcp:[],skills:[]}]};
 const manager=createSessionManager(store,async()=>config,undefined,undefined,home);
 try{
  const chat=await manager.create('p','a',undefined,'gemini',{approvalMode:'auto'});
  await manager.send(chat.id,'first');expect(modes).toEqual(['auto']);
  callbacks[0].onEvent({method:'turn/completed',params:{threadId:'acp-session',turn:{id:'turn-1',status:'completed'}}});
  await manager.send(chat.id,'second');expect(resumes).toEqual(['acp-session']);expect(closes).toContain(1);
  callbacks[0].onEvent({method:'item/agentMessage/delta',params:{threadId:'acp-session',turnId:'turn-2',itemId:'late',delta:'Stale output'}});
  expect(JSON.stringify(store.listEvents(chat.id,0))).not.toContain('Stale output');
  callbacks[1].onEvent({method:'turn/completed',params:{threadId:'acp-session',turn:{id:'turn-2',status:'completed'}}});
 }finally{await manager.close();store.close();await rm(home,{recursive:true,force:true});}
});

it('releases directory occupancy after ACP preflight failure and preserves the submitted message',async()=>{
 const home=await mkdtemp(join(tmpdir(),'mana-acp-preflight-')),store=openStore(home);
 let starts=0,callback:CodexOptions|undefined;
 vi.mocked(startAcp).mockImplementation(async(_cli,options)=>{
  callback=options;
  return {getStatus:async()=>({status:'ready',version:'fixture'}),listModels:async()=>[],startThread:async()=> 'acp-session',resumeThread:async()=>{},
   prepareTurn:async(_id,input)=>{if(input?.effort)throw new Error('ACP reasoning effort selection is not supported');},
   startTurn:async()=>{starts++;return 'turn-1';},interrupt:async()=>{},replyApproval(){},close(){}};
 });
 const config:Config={version:2,runtimes:['gemini'],projects:[{id:'p',name:'P',cwd:home,agentIds:['a'],resources:[],mcp:[],skills:[]}],agents:[{id:'a',name:'A',instructions:'',defaultCli:'gemini',models:{},mcp:[],skills:[]}]};
 const manager=createSessionManager(store,async()=>config,undefined,undefined,home);
 try{
  const chat=await manager.create('p','a',undefined,'gemini',{effort:'high'});
  await expect(manager.send(chat.id,'Preserve my request')).rejects.toThrow(/effort/);
  expect(starts).toBe(0);
  expect(store.database.prepare('SELECT * FROM task_directory_claims').all()).toEqual([]);
  expect(store.listEvents(chat.id,0).some(event=>event.kind==='user'&&(event.data as {text:string}).text==='Preserve my request')).toBe(true);
  store.updateConversation(chat.id,{effort:null});
  await manager.send(chat.id,'Try again');expect(starts).toBe(1);
  callback!.onEvent({method:'turn/completed',params:{threadId:'acp-session',turn:{id:'turn-1',status:'completed'}}});
 }finally{await manager.close();store.close();await rm(home,{recursive:true,force:true});}
});

async function approvalFixture(earlyTurnId?:string) {
 let earlyRequests=1,onReply:(()=>void)|undefined;
 const home=await mkdtemp(join(tmpdir(),'mana-acp-approval-')),store=openStore(home);
 const callbacks:CodexOptions[]=[],replies:unknown[]=[],modes:unknown[]=[];
 vi.mocked(startAcp).mockImplementation(async(_cli,options)=>{
  const generation=callbacks.push(options);
  return {getStatus:async()=>({status:'ready',version:'fixture'}),listModels:async()=>[],
   startThread:async()=> 'acp-session',resumeThread:async()=>{},
   startTurn:async(_id,_text,mode)=>{modes.push(mode);if(earlyTurnId)for(let i=0;i<earlyRequests;i++)request({turnId:earlyTurnId},'early-'+i);return 'turn-'+generation;},
   interrupt:async()=>{},replyApproval(id,result){replies.push({id,result});onReply?.();},close(){}};
 });
 const config:Config={version:2,runtimes:['gemini'],projects:[{id:'p',name:'P',cwd:home,agentIds:['a'],resources:[],mcp:[],skills:[]}],agents:[{id:'a',name:'A',instructions:'Review',defaultCli:'gemini',models:{},mcp:[],skills:[]}]};
 const manager=createSessionManager(store,async()=>config,undefined,undefined,home);
 const chat=await manager.create('p','a',undefined,'gemini');
 const options=[{optionId:'once',name:'Once',kind:'allow_once'},{optionId:'no',name:'Reject',kind:'reject_once'},{optionId:'always',name:'Always',kind:'allow_always'}];
 const request=(extra:Record<string,unknown>={},requestId='permission-1')=>callbacks.at(-1)!.onApproval({id:requestId,method:'acp/permission',params:{threadId:'acp-session',turnId:'turn-'+callbacks.length,title:'Edit file',itemId:'tool-1',toolCall:{toolCallId:'tool-1',title:'Edit file',status:'pending'},options,...extra}});
 await manager.send(chat.id,'Review this tool request');
 const complete=()=>callbacks.at(-1)!.onEvent({method:'turn/completed',params:{threadId:'acp-session',turn:{id:'turn-'+callbacks.length,status:'completed'}}});
 return {store,manager,chat,callbacks,replies,modes,request,complete,setEarlyTurn(value:string,count=1){earlyTurnId=value;earlyRequests=count;},setReplyHook(fn:()=>void){onReply=fn;},async close(){await manager.close();store.close();await rm(home,{recursive:true,force:true});}};
}

it.each([
 ['approve',{outcome:{outcome:'selected',optionId:'once'}}],
 ['reject',{outcome:{outcome:'selected',optionId:'no'}}],
] as const)('replies to a default-mode ACP permission with the exact native once option: %s',async(decision,result)=>{
 const f=await approvalFixture();
 try{
  f.request();const approval=f.manager.getApprovals(f.chat.id)[0];
  expect(f.modes).toEqual(['default']);expect(f.replies).toEqual([]);
  expect(f.store.getConversation(f.chat.id)?.status).toBe('approval');
  await f.manager.approve(f.chat.id,approval.id,decision);
  expect(f.replies).toEqual([{id:'permission-1',result}]);
  expect(f.manager.getApprovals(f.chat.id)).toEqual([]);
  expect(f.store.getConversation(f.chat.id)?.status).toBe('running');
  expect(f.store.getConversation(f.chat.id)?.approvalMode).not.toBe('auto');
  await expect(f.manager.approve(f.chat.id,approval.id,decision)).rejects.toThrow('approval expired');
 }finally{await f.close();}
});

it('refuses once and platform grants when only native persistent approval is advertised',async()=>{
 const f=await approvalFixture();
 try{
  f.request({options:[{optionId:'always',name:'Always',kind:'allow_always'},{optionId:'no',name:'Reject',kind:'reject_once'}]});
  const approval=f.manager.getApprovals(f.chat.id)[0];
  for(const decision of ['approve','approve-session','approve-conversation','approve-rule','reject-stop'] as const)
   await expect(f.manager.approve(f.chat.id,approval.id,decision)).rejects.toThrow('unsupported approval decision');
  expect(f.replies).toEqual([]);expect(f.manager.getApprovals(f.chat.id)).toHaveLength(1);
  await f.manager.approve(f.chat.id,approval.id,'reject');
  expect(f.replies).toEqual([{id:'permission-1',result:{outcome:{outcome:'selected',optionId:'no'}}}]);
 }finally{await f.close();}
});

it('cancels ACP denial when no native reject_once option exists without selecting a persistent option',async()=>{
 const f=await approvalFixture();
 try{
  f.request({options:[{optionId:'always-no',name:'Never',kind:'reject_always'}]});
  await f.manager.approve(f.chat.id,f.manager.getApprovals(f.chat.id)[0].id,'reject');
  expect(f.replies).toEqual([{id:'permission-1',result:{outcome:{outcome:'cancelled'}}}]);
 }finally{await f.close();}
});

it('binds ACP permissions to the conversation, native thread and current turn',async()=>{
 const f=await approvalFixture();
 try{
  f.request({threadId:'other-session'});f.request({turnId:'other-turn'});
  expect(f.manager.getApprovals(f.chat.id)).toEqual([]);
  f.request();const approval=f.manager.getApprovals(f.chat.id)[0];
  const other=await f.manager.create('p','a',undefined,'gemini');
  await expect(f.manager.approve(other.id,approval.id,'approve')).rejects.toThrow('approval expired');
  expect(f.replies).toEqual([]);expect(f.manager.getApprovals(f.chat.id)).toHaveLength(1);
  await f.manager.approve(f.chat.id,approval.id,'approve');
  expect(f.replies).toEqual([{id:'permission-1',result:{outcome:{outcome:'selected',optionId:'once'}}}]);
 }finally{await f.close();}
});

it.each(['resolved','completed','disconnected'] as const)('expires an ACP permission after its native request is %s',async end=>{
 const f=await approvalFixture();
 try{
  f.request();const approval=f.manager.getApprovals(f.chat.id)[0];
  if(end==='resolved')f.callbacks[0].onEvent({method:'serverRequest/resolved',params:{threadId:'acp-session',requestId:'permission-1'}});
  else if(end==='completed')f.complete();
  else f.callbacks[0].onExit('Disconnected');
  await expect(f.manager.approve(f.chat.id,approval.id,'approve')).rejects.toThrow('approval expired');
  expect(f.replies).toEqual([]);expect(f.manager.getApprovals(f.chat.id)).toEqual([]);
  if(end==='completed'){
   await f.manager.send(f.chat.id,'Next turn');f.request();
   await expect(f.manager.approve(f.chat.id,approval.id,'approve')).rejects.toThrow('approval expired');
   f.callbacks[0].onApproval({id:'retired-permission',method:'acp/permission',params:{threadId:'acp-session',turnId:'turn-2'}});
   expect(f.manager.getApprovals(f.chat.id)).toHaveLength(1);
   await f.manager.approve(f.chat.id,f.manager.getApprovals(f.chat.id)[0].id,'reject');
   expect(f.replies).toEqual([{id:'permission-1',result:{outcome:{outcome:'selected',optionId:'no'}}}]);
  }
 }finally{await f.close();}
});

it('rejects an ACP permission while native stop confirmation is pending',async()=>{
 const f=await approvalFixture();
 try{
  f.request();const approval=f.manager.getApprovals(f.chat.id)[0];
  const stopping=f.manager.stop(f.chat.id);
  await expect(f.manager.approve(f.chat.id,approval.id,'approve')).rejects.toThrow('approval expired');
  expect(f.replies).toEqual([]);
  f.complete();await stopping;
 }finally{await f.close();}
});


it('rejects an ACP permission received before the native start response binds a different turn',async()=>{
 const f=await approvalFixture('stale-turn');
 try{
  const approval=f.manager.getApprovals(f.chat.id)[0];
  expect(approval).toBeDefined();
  await expect(f.manager.approve(f.chat.id,approval.id,'approve')).rejects.toThrow('approval expired');
  expect(f.replies).toEqual([]);
 }finally{await f.close();}
});

it('reuses explicit chat authorization across turns and stops reusing it immediately after revocation',async()=>{
 const f=await approvalFixture();
 try{
  f.request();await f.manager.approve(f.chat.id,f.manager.getApprovals(f.chat.id)[0].id,'approve-conversation');
  expect(await f.manager.conversationApproval(f.chat.id)).toEqual({granted:true});
  f.request();expect(f.manager.getApprovals(f.chat.id)).toHaveLength(0);expect(f.replies).toHaveLength(2);
  f.complete();await f.manager.send(f.chat.id,'Next turn');f.request();expect(f.manager.getApprovals(f.chat.id)).toHaveLength(0);
  f.manager.revokeConversationApproval(f.chat.id);expect(await f.manager.conversationApproval(f.chat.id)).toEqual({granted:false});
  f.request();expect(f.manager.getApprovals(f.chat.id)).toHaveLength(1);
 }finally{await f.close();}
});
it('strict mode suspends chat authorization without turning it into auto mode',async()=>{
 const f=await approvalFixture();
 try{
  f.request();await f.manager.approve(f.chat.id,f.manager.getApprovals(f.chat.id)[0].id,'approve-conversation');f.complete();
  await f.manager.setApprovalMode(f.chat.id,'strict');await f.manager.send(f.chat.id,'Strict turn');f.request();
  const a=f.manager.getApprovals(f.chat.id)[0];expect(a.conversationApproval).toBe(false);
  await expect(f.manager.approve(f.chat.id,a.id,'approve-conversation')).rejects.toThrow();
 }finally{await f.close();}
});

it.each(['unrecognized-turn','turn-2'])('replays early approvals only after binding the native turn: %s',async(early)=>{
 const f=await approvalFixture();
 try{
  f.request();await f.manager.approve(f.chat.id,f.manager.getApprovals(f.chat.id)[0].id,'approve-conversation');f.complete();
  f.setEarlyTurn(early);await f.manager.send(f.chat.id,'Second turn');
  if(early==='unrecognized-turn'){
   expect(f.replies).toHaveLength(1);const a=f.manager.getApprovals(f.chat.id)[0];
   await expect(f.manager.approve(f.chat.id,a.id,'approve')).rejects.toThrow('approval expired');
  }else{expect(f.replies).toHaveLength(2);expect(f.manager.getApprovals(f.chat.id)).toHaveLength(0);}
 }finally{await f.close();}
});

it('rechecks revocation before replaying each queued native request',async()=>{
 const f=await approvalFixture();
 try{
  f.request();await f.manager.approve(f.chat.id,f.manager.getApprovals(f.chat.id)[0].id,'approve-conversation');f.complete();
  f.setEarlyTurn('turn-2',2);f.setReplyHook(()=>queueMicrotask(()=>f.manager.revokeConversationApproval(f.chat.id)));
  await f.manager.send(f.chat.id,'Two early tool requests');
  expect(f.replies).toHaveLength(2);expect(f.manager.getApprovals(f.chat.id)).toHaveLength(1);
  expect(await f.manager.conversationApproval(f.chat.id)).toEqual({granted:false});
 }finally{await f.close();}
});
