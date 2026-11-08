import { createHash } from 'node:crypto';
import { constants, readFileSync } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { approvalChoices, supportsConversationApproval } from '../shared/approvals';
import { groupChatTurns } from '../shared/chat-turns';
import { presentTurnText } from '../shared/conversation-output';
import { summarizeOperations } from '../shared/execution';
import type { ManagementProposal } from '../shared/mandala-coordination';
import { nativeQuestions } from '../shared/questions';
import type { QueuedInputSource, RunControl, Task } from '../shared/tasks';
import type { Approval, Conversation, DisplayEvent } from '../shared/types';
import { DomainError, type VersionRef } from '../shared/workspace-contracts';
import { createAssetFiles } from './asset-files';
import { createAssets } from './assets';
import { MAX_ATTACHMENT_SIZE, saveAttachment } from './attachments';
import { ensureMandalaConfig } from './config';
import { ensureMandalaConversation } from './mandala';
import type { SessionManager } from './sessions';
import type { Store } from './store';
import type { TelegramCard, TelegramDecision, TelegramFile, TelegramResult, TelegramWorkspace } from './telegram';
import { workspacePrincipal } from './workspace-identity';

const invalid = () => new DomainError('telegram_scope',409,'此操作已失效，请在 Mandala 中查看当前状态。');
const digest = (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const line = (text:string,limit=100) => text.split('\n')[0].slice(0,limit);
const sensitiveField = /^(token|secret|password|api[_-]?key|authorization|credentials?|env|headers)$/i;
function containsSensitiveFields(value:unknown):boolean {
  if (!value||typeof value!=='object') return false;
  return Object.entries(value).some(([key,value])=>sensitiveField.test(key)||containsSensitiveFields(value));
}
type Scope = {conversation:Conversation;task?:Task;run?:RunControl};
type EventData = {
  mandalaRequest?:{taskId:string;text:string;blocked:boolean};
  runId?:string;invocationId?:string;queuedInputId?:string;source?:QueuedInputSource;
  status?:string;mandalaProposal?:ManagementProposal;
};

export function createTelegramWorkspace(home:string,store:Store,manager:SessionManager):TelegramWorkspace {
  const root=workspacePrincipal(store),tasks=manager.taskService,db=store.database;
  let assets:ReturnType<typeof createAssets>|undefined;
  const reader=()=>assets??=createAssets(store,createAssetFiles(home));
  const primary=()=>store.listConversations().find(c=>c.purpose==='mandala-main'&&!c.executionLocation);
  const requirePrimary=(id:string)=>{
    const chat=primary();
    if (!chat||chat.id!==id) throw invalid();
    return chat;
  };
  const owned=(id:string)=>{
    const chat=primary(),own=chat&&manager.coordination.ownership(id);
    if (!chat||!own||own.conversationId!==chat.id||own.agentId!==chat.agentId) return;
    try { return {own,task:tasks.getTask(root,id)}; } catch (error) {
      if (!(error instanceof DomainError)||![403,404].includes(error.status)) throw error;
    }
  };
  const taskRequest=(task:Task)=>{
    if(task.state!=='waiting')return;
    const chat=primary();
    if(!chat||!readable(chat.id))return;
    const row=db.prepare("SELECT data FROM events WHERE conversationId=? AND kind='metadata' AND superseded=0 AND json_extract(data,'$.mandalaRequest.taskId')=? AND json_extract(data,'$.mandalaRequestRevision')=? ORDER BY id DESC LIMIT 1").get(chat.id,task.id,task.revision);
    return row?(JSON.parse(row.data as string) as EventData).mandalaRequest:undefined;
  };
  const sourceEvent=(conversationId:string,eventId:number|null)=>eventId===null?undefined:store.listEvents(conversationId,eventId-1,1).find(e=>e.id===eventId&&e.kind==='user');
  const originBinding=(owner:NonNullable<ReturnType<typeof owned>>['own'])=>{
    const source=(sourceEvent(owner.conversationId,owner.sourceEventId)?.data as EventData|undefined)?.source;
    return source?.kind==='telegram'?source.requestId.split(':')[0]:undefined;
  };
  const ownedTasks=()=>{
    const chat=primary();
    if(!chat) return [];
    return manager.coordination.list().flatMap(own=>{
      if (own.conversationId!==chat.id||own.agentId!==chat.agentId) return [];
      const entry=owned(own.taskId);
      return entry?[entry]:[];
    });
  };
  const scopeKey=(scope:Scope)=>scope.task&&scope.run?scope.task.id+':'+scope.task.revision+':'+scope.run.id:'main';
  const taskScopes=(task:Task):Scope[]=>{
    if (['completed','cancelled'].includes(task.state)) return [];
    return task.executions.flatMap(execution=>{
      const run=execution.latestRun,id=run?.routing?.executionConversationId;
      if (execution.supersededByExecutionId||!id||!run||!['running','approval'].includes(run.state)) return [];
      const conversation=store.getConversation(id);
      if (!conversation||conversation.executionLocation||manager.executionId(id)!==run.id) return [];
      return [{conversation,task,run}];
    });
  };
  const readable=(id:string)=>{
    try {manager.authorizeConversationRead(id);return true;}catch{return false;}
  };
  const label=(scope:Scope)=>scope.task
    ? '任务：'+line(scope.task.goal)+'\n执行者：'+line(scope.conversation.title||scope.conversation.agentId)
    : 'Mandala 主对话';
  const scopeFor=(target:TelegramDecision):Scope|undefined=>{
    const main=primary();
    if (!main||!readable(target.conversationId)) return;
    if (target.conversationId===main.id&&target.scope==='main') return {conversation:main};
    return ownedTasks().flatMap(({task})=>taskScopes(task)).find(scope=>scope.conversation.id===target.conversationId&&scopeKey(scope)===target.scope);
  };
  const invocationEvents=(id:string,runId:string)=>store.listEvents(id,0).filter(event=>(event.data as EventData).runId===runId);
  const approvalDetail=(approval:Approval,events:DisplayEvent[]):string|undefined=>{
    const params=approval.params as {
      command?:string;cwd?:string;reason?:string;kind?:string;itemId?:string;turnId?:string;message?:string;title?:string;
      toolCall?:{title?:string;rawInput?:unknown;content?:unknown;locations?:unknown};
    };
    if (!params||containsSensitiveFields(params)||!supportsConversationApproval(approval)) return;
    const choices=approvalChoices(approval);
    if (!choices.includes('approve')||!choices.includes('reject')&&!choices.includes('reject-stop')) return;
    const operation=summarizeOperations(events).find(op=>op.key===params.turnId+':'+params.itemId)?.item;
    switch(approval.method){
      case 'item/commandExecution/requestApproval': {
        const command=params.command||operation?.command,cwd=params.cwd||operation?.cwd;
        return params.kind!=='writeStdin'&&typeof command==='string'&&command.trim()&&typeof cwd==='string'&&cwd.trim()
          ? ['执行一条命令',command,'工作目录：'+cwd,params.reason].filter(Boolean).join('\n'):undefined;
      }
      case 'item/fileChange/requestApproval':
        if (!operation?.changes?.length||operation.changes.some(change=>!change.path||!change.kind?.type||typeof change.diff!=='string')) return;
        return ['修改文件',params.reason,...operation.changes.map(change=>change.kind.type+' '+change.path+'\n'+change.diff)].filter(Boolean).join('\n');
      case 'acp/permission':
        if (!params.toolCall?.title||params.toolCall.rawInput===undefined) return;
        return params.toolCall.title+'\n'+JSON.stringify({input:params.toolCall.rawInput,changes:params.toolCall.content,locations:params.toolCall.locations},null,2);
      case 'omp/confirm':
        return params.message?.trim()?['OMP 单次工具调用',params.message].join('\n'):undefined;
    }
  };
  const questionSafe=(approval:Approval)=>{
    const questions=nativeQuestions(approval);
    return questions.length&&questions.every(q=>!q.isSecret&&(q.options?.length??0)<=20&&
      [q.header,q.question,...(q.options??[]).map(o=>o.label+'：'+o.description)].join('\n').length<=3500)
      ? questions:undefined;
  };
  const approvalCards=(scope:Scope):TelegramCard[]=>{
    const id=scope.conversation.id,runId=manager.executionId(id);
    if (!readable(id)) return [];
    const events=runId?invocationEvents(id,runId):[],title=label(scope);
    return manager.getApprovals(id).filter(a=>runId||(a.params as {async?:boolean}).async).map(approval=>{
      const question=approval.method==='item/tool/requestUserInput',kind=question?'question':'approval';
      const detail=question?undefined:approvalDetail(approval,events);
      const sourceRun=(approval.params as {async?:boolean;runId?:string}).async?(approval.params as {runId?:string}).runId:runId;
      const revision=digest({runId:sourceRun,approval,detail}),target={kind,conversationId:id,id:approval.id,revision,scope:scopeKey(scope)} satisfies TelegramDecision;
      const asyncTask=scope.task&&(approval.params as {async?:boolean}).async;
      const buttons:TelegramCard['buttons']=question&&!asyncTask&&questionSafe(approval)?[{text:'回答问题',action:{kind:'question',target}}]
        :detail&&title.length+detail.length<3400?[
          {text:'允许本次',action:{kind:'decision',target,decision:'approve'}},
          {text:'拒绝',action:{kind:'decision',target,decision:'reject'}},
        ]:undefined;
      return {key:'approval:'+approval.id+':'+revision+':'+target.scope,
        text:!buttons?title+'\n'+(question?'有问题等待回答':'有操作等待确认')+'。请在桌面查看并处理。'
          :question?title+'\n有问题等待回答。':title+'\n待确认 · '+detail,buttons,taskId:scope.task?.id};
    });
  };
  const currentApproval=(target:TelegramDecision)=>{
    const scope=scopeFor(target);
    if (!scope) return;
    const approval=manager.getApprovals(target.conversationId).find(item=>item.id===target.id);
    if (!approval) return;
    const card=approvalCards(scope).find(c=>c.buttons?.some(b=>'target' in b.action&&b.action.target.id===target.id&&b.action.target.revision===target.revision));
    return card?approval:undefined;
  };
  const currentConfigRevision=()=> {
    try{return createHash('sha256').update(readFileSync(join(home,'config.json'))).digest('hex');}catch{return undefined;}
  };
  const proposalCard=(conversation:Conversation,proposal:ManagementProposal):TelegramCard=>{
    const target:TelegramDecision={kind:'proposal',id:proposal.id,revision:proposal.version,conversationId:conversation.id,scope:'main'};
    const content=JSON.stringify(proposal.change,null,2),summary=JSON.stringify(proposal.summary??{},null,2);
    const text='Mandala 配置建议 · 待确认\n'+(proposal.objectName??'')+'\n'+content+'\n变更前后：\n'+summary;
    const canDecide=text.length<=3400&&!containsSensitiveFields(proposal.change);
    return {key:'proposal:'+proposal.id+':'+proposal.version,text:canDecide?text:'Mandala 有配置建议等待确认。请在桌面查看完整变更。',
      buttons:canDecide?[
        {text:'批准此项配置',action:{kind:'decision',target,decision:'approve'}},
        {text:'拒绝',action:{kind:'decision',target,decision:'reject'}},
      ]:undefined};
  };
  const fileList=(conversationId:string,runId:string,refs:VersionRef[],taskId?:string)=>{
    const files:NonNullable<TelegramCard['buttons']>=[],unavailableFiles:string[]=[];
    if (!readable(conversationId)) return {files,unavailableFiles};
    for (const ref of refs) {
      let version;
      try {version=reader().getAuthorizedVersion(root,ref);}
      catch(error){if(error instanceof DomainError)continue;throw error;}
      if (version.provenance.runId!==runId) continue;
      for (let index=0;index<version.files.length;index++) {
        if(files.length+unavailableFiles.length>=20) return {files,unavailableFiles:[...unavailableFiles,'其余文件请在桌面查看。']};
        const manifest=version.files[index],fileId=String(index);
        const size=manifest.size<1024?manifest.size+' B':manifest.size<1024*1024?(manifest.size/1024).toFixed(1)+' KiB':(manifest.size/(1024*1024)).toFixed(1)+' MiB';
        const name=line(basename(manifest.path),80);
        if (manifest.size>MAX_ATTACHMENT_SIZE) {
          unavailableFiles.push(name+' ('+size+') · 超过 20 MiB，请在桌面查看。');
          continue;
        }
        try {reader().readAssetFile(root,ref,fileId);}
        catch(error) {
          if (!(error instanceof DomainError)) throw error;
          unavailableFiles.push(name+' ('+size+') · 文件当前不可用，请在桌面查看。');
          continue;
        }
        files.push({text:'发送文件 · '+line(name,42)+' ('+size+')',
          action:{kind:'file',file:{conversationId,runId,...ref,fileId,...(taskId?{taskId}:{})}}});
      }
    }
    return {files,unavailableFiles};
  };
  const terminal=(id:string,runId:string)=>invocationEvents(id,runId).find(event=>event.kind==='status'&&['idle','error','interrupted'].includes((event.data as EventData).status??''));
  const completionCovered=(own:NonNullable<ReturnType<typeof owned>>['own'],task:Task,bindingId:string)=>{
    if (originBinding(own)!==bindingId||!task.completion) return false;
    const settled=terminal(own.conversationId,own.invocationId);
    return !settled||((settled.data as EventData).status==='idle'&&task.completion.acceptedAt<=settled.createdAt);
  };
  const completionFiles=(task:Task)=>{
    const runId=task.completion?.sourceRunId;
    if (!runId) return {files:[],unavailableFiles:[]};
    const run=tasks.getRunControl(root,runId);
    return run.routing?fileList(run.routing.executionConversationId,runId,task.completion?.artifactVersions??[],task.id):{files:[],unavailableFiles:[]};
  };
  const result=(id:string,inputId:string):TelegramResult|undefined=>{
    if (primary()?.id!==id||!readable(id)) return;
    const input=manager.listUserInputs(id).find(input=>input.id===inputId);
    if (input?.source?.kind!=='telegram'||['queued','running'].includes(input.state)) return;
    if (input.state==='unknown') return {text:'本机执行结果尚不明确，请在 Mandala 中检查。',files:[]};
    if (input.state==='cancelled') return {text:'本机队列中的请求已取消。',files:[]};
    const all=store.listEvents(id,0),user=all.find(e=>e.kind==='user'&&(e.data as EventData).queuedInputId===inputId),data=user?.data as EventData|undefined;
    const runId=data?.invocationId;
    if (!runId) return {text:'本机请求未获得可核实的执行结果，请在 Mandala 中检查。',files:[]};
    const end=terminal(id,runId);
    if (!end||(end.data as EventData).status!=='idle') return {text:'本机执行未成功结束，请在 Mandala 中查看。',files:[]};
    const events=all.filter(event=>(event.data as EventData).runId===runId||event.id===user?.id);
    const answer=groupChatTurns(events).flatMap(turn=>presentTurnText(turn,'idle').answers.map(message=>message.text)).join('\n\n');
    const refs=db.prepare("SELECT id,asset_id FROM asset_versions WHERE json_extract(data,'$.provenance.runId')=?").all(runId)
      .map(row=>({assetId:row.asset_id as string,versionId:row.id as string}));
    const bindingId=input.source.requestId.split(':')[0];
    const completed=ownedTasks().filter(({own,task})=>own.invocationId===runId&&task.state==='completed'&&completionCovered(own,task,bindingId)).map(({task})=>task);
    const outputs=[fileList(id,runId,refs),...completed.map(completionFiles)];
    const files=outputs.flatMap(output=>output.files),unavailable=outputs.flatMap(output=>output.unavailableFiles);
    const unavailableFiles=unavailable.slice(0,20);
    if(files.length>20||unavailable.length>20)unavailableFiles.unshift('其余文件请在桌面查看。');
    return {text:[answer||'Mandala 已完成本次处理。',...completed.map(task=>'协调任务已完成 · '+line(task.goal,200))].join('\n\n'),
      files:files.slice(0,20),unavailableFiles};
  };
  return {
    async primary(assertActive) {
      const {config}=await ensureMandalaConfig(home,assertActive);
      assertActive();
      const conversation=ensureMandalaConversation(store,config);
      if (conversation.executionLocation) throw invalid();
      return conversation.id;
    },
    enqueue(id,text,requestId,bindingId,attachments) {
      requirePrimary(id);
      if(!requestId.startsWith(bindingId+':')) throw invalid();
      return manager.enqueueTelegramInput(id,text,requestId,attachments).id;
    },
    result,
    task(id) {
      const entry=owned(id);
      return entry?{originBinding:originBinding(entry.own)}:undefined;
    },
    async attachment(id,name,bytes,assertActive) {
      requirePrimary(id);assertActive();
      const file=await saveAttachment(home,id,name,bytes);
      try { assertActive(); }
      catch(error) {await rm(join(home,'attachments',id,file.id),{recursive:true,force:true});throw error;}
      return file.id;
    },
    async discardAttachments(id,attachments) {
      for(const item of attachments)if(/^[a-f0-9-]{36}$/.test(item))
        await rm(join(home,'attachments',id,item),{recursive:true,force:true});
    },
    taskReply(target,text) {
      const task=owned(target.taskId)?.task;
      if(!task||task.revision!==target.revision||!taskRequest(task))throw invalid();
      return '回复 Mandala 任务「'+line(task.goal,200)+'」（'+task.id+'）：\n'+text;
    },
    async file(ref:TelegramFile,assertActive) {
      const authorize=()=>{
        assertActive();
        if(!readable(ref.conversationId)) throw invalid();
        if(ref.taskId) {
          const task=owned(ref.taskId)?.task;
          if (task?.state!=='completed'||task.completion?.sourceRunId!==ref.runId||
              !task.completion.artifactVersions.some(item=>item.assetId===ref.assetId&&item.versionId===ref.versionId)||
              tasks.getRunControl(root,ref.runId).routing?.executionConversationId!==ref.conversationId) throw invalid();
        } else {
          requirePrimary(ref.conversationId);
          const accepted=store.listEvents(ref.conversationId,0).some(event=>event.kind==='user'&&(event.data as EventData).invocationId===ref.runId&&(event.data as EventData).source?.kind==='telegram');
          if(!accepted||!terminal(ref.conversationId,ref.runId)) throw invalid();
        }
        const version=reader().getAuthorizedVersion(root,ref);
        if(version.provenance.runId!==ref.runId) throw invalid();
        const file=reader().readAssetFile(root,ref,ref.fileId);
        if(file.size>MAX_ATTACHMENT_SIZE) throw new DomainError('telegram_size',413,'文件超过 20 MiB，请在桌面查看。');
        return {file,hash:version.files[Number(ref.fileId)].blobHash};
      };
      const {file,hash}=authorize(),handle=await open(file.blobPath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try {
        const before=await handle.stat();
        if(!before.isFile()||before.size!==file.size) throw invalid();
        const bytes=Buffer.alloc(file.size+1);
        let length=0;
        while(length<bytes.length){
          const {bytesRead}=await handle.read(bytes,length,bytes.length-length,length);
          if(!bytesRead) break;
          length+=bytesRead;
        }
        const content=bytes.subarray(0,length),after=authorize();
        if(length!==file.size||after.hash!==hash||createHash('sha256').update(content).digest('hex')!==hash) throw invalid();
        return {name:basename(file.name),bytes:content,photo:['image/jpeg','image/png'].includes(file.mediaType)};
      } finally {await handle.close();}
    },
    question(target) {
      const approval=target.kind==='question'&&currentApproval(target);
      return approval?questionSafe(approval):undefined;
    },
    submitAsyncQuestion(target,answers,requestId,assertActive) {
      const approval=target.kind==='question'&&currentApproval(target);
      if(!approval||!questionSafe(approval))throw invalid();
      if(!(approval.params as {async?:boolean}).async)return;
      requirePrimary(target.conversationId);
      assertActive();
      const input=manager.submitAsyncQuestion(target.conversationId,target.id,answers,requestId);
      return {conversationId:target.conversationId,inputId:input.id};
    },
    async decide(target,decision,assertActive) {
      assertActive();
      if (target.kind==='proposal') {
        const scope=scopeFor(target);
        if (!scope||scope.task||typeof decision!=='string') throw invalid();
        const item=manager.coordination.proposals(target.conversationId).find(p=>p.id===target.id&&p.version===target.revision&&p.status==='pending');
        if(!item||item.configRevision!==currentConfigRevision()||!proposalCard(scope.conversation,item).buttons) throw invalid();
        const confirmed=await manager.coordination.confirm(item.id,item.version,decision,assertActive);
        if(confirmed.status!==(decision==='approve'?'applied':'rejected'))throw invalid();
        return;
      }
      const approval=currentApproval(target);
      if (!approval) throw invalid();
      assertActive();
      if (target.kind==='question'&&typeof decision==='object'&&questionSafe(approval)) await manager.answerQuestions(target.conversationId,target.id,decision);
      else if (target.kind==='approval'&&approval.method!=='item/tool/requestUserInput'&&(decision==='approve'||decision==='reject'))
        await manager.approve(target.conversationId,target.id,decision==='reject'&&!approvalChoices(approval).includes('reject')?'reject-stop':decision);
      else throw invalid();
    },
    cards(bindingId,since,enabled,attention) {
      const chat=primary(),cards:TelegramCard[]=[];
      if (!chat||!readable(chat.id)) return cards;
      if (attention) {
        cards.push(...approvalCards({conversation:chat}));
        const proposals=manager.coordination.proposals(chat.id).filter(p=>p.status==='pending');
        const revision=proposals.length?currentConfigRevision():undefined;
        cards.push(...proposals.filter(p=>p.configRevision===revision).map(p=>proposalCard(chat,p)));
        if (['error','interrupted'].includes(chat.status)) {
          const end=store.listEvents(chat.id,0).filter(e=>e.kind==='status').at(-1),runId=(end?.data as EventData|undefined)?.runId;
          const source=runId?invocationEvents(chat.id,runId).find(e=>e.kind==='user')?.data as EventData|undefined:undefined;
          if(end&&end.createdAt>=since&&source?.source?.kind!=='telegram')
            cards.push({key:'main-failure:'+end.id,text:'Mandala 主对话执行中断，请在桌面查看。'});
        }
      }
      for (const {own,task} of ownedTasks()) {
        if (task.state==='completed'&&enabled(task.id)&&task.completion&&task.completion.acceptedAt>=since&&!completionCovered(own,task,bindingId)) {
          const run=task.completion.sourceRunId?tasks.getRun(root,task.completion.sourceRunId):undefined;
          const summary=run?.summary?.trim();
          const output=completionFiles(task);
          cards.push({key:'task-completed:'+task.id+':'+task.completion.acceptedAt,
            text:['任务已完成 · '+line(task.goal,200),...output.unavailableFiles,summary?.slice(0,2600)].filter(Boolean).join('\n'),buttons:output.files,taskId:task.id,completion:true});
        }
        if(!attention) continue;
        if(task.state==='review')cards.push({key:'task-review:'+task.id+':'+task.revision,text:line(task.goal,200)+'\n任务交付等待验收，请在桌面查看。',taskId:task.id});
        const scoped=taskScopes(task);
        cards.push(...scoped.flatMap(approvalCards));
        if (task.state==='waiting'&&(own.blockedReason||task.waitingReason&&task.waitingReason!=='approval'||!task.waitingReason)) {
          const request=taskRequest(task);
          const action=request?'需要你处理：'+request.text.slice(0,2600)+'\n回复这条消息可继续处理。':own.blockedReason?'任务需要处理 · '+line(own.blockedReason,800):'任务等待处理，请在桌面查看。';
          cards.push({key:'task-attention:'+task.id+':'+task.revision,text:line(task.goal,200)+'\n'+action,taskId:task.id,...(request?{reply:{taskId:task.id,revision:task.revision}}:{})});
        } else if (task.state==='running') {
          for(const execution of task.executions){
            const run=execution.latestRun;
            if(!execution.supersededByExecutionId&&run?.state==='unknown'&&run.monitor?.attention)
              cards.push({key:'task-unconfirmed:'+task.id+':'+run.id,text:line(task.goal,200)+'\n本机执行状态未确认，请在桌面查看。',taskId:task.id});
          }
        }
        if (!scoped.length&&!['completed','cancelled'].includes(task.state)&&(task.waitingReason==='approval'||task.executions.some(e=>!e.supersededByExecutionId&&e.latestRun?.state==='approval'))) {
          cards.push({key:'task-approval:'+task.id+':'+task.revision,text:line(task.goal,200)+'\n任务有审批等待处理，请在桌面查看。',taskId:task.id});
        }
      }
      return cards;
    },
    progress(bindingId) {
      const chat=primary();
      const states:Record<string,string>={queued:'排队中',running:'执行中',unknown:'状态待核实',todo:'待开始',waiting:'待处理',review:'待验收',completed:'已完成'};
      const requests=chat&&readable(chat.id)?manager.listUserInputs(chat.id).filter(input=>input.source?.kind==='telegram'&&input.source.requestId.startsWith(bindingId+':')&&['queued','running','unknown'].includes(input.state)):[];
      return [...requests.slice(-10).map(input=>states[input.state]+' · '+line(input.text||'附件请求')),
        ...ownedTasks().filter(({task})=>!['completed','cancelled'].includes(task.state)).slice(0,15).map(({task})=>states[task.state]+' · '+line(task.goal))];
    },
  };
}
