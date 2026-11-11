import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { NativeQuestion } from '../shared/questions';
import type { TelegramBot, TelegramIdentity, TelegramStatus } from '../shared/telegram';
import { DomainError } from '../shared/workspace-contracts';
import { MAX_ATTACHMENT_SIZE, MAX_ATTACHMENTS } from './attachments';
import type { Store } from './store';
import { telegramApi, TelegramApiError, telegramId, telegramToken, type TelegramCallback, type TelegramChat, type TelegramDocument, type TelegramMessage, type TelegramUpdate, type TelegramUser } from './telegram-api';

export type TelegramDecision = {kind:'approval'|'proposal'|'question';conversationId:string;id:string;revision:string;scope:string};
type WorkspaceAction =
  | {kind:'decision';target:TelegramDecision;decision:'approve'|'reject'}
  | {kind:'question';target:TelegramDecision}
  | {kind:'file';file:TelegramFile};
export type TelegramFile = {conversationId:string;runId:string;assetId:string;versionId:string;fileId:string;taskId?:string};
export type TelegramTaskReply = {taskId:string;revision:number};
export type TelegramCard = {key:string;text:string;buttons?: {text:string;action:WorkspaceAction}[];reply?:TelegramTaskReply;taskId?:string;completion?:true};
export type TelegramResult = {text:string;files:NonNullable<TelegramCard['buttons']>;unavailableFiles?:string[]};
export type TelegramWorkspace = {
  primary(assertActive:()=>void): Promise<string>;
  enqueue(conversationId:string,text:string,requestId:string,bindingId:string,attachments:string[]): string;
  result(conversationId:string,inputId:string): TelegramResult | undefined;
  cards(bindingId:string,since:string,attention:boolean): TelegramCard[];
  attachment(conversationId:string,name:string,bytes:Buffer,assertActive:()=>void):Promise<string>;
  file(file:TelegramFile,assertActive:()=>void):Promise<TelegramDocument>;
  discardAttachments?(id:string,attachments:string[]):Promise<void>;
  taskReply?(target:TelegramTaskReply,text:string):string;
  question?(target:TelegramDecision): NativeQuestion[] | undefined;
  submitAsyncQuestion?(target:TelegramDecision,answers:Record<string,{answers:string[]}>,requestId:string,assertActive:()=>void):{conversationId:string;inputId:string}|undefined;
  decide(target:TelegramDecision,decision:'approve'|'reject'|Record<string,{answers:string[]}>,assertActive:()=>void):Promise<void>;
  progress(bindingId:string):string[];
};
type Action = WorkspaceAction |
  {kind:'quarantine';requestId:string;accept:boolean} |
  {kind:'draft';revision:string;send:boolean} |
  {kind:'result';requestId:string} |
  {kind:'questionStep';revision:string;answer?:string;submit?:true};
type Button = {text:string;action:Action};
type Draft = {conversationId:string;ids:string[];names:string[];text:string;revision:string};
type QuestionSession = {target:TelegramDecision;answers:string[];revision:string};
type ReplyRoute = {kind:'task';target:TelegramTaskReply} | {kind:'question';revision:string;custom:boolean};
type Saved = {
  attention:boolean; conflict?:true; bot?:TelegramBot; credentialId?:string; offset?:number; lastUpdateAt?:number;
  pair?:{code:string;expiresAt:number;candidate?:TelegramIdentity};
  binding?:TelegramIdentity & {id:string;at:number};
  lastConnectedAt?:string; draft?:Draft; question?:QuestionSession;
};
type Request = {id:string;status:'quarantined'|'accepted'|'discarded';text:string;observedAt?:number;replyTo?:number;message?:TelegramMessage;conversationId?:string;inputId?:string;resultQueued?:true};
type Delivery = {
  id:string; text:string; state:'pending'|'sending'|'sent'|'failed'|'uncertain';
  replyToMessageId?:number;
  buttons?: (Button & {id:string})[]; file?:TelegramDocumentRef; validity?:string; questionRevision?:string; questionPrompt?:true; draftRevision?:string; reply?:TelegramTaskReply; resultRequestId?:string;
};
type TelegramDocumentRef = {requestId:string} | TelegramFile;
const key = () => randomBytes(18).toString('base64url');
const iso = (at:number) => new Date(at).toISOString();
const stale = () => new DomainError('telegram_stale',409,'此操作已失效，请发送 /pending 查看当前状态。');
const fail = (message:string) => {throw new DomainError('telegram_invalid',422,message);};
const revoked = new Error('Telegram operation revoked');
const MESSAGE_LIMIT=3500;
const preview = (text:string,length=MESSAGE_LIMIT) => text.length<=length?text:text.slice(0,length-1).replace(/[\uD800-\uDBFF]$/,'')+'…';
const help = '发送文字交给 Mandala。发送图片或文档后，可以用下一条文字编辑说明，再点发送。\n/progress 查看进展 · /pending 查看待处理事项和结果 · /help 查看用法';
const safeName = (name:string) => preview(basename(name.replace(/\\/g,'/')).replace(/[\x00-\x1f\x7f]/g,'').trim() || '附件',180).replace(/^\.{1,2}$/,'附件');
function identity(user?:TelegramUser,chat?:TelegramChat):TelegramIdentity|undefined {
  if (!user || user.is_bot !== false || chat?.type!=='private' || !telegramId(user.id) || chat.id!==user.id) return;
  return {userId:user.id,chatId:chat.id,name:preview([user.first_name,user.last_name].filter(Boolean).join(' '),200),
    ...(typeof user.username==='string'?{username:preview(user.username,64)}:{})};
}
const toStatus = (error:unknown):Pick<TelegramStatus,'state'|'error'> => {
  const code = error instanceof TelegramApiError ? error.code : 0;
  if (code===409) return {state:'conflict',error:'此 Bot 已被 Webhook 或另一个轮询客户端使用，Mandala 已暂停轮询。停止其他接收端后，请在电脑上解除绑定并重新配置。'};
  if (code===401||code===403||code===404||code===422) return {state:'error',error:'Telegram 无法验证此 Bot。请检查 Token 和 Bot 状态。'};
  return {state:'disconnected',error:code===429?'Telegram 暂时限流，Mandala 将稍后重连。':'无法连接 Telegram，Mandala 将尝试重连。'};
};

export function createTelegramService({home,store,workspace,fetch:fetcher=fetch,now=Date.now}:{
  home:string;store:Store;workspace:TelegramWorkspace;fetch?:typeof fetch;now?:()=>number;
}) {
  const db=store.database, credentialPath=join(home,'telegram-credential.json');
  db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_settings (singleton INTEGER PRIMARY KEY CHECK(singleton=1),data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS telegram_requests (id TEXT PRIMARY KEY,status TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS telegram_deliveries (id TEXT PRIMARY KEY,state TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS telegram_buttons (id TEXT PRIMARY KEY,delivery_id TEXT NOT NULL,chat_id INTEGER NOT NULL,message_id INTEGER NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS telegram_replies (message_id INTEGER PRIMARY KEY,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS telegram_request_status ON telegram_requests(status);
    CREATE INDEX IF NOT EXISTS telegram_delivery_state ON telegram_deliveries(state);
  `);
  // Retire unsent desktop completion notices when upgrading from per-task subscriptions.
  store.transaction(()=>{
    if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='telegram_task_notices'").get())return;
    db.exec(`
      DELETE FROM telegram_deliveries
      WHERE state <> 'sent' AND EXISTS (
        SELECT 1 FROM telegram_task_notices
        WHERE instr(json_extract(telegram_deliveries.data,'$.validity'),'task-completed:'||telegram_task_notices.id||':')=1
      );
      DROP TABLE telegram_task_notices;
    `);
  });
  const get = ():Saved => JSON.parse(db.prepare('SELECT data FROM telegram_settings WHERE singleton=1').get()?.data as string ?? '{"attention":true}');
  const set = (saved:Saved) => db.prepare('INSERT OR REPLACE INTO telegram_settings VALUES (1,?)').run(JSON.stringify(saved));
  const readCredential = (id?:string):string|undefined => {
    try {
      const stat=lstatSync(credentialPath);
      if (!stat.isFile()||stat.isSymbolicLink()||process.platform!=='win32'&&(stat.mode&0o077)!==0) return;
      const value=JSON.parse(readFileSync(credentialPath,'utf8'));
      if (value.id===id && telegramToken(value.token)) return value.token;
    } catch { return; }
  };
  const writeCredential = (id:string,token:string) => {
    const temporary=credentialPath+'.'+key();
    try {
      const handle=openSync(temporary,'wx',0o600);
      try { writeFileSync(handle,JSON.stringify({id,token}));fsyncSync(handle); }
      finally { closeSync(handle); }
      renameSync(temporary,credentialPath);
      if(process.platform!=='win32'){
        const directory=openSync(home,'r');
        try {fsyncSync(directory);}finally{closeSync(directory);}
      }
    } finally {rmSync(temporary,{force:true});}
  };
  const initial=get();
  let token=readCredential(initial.credentialId), conflict=!!initial.conflict;
  let connection:Pick<TelegramStatus,'state'|'error'> = token
    ? conflict?toStatus(new TelegramApiError(409)):{state:'connecting'}
    : initial.bot ? {state:'error',error:'Bot 凭据不可用，请重新配置。'} : {state:'unconfigured'};
  let epoch=new AbortController(), wake:AbortController|undefined, stopped=false, started=false;
  let polling:Promise<void>|undefined, configuring:AbortController|undefined, registerCommands=!!token;
  let catchingUp=true, reconnecting=!!get().lastConnectedAt, retryAfter=0;
  const interruptSends=db.prepare("UPDATE telegram_deliveries SET state='uncertain' WHERE state='sending'");
  interruptSends.run();

  const putRequest = (request:Request) => db.prepare('INSERT OR REPLACE INTO telegram_requests VALUES (?,?,?)').run(request.id,request.status,JSON.stringify(request));
  const requestById = (id:string):Request|undefined => {
    const row=db.prepare('SELECT data FROM telegram_requests WHERE id=?').get(id);
    return row?JSON.parse(row.data as string):undefined;
  };
  const putDelivery = (delivery:Delivery) => db.prepare('INSERT OR REPLACE INTO telegram_deliveries VALUES (?,?,?)').run(delivery.id,delivery.state,JSON.stringify(delivery));
  const identifyButtons=(buttons?:Button[])=>buttons?.length?buttons.map(button=>({...button,id:key()})):undefined;
  const note = (id:string,text:string,buttons?:Button[], extra?:Pick<Delivery,'validity'|'file'|'questionRevision'|'questionPrompt'|'draftRevision'|'reply'|'resultRequestId'|'replyToMessageId'>) => {
    if (db.prepare('SELECT id FROM telegram_deliveries WHERE id=?').get(id)) return;
    putDelivery({id,text,state:'pending',...extra,buttons:identifyButtons(buttons)});
  };
  const invalidate = () => {
    epoch.abort();
    epoch=new AbortController();
    wake?.abort();
    catchingUp=true;
  };
  const recordFailure = (error:unknown) => {
    connection=toStatus(error);
    catchingUp=true;reconnecting=true;
    if(error instanceof TelegramApiError&&error.code===409){
      store.transaction(()=>{
        set({...get(),conflict:true});
        // The failing send is already recorded. Other in-flight sends may have reached Telegram.
        interruptSends.run();
      });
      conflict=true;
      invalidate();
    }
  };
  const reset = () => {
    db.exec('DELETE FROM telegram_buttons; DELETE FROM telegram_deliveries; DELETE FROM telegram_requests; DELETE FROM telegram_replies;');
  };
  const guard = (signal:AbortSignal,bindingId?:string) => () => {
    if (stopped||signal.aborted||(bindingId&&get().binding?.id!==bindingId)) throw revoked;
  };
  const status = ():TelegramStatus => {
    const saved=get(),pair=saved.pair;
    const candidate=pair&&pair.expiresAt>now()?pair.candidate:undefined;
    const {id:_bindingId,at:_boundAt,...binding}=saved.binding??{};
    const deliveries = db.prepare("SELECT id,state,data FROM telegram_deliveries WHERE state IN ('failed','uncertain') ORDER BY rowid DESC LIMIT 20").all()
      .map(row=>({id:row.id as string,state:row.state as 'failed'|'uncertain',summary:preview((JSON.parse(row.data as string) as Delivery).text,160)}));
    return {configured:!!token,...connection,attention:saved.attention,
      ...(saved.bot?{bot:saved.bot}:{}),...(saved.binding?{binding:binding as TelegramIdentity}:{}),
      ...(candidate?{candidate}:{}),
      ...(pair&&!candidate&&saved.bot?{pairing:{url:'https://t.me/'+saved.bot.username+'?start='+pair.code,expiresAt:iso(pair.expiresAt)}}:{}),
      ...(saved.lastConnectedAt?{lastConnectedAt:saved.lastConnectedAt}:{}),...(deliveries.length?{deliveries}:{})};
  };
  const pendingRequests = (state:Request['status'],limit=50):Request[] => db.prepare('SELECT data FROM telegram_requests WHERE status=? ORDER BY rowid LIMIT ?').all(state,limit).map(row=>JSON.parse(row.data as string));
  const currentCards = (binding:NonNullable<Saved['binding']>, attention=get().attention) => workspace.cards(binding.id,iso(binding.at),attention);
  const pendingCards=(binding:NonNullable<Saved['binding']>,attention:boolean)=>currentCards(binding,attention).filter(card=>
    !card.completion||!db.prepare("SELECT 1 FROM telegram_deliveries WHERE state='sent' AND json_extract(data,'$.validity')=? LIMIT 1").get(card.key));
  const requireScopedConfirmation=(text:string,binding:NonNullable<Saved['binding']>)=>{
    if(/^(?:yes|agree|approve|ok|同意|批准|允许|好|可以|确认)[。.!！ ]*$/iu.test(text)&&currentCards(binding,true).some(card=>card.reply||card.key.startsWith('approval:')||card.key.startsWith('proposal:')||card.buttons?.some(button=>['decision','question'].includes(button.action.kind))))
      fail('请使用对应卡片的按钮，或回复具体任务卡片。');
  };
  const snapshotPending = (binding:NonNullable<Saved['binding']>, id:string) => {
    const requests=pendingRequests('quarantined',30);
    const cards=pendingCards(binding,true);
    const queued=db.prepare("SELECT data FROM telegram_requests WHERE status='accepted' AND json_extract(data,'$.resultQueued')=1 ORDER BY rowid DESC LIMIT 10").all()
      .map(row=>JSON.parse(row.data as string) as Request);
    note(id,'待处理：'+requests.length+' 条离线消息，'+cards.length+' 项当前事项。'+(queued.length?' 最近结果可在下方下载。':''));
    for(const request of queued){
      const result=workspace.result(request.conversationId!,request.inputId!);
      if(!result)continue;
      const message=resultMessage(request,result,true);
      note(id+':result:'+request.id,message.text,message.buttons,{resultRequestId:request.id});
    }
    for (const request of requests) {
      const description=request.text||request.message?.document?.file_name||'附件';
      note(id+':'+request.id,'离线收到，尚未执行 · '+(request.observedAt?iso(request.observedAt):'')+'\n'+preview(description),[
        {text:'确认发送',action:{kind:'quarantine',requestId:request.id,accept:true}},
        {text:'丢弃',action:{kind:'quarantine',requestId:request.id,accept:false}},
      ]);
    }
    for (const card of cards) {
      const automatic='notice:'+card.key,row=db.prepare('SELECT state FROM telegram_deliveries WHERE id=?').get(automatic);
      if(card.completion&&row?.state==='failed'){
        db.prepare("UPDATE telegram_deliveries SET state='pending' WHERE id=?").run(automatic);
        continue;
      }
      const useAutomatic=card.completion?row?.state!=='uncertain':get().attention&&(!row||row.state==='pending');
      note(useAutomatic?automatic:id+':'+card.key,card.text,card.buttons,{validity:card.key,reply:card.reply});
    }
    // A verified Telegram rejection can be retried. A lost response never is.
    db.prepare("UPDATE telegram_deliveries SET state='pending' WHERE state='failed' AND id NOT LIKE 'test:%' AND json_extract(data,'$.validity') IS NULL").run();
  };
  const accept = (request:Request,conversationId:string,bindingId:string,attachments:string[]=[]) => {
    const commit=()=>{
      const previous=requestById(request.id);
      if (previous?.status==='accepted'||previous?.status==='discarded') return;
      const inputId=workspace.enqueue(conversationId,request.text,request.id,bindingId,attachments);
      putRequest({id:request.id,status:'accepted',text:request.text,conversationId,inputId});
      note('accepted:'+request.id,'Mandala 已接收，进入本机队列。');
    };
    if(db.isTransaction)commit();else store.transaction(commit);
  };
  const draftCard = (draft:Draft,id='draft:'+draft.revision) => {
    const files=draft.names.map(name=>'• '+name).join('\n');
    note(id,'附件草稿（'+draft.ids.length+'/'+MAX_ATTACHMENTS+'）\n'+files+'\n说明：'+preview(draft.text||'发送一条文字即可填写说明。',1200),[
      {text:'发送',action:{kind:'draft',revision:draft.revision,send:true}},
      {text:'取消',action:{kind:'draft',revision:draft.revision,send:false}},
    ],{draftRevision:draft.revision});
  };
  const stage = async (message:TelegramMessage,requestId:string,bindingId:string,assertActive:()=>void,api:ReturnType<typeof telegramApi>) => {
    if(requestById(requestId)?.status==='discarded')return;
    const file=message.document??message.photo?.at(-1);
    if (!file || message.video||message.voice||message.video_note||message.audio||message.animation||message.sticker||
        /^(audio|video)\//i.test(message.document?.mime_type??'')) fail('目前支持图片和文档，请在桌面处理音视频等内容。');
    const media=file!;
    const saved=get();
    if ((saved.draft?.ids.length??0)>=MAX_ATTACHMENTS) fail('一个草稿最多添加 8 个文件。');
    if ((media.file_size??0)>MAX_ATTACHMENT_SIZE) fail('单个附件不能超过 20 MiB。');
    const conversationId=saved.draft?.conversationId??await workspace.primary(assertActive);
    assertActive();
    const bytes=await api.download(media);
    assertActive();
    const name=safeName(media.file_name??('图片-'+message.message_id+'.jpg'));
    const id=await workspace.attachment(conversationId,name,bytes,assertActive);
    assertActive();
    store.transaction(()=>{
      const current=get();
      if (current.binding?.id!==bindingId) throw revoked;
      const draft:Draft={conversationId,ids:[...(current.draft?.ids??[]),id],names:[...(current.draft?.names??[]),name],
        text:message.caption?.trim()||current.draft?.text||'',revision:key()};
      set({...current,draft});draftCard(draft);
      putRequest({id:requestId,status:'discarded',text:''});
    });
  };
  const safeQuestions = (target:TelegramDecision) => {
    const questions=workspace.question?.(target);
    return questions?.length&&!questions.some(q=>q.isSecret)?questions:undefined;
  };
  const canDeliverQuestion = (revision:string) => {
    const session=get().question;
    return session?.revision===revision&&!!safeQuestions(session.target);
  };
  const openQuestion = (session:QuestionSession) => {
    const questions=safeQuestions(session.target);
    if (!questions) throw stale();
    const question=questions[session.answers.length];
    if (question) {
      const options=(question.options??[]).map(option=>({text:preview(option.label,64),action:{kind:'questionStep' as const,revision:session.revision,answer:option.label}}));
      const text=[question.header,question.question,...(question.options??[]).map(o=>o.label+'：'+o.description),'回复这条消息可填写自定义答案。'].join('\n');
      if (text.length>MESSAGE_LIMIT||options.length>20) fail('问题内容过长，请在桌面回答。');
      note('question:'+session.revision,text,options,{questionRevision:session.revision,questionPrompt:true});
    } else {
      const review='核对答案：\n'+questions.map((q,index)=>q.header+'：'+session.answers[index]).join('\n');
      if (review.length>MESSAGE_LIMIT) fail('答案内容过长，请在桌面填写。');
      note('question:'+session.revision,review,[{text:'提交答案',action:{kind:'questionStep',revision:session.revision,submit:true}}],{questionRevision:session.revision});
    }
    set({...get(),question:session});
  };
  const advanceQuestion = (session:QuestionSession,answer:string) => {
    if (!answer.trim()||answer.length>1200) fail('答案须为 1 至 1200 字。较长的答案请在桌面填写。');
    openQuestion({...session,answers:[...session.answers,answer.trim()],revision:key()});
  };
  const replyRoute = (messageId?:number):ReplyRoute|undefined => {
    if(!telegramId(messageId))return;
    const row=db.prepare('SELECT data FROM telegram_replies WHERE message_id=?').get(messageId);
    return row?JSON.parse(row.data as string):undefined;
  };
  const acceptText = async (request:Request,binding:NonNullable<Saved['binding']>,assertActive:()=>void) => {
    const route=replyRoute(request.replyTo);
    if (request.replyTo&&!route) throw stale();
    if (route?.kind==='question') {
      const session=get().question;
      if(!route.custom||!session||session.revision!==route.revision) throw stale();
      store.transaction(()=>{
        advanceQuestion(session,request.text);
        if(request.status==='quarantined')putRequest({id:request.id,status:'discarded',text:''});
      });
      return;
    }
    const conversationId=await workspace.primary(assertActive);
    assertActive();
    if(!route)requireScopedConfirmation(request.text,binding);
    let text=request.text;
    if (route?.kind==='task') {
      if(!workspace.taskReply)throw stale();
      text=workspace.taskReply(route.target,text);
    }
    accept({...request,text},conversationId,binding.id);
  };
  const handleAction = async (action:Action,updateId:number,binding:NonNullable<Saved['binding']>,assertActive:()=>void,api:ReturnType<typeof telegramApi>) => {
    switch(action.kind){
      case 'quarantine': {
        const request=requestById(action.requestId);
        if (request?.status!=='quarantined') throw stale();
        if (!action.accept) putRequest({id:request.id,status:'discarded',text:''});
        else if (request.message?.document||request.message?.photo?.length) {
          await stage(request.message,request.id,binding.id,assertActive,api);
        } else await acceptText(request,binding,assertActive);
        return;
      }
      case 'draft': {
        const saved=get(),draft=saved.draft;
        if (!draft||draft.revision!==action.revision) throw stale();
        store.transaction(()=>{
          if (action.send) accept({id:binding.id+':draft:'+draft.revision,status:'accepted',text:draft.text},draft.conversationId,binding.id,draft.ids);
          set({...get(),draft:undefined});
          if (!action.send) note('draft-cancel:'+draft.revision,'已取消附件草稿。');
        });
        if(!action.send)await workspace.discardAttachments?.(draft.conversationId,draft.ids).catch(()=>{});
        return;
      }
      case 'result': {
        const request=requestById(action.requestId);
        const result=request?.inputId&&workspace.result(request.conversationId!,request.inputId);
        if (!result) throw stale();
        if (Buffer.byteLength(result.text)>MAX_ATTACHMENT_SIZE) fail('完整结果超过 20 MiB，请在桌面查看。');
        note('download:'+updateId,'完整结果',undefined,{file:{requestId:action.requestId}});
        return;
      }
      case 'file':
        note('download:'+updateId,'文件下载',undefined,{file:action.file});
        return;
      case 'decision':
        await workspace.decide(action.target,action.decision,assertActive);
        return;
      case 'question':
        openQuestion({target:action.target,answers:[],revision:key()});
        return;
      case 'questionStep': {
        const session=get().question;
        if (!session||session.revision!==action.revision) throw stale();
        if (!action.submit) {advanceQuestion(session,action.answer??'');return;}
        const questions=safeQuestions(session.target);
        if (!questions||questions.length!==session.answers.length) throw stale();
        const answers=Object.fromEntries(questions.map((q,index)=>[q.id,{answers:[session.answers[index]]}]));
        const submitted=store.transaction(()=>{
          const id=binding.id+':question:'+session.target.id;
          const input=workspace.submitAsyncQuestion?.(session.target,answers,id,assertActive);
          if(!input)return false;
          putRequest({id,status:'accepted',text:'问题回答',...input});
          note('accepted:'+id,'答案已提交，进入本机队列。');
          return true;
        });
        if(!submitted)await workspace.decide(session.target,answers,assertActive);
        assertActive();
        set({...get(),question:undefined});
      }
    }
  };
  const handleCallback = async (callback:TelegramCallback,updateId:number,binding:NonNullable<Saved['binding']>,backlog:boolean,assertActive:()=>void,api:ReturnType<typeof telegramApi>) => {
    const reply = async (text:string) => {try{await api.call('answerCallbackQuery',{callback_query_id:callback.id,text});}catch{/* Callback toast cannot change the action outcome. */}};
    const message=callback.message;
    if (backlog||!message||!telegramId(message.date)||typeof callback.data!=='string') {await reply('按钮已失效，请发送 /pending。');return;}
    const row=db.prepare('SELECT * FROM telegram_buttons WHERE id=? AND chat_id=? AND message_id=?').get(callback.data,binding.chatId,message.message_id);
    if (!row) {await reply('按钮已失效，请发送 /pending。');return;}
    const action:Action=JSON.parse(row.data as string);
    // Consume before any native or network operation. An interrupted callback is never replayed.
    db.prepare('DELETE FROM telegram_buttons WHERE id=?').run(callback.data);
    try {
      await handleAction(action,updateId,binding,assertActive,api);assertActive();
      if(action.kind==='decision')note('decision:'+callback.data,
        action.target.kind==='proposal'?(action.decision==='approve'?'配置变更已确认。':'配置变更已拒绝。')
          :action.decision==='approve'?'已允许本次操作。':'已拒绝本次操作。',undefined,{replyToMessageId:message.message_id});
      await reply('已处理。');
    }
    catch (error) {assertActive();await reply(error instanceof DomainError&&error.code.startsWith('telegram_')?error.message:'操作暂时无法完成，请发送 /pending。');}
  };
  const handleUpdate = async (update:TelegramUpdate,signal:AbortSignal,backlog:boolean,api:ReturnType<typeof telegramApi>) => {
    const saved=get(), message=update.message, callback=update.callback_query;
    const peer=identity(callback?.from??message?.from,callback?.message?.chat??message?.chat);
    if (!peer) return;
    const replyTo=message?.reply_to_message?.message_id,route=replyRoute(replyTo);
    const command=route?undefined:message?.text?.trim().match(/^\/([a-zA-Z]+)(?:@([a-zA-Z0-9_]+))?(?:\s+([\s\S]+))?$/);
    if (command?.[2] && command[2].toLowerCase()!==saved.bot?.username.toLowerCase()) return;
    const binding=saved.binding;
    if (!binding) {
      const pair=saved.pair;
      if (pair&&!pair.candidate&&pair.expiresAt>now()&&command?.[1]==='start'&&command[3]===pair.code) {
        set({...saved,pair:{...pair,candidate:peer}});
      }
      return;
    }
    if (binding.userId!==peer.userId||binding.chatId!==peer.chatId) return;
    const assertActive=guard(signal,binding.id);
    if (callback) {await handleCallback(callback,update.update_id,binding,backlog,assertActive,api);return;}
    if (!message||!telegramId(message.date)||message.date<Math.floor(binding.at/1000)) return;
    const id=binding.id+':'+update.update_id;
    const text=message.text?.trim()||(!route&&message.caption?.trim())||'';
    if (backlog||message.date===Math.floor(binding.at/1000)) {
      if (!command&&(text||!route&&(message.document||message.photo?.length))&&!requestById(id))
        putRequest({id,status:'quarantined',text,observedAt:message.date*1000,...(route?{replyTo}:{}),...(!route&&(message.document||message.photo?.length)?{message}:{})});
      return;
    }
    if (command) {
      switch (command[1].toLowerCase()){
        case 'progress': note(id,workspace.progress(binding.id).join('\n')||'目前没有需要关注的进展。');break;
        case 'pending': snapshotPending(binding,id);if(saved.draft)draftCard(saved.draft,id+':draft');break;
        default: note(id,help);
      }
      return;
    }
    if(route){
      if(!message.text?.trim())fail('请回复文字，或在桌面处理。');
      if(!requestById(id))await acceptText({id,status:'accepted',text,replyTo},binding,assertActive);
      return;
    }
    if (message.document||message.photo?.length||message.video||message.voice||message.video_note||message.audio||message.animation||message.sticker) {
      await stage(message,id,binding.id,assertActive,api);
      return;
    }
    if (!text) return;
    if(saved.draft) {
      const draft={...saved.draft,text,revision:key()};
      store.transaction(()=>{set({...get(),draft});draftCard(draft);});
      return;
    }
    if(!requestById(id))await acceptText({id,status:'accepted',text},binding,assertActive);
  };
  const resultMessage=(request:Request,result:TelegramResult,recent=false)=>{
    const unavailable=result.unavailableFiles?.length?'\n\n'+preview(result.unavailableFiles.join('\n'),900):'';
    const long=result.text.length+unavailable.length>3500;
    const buttons:Button[]=[...(long||recent?[{text:'下载完整结果',action:{kind:'result' as const,requestId:request.id}}]:[]),...result.files];
    const text=recent?'最近结果 · '+preview(request.text||'附件请求',80)+'\n'+preview(result.text,900)
      :long?preview(result.text,3300-unavailable.length)+'\n\n可下载完整结果。':result.text;
    return {text:text+unavailable,buttons};
  };
  const enqueueNotices = (binding:NonNullable<Saved['binding']>) => {
    for (const row of db.prepare("SELECT data FROM telegram_requests WHERE status='accepted' AND json_extract(data,'$.resultQueued') IS NULL ORDER BY rowid").all()) {
      const request:Request=JSON.parse(row.data as string);
      const result=workspace.result(request.conversationId!,request.inputId!);
      if (!result) continue;
      store.transaction(()=>{
        const message=resultMessage(request,result);
        note('result:'+request.id,message.text,message.buttons,{resultRequestId:request.id});
        putRequest({...request,resultQueued:true});
      });
    }
    for (const card of currentCards(binding)) note('notice:'+card.key,card.text,card.buttons,{validity:card.key,reply:card.reply});
  };
  const deliver = async (binding:NonNullable<Saved['binding']>,signal:AbortSignal,api:ReturnType<typeof telegramApi>) => {
    const assertActive=guard(signal,binding.id);
    enqueueNotices(binding);
    for (const row of db.prepare("SELECT data FROM telegram_deliveries WHERE state='pending' ORDER BY rowid LIMIT 30").all()) {
      let delivery:Delivery=JSON.parse(row.data as string);
      assertActive();
      if (delivery.validity) {
        const card=currentCards(binding,!delivery.id.startsWith('notice:')||get().attention).find(card=>card.key===delivery.validity);
        if(!card){
          db.prepare('DELETE FROM telegram_deliveries WHERE id=?').run(delivery.id);
          continue;
        }
        delivery={...delivery,text:card.text,buttons:identifyButtons(card.buttons),reply:card.reply};
      }
      if(delivery.resultRequestId){
        const request=requestById(delivery.resultRequestId),result=request?.inputId&&workspace.result(request.conversationId!,request.inputId);
        if(!request||!result){
          db.prepare('DELETE FROM telegram_deliveries WHERE id=?').run(delivery.id);
          continue;
        }
        const message=resultMessage(request,result,!delivery.id.startsWith('result:'));
        delivery={...delivery,text:message.text,buttons:identifyButtons(message.buttons)};
      }
      if (delivery.questionRevision&&!canDeliverQuestion(delivery.questionRevision)||delivery.draftRevision&&get().draft?.revision!==delivery.draftRevision) {
        db.prepare('DELETE FROM telegram_deliveries WHERE id=?').run(delivery.id);
        continue;
      }
      let file:TelegramDocument|undefined;
      try {
        if (delivery.file) {
          if ('requestId' in delivery.file) {
            const request=requestById(delivery.file.requestId);
            const result=request?.inputId&&workspace.result(request.conversationId!,request.inputId);
            if (!result||Buffer.byteLength(result.text)>MAX_ATTACHMENT_SIZE) throw stale();
            file={name:'Mandala-result.txt',bytes:Buffer.from(result.text)};
          } else file=await workspace.file(delivery.file,assertActive);
        }
      } catch {
        assertActive();
        putDelivery({...delivery,state:'failed'});
        note('file-error:'+delivery.id,'文件当前不可用，请在桌面查看。');
        continue;
      }
      assertActive();
      putDelivery({...delivery,state:'sending'});
      try {
        const result=file?await api.sendDocument(binding.chatId,file):await api.call<TelegramMessage>('sendMessage',{
          chat_id:binding.chatId,text:preview(delivery.text),link_preview_options:{is_disabled:true},
          ...(delivery.replyToMessageId?{reply_parameters:{message_id:delivery.replyToMessageId,allow_sending_without_reply:true}}:{}),
          ...(delivery.buttons?.length?{reply_markup:{inline_keyboard:delivery.buttons.map(button=>[{text:button.text,callback_data:button.id}])}}:{}),
        });
        assertActive();
        if (!telegramId(result?.message_id)) throw new TelegramApiError(0);
        store.transaction(()=>{
          putDelivery({...delivery,state:'sent'});
          for (const button of delivery.buttons??[]) db.prepare('INSERT INTO telegram_buttons VALUES (?,?,?,?,?)')
            .run(button.id,delivery.id,binding.chatId,result.message_id,JSON.stringify(button.action));
          const reply:ReplyRoute|undefined=delivery.reply?{kind:'task',target:delivery.reply}
            :delivery.questionRevision?{kind:'question',revision:delivery.questionRevision,custom:!!delivery.questionPrompt}:undefined;
          if(reply)db.prepare('INSERT OR REPLACE INTO telegram_replies VALUES (?,?)').run(result.message_id,JSON.stringify(reply));
        });
      } catch (error) {
        assertActive();
        const code=error instanceof TelegramApiError?error.code:0;
        putDelivery({...delivery,state:code?'failed':'uncertain'});
        if ([401,403,409,429].includes(code)||!code) throw error;
      }
    }
  };
  let processingUpdate = false;
  const tick = async () => {
    const signal=epoch.signal, secret=token;
    if (!secret||stopped||conflict) return;
    const api=telegramApi(secret,fetcher,signal),assertActive=guard(signal);
    try {
      const saved=get(), startedAt=now(), backlog=catchingUp;
      const offset=saved.lastUpdateAt!==undefined&&startedAt-saved.lastUpdateAt>6*24*60*60_000?undefined:saved.offset;
      const updates=await api.call<TelegramUpdate[]>('getUpdates',{offset,timeout:backlog?0:8,limit:100,allowed_updates:['message','callback_query']},20_000);
      assertActive();
      processingUpdate = true;
      if (!Array.isArray(updates)) throw new TelegramApiError(0);
      const delayed=now()-startedAt>25_000;
      if (delayed) {catchingUp=true;reconnecting=true;}
      for (const update of updates) {
        assertActive();
        if (!telegramId(update?.update_id)||offset!==undefined&&update.update_id<offset) continue;
        try {await handleUpdate(update,signal,backlog||delayed,api);}
        catch (error) {
          assertActive();
          if (error instanceof DomainError&&error.status<500||error instanceof TelegramApiError&&[400,413,422].includes(error.code))
            note('input-error:'+update.update_id,error instanceof DomainError?(error.code.startsWith('telegram_')?error.message:'Mandala 未接收这条消息，请在桌面检查后重试。'):'无法读取附件，请重新上传。');
          else throw error;
        }
        assertActive();
        const current=get();
        set({...current,offset:update.update_id+1,lastUpdateAt:now()});
      }
      if (catchingUp&&updates.length) return;
      const current=get();
      if (catchingUp&&current.binding&&reconnecting) {
        const count=pendingRequests('quarantined',100).length,actions=pendingCards(current.binding,get().attention).length;
        note('reconnect:'+key(),'Mandala 已恢复连接。'+(count?' 有 '+count+' 条离线消息等待确认。':'')+(actions?' 有 '+actions+' 项当前事项。':'')+' 发送 /pending 查看待处理事项和结果。');
      }
      catchingUp=false;reconnecting=false;retryAfter=0;
      connection={state:'connected'};
      set({...current,lastConnectedAt:iso(now())});
      if(registerCommands){
        registerCommands=false;
        await api.call('setMyCommands',{commands:[{command:'progress',description:'查看进展'},{command:'pending',description:'查看待处理事项'},{command:'help',description:'查看用法'}]}).catch(()=>{});
        assertActive();
      }
      if (current.binding) await deliver(current.binding,signal,api);
    } catch (error) {
      if (stopped||signal.aborted) return;
      recordFailure(error);
      retryAfter=Math.min(60_000,Math.max(error instanceof TelegramApiError?error.retryAfter??0:0,retryAfter?retryAfter*2:1000));
    } finally { processingUpdate = false; }
  };
  const poll = () => {
    if (polling) return polling;
    polling=tick().finally(()=>{polling=undefined;});
    return polling;
  };
  const loop = async () => {
    while (!stopped) {
      if (token&&!configuring&&!conflict) await poll();
      if (stopped) break;
      wake=new AbortController();
      await delay(token&&!configuring&&!conflict?(retryAfter||100):2**31-1,undefined,{signal:wake.signal,ref:false}).catch(()=>{});
    }
  };
  const validate = async (secret:string,signal:AbortSignal):Promise<TelegramBot> => {
    const api=telegramApi(secret,fetcher,signal);
    const bot=await api.call<TelegramUser>('getMe');
    if (!telegramId(bot?.id)||bot.is_bot!==true||!/^[A-Za-z0-9_]{5,32}$/.test(bot.username??'')) throw new TelegramApiError(422);
    const webhook=await api.call<{url:string}>('getWebhookInfo');
    if (typeof webhook?.url!=='string') throw new TelegramApiError(422);
    if (webhook.url) throw new TelegramApiError(409);
    return {id:bot.id,name:preview(bot.first_name,200),username:bot.username!};
  };
  return {
    status,poll,
    hasActiveWork:()=>processingUpdate||!!configuring,
    start(){if(!started&&!stopped){started=true;void loop();}},
    stop(){stopped=true;configuring?.abort();invalidate();},
    async configure(value:unknown) {
      if (!telegramToken(value)) fail('请输入有效的 Telegram Bot Token。');
      const secret=value as string;
      configuring?.abort();
      const controller=new AbortController();
      configuring=controller;wake?.abort();
      if(!token)connection={state:'connecting'};
      try {
        const bot=await validate(secret,controller.signal);
        if (stopped)throw stale();
        if (controller.signal.aborted) return status();
        const saved=get(),credentialId=key();
        if (token===secret&&saved.bot?.id===bot.id) {
          if(conflict){
            set({...saved,conflict:undefined});
            conflict=false;
            invalidate();
            retryAfter=0;connection={state:'connecting'};
          }
          return status();
        }
        writeCredential(credentialId,secret);
        invalidate();
        store.transaction(()=>{reset();set({bot,credentialId,attention:saved.attention});});
        token=secret;conflict=false;connection={state:'connecting'};reconnecting=false;retryAfter=0;registerCommands=true;
      } catch (error) {
        if (!controller.signal.aborted&&!stopped) {
          if(token){
            if(secret===token&&error instanceof TelegramApiError&&error.code===409)recordFailure(error);
            const failure=toStatus(error);
            const message=secret===token||failure.state!=='conflict'?failure.error:'新 Bot 已被 Webhook 使用，现有连接保持不变。';
            throw new DomainError('telegram_credential',failure.state==='conflict'?409:failure.state==='error'?422:502,message!);
          }
          connection=toStatus(error);
        }
      } finally {
        if (configuring===controller){configuring=undefined;wake?.abort();}
      }
      if(stopped)throw stale();
      return status();
    },
    pair() {
      const saved=get();
      if (!token||!saved.bot) fail('请先配置 Bot。');
      if (saved.binding) fail('请先解除现有绑定。');
      set({...saved,pair:{code:key(),expiresAt:now()+10*60_000}});
      return status();
    },
    confirm(userId:unknown) {
      const saved=get(),pair=saved.pair;
      if (!token||saved.binding||!pair||pair.expiresAt<=now()||pair.candidate?.userId!==userId||!pair.candidate) throw stale();
      store.transaction(()=>{
        const binding={...pair.candidate!,id:key(),at:now()};
        set({...saved,pair:undefined,binding});
        note('welcome:'+binding.id,'已连接 '+preview(hostname(),100)+' 上的 Mandala。电脑或服务离线时，消息须在恢复后确认。\n'+help);
      });
      return status();
    },
    unlink() {
      configuring?.abort();configuring=undefined;
      const draft=get().draft;
      invalidate();token=undefined;conflict=false;connection={state:'unconfigured'};retryAfter=0;reconnecting=false;
      store.transaction(()=>{reset();set({attention:get().attention});});
      rmSync(credentialPath,{force:true});
      if(draft)void workspace.discardAttachments?.(draft.conversationId,draft.ids).catch(()=>{});
      return status();
    },
    async test() {
      const binding=get().binding;
      if(!token||!binding)fail('请先确认 Telegram 绑定。');
      if(conflict)throw new DomainError('telegram_conflict',409,connection.error!);
      const signal=epoch.signal,assertActive=guard(signal,binding!.id),api=telegramApi(token!,fetcher,signal);
      const delivery:Delivery={id:'test:'+key(),text:'Mandala 测试消息。',state:'sending'};
      putDelivery(delivery);
      try {
        const result=await api.call<TelegramMessage>('sendMessage',{chat_id:binding!.chatId,text:delivery.text});
        assertActive();
        if(!telegramId(result?.message_id))throw new TelegramApiError(0);
        putDelivery({...delivery,state:'sent'});
      } catch(error) {
        if (signal.aborted||stopped) throw stale();
        const known=error instanceof TelegramApiError&&error.code!==0;
        putDelivery({...delivery,state:known?'failed':'uncertain'});
        if(!known||error instanceof TelegramApiError&&[401,403,409,429].includes(error.code)) {
          recordFailure(error);
        }
        throw new DomainError('telegram_delivery',502,known?'Telegram 拒绝了测试消息。':'测试消息的送达状态未知，请在 Telegram 中查看。');
      }
      return status();
    },
    notifications(attention:unknown) {
      if (typeof attention!=='boolean') fail('请指定是否接收提醒。');
      set({...get(),attention:attention as boolean});
      return status();
    },
  };
}
