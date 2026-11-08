import {ensureConfiguredMandala} from './configured-mandala';
import { readFileSync } from "node:fs";

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readConfig, writeConfig } from '../server/config';
import { createSessionManager } from '../server/sessions';
import { createTelegramWorkspace } from '../server/telegram-workspace';
import { createAssetFiles } from '../server/asset-files';
import { createAssets } from '../server/assets';
import { MAX_ATTACHMENT_SIZE } from '../server/attachments';
import { openStore } from '../server/store';
import type { CodexOptions } from '../server/codex';

let home:string,store:ReturnType<typeof openStore>,manager:ReturnType<typeof createSessionManager>;
let events:CodexOptions, nativeTurns:string[], replies:unknown[], primary:string;
let workspace:ReturnType<typeof createTelegramWorkspace>;
const allow=()=>{};
const binding='fixture-binding';
beforeEach(async()=>{
  home=await mkdtemp(join(tmpdir(),'telegram-workspace-'));
  await ensureConfiguredMandala(home);
  store=openStore(home);
  nativeTurns=[];replies=[];
  manager=createManager();
  workspace=createTelegramWorkspace(home,store,manager);
  primary=await workspace.primary(allow);
});
function createManager(){
  return createSessionManager(store,async()=>(await readConfig(home)).config,async options=>{
    events=options;
    return {getStatus:async()=>({status:'ready',version:'fixture'}),listModels:async()=>[],
      startThread:async()=> 'telegram-native',resumeThread:async()=>{},
      startTurn:async(_thread, text)=>{nativeTurns.push(text);return 'turn-'+nativeTurns.length;},
      interrupt:async()=>{},replyApproval:(_id,value)=>{replies.push(value);},close(){}};
  },undefined,home);
}
afterEach(async()=>{await manager.close();store.close();await rm(home,{recursive:true,force:true});});

async function begin() {
  const id=workspace.enqueue(primary,'phone request',binding+':1',binding,[]);
  await vi.waitFor(()=>expect(store.getConversation(primary)?.turnId).toBe('turn-1'));
  return id;
}
function end(text:string) {
  events.onEvent({method:'item/completed',params:{threadId:'telegram-native',turnId:'turn-1',item:{id:'thought',type:'agentMessage',text:'internal commentary',phase:'commentary'}}});
  events.onEvent({method:'item/completed',params:{threadId:'telegram-native',turnId:'turn-1',item:{id:'answer',type:'agentMessage',text,phase:'final_answer'}}});
  events.onEvent({method:'turn/completed',params:{threadId:'telegram-native',turn:{id:'turn-1',status:'completed'}}});
}
function approval(params:Record<string,unknown>={}) {
  events.onApproval({id:'command-1',method:'item/commandExecution/requestApproval',
    params:{threadId:'telegram-native',turnId:'turn-1',itemId:'item-1',command:'printf hello',cwd:home,...params}});
}
const cards=()=>workspace.cards(binding,new Date(0).toISOString(),()=>false,true);

describe('Mandala routing for Telegram',()=>{
  it('supports single command approval when Codex offers cancel instead of decline',async()=>{
    await begin();approval({availableDecisions:['accept','cancel']});
    const card=cards().find(c=>c.buttons?.some(b=>b.action.kind==='decision'))!;
    expect(card?.buttons?.map(b=>b.text)).toEqual(['允许本次','拒绝']);
    const action=card.buttons![1].action;
    if(action.kind!=='decision')throw new Error('missing decision');
    await workspace.decide(action.target,'reject',allow);
    expect(replies).toEqual([{decision:'cancel'}]);
    await expect(workspace.decide(action.target,'approve',allow)).rejects.toThrow();
  });

  it('restores an unanswered async form after restart and correlates its phone answer result',async()=>{
    await begin();
    events.onEvent({method:'item/completed',params:{threadId:'telegram-native',turnId:'turn-1',item:{
      id:'restart-question',type:'agentMessage',delivery:'async',phase:'final_answer',text:'Choose',questions:[{title:'Drink?',options:['Tea','Coffee']}],
    }}});
    end('Waiting');
    const original=cards().find(c=>c.buttons?.some(b=>b.action.kind==='question'))!;
    await manager.close();
    manager=createManager();workspace=createTelegramWorkspace(home,store,manager);
    const restored=cards().find(c=>c.key===original.key)!;
    expect(restored).toBeDefined();
    const action=restored.buttons![0].action;
    if(action.kind!=='question')throw new Error('missing question');
    const input=workspace.submitAsyncQuestion!(action.target,{'0':{answers:['Tea']}},binding+':reply',allow)!;
    expect(manager.listUserInputs(primary).find(i=>i.id===input.inputId)?.source).toEqual({kind:'telegram',requestId:binding+':reply'});
    expect(cards().some(c=>c.key===original.key)).toBe(false);
    await vi.waitFor(()=>expect(nativeTurns).toHaveLength(2));
    events.onEvent({method:'item/completed',params:{threadId:'telegram-native',turnId:'turn-2',item:{id:'reply',type:'agentMessage',text:'Tea selected',phase:'final_answer'}}});
    events.onEvent({method:'turn/completed',params:{threadId:'telegram-native',turn:{id:'turn-2',status:'completed'}}});
    expect(workspace.result(primary,input.inputId)?.text).toBe('Tea selected');
    await manager.close();manager=createManager();workspace=createTelegramWorkspace(home,store,manager);
    expect(cards().some(c=>c.key===original.key)).toBe(false);
  });

  it('keeps asynchronous Codex questions actionable after the native turn ends and resumes once',async()=>{
    await begin();
    events.onEvent({method:'item/completed',params:{threadId:'telegram-native',turnId:'turn-1',item:{
      id:'call-question',type:'agentMessage',delivery:'async',phase:'final_answer',text:'Choose a drink',
      questions:[{title:'Drink?',options:['Tea','Coffee']},{title:'Temperature?',options:['Hot','Cold']}],
    }}});
    end('Waiting for your answers');
    const card=cards().find(c=>c.buttons?.some(b=>b.action.kind==='question'));
    expect(card).toBeDefined();
    const action=card!.buttons![0].action;
    if(action.kind!=='question')throw new Error('missing question');
    const questions=workspace.question!(action.target)!;
    expect(questions.map(q=>q.question)).toEqual(['Drink?','Temperature?']);
    await expect(workspace.decide(action.target,{[questions[0].id]:{answers:['Tea']}},allow)).rejects.toThrow();
    expect(workspace.question!(action.target)).toHaveLength(2);
    await manager.answerQuestions(primary,action.target.id,Object.fromEntries(questions.map((q,i)=>[q.id,{answers:[i?'Cold':'Tea']}])));
    expect(workspace.question!(action.target)).toBeUndefined();
    await expect(workspace.decide(action.target,{},allow)).rejects.toThrow();
    await vi.waitFor(()=>expect(nativeTurns).toHaveLength(2));
    expect(nativeTurns[1]).toContain('<send_user_message_question_reply>');
    expect(nativeTurns[1]).toContain('call-question');
    expect(replies).toEqual([]);
  });

  it('uses the main durable queue and mirrors only a correlated final reply',async()=>{
    const input=await begin();
    const replay=workspace.enqueue(primary,'phone request',binding+':1',binding,[]);
    expect(replay).toBe(input);
    expect(workspace.result(primary,input)).toBeUndefined();
    const user=store.listEvents(primary,0).find(e=>e.kind==='user');
    expect(user?.data).toMatchObject({text:'phone request',source:{kind:'telegram',requestId:binding+':1'}});
    end('Complete response');
    expect(workspace.result(primary,input)).toMatchObject({text:'Complete response'});
    expect(nativeTurns).toHaveLength(1);
    const ordinary=store.createConversation({agentId:'unrelated',projectId:'',cli:'codex',model:null});
    expect(()=>workspace.enqueue(ordinary.id,'bad',binding+':2',binding,[])).toThrow();
    const desktop=manager.enqueueUserInput(primary,'desktop only','desktop-1');
    expect(workspace.result(primary,desktop.id)).toBeUndefined();
  });

  it('projects only current single approval choices and invalidates a stale Telegram action after desktop decision',async()=>{
    await begin();approval();
    const card=cards().find(c=>c.buttons?.some(b=>b.action.kind==='decision'))!;
    expect(card.text).toContain('printf hello');
    const button=card.buttons?.find(b=>b.action.kind==='decision'&&b.action.decision==='approve')!;
    if(button.action.kind!=='decision')throw new Error('missing approval');
    const target=button.action.target;
    await manager.approve(primary,manager.getApprovals(primary)[0].id,'reject');
    expect(cards().some(c=>c.key===card.key)).toBe(false);
    await expect(workspace.decide(target,'approve',allow)).rejects.toThrow();
    expect(replies).toEqual([{decision:'decline'}]);
  });

  it('keeps expanded filesystem permission on desktop',async()=>{
    await begin();approval({grantRoot:home});
    expect(cards().some(c=>c.buttons?.length)).toBe(false);
    expect(cards().map(c=>c.text).join(' ')).toContain('桌面');
    expect(replies).toEqual([]);
  });

  it('keeps secret input on the desktop without publishing its prompt',async()=>{
    await begin();
    events.onApproval({id:'secret-1',method:'item/tool/requestUserInput',params:{threadId:'telegram-native',turnId:'turn-1',
      questions:[{id:'pw',header:'Password',question:'Private prompt',isSecret:true}]}});
    expect(cards().map(c=>c.text).join(' ')).toContain('桌面');
    expect(JSON.stringify(cards())).not.toContain('Private prompt');
    expect(cards().some(c=>c.buttons?.length)).toBe(false);
  });
});

function coordinationSource() {
  const event=store.listEvents(primary,0).find(event=>event.kind==='user')!;
  return {agentId:store.getConversation(primary)!.agentId,conversationId:primary,invocationId:manager.executionId(primary)!,humanEventId:event.id};
}
const newGoal=(goal:string)=>({goal,criteria:[{id:'evidence',text:'Show evidence',checkRef:null}],projectId:null});

it('scopes task attention and replies to the owned task revision',async()=>{
  await begin();
  const source=coordinationSource(),task=await manager.coordination.create(source,newGoal('Owned task'),'create-owned');
  const unrelated=manager.taskService.createTask({userId:store.ownerUserId},newGoal('Unrelated task'),'unrelated');
  expect(workspace.task(task.id)?.originBinding).toBe(binding);
  expect(workspace.task(unrelated.id)).toBeUndefined();
  const waiting=await manager.coordination.request(source,{taskId:task.id,expectedRevision:task.revision,text:'Choose the Singapore region'},'request-owned');
  expect(workspace.cards(binding,new Date(0).toISOString(),()=>false,false)).toEqual([]);
  const card=cards().find(card=>card.taskId===task.id)!;
  expect(card.text).toContain('Choose the Singapore region');
  expect(card.reply).toEqual({taskId:task.id,revision:waiting.revision});
  expect(workspace.taskReply!(card.reply!,'yes')).toContain(task.id);
  expect(workspace.taskReply!(card.reply!,'yes')).toContain('yes');
  await manager.coordination.request(source,{taskId:task.id,expectedRevision:waiting.revision,text:'Choose the London region'},'request-new');
  expect(()=>workspace.taskReply!(card.reply!,'yes')).toThrow();
});

it('includes an already completed phone goal in the correlated answer without sending a second completion card',async()=>{
  const input=await begin();
  const task=await manager.coordination.create(coordinationSource(),newGoal('Phone task'),'phone-task');
  const actor={userId:store.ownerUserId},review=manager.taskService.userCommand(actor,task.id,task.revision,'complete');
  manager.taskService.userCommand(actor,task.id,review.revision,'accept');
  const notifications=()=>workspace.cards(binding,new Date(0).toISOString(),()=>true,true);
  expect(notifications().find(card=>card.taskId===task.id)).toBeUndefined();
  end('Finished');
  expect(workspace.result(primary,input)?.text).toContain('Phone task');
  expect(notifications().find(card=>card.taskId===task.id)).toBeUndefined();
});

it('offers authorized run output by name and refuses a changed or unrelated asset',async()=>{
  const input=await begin(),runId=manager.executionId(primary)!;
  const files=createAssetFiles(home),assets=createAssets(store,files),principal={userId:store.ownerUserId,runId};
  await writeFile(join(home,'authorized.txt'),'result content');
  await writeFile(join(home,'large.bin'),Buffer.alloc(MAX_ATTACHMENT_SIZE+1));
  const stage=await files.stageFiles(principal,runId,['authorized.txt','large.bin'].map(path=>({allowedRoot:home,relativePath:path,manifestPath:path})));
  const published=assets.importAsset(principal,{kind:'file',title:'Run output',submissionId:stage.submissionId},'publish-fixture');
  end('Finished');
  const result=workspace.result(primary,input)!;
  expect(result.unavailableFiles).toEqual([expect.stringMatching(/large.bin.*MiB.*桌面/)]);
  const button=result.files.find(button=>button.text.includes('authorized.txt'))!;
  if(button.action.kind!=='file')throw new Error('missing file action');
  expect(Buffer.from((await workspace.file(button.action.file,allow)).bytes).toString()).toBe('result content');
  await expect(workspace.file({...button.action.file,runId:'wrong'},allow)).rejects.toThrow();
  assets.setLifecycle(principal,published.asset.id,'retracted',published.asset.revision);
  await expect(workspace.file(button.action.file,allow)).rejects.toThrow();
});

it('does not report a phone rejection when a concurrent desktop approval wins',async()=>{
  await begin();
  const proposal=await manager.coordination.configure(coordinationSource(),{kind:'project',action:'create',values:{
    id:'race-project',name:'Race Project',cwd:'',agentIds:[],resources:[],mcp:[],skills:[],
  }},'propose','race-project',allow);
  const action=cards().find(card=>card.key.includes(proposal.id))!.buttons![1].action;
  if(action.kind!=='decision')throw new Error('missing proposal action');
  const desktop=manager.coordination.confirm(proposal.id,proposal.version,'approve',allow);
  await expect(workspace.decide(action.target,'reject',allow)).rejects.toThrow();
  expect((await desktop).status).toBe('applied');
});

it('rejects a configuration proposal if the configuration changed after the card',async()=>{
  await begin();
  const source=coordinationSource();
  const proposal=await manager.coordination.configure(source,{kind:'agent',action:'create',values:{
    id:'fixture-agent',name:'Fixture Agent',defaultCli:'codex',instructions:'fixture',models:{},mcp:[],skills:[],
  }},'propose','new-agent',allow);
  const card=cards().find(card=>card.key.includes(proposal.id))!;
  expect(card.text).toContain('Fixture Agent');
  const button=card.buttons?.find(button=>button.action.kind==='decision'&&button.action.decision==='approve')!;
  if(button.action.kind!=='decision')throw new Error('missing proposal action');
  const {config,revision}=await readConfig(home);
  await writeConfig(home,{...config,agents:[...config.agents,{id:'other',name:'Other',defaultCli:'codex',instructions:'',models:{},mcp:[],skills:[]}]},revision);
  expect(cards().find(candidate=>candidate.key===card.key)).toBeUndefined();
  await expect(workspace.decide(button.action.target,'approve',allow)).rejects.toThrow();
  expect((await readConfig(home)).config.agents.some(agent=>agent.id==='fixture-agent')).toBe(false);
});

it('publishes a guarded configuration before yielding after the final authorization check',async()=>{
  const {config,revision}=await readConfig(home);
  let checks=0;
  let observed=false;
  const saved={...config,agents:[...config.agents,{id:'atomic-agent',name:'Atomic Agent',defaultCli:'codex' as const,instructions:'',models:{},mcp:[],skills:[]}]};
  await writeConfig(home,saved,revision,()=>{
    if(++checks===2) queueMicrotask(()=>{
      observed=JSON.parse(readFileSync(join(home,'config.json'),'utf8')).agents.some((agent:{id:string})=>agent.id==='atomic-agent');
    });
  });
  expect(observed).toBe(true);
});

it('keeps the desktop hint when combined authorized run outputs exceed the keyboard limit',async()=>{
  const input=await begin(),source=coordinationSource();
  const task=await manager.coordination.create(source,newGoal('Artifact task'),'artifact-task');
  const {taskService}=manager,userId=store.ownerUserId,actor={userId},agentId=source.agentId;
  const runId='artifact-child',hostId='local';
  const prepared=taskService.prepareStart(actor,task.id,task.revision,'fixture-child',runId,{agentId,selection:{
    agentId,projectId:null,hostId,input:'fixture',sourceVersions:[],requiredOutputAssetIds:[],effectiveCapabilities:[],nativeVisibility:'partial',
  }});
  store.transaction(()=>prepared.commit());
  const identity={runId,hostId,nativeSessionId:'fixture-child-session',nativeTurnId:'fixture-child-turn'};
  expect(taskService.bindRunIdentity(identity)).toBe('applied');
  const files=createAssetFiles(home),assets=createAssets(store,files);
  await writeFile(join(home,'source.txt'),'result content');
  const publish=async(runId:string,names:string[],owner?:string)=>{
    const principal={userId,runId,...(owner?{agentId:owner}:{})};
    const stage=await files.stageFiles(principal,runId,names.map(manifestPath=>({allowedRoot:home,relativePath:'source.txt',manifestPath})));
    const {asset,version}=assets.importAsset(principal,{kind:'file',title:'Output',agentId:owner,submissionId:stage.submissionId},'publish-'+runId);
    return {assetId:asset.id,versionId:version.id};
  };
  await publish(source.invocationId,Array.from({length:20},(_,i)=>'output-'+i+'.txt'));
  const childArtifact=await publish(runId,['child.txt'],agentId);
  expect(taskService.applyRunEvent({...identity,eventKey:'fixture-complete',outcome:'succeeded',summary:'done',artifactVersions:[childArtifact]})).toBe('applied');
  const review=taskService.getTask(actor,task.id);
  taskService.userCommand(actor,task.id,review.revision,'accept');
  end('Finished');
  const result=workspace.result(primary,input)!;
  expect(result.files).toHaveLength(20);
  expect(result.unavailableFiles).toContain('其余文件请在桌面查看。');
});
