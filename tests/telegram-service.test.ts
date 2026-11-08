import { DomainError } from "../shared/workspace-contracts";

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_ATTACHMENT_SIZE } from '../server/attachments';
import type { TelegramDecision } from '../server/telegram';
import { openStore } from '../server/store';
import { createTelegramService, type TelegramWorkspace } from '../server/telegram';

const token = '123456:fixture_token_not_a_real_secret';
const sender = {id: 42, first_name:'Ada', username:'ada', is_bot:false};
const privateChat = {id:42,type:'private'};
const clean: (()=>void)[] = [];
afterEach(() => { for (const close of clean.splice(0).reverse()) close(); });

function fixture() {
  const home = mkdtempSync(join(tmpdir(),'mandala-telegram-')), store = openStore(home);
  clean.push(() => {store.close();rmSync(home,{recursive:true,force:true});});
  let holdNextSend=false;
  let clock=Date.parse('2026-11-08T08:00:00Z'), serial=10, webhook='', failure=0, ambiguous=false, outage=false, sendFailure=0, filePath='documents/fixture.txt';
  const updates: Record<string, unknown>[] = [], calls:string[]=[], sends: any[]=[], documents:FormData[]=[], attachments:string[][]=[], toasts:string[]=[];
  const primary=store.createConversation({agentId:'mandala',projectId:'',cli:'codex',model:null,purpose:'mandala-main'});
  const workspace: TelegramWorkspace = {
    async primary() {return primary.id;},
    enqueue(conversationId,text,requestId,_binding,files) {
      const existing=store.listEvents(conversationId,0).find(e=>(e.data as {requestId?:string}).requestId===requestId);
      attachments.push(files);
      return String((existing??store.appendEvent(conversationId,'user',{text,requestId})).id);
    },
    cards: () => [],
    result: () => undefined,
    task: () => undefined,
    attachment: async (_id,name) => name,
    file: async () => {throw new Error('Unexpected file');},
    decide: async () => {throw new Error('Unexpected decision');},
    progress: () => [],
  };
  const fetcher: typeof fetch = async (url, init) => {
    const method = String(url).split('/').at(-1)!;
    calls.push(method);
    const body=typeof init?.body==='string'?JSON.parse(init.body):{};
    const ok=(result:unknown)=>Response.json({ok:true,result});
    if(method==='getMe')return ok({id:123456,first_name:'Fixture Bot',username:'fixture_bot',is_bot:true});
    if(method==='getWebhookInfo')return ok({url:webhook,has_custom_certificate:false,pending_update_count:0});
    if(method==='getUpdates'){
      if(outage)throw new TypeError('fixture network offline');
      if(failure)return Response.json({ok:false,error_code:failure,description:'should not be forwarded'},{status:failure});
      while(updates.length&&Number(updates[0].update_id)<(body.offset??0))updates.shift();
      return ok(updates.slice(0,100));
    }
    if(method==='sendMessage'){
      sends.push({...body,id:++serial});
      if(holdNextSend){
        holdNextSend=false;
        return new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new Error('fixture interrupted send')),{once:true}));
      }
      if(ambiguous)throw new TypeError('fixture lost response');
      if(sendFailure)return Response.json({ok:false,error_code:sendFailure,description:'fixture refusal'},{status:sendFailure});
      return ok({message_id:serial,date:Math.floor(clock/1000),chat:privateChat,text:body.text});
    }
    if(method==='setMyCommands')return ok(true);
    if(method==='getFile')return ok({file_id:body.file_id,file_unique_id:'fixture-file',file_path:filePath});
    if(String(url).includes('/file/'))return new Response('fixture bytes');
    if(method==='sendDocument'||method==='sendPhoto'){
      documents.push(init?.body as FormData);
      return ok({message_id:++serial,date:Math.floor(clock/1000),chat:privateChat});
    }
    if(method==='answerCallbackQuery'){toasts.push(body.text);return ok(true);}
    throw new Error('Unexpected request');
  };
  const create=()=>createTelegramService({home,store,workspace,fetch:fetcher,now:()=>clock});
  const service=create();
  clean.push(()=>service.stop());
  const message=(text:string, from=sender, chat=privateChat, reply?:number)=> {
    const id=++serial;
    updates.push({update_id:id,message:{message_id:id,from,chat,date:Math.floor(clock/1000),text,...(reply?{reply_to_message:{message_id:reply}}:{})}});
  };
  const media=(extra:Record<string,unknown>)=>{const id=++serial;updates.push({update_id:id,message:{message_id:id,from:sender,chat:privateChat,date:Math.floor(clock/1000),...extra}});};
  const press=(data:string, id:number, from=sender, chat=privateChat)=>{
    updates.push({update_id:++serial,callback_query:{id:String(serial),from,data,message:{message_id:id,chat,date:Math.floor(clock/1000)}}});
  };
  const pair=async()=>{
    await service.configure(token);
    await service.poll();
    const url=service.pair().pairing!.url;
    message('/start '+new URL(url).searchParams.get('start'));
    await service.poll();
    return url;
  };
  const bind=async()=>{
    await pair();
    service.confirm(42);
    clock+=1000;
    await service.poll();
  };
  const submitted=()=>store.listEvents(primary.id,0).filter(e=>e.kind==='user').map(e=>(e.data as {text:string}).text);
  return {service,create,store,workspace,updates,calls,sends,documents,attachments,toasts,submitted,message,media,press,pair,bind,
    holdSend:()=>{holdNextSend=true;},sendFailure:(code:number)=>{sendFailure=code;},filePath:(path:string)=>{filePath=path;},
    webhook:(value:string)=>{webhook=value;},failure:(value:number)=>{failure=value;},
    advance:(ms:number)=>{clock+=ms;},ambiguous:(value:boolean)=>{ambiguous=value;},outage:(value:boolean)=>{outage=value;},
    lastMessageId:()=>serial};
}

describe('Telegram binding and durable input',()=>{
  it('does no network work until configured and preserves an existing webhook',async()=>{
    const f=fixture();
    await f.service.poll();
    expect(f.calls).toEqual([]);
    f.webhook('https://example.invalid/existing');
    expect(await f.service.configure(token)).toMatchObject({configured:false,state:'conflict'});
    expect(f.calls).toEqual(['getMe','getWebhookInfo']);
    expect(JSON.stringify(f.service.status())).not.toContain(token);
  });

  it('ignores groups and unconfirmed or mismatched identities and accepts one copy of a private message',async()=>{
    const f=fixture();
    const pairing=await f.pair();
    f.message('before desktop confirmation');
    f.message('/start '+new URL(pairing).searchParams.get('start'),{...sender,id:43},{id:43,type:'private'});
    await f.service.poll();
    expect(f.service.status().candidate?.userId).toBe(42);
    expect(()=>f.service.confirm(43)).toThrow();
    f.service.confirm(42);
    f.advance(1000);
    f.message('wrong group',sender,{id:42,type:'group'});
    f.message('wrong person',{...sender,id:43});
    f.message('check today');
    const repeated=f.updates.at(-1)!;
    await f.service.poll();
    f.updates.push(repeated);
    await f.service.poll();
    expect(f.submitted()).toEqual(['check today']);
    expect(f.service.status().pairing).toBeUndefined();
  });

  it('retains the expired pairing timestamp without allowing a previously claimed candidate',async()=>{
    const f=fixture(),url=await f.pair();
    expect(f.service.status().candidate?.userId).toBe(42);
    expect(f.service.status().pairing).toBeUndefined();
    f.advance(10*60_000);
    expect(f.service.status().pairing).toEqual({url,expiresAt:'2026-11-08T08:10:00.000Z'});
    expect(f.service.status().candidate).toBeUndefined();
    expect(()=>f.service.confirm(42)).toThrow();
  });

  it('retains the expired unclaimed pairing timestamp and ignores a late start',async()=>{
    const f=fixture();await f.service.configure(token);await f.service.poll();
    const pairing=f.service.pair().pairing!;
    f.advance(10*60_000+1);
    f.message('/start '+new URL(pairing.url).searchParams.get('start'));await f.service.poll();
    expect(f.service.status().pairing).toEqual(pairing);
    expect(f.service.status().candidate).toBeUndefined();
    expect(()=>f.service.confirm(42)).toThrow();
  });

  it('quarantines backlog during a reconnect and binds confirmation to the actual bot message',async()=>{
    const f=fixture();await f.bind();
    f.outage(true);await f.service.poll();
    expect(f.service.status().state).toBe('disconnected');
    f.outage(false);f.message('do not start while offline');
    await f.service.poll();await f.service.poll();
    expect(f.submitted()).toEqual([]);
    f.message('/pending');await f.service.poll();
    const card=f.sends.at(-1);
    const button=card.reply_markup.inline_keyboard.flat().find((button:{text:string})=>button.text==='确认发送');
    const cardId=f.lastMessageId();
    f.press(button.callback_data,cardId-1);await f.service.poll();
    expect(f.submitted()).toEqual([]);
    f.press(button.callback_data,cardId);await f.service.poll();
    f.press(button.callback_data,cardId);await f.service.poll();
    expect(f.submitted()).toEqual(['do not start while offline']);
  });

  it('does not send again after an ambiguous delivery or a restart',async()=>{
    const f=fixture();await f.bind();
    f.ambiguous(true);f.message('check invoices');await f.service.poll();
    expect(f.submitted()).toEqual(['check invoices']);
    expect(f.service.status().deliveries).toEqual([expect.objectContaining({state:'uncertain'})]);
    const first=f.sends.filter(m=>m.text.includes('已接收')).length;
    f.ambiguous(false);
    f.service.stop();
    const restarted=f.create();clean.push(()=>restarted.stop());
    await restarted.poll();await restarted.poll();
    expect(f.sends.filter(m=>m.text.includes('已接收'))).toHaveLength(first);
    expect(f.submitted()).toEqual(['check invoices']);
  });

  it('revokes an in-flight configuration before it can write credentials',async()=>{
    const f=fixture();
    const configuring=f.service.configure(token);
    f.service.unlink();
    await configuring;
    expect(f.service.status()).toMatchObject({state:'unconfigured',configured:false});
    const restarted=f.create();clean.push(()=>restarted.stop());
    expect(restarted.status().configured).toBe(false);
  });
});

const buttonOn=(card:any,text:string)=>card.reply_markup.inline_keyboard.flat().find((button:{text:string})=>button.text===text)?.callback_data;

it('persists a configuration decision receipt and does not repeat it for a consumed button',async()=>{
  const f=fixture();await f.bind();
  const target:TelegramDecision={kind:'proposal',conversationId:'fixture',id:'1',revision:'v1',scope:'main'};
  let decisions=0;
  f.workspace.decide=async()=>{decisions++;};
  f.workspace.cards=()=>decisions?[]:[{key:'proposal:v1',text:'Configuration preview',buttons:[{text:'批准此项配置',action:{kind:'decision',target,decision:'approve'}}]}];
  await f.service.poll();
  const card=f.sends.find(m=>m.text==='Configuration preview');
  f.press(buttonOn(card,'批准此项配置'),card.id);await f.service.poll();
  expect(f.sends.filter(m=>m.text==='配置变更已确认。')).toHaveLength(1);
  expect(f.sends.find(m=>m.text==='配置变更已确认。').reply_parameters).toEqual({message_id:card.id,allow_sending_without_reply:true});
  f.press(buttonOn(card,'批准此项配置'),card.id);await f.service.poll();
  expect(decisions).toBe(1);
  expect(f.sends.filter(m=>m.text==='配置变更已确认。')).toHaveLength(1);
});

it('welcomes the confirmed account and reports actual test-message delivery failures',async()=>{
  const f=fixture();await f.bind();
  expect(f.sends.some(m=>m.text.includes('/help')&&m.text.includes('离线'))).toBe(true);
  expect(await f.service.test()).toMatchObject({configured:true,binding:{userId:42}});
  expect(f.sends.at(-1).text).toContain('测试');
  f.ambiguous(true);
  await expect(f.service.test()).rejects.toThrow();
  expect(f.service.status().deliveries).toContainEqual(expect.objectContaining({state:'uncertain'}));
});

it('keeps old approvals from firing if clicked during outage',async()=>{
  const f=fixture();await f.bind();
  const target:TelegramDecision={kind:'approval',conversationId:'fixture',id:'1',revision:'v1',scope:'main'};
  let approvals=0;
  f.workspace.decide=async()=>{approvals++;};
  f.workspace.cards=()=>[{key:'approve:v1',text:'Approve command',buttons:[{text:'允许本次',action:{kind:'decision',target,decision:'approve'}}]}];
  f.message('/pending');await f.service.poll();
  const card=f.sends.filter(m=>m.text==='Approve command').at(-1);
  f.outage(true);await f.service.poll();
  f.press(buttonOn(card,'允许本次'),card.id);
  f.outage(false);await f.service.poll();await f.service.poll();
  expect(approvals).toBe(0);
  f.message('agree');await f.service.poll();
  expect(f.submitted()).toEqual([]);
  expect(approvals).toBe(0);
});

it('stages at most eight documents and submits only after the latest draft card is confirmed',async()=>{
  const f=fixture();await f.bind();
  const file=(name:string)=>({document:{file_id:'fixture-id',file_name:name,file_size:13,mime_type:'text/plain'}});
  f.media(file('../../unsafe.txt'));await f.service.poll();
  const old=f.sends.at(-1);
  for(let index=2;index<=9;index++)f.media(file('file-'+index+'.txt'));
  await f.service.poll();
  expect(f.calls.filter(method=>method==='getFile')).toHaveLength(8);
  expect(f.sends.some(m=>m.text.includes('最多添加 8 个'))).toBe(true);
  expect(f.submitted()).toEqual([]);
  f.press(buttonOn(old,'发送'),old.id);await f.service.poll();
  expect(f.submitted()).toEqual([]);
  f.message('Read these files');await f.service.poll();
  const draft=f.sends.at(-1);
  expect(draft.text).toContain('Read these files');
  expect(draft.text).toContain('• unsafe.txt');
  expect(draft.text).not.toContain('../');
  f.press(buttonOn(draft,'发送'),draft.id);await f.service.poll();
  expect(f.submitted()).toEqual(['Read these files']);
  expect(f.attachments.at(-1)).toHaveLength(8);
});

it('rejects oversized and unsupported media and never follows an invalid Telegram file path',async()=>{
  const f=fixture();await f.bind();
  f.media({document:{file_id:'size',file_name:'large.txt',file_size:MAX_ATTACHMENT_SIZE+1}});
  f.media({voice:{file_id:'voice'}});
  f.filePath('../outside.txt');
  f.media({document:{file_id:'path',file_name:'fixture.txt'}});
  await f.service.poll();
  expect(f.calls.filter(method=>method==='getFile')).toHaveLength(1);
  expect(f.calls).not.toContain('outside.txt');
  expect(f.sends.map(m=>m.text).join('\n')).toContain('20 MiB');
  expect(f.sends.map(m=>m.text).join('\n')).toContain('音视频');
  expect(f.sends.map(m=>m.text).join('\n')).toContain('无法读取附件');
  expect(f.submitted()).toEqual([]);
});

it.each([false,true])('collects a choice and a scoped custom reply before submitting a reviewed answer set (async %s)',async(asyncQuestion)=>{
  const f=fixture();await f.bind();
  const target:TelegramDecision={kind:'question',conversationId:'fixture',id:'1',revision:'v1',scope:'main'};
  const decisions:unknown[]=[];
  f.workspace.question=()=>[{id:'env',header:'Environment',question:'Where?',options:[{label:'Stage',description:'Staging environment'}]},
    {id:'note',header:'Note',question:'What should we record?'}];
  f.workspace.cards=()=>[{key:'question:v1',text:'有问题等待回答',buttons:[{text:'回答问题',action:{kind:'question',target}}]}];
  f.workspace.decide=async(_target,decision)=>{decisions.push(decision);};
  if(asyncQuestion)f.workspace.submitAsyncQuestion=(_target,decision,_requestId,assertActive)=>{
    assertActive();expect(f.store.database.isTransaction).toBe(true);decisions.push(decision);
    return {conversationId:'fixture',inputId:'async-input'};
  };
  f.message('/pending');await f.service.poll();
  const start=f.sends.filter(m=>m.text==='有问题等待回答').at(-1);
  f.press(buttonOn(start,'回答问题'),start.id);await f.service.poll();
  const question=f.sends.at(-1);
  expect(question.text).toContain('Staging environment');
  f.press(buttonOn(question,'Stage'),question.id);await f.service.poll();
  const followUp=f.sends.at(-1);
  f.message('Write a note',sender,privateChat,followUp.id);
  await f.service.poll();
  const review=f.sends.at(-1);
  expect(review.text).toContain('Environment：Stage');
  expect(review.text).toContain('Note：Write a note');
  expect(decisions).toEqual([]);
  f.press(buttonOn(review,'提交答案'),review.id);await f.service.poll();
  expect(decisions).toEqual([{env:{answers:['Stage']},note:{answers:['Write a note']}}]);
  expect(f.submitted()).toEqual([]);
  if(asyncQuestion){
    const requests=f.store.database.prepare("SELECT data FROM telegram_requests WHERE status='accepted'").all();
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0].data as string)).toMatchObject({conversationId:'fixture',inputId:'async-input'});
    f.workspace.result=(_conversation,inputId)=>inputId==='async-input'?{text:'Your chosen combination',files:[]}:undefined;
    await f.service.poll();
    expect(f.sends.filter(message=>message.text==='Your chosen combination')).toHaveLength(1);
    f.press(buttonOn(review,'提交答案'),review.id);await f.service.poll();
    expect(decisions).toHaveLength(1);
  }
});

it('provides long output and authorized files only after explicit requests',async()=>{
  const f=fixture();await f.bind();
  const text='完整内容'.repeat(2000),file={conversationId:'fixture',runId:'run',assetId:'asset',versionId:'version',fileId:'0'};
  f.workspace.result=()=>({text,files:[{text:'发送文件 · test.txt (5 B)',action:{kind:'file',file}}]});
  f.workspace.file=async(ref)=>{expect(ref).toEqual(file);return {name:'test.txt',bytes:Buffer.from('hello')};};
  f.message('Get output');await f.service.poll();
  const card=f.sends.at(-1);
  expect(card.text.length).toBeLessThan(text.length);
  expect(f.documents).toEqual([]);
  f.press(buttonOn(card,'下载完整结果'),card.id);await f.service.poll();
  f.press(buttonOn(card,'发送文件 · test.txt (5 B)'),card.id);await f.service.poll();
  const uploaded=f.documents.map(form=>form.get('document') as File);
  expect(uploaded.map(file=>file.name)).toEqual(['Mandala-result.txt','test.txt']);
  expect(await uploaded[0].text()).toBe(text);
  expect(await uploaded[1].text()).toBe('hello');
});

it('retries a known rejected acknowledgement without enqueuing another request',async()=>{
  const f=fixture();await f.bind();
  f.sendFailure(400);f.message('check invoices');await f.service.poll();
  expect(f.service.status().deliveries).toContainEqual(expect.objectContaining({state:'failed'}));
  f.sendFailure(0);f.message('/pending');await f.service.poll();
  expect(f.service.status().deliveries).toBeUndefined();
  expect(f.sends.filter(m=>m.text.includes('已接收'))).toHaveLength(2);
  expect(f.submitted()).toEqual(['check invoices']);
});

it('uses a task-card reply target and only opts desktop tasks into completion notices',async()=>{
  const f=fixture();await f.bind();
  f.workspace.task=(id)=>id==='desktop'?{}:undefined;
  f.workspace.cards=(_binding,_since,enabled,attention)=>[
    ...(attention?[{key:'task-input',text:'Need a date',reply:{taskId:'desktop',revision:3}}]:[]),
    ...(enabled('desktop')?[{key:'task-complete',text:'Task completed',completion:true as const}]:[]),
  ];
  f.workspace.taskReply=(target,text)=>{
    expect(target).toEqual({taskId:'desktop',revision:3});
    return 'Reply for desktop task: '+text;
  };
  f.message('/pending');await f.service.poll();
  expect(f.sends.filter(m=>m.text==='Need a date')).toHaveLength(1);
  expect(f.sends.some(m=>m.text==='Task completed')).toBe(false);
  const question=f.sends.find(m=>m.text==='Need a date');
  f.message('Wednesday',sender,privateChat,question.id);await f.service.poll();
  expect(f.submitted()).toEqual(['Reply for desktop task: Wednesday']);
  expect(f.service.taskNotifications('desktop',true)).toEqual({available:true,enabled:true});
  await f.service.poll();
  f.message('/pending');await f.service.poll();
  expect(f.sends.filter(m=>m.text==='Task completed')).toHaveLength(1);
});

it('cleans up a saved draft when the owner cancels',async()=>{
  const f=fixture();await f.bind();
  const discarded:string[][]=[];
  f.workspace.discardAttachments=async(_id,items)=>{discarded.push(items);};
  f.media({document:{file_id:'safe',file_name:'cancelled.txt'}});
  await f.service.poll();
  const draft=f.sends.at(-1);
  f.press(buttonOn(draft,'取消'),draft.id);
  await f.service.poll();
  expect(f.submitted()).toEqual([]);
  expect(discarded).toEqual([['cancelled.txt']]);
  expect(f.sends.at(-1).text).toContain('已取消附件草稿');
});

it('rolls back local acceptance if durable request recording fails',async()=>{
  const f=fixture();await f.bind();
  f.store.database.exec("CREATE TRIGGER fixture_reject_receipt BEFORE INSERT ON telegram_requests BEGIN SELECT RAISE(ABORT,'fixture'); END");
  f.message('write once');await f.service.poll();
  expect(f.submitted()).toEqual([]);
  expect(f.sends.some(m=>m.text.includes('已接收'))).toBe(false);
  f.store.database.exec('DROP TRIGGER fixture_reject_receipt');
  await f.service.poll();await f.service.poll();
  expect(f.submitted()).toEqual([]);
  f.message('/pending');await f.service.poll();
  const quarantine=f.sends.filter(m=>m.text.includes('离线收到')).at(-1);
  expect(quarantine.text).toContain('2026-11-08T08:00:01.000Z');
  f.press(buttonOn(quarantine,'确认发送'),quarantine.id);await f.service.poll();
  expect(f.submitted()).toEqual(['write once']);
});

it('latches a polling conflict across restart until an explicit validated local reconfiguration',async()=>{
  const f=fixture();await f.bind();
  f.failure(409);await f.service.poll();
  expect(f.service.status()).toMatchObject({configured:true,state:'conflict'});
  const calls=f.calls.length;
  f.failure(0);await f.service.poll();
  f.service.stop();
  const restarted=f.create();clean.push(()=>restarted.stop());
  expect(restarted.status().state).toBe('conflict');
  await restarted.poll();
  expect(f.calls).toHaveLength(calls);
  await restarted.configure(token);await restarted.poll();
  expect(restarted.status()).toMatchObject({state:'connected',binding:{userId:42}});
  expect(f.calls.slice(calls, calls+3)).toEqual(['getMe','getWebhookInfo','getUpdates']);
});

it('reports a rejected token replacement and preserves the active account',async()=>{
  const f=fixture();await f.bind();
  f.webhook('https://example.invalid/occupied');
  await expect(f.service.configure('234567:other_fixture_token_not_a_secret')).rejects.toThrow();
  expect(f.service.status()).toMatchObject({state:'connected',binding:{userId:42}});
  f.service.stop();
  const restarted=f.create();clean.push(()=>restarted.stop());
  expect(restarted.status()).toMatchObject({configured:true,binding:{userId:42}});
});

async function startQuestions(f:ReturnType<typeof fixture>,headers:string[]) {
  const target:TelegramDecision={kind:'question',conversationId:'fixture',id:'1',revision:'v1',scope:'main'};
  f.workspace.question=()=>headers.map((header,index)=>({id:String(index),header,question:'What is your answer?'}));
  f.workspace.cards=()=>[{key:'question:v1',text:'有问题等待回答',buttons:[{text:'回答问题',action:{kind:'question',target}}]}];
  await f.service.poll();
  const card=f.sends.at(-1);
  f.press(buttonOn(card,'回答问题'),card.id);await f.service.poll();
  return f.sends.at(-1);
}

it('rejects stale question replies online and through outage recovery while preserving the review submission',async()=>{
  const f=fixture();await f.bind();
  const decisions:unknown[]=[];
  f.workspace.decide=async(_target,decision)=>{decisions.push(decision);};
  const first=await startQuestions(f,['Question One','Question Two']);
  f.message('first answer',sender,privateChat,first.id);await f.service.poll();
  const second=f.sends.at(-1);
  f.message('stale first reply',sender,privateChat,first.id);await f.service.poll();
  expect(f.submitted()).toEqual([]);
  f.outage(true);await f.service.poll();
  f.message('second answer',sender,privateChat,second.id);
  f.outage(false);await f.service.poll();await f.service.poll();
  f.message('/pending');await f.service.poll();
  const queued=f.sends.filter(m=>m.text.includes('离线收到')).at(-1);
  f.press(buttonOn(queued,'确认发送'),queued.id);await f.service.poll();
  const review=f.sends.at(-1);
  expect(review.text).toContain('Question Two：second answer');
  f.message('extra answer',sender,privateChat,review.id);await f.service.poll();
  f.press(buttonOn(review,'提交答案'),review.id);await f.service.poll();
  expect(decisions).toEqual([{'0':{answers:['first answer']},'1':{answers:['second answer']}}]);
  expect(f.submitted()).toEqual([]);
});

it('never shows a submit button on a truncated question review',async()=>{
  const f=fixture();await f.bind();
  let prompt=await startQuestions(f,['One','Two','Three']);
  for(const letter of ['a','b','c']){
    f.message(letter.repeat(1200),sender,privateChat,prompt.id);
    await f.service.poll();
    prompt=f.sends.at(-1);
  }
  expect(f.sends.some(card=>card.text.startsWith('核对答案'))).toBe(false);
  expect(f.sends.at(-1).text).toContain('桌面');
  expect(f.submitted()).toEqual([]);
});

it('rechecks a waiting task reply after local preparation and when confirming an offline reply',async()=>{
  const f=fixture();await f.bind();
  f.workspace.cards=()=>[{key:'task-input',text:'Need a date',reply:{taskId:'desktop',revision:3}}];
  let current=3;
  f.workspace.taskReply=(target,text)=>{
    if(target.revision!==current)throw new DomainError('telegram_scope',409,'stale fixture task');
    return 'Task reply: '+text;
  };
  await f.service.poll();
  const card=f.sends.at(-1),primary=f.workspace.primary;
  f.workspace.primary=async guard=>{current=4;return primary(guard);};
  f.message('Monday',sender,privateChat,card.id);
  await f.service.poll();
  expect(f.submitted()).toEqual([]);
  current=3;
  f.workspace.primary=primary;
  f.outage(true);await f.service.poll();
  f.message('Tuesday',sender,privateChat,card.id);
  f.outage(false);await f.service.poll();await f.service.poll();
  current=4;
  f.message('/pending');await f.service.poll();
  const queued=f.sends.filter(m=>m.text.includes('离线收到')).at(-1);
  f.press(buttonOn(queued,'确认发送'),queued.id);await f.service.poll();
  expect(f.submitted()).toEqual([]);
});

it.each(['poll','send'] as const)('resolves the delivery interrupted by a concurrent %s conflict as uncertain',async trigger=>{
  const f=fixture();await f.bind();
  f.holdSend();
  const interrupted=f.service.test().catch(error=>error);
  if(trigger==='poll'){
    f.failure(409);
    await f.service.poll();
  }else{
    f.sendFailure(409);
    await expect(f.service.test()).rejects.toThrow();
  }
  expect(await interrupted).toBeInstanceOf(DomainError);
  expect(f.service.status().state).toBe('conflict');
  expect(f.service.status().deliveries?.map(d=>d.state).sort()).toEqual(trigger==='poll'?['uncertain']:['failed','uncertain']);

  f.failure(0);f.sendFailure(0);
  await f.service.configure(token);
  await f.service.poll();
  expect(f.service.status().state).toBe('connected');
  expect(f.sends.filter(message=>message.text.includes('测试消息'))).toHaveLength(trigger==='poll'?1:2);
});

it.each([
  {phase:'prompt',change:'resolved'},
  {phase:'prompt',change:'revised'},
  {phase:'review',change:'secret'},
  {phase:'review',change:'still-active'},
] as const)('validates a failed question $phase before retry when the native request is $change',async({phase,change})=>{
  const f=fixture();await f.bind();
  const prompt=await startQuestions(f,phase==='prompt'?['First','Second']:['First']);
  f.sendFailure(400);
  f.message('Custom answer',sender,privateChat,prompt.id);await f.service.poll();
  const failed=f.sends.at(-1);
  expect(failed.text).toContain(phase==='prompt'?'Second':'核对答案');
  expect(f.service.status().deliveries).toEqual([expect.objectContaining({state:'failed'})]);

  const question=f.workspace.question!;
  f.workspace.question=target=>{
    if(change==='still-active')return question(target);
    if(change==='secret')return question(target)?.map(item=>({...item,isSecret:true}));
    if(change==='revised'&&target.revision==='v2')return question(target);
    return undefined;
  };
  if(change!=='still-active')f.workspace.cards=()=>[];
  f.sendFailure(0);
  f.message('/pending');await f.service.poll();
  expect(f.sends.filter(message=>message.text===failed.text)).toHaveLength(change==='still-active'?2:1);
  if(change!=='still-active')expect(f.sends.at(-1).text).toContain('0 项当前事项');
  expect(f.service.status().deliveries).toBeUndefined();
});
