import { useEffect, useMemo, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from './components/ui/popover';
import type {ExecutionLocation} from '../shared/types';
import type { ConversationReferenceSummary, ReferenceDocument } from '../shared/conversation-references';
import type { ConversationWorkspaceTab } from './ConversationWorkspace';
import type { ContentTarget } from './ContentPreviewContext';
import { sourceIcon, sourceLabel, type ConversationFile } from './conversationFiles';
import { goalParts } from '../shared/task-presentation';
import { memoryBody, memorySummary } from './memory-text';
import { followAssetPage } from './AssetLibrary';
import { requestJson } from './api';
import { useLanguage } from './i18n';
import Icon, { type IconName } from './ui/Icon';
import './conversation-context-popover.css';

type Environment = {cwd:string;git:false}|{cwd:string;git:true;branch:string;changes:{files:number;additions:number;deletions:number};worktrees?:{path:string;branch:string;createdHere:boolean}[]};
type Capabilities = {skills:unknown[];mcp:unknown[]};
type Source = {key:string;icon:IconName;name:string;kind:string;tone?:'muted';open?:()=>void;href?:string};

// The single context view of a chat, and the summary of everything the side panel holds:
// where it works and what changed, what is moving, every source it draws on and what it can use.
// Clicking through opens the matching side-panel tool; documents open in the panel's reader.
export default function ConversationContextPopover({conversationId,executionLocation,activityVersion='',running=false,capabilitiesQuery,loadFiles,onPanel,onDocument,onContent}:{
 conversationId:string; executionLocation?:ExecutionLocation; activityVersion?:string; running?:boolean; capabilitiesQuery?:string;
 loadFiles?:()=>ConversationFile[];
 onPanel:(tab:ConversationWorkspaceTab)=>void; onDocument:(doc:ReferenceDocument)=>void; onContent:(target:ContentTarget)=>void;
}) {
 const {text}=useLanguage();
 const [open,setOpen]=useState(false);
 const [place,setPlace]=useState<{id:string;value:Environment}|null>(null);
 const [summary,setSummary]=useState<{id:string;value:ConversationReferenceSummary}|null>(null);
 const [abilities,setAbilities]=useState<{key:string;value:Capabilities}|null>(null);
 useEffect(()=>{
  const controller=new AbortController();
  // The trigger stays useful without the summary, so a failed read only hides the numbers.
  void requestJson<Environment>('/api/conversations/'+encodeURIComponent(conversationId)+'/environment',{signal:controller.signal}).then(value=>{if(!controller.signal.aborted)setPlace({id:conversationId,value});}).catch(()=>{});
  return()=>controller.abort();
 },[conversationId,activityVersion]);
 useEffect(()=>{
  if(!open)return;
  const controller=new AbortController();
  void requestJson<ConversationReferenceSummary>('/api/conversations/'+encodeURIComponent(conversationId)+'/reference-summary',{signal:controller.signal}).then(value=>{if(!controller.signal.aborted)setSummary({id:conversationId,value});}).catch(()=>{});
  if(capabilitiesQuery)void requestJson<Capabilities>('/api/effective?'+capabilitiesQuery,{signal:controller.signal}).then(value=>{if(!controller.signal.aborted)setAbilities({key:capabilitiesQuery,value});}).catch(()=>{});
  return()=>controller.abort();
 },[open,conversationId,activityVersion,capabilitiesQuery]);
 const files=useMemo(()=>open&&loadFiles?loadFiles():[],[open,loadFiles]);
 const env=place?.id===conversationId?place.value:null,data=summary?.id===conversationId?summary.value:null;
 const caps=abilities&&abilities.key===capabilitiesQuery?abilities.value:null;
 const changes=env?.git&&env.changes.files>0?env.changes:null;
 const created=env?.git?(env.worktrees??[]).filter(item=>item.createdHere):[];
 const states:Record<string,string>={todo:text('待办','To do'),running:text('进行中','In progress'),waiting:text('待处理','Needs attention'),review:text('待审阅','Review'),completed:text('已完成','Completed'),cancelled:text('已取消','Cancelled')};
 // Every linked task, unfinished first; finished ones stay listed but quiet.
 const done=(state:string)=>state==='completed'||state==='cancelled';
 const linked=[...(data?.tasks??[])].sort((a,b)=>Number(done(a.state))-Number(done(b.state)));
 const delivery=(memory:ConversationReferenceSummary['memories'][number])=>memory.relation==='generated'?text('本次生成','Generated here'):memory.relation==='available'?(memory.suppliedRevision?text('新版本未提供','Newer revision not provided'):text('尚未提供','Not provided')):text('已提供','Provided');
 const remaining=files.filter(file=>!data?.documents.some(doc=>doc.attachmentId===file.id));
 const sources:Source[]=data?[
  ...data.documents.filter(doc=>!doc.relations.includes('output')).map(doc=>({key:'d'+doc.assetId+doc.versionId,icon:'book' as IconName,name:doc.title,kind:text('资料','Source')+' v'+doc.ordinal,open:()=>onDocument(doc)})),
  ...remaining.map(file=>({key:'f'+file.id,icon:sourceIcon[file.source],name:file.name,kind:text(sourceLabel[file.source][0],sourceLabel[file.source][1]),open:()=>onContent(file.target)})),
  ...data.memories.map(memory=>({key:'m'+memory.recordId+memory.relation,icon:'layers' as IconName,name:memoryTitle(memory.text),kind:text('记忆','Memory')+' · '+delivery(memory),tone:memory.relation==='available'?'muted' as const:undefined,href:'/mana?recordId='+encodeURIComponent(memory.recordId)})),
  ...data.documents.filter(doc=>doc.relations.includes('output')).map(doc=>({key:'o'+doc.assetId+doc.versionId,icon:'file' as IconName,name:doc.title,kind:text('产出','Output')+' v'+doc.ordinal,open:()=>onDocument(doc)})),
 ]:[];
 const panel=(tab:ConversationWorkspaceTab)=>{setOpen(false);onPanel(tab);};
 const cwd=executionLocation?.cwd??env?.cwd;
 const folder=cwd?cwd.split(/[\\/]/).filter(Boolean).pop()??cwd:'';
 const capabilityText=caps?[caps.skills.length?text(`${caps.skills.length} 个技能`,`${caps.skills.length} skills`):'',caps.mcp.length?text(`${caps.mcp.length} 个 MCP`,`${caps.mcp.length} MCP`):''].filter(Boolean).join(' · ')||text('未配置技能或 MCP','No skills or MCP'):'';
 return <Popover open={open} onOpenChange={setOpen}>
  <PopoverTrigger asChild><button type="button" className="context-popover-trigger" aria-label={text('对话上下文','Chat context')} title={executionLocation?text(`对话上下文 · 在 ${executionLocation.machineName}（${executionLocation.host}）上执行`,`Chat context · runs on ${executionLocation.machineName} (${executionLocation.host})`):text('对话上下文','Chat context')}>
   {executionLocation?<><Icon name="server" size={16}/><span className="context-popover-machine">{executionLocation.machineName}</span></>:<Icon name={env?.git?'gitBranch':'layers'} size={16}/>}
   {changes?<span className="context-popover-diff"><span className="change-add">+{changes.additions}</span> <span className="change-remove">−{changes.deletions}</span></span>:!executionLocation&&<span>{text('上下文','Context')}</span>}
   {running&&<span className="status-dot running" aria-label={text('执行中','Running')}/>}
  </button></PopoverTrigger>
  <PopoverContent className="context-popover" align="end" sideOffset={6} aria-label={text('对话上下文','Chat context')}>
   {(env||executionLocation)&&<section aria-label={text('工作区','Workspace')}><h3>{text('工作区','Workspace')}</h3>
    {executionLocation&&<div className="context-popover-row is-static" title={executionLocation.host}><Icon name="server" size={16}/><span className="context-popover-name">{executionLocation.machineName}</span><span className="context-popover-aside mono">{executionLocation.host}</span></div>}
    {executionLocation&&<p className="context-popover-note mono">{executionLocation.cwd}</p>}
    <button type="button" className="context-popover-row" title={cwd} onClick={()=>panel('files')}><Icon name="folder" size={16}/><span className="context-popover-name">{folder}</span>{env?.git&&<span className="context-popover-aside mono">{env.branch||text('游离提交','Detached HEAD')}</span>}<Icon className="context-popover-chevron" name="chevronRight" size={14}/></button>
    {env?.git&&<button type="button" className="context-popover-row" onClick={()=>panel('changes')}><Icon name="gitBranch" size={16}/><span className="context-popover-name">{changes?text(`改动 · ${changes.files} 个文件`,`Changes · ${changes.files} files`):text('没有未提交改动','No uncommitted changes')}</span>{changes&&<span className="context-popover-aside"><span className="change-add">+{changes.additions}</span> <span className="change-remove">−{changes.deletions}</span></span>}<Icon className="context-popover-chevron" name="chevronRight" size={14}/></button>}
    {created.map(item=><div key={item.path} className="context-popover-row is-static" title={item.path}><Icon name="gitBranch" size={16}/><span className="context-popover-name mono">{item.branch||text('游离提交','Detached HEAD')}</span><span className="context-popover-aside">{text('本对话创建','Created here')}</span></div>)}
   </section>}
   {linked.length>0&&<section aria-label={text('任务','Tasks')}><h3>{text('任务','Tasks')}</h3>
    {linked.map(task=><a key={task.id} className="context-popover-row" href={'/tasks/'+encodeURIComponent(task.id)} onClick={event=>{setOpen(false);followAssetPage(event);}}><Icon name="plan" size={16}/><span className="context-popover-name">{goalParts(task.goal).title}</span><span className="context-popover-state" data-state={task.state}>{states[task.state]}</span></a>)}
   </section>}
   <section aria-label={text('来源','Sources')}><h3>{text('来源','Sources')}</h3>
    {!data?<p className="context-popover-note">{text('正在读取…','Loading…')}</p>:!sources.length&&<p className="context-popover-note">{text('还没有附件、资料或记忆。','No attachments, sources or memories yet.')}</p>}
    <div className="context-popover-sources">{sources.map(source=>{const body=<><Icon name={source.icon} size={16}/><span className="context-popover-name">{source.name}</span><span className="context-popover-aside" data-tone={source.tone}>{source.kind}</span></>;
     return source.href?<a key={source.key} className="context-popover-row" href={source.href} onClick={event=>{setOpen(false);followAssetPage(event);}}>{body}</a>:<button type="button" key={source.key} className="context-popover-row" onClick={()=>{setOpen(false);source.open?.();}}>{body}</button>;})}</div>
    {data?.truncated&&<p className="context-popover-note">{text('引用过多，仅显示最近的部分。','Only the most recent references are shown.')}</p>}
   </section>
   <section aria-label={text('能力','Capabilities')}><h3>{text('能力','Capabilities')}</h3>
    <button type="button" className="context-popover-row" onClick={()=>panel('configuration')}><Icon name="sparkles" size={16}/><span className="context-popover-name">{capabilityText||text('技能与 MCP','Skills and MCP')}</span><Icon className="context-popover-chevron" name="chevronRight" size={14}/></button>
    <button type="button" className="context-popover-row" onClick={()=>panel('configuration')}><Icon name="book" size={16}/><span className="context-popover-name">{text('指令与候选资料','Instructions and available sources')}</span><Icon className="context-popover-chevron" name="chevronRight" size={14}/></button>
   </section>
   <section className="context-popover-tools" aria-label={text('工具','Tools')}>
    <button type="button" onClick={()=>panel('files')}><Icon name="file" size={16}/>{text('文件','Files')}</button>
    <button type="button" onClick={()=>panel('changes')}><Icon name="gitBranch" size={16}/>{text('改动','Changes')}</button>
    <button type="button" onClick={()=>panel('terminal')}><Icon name="terminal" size={16}/>{text('终端','Terminal')}</button>
   </section>
  </PopoverContent>
 </Popover>;
}

function memoryTitle(value:string){
 const title=memorySummary(value)??memoryBody(value).split('\n').map(line=>line.replace(/^[#>*\-\s]+/,'').trim()).find(Boolean)??'';
 return title.length>80?title.slice(0,80)+'…':title;
}
