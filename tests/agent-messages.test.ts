import {createTaskWithExecutions} from './helpers/task-executions';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,type Store} from '../server/store';
import {createSessionManager,type SessionManager} from '../server/sessions';
import type {CodexClient,CodexOptions} from '../server/codex';
import type {Config} from '../shared/types';
import {createHttpServer} from '../server/http';
import {execFile} from 'node:child_process';
import {businessCliContext} from './business-cli-context';
import {createConversationProgress} from '../server/conversation-progress';

let home:string,store:Store,manager:SessionManager,config:Config;
const native=new Map<string,CodexOptions>(),turns:{session:string;text:string;turn:string}[]=[];
let number=0,instructions='',gate:(()=>Promise<void>)|undefined,inspection:'succeeded'|'unknown'='unknown';
const factory=async(o:CodexOptions):Promise<CodexClient>=>{
 const session='session-'+(++number);native.set(session,o);
 return {getStatus:async()=>({status:'ready',version:'fixture'}),listModels:async()=>[],startThread:async(p)=>{instructions=p.instructions;await gate?.();return session;},resumeThread:async(id,_mcp,prompt)=>{instructions=prompt??'';native.set(id,o);await gate?.();},
  startTurn:async(id,text)=>{const turn='turn-'+(turns.length+1);turns.push({session:id,text,turn});return turn;},
  inspectInvocation:async()=>inspection,
  interrupt:async(id,turn)=>native.get(id)!.onEvent({method:'turn/completed',params:{threadId:id,turn:{id:turn,status:'interrupted'}}}),replyApproval(){},close(){}};
};
function finish(id:string,text='Done'){
 const chat=store.getConversation(id)!;
 native.get(chat.nativeId!)!.onEvent({method:'item/completed',params:{threadId:chat.nativeId,turnId:chat.turnId,item:{id:chat.turnId+'-final',type:'agentMessage',phase:'final_answer',text}}});
 native.get(chat.nativeId!)!.onEvent({method:'turn/completed',params:{threadId:chat.nativeId,turn:{id:chat.turnId,status:'completed'}}});
}
async function running(id:string){await vi.waitFor(()=>{const chat=store.getConversation(id);expect(chat?.status).toBe('running');expect(chat?.turnId).toBeTruthy();expect(turns.some(turn=>turn.session===chat?.nativeId&&turn.turn===chat?.turnId)).toBe(true);});}
async function source(){const c=await manager.create('p','a',undefined,undefined,{workspaceId:null});await manager.send(c.id,'Confirm the API before planning');return c;}
function counts(){return ['work_tasks','task_runs','task_receipts','tasks'].map(table=>store.database.prepare('SELECT count(*) n FROM '+table).get()!.n);}
beforeEach(()=>{
 home=mkdtempSync(join(tmpdir(),'mana-messages-'));store=openStore(home);number=0;gate=undefined;inspection='unknown';native.clear();turns.length=0;
 config={version:2,projects:[{id:'p',name:'P',cwd:home,agentIds:['a','b'],resources:[],mcp:[],skills:[]}],agents:['a','b'].map(id=>({id,name:id,instructions:'Help',defaultCli:'codex',models:{},mcp:[],skills:[]}))};
 manager=createSessionManager(store,async()=>structuredClone(config),factory,undefined,home);
});
afterEach(async()=>{await manager.close();store.close();rmSync(home,{recursive:true,force:true});});

test('simple confirmation resumes A with B final answer without creating any Task',async()=>{
 const a=await source(),before=counts();
 const message=await manager.askAgent(a.id,{targetAgentId:'b',text:'Is the parameter optional?'},{commandKey:'confirm'});
 expect(message.policy).toBe('resume');expect(counts()).toEqual(before);
 finish(a.id);await vi.waitFor(()=>expect(store.getConversation(message.targetConversationId)?.turnId).toBeTruthy());
 finish(message.targetConversationId,'The parameter is optional');
 await vi.waitFor(()=>{expect(store.getConversation(a.id)?.status).toBe('running');expect(turns.at(-1)!.text).toContain('The parameter is optional');});
expect(turns.at(-1)!.text).toContain('Confirm the API before planning');
 finish(a.id,'Use the optional parameter');
 expect(manager.getAgentMessage(message.id)).toMatchObject({state:'succeeded',reply:'The parameter is optional',replyState:'consumed'});
 expect(counts()).toEqual(before);
});

test('a selected conversation inquiry reaches the exact recipient and returns its reply to the source',async()=>{
 const b=await manager.create('p','b',undefined,undefined,{workspaceId:null}),a=await manager.create('p','a',undefined,undefined,{workspaceId:null});
 const item=(await manager.listComposerReferences(a.id)).find(item=>item.kind==='chat'&&item.intent==='inquiry'&&item.objectId===b.id)!;
 expect(item).toBeDefined();const before=counts();
 await manager.send(a.id,'Confirm the earlier decision',[],[{id:item.id}]);
 expect(turns.at(-1)!.text).toContain('"targetConversationId":"'+b.id+'"');
 const token=businessCliContext(instructions).token;
 const message=await manager.callBoundTool(token,'message_ask',{targetAgentId:'b',targetConversationId:b.id,text:'Is the parameter optional?',policy:'resume'},'card-inquiry') as {id:string;targetConversationId:string};
 expect(message.targetConversationId).toBe(b.id);finish(a.id);await running(b.id);
 finish(b.id,'The earlier decision allows an optional parameter');
 await vi.waitFor(()=>{expect(store.getConversation(a.id)?.status).toBe('running');expect(turns.at(-1)!.text).toContain('The earlier decision allows an optional parameter');});
 finish(a.id,'Decision confirmed');
 expect(manager.getAgentMessage(message.id)).toMatchObject({state:'succeeded',replyState:'consumed'});expect(counts()).toEqual(before);
},30000);

test.each([false,true])('stopping idle A saves late B answer and never wakes A after continue (restart=%s)',async(restart)=>{
 const a=await source(),message=await manager.askAgent(a.id,{targetAgentId:'b',text:'Confirm a detail'},{commandKey:'late'});
 finish(a.id);await vi.waitFor(()=>expect(store.getConversation(message.targetConversationId)?.turnId).toBeTruthy());
 await expect(manager.stop(a.id)).resolves.toBe(true);
 expect(store.getConversation(message.targetConversationId)?.status).toBe('running');
 finish(message.targetConversationId,'Late confirmation');
 await vi.waitFor(()=>expect(manager.getAgentMessage(message.id).replyState).toBe('parked'));
 if(restart){await manager.close();store.close();store=openStore(home);manager=createSessionManager(store,async()=>structuredClone(config),factory,undefined,home);await manager.reconcileRuns('local');}
 await manager.continue(a.id,'A different request');finish(a.id,'New answer');await new Promise(r=>setImmediate(r));
 expect(store.getConversation(a.id)?.status).toBe('idle');expect(turns.filter(t=>t.text.includes('Late confirmation'))).toHaveLength(0);
 expect(manager.getAgentMessage(message.id)).toMatchObject({reply:'Late confirmation',replyState:'parked'});
 expect(createConversationProgress(store,manager).list().find(row=>row.id===message.targetConversationId)?.state).toBe('completed');
 expect(counts()).toEqual([0,0,0,0]);
});

test('notify saves visible reply without a new A turn and stable keys do not duplicate B inputs',async()=>{
 const a=await source(),input={targetAgentId:'b',text:'Confirm only',policy:'notify' as const};
 const message=await manager.askAgent(a.id,input,{commandKey:'once'});
 expect(message).toMatchObject({sourceRequestEventId:store.listEvents(a.id,0).find(e=>e.kind==='user')!.id,sourceAgentId:'a',targetAgentId:'b'});
 expect((await manager.askAgent(a.id,input,{commandKey:'once'})).id).toBe(message.id);
 await expect(manager.askAgent(a.id,{...input,text:'Different'},{commandKey:'once'})).rejects.toMatchObject({code:'idempotency_conflict'});
 finish(a.id);await vi.waitFor(()=>expect(store.getConversation(message.targetConversationId)?.turnId).toBeTruthy());
 finish(message.targetConversationId,'Confirmed');await new Promise(r=>setImmediate(r));
 expect(turns).toHaveLength(2);expect(manager.getAgentMessage(message.id)).toMatchObject({reply:'Confirmed',replyState:'parked'});
 expect(JSON.stringify(store.listEvents(a.id,0))).toContain('Confirmed');
});

test('B busy conversation queues confirmation instead of steering the active turn',async()=>{
 const a=await source(),b=await manager.create('p','b',undefined,undefined,{workspaceId:null});await manager.send(b.id,'Current work');
 const message=await manager.askAgent(a.id,{targetAgentId:'b',targetConversationId:b.id,text:'Queued confirmation'},{commandKey:'busy'});
 expect(turns).toHaveLength(2);expect(manager.getAgentMessage(message.id).state).toBe('queued');
 finish(a.id);finish(b.id);await vi.waitFor(()=>expect(turns.at(-1)!.text).toContain('Queued confirmation'));
 expect(counts()).toEqual([0,0,0,0]);
});

test('stopping A while a reply is queued cancels its auto delivery but preserves a user queued input',async()=>{
 const a=await source(),message=await manager.askAgent(a.id,{targetAgentId:'b',text:'Question'},{commandKey:'queued-stop'});
 finish(a.id);await vi.waitFor(()=>expect(store.getConversation(message.targetConversationId)?.turnId).toBeTruthy());
 // Another user turn keeps A occupied while the confirmation arrives.
 await manager.send(a.id,'New ongoing request');manager.enqueueUserInput(a.id,'User follow-up','user-follow-up');
 finish(message.targetConversationId,'Old confirmation');await vi.waitFor(()=>expect(manager.getAgentMessage(message.id).replyState).toBe('queued'));
 await manager.stop(a.id);
 expect(manager.getAgentMessage(message.id).replyState).toBe('parked');
 expect(manager.listUserInputs(a.id).find(i=>i.text==='User follow-up')?.state).toBe('queued');
 expect(turns.some(t=>t.text.includes('Old confirmation'))).toBe(false);
});

test('revalidates project membership before injecting a queued message',async()=>{
 const a=await source(),message=await manager.askAgent(a.id,{targetAgentId:'b',text:'Private question'},{commandKey:'revoke'});
 config.projects[0].agentIds=['a'];finish(a.id);
 await vi.waitFor(()=>expect(manager.getAgentMessage(message.id).state).toBe('failed'));
 expect(turns.some(t=>t.text.includes('Private question'))).toBe(false);
});

test('native disconnect records unknown message outcome and never automatically retries B',async()=>{
 const a=await source(),message=await manager.askAgent(a.id,{targetAgentId:'b',text:'Pending confirmation'},{commandKey:'disconnect'});
 finish(a.id);await vi.waitFor(()=>expect(store.getConversation(message.targetConversationId)?.turnId).toBeTruthy());
 const b=store.getConversation(message.targetConversationId)!;native.get(b.nativeId!)!.onExit('connection lost');
 expect(manager.getAgentMessage(message.id).state).toBe('unknown');
 await new Promise(r=>setImmediate(r));expect(turns).toHaveLength(2);
});

test('replaced source request rejects its queued inquiry without leaving B blocked by a phantom input',async()=>{
 const a=await source(),message=await manager.askAgent(a.id,{targetAgentId:'b',text:'Old question'},{commandKey:'replaced'});
 const original=store.listEvents(a.id,0).find(e=>e.kind==='user')!;
 finish(a.id);store.replaceHistory(a.id,original.id,'replacement-native');
 await vi.waitFor(()=>expect(manager.getAgentMessage(message.id).state).toBe('failed'));
 expect(manager.listUserInputs(message.targetConversationId).every(i=>i.state==='cancelled')).toBe(true);
 expect(turns.some(t=>t.text.includes('Old question'))).toBe(false);
});

test('rejecting an obsolete inquiry immediately advances B to its next legal queued inquiry',async()=>{
 const b=await manager.create('p','b',undefined,undefined,{workspaceId:null});await manager.send(b.id,'Ongoing B work');
 const a=await source(),other=await source();
 const obsolete=await manager.askAgent(a.id,{targetAgentId:'b',targetConversationId:b.id,text:'Obsolete inquiry'},{commandKey:'obsolete'});
 await manager.askAgent(a.id,{targetAgentId:'b',targetConversationId:b.id,text:'Another obsolete inquiry'},{commandKey:'obsolete-two'});
 const next=await manager.askAgent(other.id,{targetAgentId:'b',targetConversationId:b.id,text:'Legal inquiry'},{commandKey:'legal'});
 const original=store.listEvents(a.id,0).find(e=>e.kind==='user')!;finish(a.id);finish(other.id);store.replaceHistory(a.id,original.id,'replacement');finish(b.id);
 await vi.waitFor(()=>expect(manager.getAgentMessage(obsolete.id).state).toBe('failed'));
 await vi.waitFor(()=>expect(manager.getAgentMessage(next.id).state).toBe('running'));
 expect(turns.at(-1)!.text).toContain('Legal inquiry');
});

test('stop during slow reply preparation prevents native submission',async()=>{
 const a=await source(),message=await manager.askAgent(a.id,{targetAgentId:'b',text:'Confirm'},{commandKey:'preparing-stop'});
 finish(a.id);await vi.waitFor(()=>expect(store.getConversation(message.targetConversationId)?.turnId).toBeTruthy());
 let release!:()=>void,entered=false;gate=async()=>{entered=true;await new Promise<void>(resolve=>{release=resolve;});};
 finish(message.targetConversationId,'Reply before preparation');await vi.waitFor(()=>expect(entered).toBe(true));
 await manager.stop(a.id);gate=undefined;release();await new Promise(r=>setImmediate(r));
 expect(turns).toHaveLength(2);expect(manager.getAgentMessage(message.id)).toMatchObject({reply:'Reply before preparation',replyState:'parked'});
});

test('an inquiry stays queued while the native thread is preparing and becomes running only after submission',async()=>{
 const a=await source();let release!:()=>void,entered=false;
 gate=async()=>{entered=true;await new Promise<void>(r=>{release=r;});};
 const message=await manager.askAgent(a.id,{targetAgentId:'b',text:'Prepare a confirmation'},{commandKey:'native-preparation'});
 finish(a.id);await vi.waitFor(()=>expect(entered).toBe(true));expect(manager.getAgentMessage(message.id).state).toBe('queued');
 gate=undefined;release();await vi.waitFor(()=>expect(manager.getAgentMessage(message.id).state).toBe('running'));
 expect(store.getConversation(message.targetConversationId)?.turnId).toBeTruthy();
});

test.each([false,true])('recovery adopts the exact saved final and resumes only an unstopped A (stopped=%s)',async(stopped)=>{
 const a=await source(),message=await manager.askAgent(a.id,{targetAgentId:'b',text:'Recovery confirmation'},{commandKey:'recovery'});
 finish(a.id);await vi.waitFor(()=>expect(store.getConversation(message.targetConversationId)?.turnId).toBeTruthy());
 if(stopped)await manager.stop(a.id);
 await vi.waitFor(()=>expect(store.getConversation(message.targetConversationId)?.turnId).toBeTruthy());
 const b=store.getConversation(message.targetConversationId)!;
 native.get(b.nativeId!)!.onEvent({method:'item/completed',params:{threadId:b.nativeId,turnId:b.turnId,item:{id:'saved-final',type:'agentMessage',phase:'final_answer',text:'Saved exact reply'}}});
 await manager.close();store.close();store=openStore(home);inspection='succeeded';manager=createSessionManager(store,async()=>structuredClone(config),factory,undefined,home);
 await manager.reconcileRuns('local');
 expect(manager.getAgentMessage(message.id)).toMatchObject({state:'succeeded',reply:'Saved exact reply'});
 await vi.waitFor(()=>expect(createConversationProgress(store,manager).list().find(row=>row.id===message.targetConversationId)?.state).toBe('completed'));
 if(stopped){expect(manager.getAgentMessage(message.id).replyState).toBe('parked');expect(turns).toHaveLength(2);}
 else {await vi.waitFor(()=>expect(turns).toHaveLength(3));expect(turns.at(-1)!.text).toContain('Saved exact reply');}
});

test('default Task delegation stops waiting A without cancelling B or reactivating its old receipt',async()=>{
 const a=await source(),task=await manager.createTask(a.id,'b','Deliver a review');
 finish(a.id);await vi.waitFor(()=>expect(store.getConversation(task.targetConversationId)?.turnId).toBeTruthy());
 await expect(manager.stop(a.id)).resolves.toBe(true);expect(store.getConversation(task.targetConversationId)?.status).toBe('running');
 finish(task.targetConversationId,'Review delivered');await new Promise(r=>setImmediate(r));
 expect(manager.taskService.listReceipts({userId:store.ownerUserId},task.id)[0]).toMatchObject({policy:'resume',deliveryState:'parked'});
 await manager.continue(a.id,'New question');finish(a.id);await new Promise(r=>setImmediate(r));
 expect(turns.some(t=>t.text.includes('Task receipts (data)'))).toBe(false);
});

test('HTTP and bound CLI expose message commands and reject identity overrides',async()=>{
 const a=await source(),context=businessCliContext(instructions),server=createHttpServer({home,store,manager,requireIdentity:false});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 try{
  const result=await new Promise<{code:number;stdout:string;stderr:string}>(r=>execFile(process.execPath,['cli/openmana.mjs','messages','ask','--base-url',base,'--key','cli-message','--data',JSON.stringify({sourceConversationId:a.id,targetAgentId:'b',text:'CLI confirmation'})],{env:{...process.env,OPEN_MANA_CONTEXT:''}},(error,stdout,stderr)=>r({code:error?1:0,stdout,stderr})));
  expect(result.code,result.stdout+result.stderr).toBe(0);const message=JSON.parse(result.stdout).data;
  const read=await fetch(base+'/api/agent-messages/'+message.id);expect(read.status).toBe(200);expect(await read.json()).toMatchObject({text:'CLI confirmation',policy:'resume'});
  const bound=await fetch(base+'/api/cli/invoke',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+context.token},body:JSON.stringify({command:'messages get',args:{messageId:message.id},commandKey:'read'})});expect(bound.status).toBe(200);
  const invalid=await fetch(base+'/api/cli/invoke',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+context.token},body:JSON.stringify({command:'messages ask',args:{sourceConversationId:a.id,targetAgentId:'b',text:'spoof'},commandKey:'spoof'})});expect(invalid.status).toBeGreaterThanOrEqual(400);
  expect(counts()).toEqual([0,0,0,0]);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('a lightweight inquiry starts in the same project while its source remains active',async()=>{
 const a=await manager.create('p','a');await manager.send(a.id,'Confirm the API before planning');const before=counts();const message=await manager.askAgent(a.id,{targetAgentId:'b',text:'Confirm the already discussed parameter'},{commandKey:'parallel-confirm'});
 await vi.waitFor(()=>expect(store.getConversation(message.targetConversationId)?.turnId).toBeTruthy());
 expect(store.getConversation(a.id)?.status).toBe('running');expect(counts()).toEqual(before);
 const claim=store.database.prepare("SELECT delegated FROM task_directory_claims WHERE conversation_id=?").get(message.targetConversationId);expect(claim?.delegated).toBe(0);
 finish(message.targetConversationId,'Confirmed');finish(a.id,'Thanks');
 await vi.waitFor(()=>expect(turns.at(-1)?.text).toContain('Confirmed'));
});

test('a lightweight inquiry still waits for a formal Task directory owner',async()=>{
 const {createTaskResources}=await import('../server/task-resources');const resources=createTaskResources(store);
 const a=await manager.create('p','a');await manager.send(a.id,'Confirm');finish(a.id);expect(resources.claimDirectory('formal-task-run',home,'write')).toBe('granted');
 const message=await manager.askAgent(a.id,{targetAgentId:'b',text:'Confirm the parameter'},{commandKey:'formal-owner'});
 await new Promise(resolve=>setTimeout(resolve,30));expect(store.getConversation(message.targetConversationId)?.nativeId).toBeNull();expect(manager.getAgentMessage(message.id).state).toBe('queued');
 expect(manager.listUserInputs(message.targetConversationId).find(input=>input.agentMessage?.id===message.id)).toMatchObject({waitingReason:'directory'});
 resources.releaseUnsubmitted('run','formal-task-run');manager.enqueueUserInput(message.targetConversationId,'later request','later');
 await vi.waitFor(()=>expect(store.getConversation(message.targetConversationId)?.turnId).toBeTruthy());finish(message.targetConversationId,'Human request finished');
 await vi.waitFor(()=>expect(manager.getAgentMessage(message.id).state).toBe('running'));
});

test('both sides receive the real queued-to-running transition once',async()=>{
 const a=await source(),message=await manager.askAgent(a.id,{targetAgentId:'b',text:'Observe actual execution'},{commandKey:'visible-state'});
 finish(a.id);await vi.waitFor(()=>expect(manager.getAgentMessage(message.id).state).toBe('running'));
 for(const [id,direction] of [[a.id,'sent'],[message.targetConversationId,'request']]){
  const states=store.listEvents(id,0).flatMap(event=>{const value=(event.data as {agentMessage?:{id:string;direction:string;state:string}}).agentMessage;return event.kind==='metadata'&&value?.id===message.id&&value.direction===direction?[value.state]:[];});
  expect(states).toEqual(['queued','running']);
 }
});

 test('cancelling a queued inquiry updates B request metadata without starting it',async()=>{
 const a=await source(),b=await manager.create('p','b');await manager.send(b.id,'Hold B');
 const message=await manager.askAgent(a.id,{targetAgentId:'b',targetConversationId:b.id,text:'Cancel this queued inquiry'},{commandKey:'cancel-queued'});
 const input=manager.listUserInputs(b.id).find(input=>input.text==='Cancel this queued inquiry')!;
 await manager.cancelUserInput(input.id);
 expect(manager.getAgentMessage(message.id).state).toBe('failed');
 const updates=store.listEvents(b.id,0).filter(event=>event.kind==='metadata').flatMap(event=>{const m=(event.data as {agentMessage?:{id:string;direction:string;state:string}}).agentMessage;return m?.id===message.id&&m.direction==='request'?[m.state]:[];});
 expect(updates).toEqual(['queued','failed']);expect(store.getConversation(b.id)?.status).toBe('running');
 });

test.each([false,true])('out-of-order and duplicate helper replies are consumed once, or all parked after source stop (stopped=%s)',async(stopped)=>{
 const a=await source(),first=await manager.askAgent(a.id,{targetAgentId:'b',text:'First detail'},{commandKey:'first-detail'}),second=await manager.askAgent(a.id,{targetAgentId:'b',text:'Second detail'},{commandKey:'second-detail'});finish(a.id);
 await vi.waitFor(()=>{expect(store.getConversation(first.targetConversationId)?.turnId).toBeTruthy();expect(store.getConversation(second.targetConversationId)?.turnId).toBeTruthy();});
 if(stopped)await manager.stop(a.id);
 const b=store.getConversation(second.targetConversationId)!,turn=b.turnId!,client=native.get(b.nativeId!)!;finish(b.id,'Second detail answer');
 if(!stopped)await vi.waitFor(()=>expect(turns.filter(t=>t.text.includes('Agent reply (data)'))).toHaveLength(1));
 finish(first.targetConversationId,'First detail answer');
 client.onEvent({method:'item/completed',params:{threadId:b.nativeId,turnId:turn,item:{id:turn+'-final',type:'agentMessage',phase:'final_answer',text:'Second detail answer'}}});
 client.onEvent({method:'turn/completed',params:{threadId:b.nativeId,turn:{id:turn,status:'completed'}}});
 if(!stopped){finish(a.id,'Handled second reply');await vi.waitFor(()=>expect(turns.filter(t=>t.text.includes('Agent reply (data)'))).toHaveLength(2));finish(a.id,'Handled first reply');}
 await vi.waitFor(()=>{for(const m of [first,second])expect(manager.getAgentMessage(m.id).replyState).toBe(stopped?'parked':'consumed');});
 const delivered=turns.filter(t=>t.text.includes('Agent reply (data)'));expect(delivered).toHaveLength(stopped?0:2);
 for(const m of [first,second])expect(manager.listUserInputs(a.id).filter(i=>i.agentMessage?.id===m.id&&i.agentMessage.direction==='reply')).toHaveLength(stopped?0:1);
 if(!stopped){expect(delivered[0].text).toContain('Second detail answer');expect(delivered[1].text).toContain('First detail answer');}
 expect(counts()).toEqual([0,0,0,0]);
});


test('a dedicated inquiry settles in Completed, can be explicitly reopened, and human input resumes it',async()=>{
 const a=await source(),message=await manager.askAgent(a.id,{targetAgentId:'b',text:'Confirm this detail'},{commandKey:'settle'}),progress=createConversationProgress(store,manager);
 finish(a.id);await vi.waitFor(()=>expect(manager.getAgentMessage(message.id).state).toBe('running'));
 expect(progress.list().find(row=>row.id===message.targetConversationId)?.state).toBe('running');
 finish(message.targetConversationId,'Confirmed');
 await vi.waitFor(()=>expect(progress.list().find(row=>row.id===message.targetConversationId)?.state).toBe('completed'));
 expect(progress.list().find(row=>row.id===a.id)?.state).not.toBe('completed');
 progress.update(message.targetConversationId,{action:'reopen'});
 expect(progress.list().find(row=>row.id===message.targetConversationId)?.state).toBe('recent');
 expect(progress.list().find(row=>row.id===message.targetConversationId)?.state).toBe('recent');
 await manager.send(message.targetConversationId,'Continue with another detail');
 expect(progress.list().find(row=>row.id===message.targetConversationId)?.state).toBe('running');
});

test('a nested inquiry waits for its child before replying upstream and settling the dedicated receiver',async()=>{
 config.projects[0].agentIds.push('c');config.agents.push({...structuredClone(config.agents[1]),id:'c',name:'c'});
 const a=await source(),message=await manager.askAgent(a.id,{targetAgentId:'b',text:'Check the complete answer'},{commandKey:'nested-parent'}),progress=createConversationProgress(store,manager);
 finish(a.id);await vi.waitFor(()=>expect(manager.getAgentMessage(message.id).state).toBe('running'));
 const child=await manager.askAgent(message.targetConversationId,{targetAgentId:'c',text:'Verify a dependency'},{commandKey:'nested-child'});
 finish(message.targetConversationId,'Waiting for the dependency');
 await vi.waitFor(()=>expect(manager.getAgentMessage(child.id).state).toBe('running'));
 expect(manager.getAgentMessage(message.id)).toMatchObject({state:'running',reply:null});
 expect(store.getConversation(a.id)?.status).toBe('idle');
 expect(progress.list().find(row=>row.id===message.targetConversationId)?.state).toBe('waiting');
 finish(child.targetConversationId,'Dependency confirmed');
 await running(message.targetConversationId);
 finish(message.targetConversationId,'The final checked answer');
 await vi.waitFor(()=>{expect(manager.getAgentMessage(message.id)).toMatchObject({state:'succeeded',reply:'The final checked answer'});expect(store.getConversation(a.id)?.status).toBe('running');});
 expect(turns.filter(turn=>turn.text.includes('Agent reply (data)')&&turn.text.includes('Waiting for the dependency'))).toHaveLength(0);
 expect(progress.list().find(row=>row.id===message.targetConversationId)?.state).toBe('completed');
});

test('successful inquiries in an existing human conversation do not mark it completed',async()=>{
 const a=await source(),b=await manager.create('p','b',undefined,undefined,{workspaceId:null});await manager.send(b.id,'Original human question');finish(b.id,'Human answer');
 const message=await manager.askAgent(a.id,{targetAgentId:'b',targetConversationId:b.id,text:'Confirm in existing chat'},{commandKey:'existing-not-complete'});
 finish(a.id);await vi.waitFor(()=>expect(manager.getAgentMessage(message.id).state).toBe('running'));finish(b.id,'Confirmed');
 await vi.waitFor(()=>expect(manager.getAgentMessage(message.id).state).toBe('succeeded'));
 expect(createConversationProgress(store,manager).list().find(row=>row.id===b.id)?.state).not.toBe('completed');
});


test.each(['failed','unknown','missing'] as const)('an inquiry with %s result is not marked completed',async(outcome)=>{
 const a=await source(),message=await manager.askAgent(a.id,{targetAgentId:'b',text:'Check a detail'},{commandKey:'unsuccessful'});finish(a.id);
 await vi.waitFor(()=>expect(manager.getAgentMessage(message.id).state).toBe('running'));
 const b=store.getConversation(message.targetConversationId)!,client=native.get(b.nativeId!)!;
 if(outcome==='unknown')client.onExit('Connection lost');
 else if(outcome==='missing')finish(b.id,'');
 else client.onEvent({method:'turn/completed',params:{threadId:b.nativeId,turn:{id:b.turnId,status:'failed'}}});
 await vi.waitFor(()=>expect(manager.getAgentMessage(message.id).state).toBe(outcome==='unknown'?'unknown':'failed'));
 expect(createConversationProgress(store,manager).list().find(row=>row.id===b.id)?.state).not.toBe('completed');
});

test('queued human follow-up prevents automatic completion of a dedicated inquiry conversation',async()=>{
 const a=await source(),message=await manager.askAgent(a.id,{targetAgentId:'b',text:'Confirm once'},{commandKey:'human-followup'});finish(a.id);
 await vi.waitFor(()=>expect(manager.getAgentMessage(message.id).state).toBe('running'));
 manager.enqueueUserInput(message.targetConversationId,'Separate human work','separate-human');
 finish(message.targetConversationId,'Confirmed');
 expect(createConversationProgress(store,manager).list().find(row=>row.id===message.targetConversationId)?.state).not.toBe('completed');
 await vi.waitFor(()=>expect(turns.some(turn=>turn.session===store.getConversation(message.targetConversationId)?.nativeId&&turn.text==='Separate human work')).toBe(true));
 finish(message.targetConversationId,'Human work done');
 expect(createConversationProgress(store,manager).list().find(row=>row.id===message.targetConversationId)?.state).not.toBe('completed');
});

test('a Task linked to a dedicated inquiry prevents automatic conversation completion',async()=>{
 const a=await source(),message=await manager.askAgent(a.id,{targetAgentId:'b',text:'Confirm once'},{commandKey:'linked-task'});finish(a.id);
 await vi.waitFor(()=>expect(manager.getAgentMessage(message.id).state).toBe('running'));
 const task=createTaskWithExecutions(store,manager.taskService,{userId:store.ownerUserId},{goal:'Unfinished independent goal',projectId:'p'},[message.targetConversationId],'unrelated-task');
 finish(message.targetConversationId,'Confirmed');
 expect(createConversationProgress(store,manager).list().find(row=>row.id===message.targetConversationId)?.state).not.toBe('completed');
 expect(manager.taskService.getTask({userId:store.ownerUserId},task.id).state).toBe('todo');
});

test('a stopped source parks the final nested answer and stays stopped while its dedicated receivers settle',async()=>{
 config.projects[0].agentIds.push('c');config.agents.push({...structuredClone(config.agents[1]),id:'c',name:'c'});
 const a=await source(),message=await manager.askAgent(a.id,{targetAgentId:'b',text:'Check answer'},{commandKey:'stop-parent'});finish(a.id);
 await vi.waitFor(()=>expect(manager.getAgentMessage(message.id).state).toBe('running'));
 const child=await manager.askAgent(message.targetConversationId,{targetAgentId:'c',text:'Verify'},{commandKey:'stop-child'});finish(message.targetConversationId,'Waiting');
 await manager.stop(a.id);await vi.waitFor(()=>expect(manager.getAgentMessage(child.id).state).toBe('running'));finish(child.targetConversationId,'Verified');
 await running(message.targetConversationId);finish(message.targetConversationId,'Final checked answer');
 expect(manager.getAgentMessage(message.id)).toMatchObject({state:'succeeded',replyState:'parked',reply:'Final checked answer'});
 expect(store.getConversation(a.id)?.status).toBe('idle');
 expect(createConversationProgress(store,manager).list().find(row=>row.id===message.targetConversationId)?.state).toBe('completed');
 await manager.continue(a.id,'New unrelated work');finish(a.id,'New result');await new Promise(resolve=>setImmediate(resolve));
 expect(turns.filter(turn=>turn.text.includes('Agent reply (data)')&&turn.text.includes('Final checked answer'))).toHaveLength(0);
});


test('a fresh inquiry reopens a settled dedicated receiver while an idempotent retry does not reopen it',async()=>{
 const a=await source(),first=await manager.askAgent(a.id,{targetAgentId:'b',text:'First question'},{commandKey:'reusable-first'}),progress=createConversationProgress(store,manager);finish(a.id);
 await vi.waitFor(()=>expect(manager.getAgentMessage(first.id).state).toBe('running'));finish(first.targetConversationId,'First answer');
 expect(progress.list().find(row=>row.id===first.targetConversationId)?.state).toBe('completed');
 await manager.askAgent(a.id,{targetAgentId:'b',text:'First question'},{commandKey:'reusable-first'});
 expect(progress.list().find(row=>row.id===first.targetConversationId)?.state).toBe('completed');
 const second=await manager.askAgent(a.id,{targetAgentId:'b',targetConversationId:first.targetConversationId,text:'Second question'},{commandKey:'reusable-second'});
 expect(progress.list().find(row=>row.id===first.targetConversationId)?.state).toBe('queued');
 await vi.waitFor(()=>expect(manager.getAgentMessage(second.id).state).toBe('running'));
 expect(progress.list().find(row=>row.id===first.targetConversationId)?.state).toBe('running');finish(first.targetConversationId,'Second answer');
 expect(progress.list().find(row=>row.id===first.targetConversationId)?.state).toBe('completed');
});


test('receiver provenance is required before marking an inquiry-only conversation completed',async()=>{
 const a=await source(),message=await manager.askAgent(a.id,{targetAgentId:'b',text:'Old imported inquiry'},{commandKey:'unproven-old'});finish(a.id);
 await vi.waitFor(()=>expect(manager.getAgentMessage(message.id).state).toBe('running'));
 store.database.prepare('DELETE FROM agent_inquiry_conversations WHERE conversation_id=?').run(message.targetConversationId);
 finish(message.targetConversationId,'Answered');
 expect(createConversationProgress(store,manager).list().find(row=>row.id===message.targetConversationId)?.state).not.toBe('completed');
});

test('multiple nested inquiries must all be resolved before a single final upstream reply',async()=>{
 for(const id of ['c','d']){config.projects[0].agentIds.push(id);config.agents.push({...structuredClone(config.agents[1]),id,name:id});}
 const a=await source(),parent=await manager.askAgent(a.id,{targetAgentId:'b',text:'Check two dependencies'},{commandKey:'multi-parent'});finish(a.id);
 await vi.waitFor(()=>expect(manager.getAgentMessage(parent.id).state).toBe('running'));
 const first=await manager.askAgent(parent.targetConversationId,{targetAgentId:'c',text:'First dependency'},{commandKey:'multi-first'});
 const second=await manager.askAgent(parent.targetConversationId,{targetAgentId:'d',text:'Second dependency'},{commandKey:'multi-second'});finish(parent.targetConversationId,'Checking both');
 await vi.waitFor(()=>{expect(manager.getAgentMessage(first.id).state).toBe('running');expect(manager.getAgentMessage(second.id).state).toBe('running');});
 finish(second.targetConversationId,'Second confirmed');await running(parent.targetConversationId);finish(parent.targetConversationId,'Still waiting for first');
 expect(manager.getAgentMessage(parent.id)).toMatchObject({state:'running',reply:null});expect(store.getConversation(a.id)?.status).toBe('idle');
 finish(first.targetConversationId,'First confirmed');await running(parent.targetConversationId);finish(parent.targetConversationId,'Both verified');
 expect(manager.getAgentMessage(parent.id)).toMatchObject({state:'succeeded',reply:'Both verified'});
 await running(a.id);
 expect(turns.filter(turn=>turn.session===store.getConversation(a.id)?.nativeId&&turn.text.includes('Agent reply (data)'))).toHaveLength(1);
 expect(createConversationProgress(store,manager).list().find(row=>row.id===parent.targetConversationId)?.state).toBe('completed');
});


test('stopping a receiver that yielded to a nested inquiry reports failure upstream without orphaning the parent',async()=>{
 config.projects[0].agentIds.push('c');config.agents.push({...structuredClone(config.agents[1]),id:'c',name:'c'});
 const a=await source(),parent=await manager.askAgent(a.id,{targetAgentId:'b',text:'Check a dependency'},{commandKey:'cancel-receiver-parent'});finish(a.id);
 await vi.waitFor(()=>expect(manager.getAgentMessage(parent.id).state).toBe('running'));
 const child=await manager.askAgent(parent.targetConversationId,{targetAgentId:'c',text:'Verify'},{commandKey:'cancel-receiver-child'});finish(parent.targetConversationId,'Waiting');
 await vi.waitFor(()=>expect(manager.getAgentMessage(child.id).state).toBe('running'));
 await manager.stop(parent.targetConversationId);
 expect(manager.getAgentMessage(parent.id)).toMatchObject({state:'failed',reply:'询问已停止'});
 await running(a.id);
 finish(child.targetConversationId,'Late dependency');await new Promise(resolve=>setImmediate(resolve));
 expect(manager.getAgentMessage(child.id).replyState).toBe('parked');
 expect(store.getConversation(parent.targetConversationId)?.status).toBe('idle');
 expect(createConversationProgress(store,manager).list().find(row=>row.id===parent.targetConversationId)?.state).not.toBe('completed');
 expect(turns.filter(turn=>turn.session===store.getConversation(a.id)?.nativeId&&turn.text.includes('Agent reply (data)'))).toHaveLength(1);
});


test('a notify inquiry may answer upstream but keeps its dedicated source visible until background work settles',async()=>{
 config.projects[0].agentIds.push('c');config.agents.push({...structuredClone(config.agents[1]),id:'c',name:'c'});
 const a=await source(),parent=await manager.askAgent(a.id,{targetAgentId:'b',text:'Answer and notify a peer'},{commandKey:'notify-parent'});finish(a.id);
 await vi.waitFor(()=>expect(manager.getAgentMessage(parent.id).state).toBe('running'));
 const child=await manager.askAgent(parent.targetConversationId,{targetAgentId:'c',text:'Background check',policy:'notify'},{commandKey:'notify-child'});finish(parent.targetConversationId,'Answer is ready');
 expect(manager.getAgentMessage(parent.id).state).toBe('succeeded');
 expect(createConversationProgress(store,manager).list().find(row=>row.id===parent.targetConversationId)?.state).not.toBe('completed');
 await vi.waitFor(()=>expect(manager.getAgentMessage(child.id).state).toBe('running'));finish(child.targetConversationId,'Background result');
 await vi.waitFor(()=>expect(createConversationProgress(store,manager).list().find(row=>row.id===parent.targetConversationId)?.state).toBe('completed'));
 expect(manager.getAgentMessage(child.id).replyState).toBe('parked');
});


async function reportPresented(owner:{userId:string},taskId:string,conversationId:string,summary:string){
 await vi.waitFor(()=>{const receipt=manager.taskService.listReceipts(owner,taskId).find(receipt=>receipt.summary===summary)!;expect(receipt).toMatchObject({destinationConversationId:conversationId,policy:'notify',deliveryState:'presented'});expect(store.listEvents(conversationId,0)).toContainEqual(expect.objectContaining({kind:'task',data:expect.objectContaining({taskId,receiptId:receipt.id})}));});
 expect(store.getConversation(conversationId)?.status).toBe('idle');
}

test('a durable delegated executor waits for a lightweight peer and only delivers its final checked answer upstream',async()=>{
 config.projects[0].agentIds.push('c');config.agents.push({...structuredClone(config.agents[1]),id:'c',name:'c'});
 const owner={userId:store.ownerUserId},a=await source(),task=await manager.createTask(a.id,'b','Deliver final review after peer check');finish(a.id,'Waiting on B');
 await running(task.targetConversationId);
 const first=manager.taskService.listRuns(owner,task.id).at(-1)!,peer=await manager.askAgent(task.targetConversationId,{targetAgentId:'c',text:'Verify the prerequisite'},{commandKey:'durable-peer'});
 const current=manager.taskService.getTask(owner,task.id);
 manager.taskService.requestCompletion({...owner,agentId:'b',runId:first.id},task.id,current.revision,'intermediate-intent');
 finish(task.targetConversationId,'Waiting on C, review not final');
 await vi.waitFor(()=>expect(manager.getAgentMessage(peer.id).state).toBe('running'));
 expect(manager.taskService.getRun(owner,first.id).state).toBe('succeeded');
 expect(manager.taskService.getTask(owner,task.id)).toMatchObject({state:'waiting',waitingReason:'input',completion:null});
 expect(manager.taskService.listReceipts(owner,task.id)).toEqual([]);expect(store.getConversation(a.id)?.status).toBe('idle');
 finish(peer.targetConversationId,'Peer verified');
 await running(task.targetConversationId);
 const resumed=manager.taskService.listRuns(owner,task.id).at(-1)!;expect(resumed.id).not.toBe(first.id);
 expect(resumed).toMatchObject({executionId:first.executionId,state:'running',routing:{executionConversationId:task.targetConversationId,destinationConversationId:a.id}});
 expect(manager.taskService.getRun(owner,first.id).nativeTurnId).not.toBe(resumed.nativeTurnId);
 const finalTask=manager.taskService.getTask(owner,task.id),finalToken=businessCliContext(instructions).token;
 expect(await manager.callBoundTool(finalToken,'task_mark_completed',{taskId:task.id,expectedRevision:finalTask.revision},'final-intent')).toMatchObject({completionRequested:true});
 finish(task.targetConversationId,'Final reviewed answer after peer verified');
 await vi.waitFor(()=>expect(manager.taskService.getTask(owner,task.id)).toMatchObject({state:'completed',completion:{completedBy:'agent',sourceRunId:resumed.id}}));
 const receipts=manager.taskService.listReceipts(owner,task.id);expect(receipts).toHaveLength(1);expect(receipts[0].summary).toBe('Final reviewed answer after peer verified');
 await reportPresented(owner,task.id,a.id,'Final reviewed answer after peer verified');
});


async function durablePeer(key:string){
 config.projects[0].agentIds.push('c');config.agents.push({...structuredClone(config.agents[1]),id:'c',name:'c'});
 const owner={userId:store.ownerUserId},a=await source(),task=await manager.createTask(a.id,'b','Deliver final review after peer check');finish(a.id,'Waiting on B');
 await running(task.targetConversationId);
 const first=manager.taskService.listRuns(owner,task.id).at(-1)!,peer=await manager.askAgent(task.targetConversationId,{targetAgentId:'c',text:'Verify prerequisite'},{commandKey:key});
 finish(task.targetConversationId,'Waiting on peer');await vi.waitFor(()=>expect(manager.getAgentMessage(peer.id).state).toBe('running'));
 return {owner,a,task,first,peer};
}
function ageActivity(hours:number){
 const old=new Date(Date.now()-hours*3600000).toISOString();
 store.database.prepare('UPDATE events SET createdAt=?').run(old);
 store.database.prepare("UPDATE conversations SET data=json_set(data,'$.createdAt',?)").run(old);
 for(const table of ['work_tasks','task_runs','outbox'])store.database.prepare('UPDATE '+table+' SET created_at=?').run(old);
 store.database.prepare('UPDATE conversation_progress SET visited_at=?,changed_at=?').run(old,old);
}

test('an old mixed Task inquiry stays live beyond six hours, but stopping upstream A expires only A and parks its final receipt',async()=>{
 const {owner,a,task,peer}=await durablePeer('aged-mixed'),progress=createConversationProgress(store,manager);ageActivity(7);
 let rows=progress.list();expect(rows.find(row=>row.id===a.id)).toMatchObject({active:true,withinWindow:false,state:'waiting'});
 expect(rows.find(row=>row.id===task.targetConversationId)).toMatchObject({active:true,withinWindow:false,state:'waiting'});
 expect(manager.taskService.getTask(owner,task.id).live).toBe(true);
 await manager.stop(a.id);rows=progress.list();expect(rows.find(row=>row.id===a.id)?.active).toBe(false);expect(rows.find(row=>row.id===task.targetConversationId)?.active).toBe(true);
 finish(peer.targetConversationId,'Peer verified');await running(task.targetConversationId);
 const current=manager.taskService.getTask(owner,task.id);await manager.callBoundTool(businessCliContext(instructions).token,'task_mark_completed',{taskId:task.id,expectedRevision:current.revision},'aged-final-intent');finish(task.targetConversationId,'Final checked answer');
 await vi.waitFor(()=>expect(manager.taskService.getTask(owner,task.id).state).toBe('completed'));
 expect(manager.taskService.listReceipts(owner,task.id)).toMatchObject([{deliveryState:'parked',summary:'Final checked answer'}]);expect(store.getConversation(a.id)?.status).toBe('idle');
});

test('unknown peer state alone does not keep a mixed inquiry alive beyond six hours',async()=>{
 const {owner,a,task,peer}=await durablePeer('unknown-mixed'),progress=createConversationProgress(store,manager);ageActivity(7);
 const c=store.getConversation(peer.targetConversationId)!;native.get(c.nativeId!)!.onExit('Native peer disconnected');
 expect(manager.getAgentMessage(peer.id).state).toBe('unknown');expect(manager.taskService.getTask(owner,task.id).live).toBe(false);
 const rows=progress.list();expect(rows.find(row=>row.id===a.id)?.active).toBe(false);expect(rows.find(row=>row.id===task.targetConversationId)).toMatchObject({active:false,state:'attention'});
});

test.each(['task','conversation'])('stopping waiting mixed B via %s keeps C independent and returns one honest interruption',async(entry)=>{
 const {owner,a,task,first,peer}=await durablePeer('stop-mixed');
 if(entry==='task')await manager.stopDurableTask(task.id,manager.taskService.getTask(owner,task.id).revision);
 else await manager.stop(task.targetConversationId);
 expect(manager.taskService.getTask(owner,task.id).futureAutoResume).toBe(entry==='conversation');
 expect(manager.taskService.getRun(owner,first.id).state).toBe('succeeded');expect(store.getConversation(peer.targetConversationId)?.status).toBe('running');
 if(entry==='conversation')await running(a.id);else expect(store.getConversation(a.id)?.status).toBe('idle');
 const receipts=manager.taskService.listReceipts(owner,task.id);expect(receipts).toHaveLength(1);expect(receipts[0].destinationConversationId).toBe(a.id);expect(receipts[0].summary).toContain('stopped while waiting');if(entry==='conversation'){expect(['pending','presented']).toContain(receipts[0].deliveryState);expect(receipts[0].claimedByRunId).toBeTruthy();}else{expect(receipts[0].deliveryState).toBe('parked');expect(manager.taskService.getTask(owner,task.id)).toMatchObject({state:'waiting',waitingReason:'interrupted'});}
 finish(peer.targetConversationId,'Late peer result');await new Promise(resolve=>setImmediate(resolve));
 expect(manager.getAgentMessage(peer.id).replyState).toBe('parked');expect(manager.taskService.listRuns(owner,task.id)).toHaveLength(entry==='conversation'?2:1);
 expect(manager.taskService.listReceipts(owner,task.id)).toHaveLength(1);expect(store.getConversation(task.targetConversationId)?.status).toBe('idle');
});

test('recovery of a saved peer answer resumes the same durable Task with a distinct native Run',async()=>{
 const {owner,a,task,first,peer}=await durablePeer('recover-mixed');
 const c=store.getConversation(peer.targetConversationId)!;native.get(c.nativeId!)!.onEvent({method:'item/completed',params:{threadId:c.nativeId,turnId:c.turnId,item:{id:'saved-peer',type:'agentMessage',phase:'final_answer',text:'Saved peer verification'}}});
 await manager.close();store.close();store=openStore(home);inspection='succeeded';manager=createSessionManager(store,async()=>structuredClone(config),factory,undefined,home);await manager.reconcileRuns('local');
 await running(task.targetConversationId);
 const resumed=manager.taskService.listRuns(owner,task.id).at(-1)!;expect(resumed.id).not.toBe(first.id);expect(resumed.state).toBe('running');expect(turns.at(-1)?.text).toContain('Saved peer verification');expect(store.getConversation(a.id)?.status).toBe('idle');
 const current=manager.taskService.getTask(owner,task.id);await manager.callBoundTool(businessCliContext(instructions).token,'task_mark_completed',{taskId:task.id,expectedRevision:current.revision},'recover-final-intent');finish(task.targetConversationId,'Recovered final answer');
 await vi.waitFor(()=>expect(manager.taskService.getTask(owner,task.id).state).toBe('completed'));expect(manager.taskService.listReceipts(owner,task.id)).toMatchObject([{summary:'Recovered final answer'}]);
 await reportPresented(owner,task.id,a.id,'Recovered final answer');
});

test('recovering the saved final Task answer consumes its correlated inquiry before terminal assessment',async()=>{
 const {owner,a,task,peer}=await durablePeer('recover-final-mixed');finish(peer.targetConversationId,'Peer verified');await running(task.targetConversationId);
 const resumed=manager.taskService.listRuns(owner,task.id).at(-1)!,current=manager.taskService.getTask(owner,task.id);await manager.callBoundTool(businessCliContext(instructions).token,'task_mark_completed',{taskId:task.id,expectedRevision:current.revision},'saved-final-intent');
 const b=store.getConversation(task.targetConversationId)!;native.get(b.nativeId!)!.onEvent({method:'item/completed',params:{threadId:b.nativeId,turnId:b.turnId,item:{id:'saved-task-final',type:'agentMessage',phase:'final_answer',text:'Saved final Task answer'}}});
 await manager.close();store.close();store=openStore(home);inspection='succeeded';manager=createSessionManager(store,async()=>structuredClone(config),factory,undefined,home);await manager.reconcileRuns('local');
 expect(manager.getAgentMessage(peer.id).replyState).toBe('consumed');expect(manager.taskService.getRun(owner,resumed.id).state).toBe('succeeded');
 expect(manager.taskService.getTask(owner,task.id)).toMatchObject({state:'completed',completion:{completedBy:'agent',sourceRunId:resumed.id}});
 expect(manager.taskService.listReceipts(owner,task.id)).toMatchObject([{summary:'Saved final Task answer'}]);
 await reportPresented(owner,task.id,a.id,'Saved final Task answer');
});


test.each(['unknown','succeeded'] as const)('an interrupted reply resumes only from exact terminal proof (%s)',async(outcome)=>{
 const a=await source(),message=await manager.askAgent(a.id,{targetAgentId:'b',text:'Confirm a detail'},{commandKey:'reply-recovery'});finish(a.id);
 await vi.waitFor(()=>expect(manager.getAgentMessage(message.id).state).toBe('running'));finish(message.targetConversationId,'Verified');await running(a.id);
 const current=store.getConversation(a.id)!;native.get(current.nativeId!)!.onEvent({method:'item/completed',params:{threadId:current.nativeId,turnId:current.turnId,item:{id:'saved-source-final',type:'agentMessage',phase:'final_answer',text:'Handled verified reply'}}});
 const before=turns.length;await manager.close();store.close();store=openStore(home);inspection=outcome;manager=createSessionManager(store,async()=>structuredClone(config),factory,undefined,home);await manager.reconcileRuns('local');
 expect(turns).toHaveLength(before);expect(manager.getAgentMessage(message.id).replyState).toBe(outcome==='succeeded'?'consumed':'queued');
 if(outcome==='unknown'){
  const progress=createConversationProgress(store,manager);ageActivity(7);expect(progress.list().find(row=>row.id===a.id)).toMatchObject({active:false,state:'attention'});
  await manager.stop(a.id);expect(manager.getAgentMessage(message.id).replyState).toBe('parked');
 }
});

test.each(['move','mark-completed','agent'] as const)('explicit %s completion while B waits records one parked decision and parks late peer work',async(entry)=>{
 const {owner,a,task,first,peer}=await durablePeer('manual-decision');const current=manager.taskService.getTask(owner,task.id);
 if(entry==='agent'){
  const actor=await manager.create('p','b',undefined,undefined,{workspaceId:null});await manager.send(actor.id,'Record an explicit completion decision');
  await manager.callBoundTool(businessCliContext(instructions).token,'task_mark_completed',{taskId:task.id,expectedRevision:current.revision},'manual-agent-done');finish(actor.id,'Decision recorded');
 }else{
  const server=createHttpServer({home,store,manager,requireIdentity:false});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
   const base='http://127.0.0.1:'+(server.address() as {port:number}).port,result=await fetch(base+'/api/v2/tasks/'+task.id+'/'+entry,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'manual-user-done'},body:JSON.stringify({expectedRevision:current.revision,...(entry==='move'?{state:'completed'}:{})})});
   expect(result.status,await result.text()).toBe(200);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
 }
 expect(manager.taskService.getTask(owner,task.id).state).toBe('completed');expect(manager.taskService.getRun(owner,first.id).state).toBe('succeeded');
 expect(store.getConversation(a.id)?.status).toBe('idle');
 const receipts=manager.taskService.listReceipts(owner,task.id);expect(receipts).toHaveLength(1);expect(receipts[0]).toMatchObject({deliveryState:'parked',destinationConversationId:a.id});expect(receipts[0].summary).not.toBe('Waiting on peer');
 finish(peer.targetConversationId,'Late peer detail');await new Promise(resolve=>setImmediate(resolve));
 expect(manager.getAgentMessage(peer.id).replyState).toBe('parked');expect(manager.taskService.listRuns(owner,task.id)).toHaveLength(1);expect(manager.taskService.listReceipts(owner,task.id)).toHaveLength(1);
});
