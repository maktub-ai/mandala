import {memoryGroup, memoryMatchesAgent} from './object-scope';
import Button from './ui/Button';
import Input from './ui/Input';
import Textarea from './ui/Textarea';
import { startPolling } from './polling';
import { requestJson } from './api';
import IdentityAvatar from "./IdentityAvatar";
import Select from './ui/Select';
import LoadingState from './ui/LoadingState';
import Disclosure from './ui/Disclosure';
import Dialog from './Dialog';
import { useEffect, useLayoutEffect, useState } from 'react';
import type { Config, Conversation } from '../shared/types';
import type { MemoryCollection, MemoryJob, MemoryRevision, MemorySource, MemorySourceSummary } from '../shared/memory';
import { useLanguage } from './i18n';
import { followAssetPage } from './AssetLibrary';
import Icon, { type IconName } from './ui/Icon';
import EmptyState from './ui/EmptyState';
import MarkdownMessage from './MarkdownMessage';
import { enabledRuntimes } from '../shared/runtimes';
import './memory.css';
import { memoryBody, memorySummary } from './memory-text';
import { needsCorrection } from '../shared/memory-job-policy';
function request<T>(path:string,method='GET',body?:unknown,signal?:AbortSignal):Promise<T>{return requestJson('/api/v2/memory/'+path,{method,signal,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});}
const states:Record<string,[string,string]>={active:['生效','Active'],proposed:['未验证','Unverified'],retracted:['已撤回','Withdrawn'],stale:['来源已更新','Source changed'],superseded:['历史修订','Historical revision'],expired:['已过期','Expired']};
const actionErrors:Record<string,[string,string]>={
 revision_conflict:['记录已更新，请重新审核最新内容。','Memory changed. Review the latest content.'],
 invalid_memory_text:['内容为空、过长或包含敏感信息，请修改后重试。','Content is empty, too long or contains sensitive data. Correct it before saving.'],
};
const contentTypes:Record<MemoryRevision['contentType'],[string,string]>={fact:['事实','Fact'],preference:['偏好','Preference'],decision:['决策','Decision'],procedure:['流程','Procedure'],constraint:['约束','Constraint'],open_issue:['未决问题','Open issue']};
const groups={
 facts:{layer:'L1',icon:'file',label:['原子事实','Atomic facts'],description:['有来源支持的具体事实与偏好','Specific facts and preferences backed by sources']},
 scenes:{layer:'L2',icon:'layers',label:['场景知识','Scene knowledge'],description:['把相关事实整合成可复用的场景','Related facts consolidated into reusable scenes']},
 sessions:{layer:'',icon:'message',label:['整合上下文','Consolidated context'],description:['会话整理后的背景与进展','Context and progress consolidated from conversations']},
 context:{layer:'L3',icon:'sparkles',label:['长期上下文','Stable context'],description:['跨场景整理的长期背景与约定','Long-term context and conventions across scenes']},
} satisfies Record<string,{layer:string;icon:IconName;label:[string,string];description:[string,string]}>;
type MemoryGroup=keyof typeof groups;
const groupKeys=['facts','scenes','context'] as const;
const legacyCandidate=(r:MemoryRevision)=>r.status==='proposed'&&r.verification==='legacy_user_managed';
const compactPaths=(text:string)=>text.replace(/\/(?:Users|var|tmp)\/[^\s，。；：]+/g,path=>'…/'+path.split('/').at(-1));
const uuidPattern=/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// Known task/chat ids read as their titles; other ids shrink to a short prefix.
const readableIds=(text:string,names:Map<string,string>)=>text.replace(uuidPattern,id=>names.has(id)?'「'+names.get(id)+'」':id.slice(0,8));
const PAGE_SIZE=20;
const updatedAt=(record:MemoryRevision)=>[record.extractedAt,record.effectiveFrom].find(value=>value&&Number.isFinite(Date.parse(value)))??'';
function MemoryPagination({total,page,onPage,label,disabled}:{total:number;page:number;onPage:(page:number)=>void;label:string;disabled:boolean}){
 const {text: localize}=useLanguage();
 if(!total)return null;
 return <nav className="memory-pagination" aria-label={label}><span role="status">{(page-1)*PAGE_SIZE+1}–{Math.min(page*PAGE_SIZE,total)} {localize('/', 'of')} {total}</span><div><Button disabled={disabled||page===1} onClick={()=>onPage(page-1)}>{localize('上一页', 'Previous')}</Button><Button disabled={disabled||page*PAGE_SIZE>=total} onClick={()=>onPage(page+1)}>{localize('下一页', 'Next')}</Button></div></nav>;
}
function MemoryContent({record,compact=false,names}:{record:MemoryRevision;compact?:boolean;names:Map<string,string>}){
 const {text: localize}=useLanguage(),body=readableIds(memoryBody(record.text),names),long=compact&&/\/(?:Users|var|tmp)\//.test(body)||body.length>(compact?240:420)||(body.match(/^#{1,6}\s/gm)?.length??0)>=3,[expanded,setExpanded]=useState(false);
 const metaTitle=record.legacy?.title??memorySummary(record.text),title=metaTitle?readableIds(metaTitle,names):(record.layer==='L1'?body.match(/\/([^/\s]+\.(?:tsx?|md|py|json))(?=[\s：:，。,；;)]|$)/)?.[1]:undefined);
 const excerpt=compactPaths(body.split('\n').filter(line=>line.trim()&&!/^\s*#/.test(line)).join(' ').replace(/[*`]/g,'')).slice(0,compact?160:240);
 return <div className="memory-card-content">{long?<>{title&&<h3 className="memory-card-title">{compactPaths(title)}</h3>}<p className="memory-card-excerpt">{excerpt}…</p><Disclosure className="memory-card-detail" onToggle={e=>{if(e.target===e.currentTarget)setExpanded(e.currentTarget.open);}} title={<> {localize('查看完整内容', 'Read full memory')} </>}>{expanded&&<MarkdownMessage text={body}/>}</Disclosure></>:<MarkdownMessage text={body}/>}</div>;
}
export default function MemoryWorkspace({config,scopedAgentId,conversations=[],onOpenConversation,onNavigationLockChange}:{config:Config;scopedAgentId?:string;conversations?:Conversation[];onOpenConversation?:(id:string)=>void;onNavigationLockChange?:(v:boolean)=>void}){
 const {text: localize, language}=useLanguage(),say=(zh:string,en:string)=>localize(zh, en);
 const [sourceSummaries,setSourceSummaries]=useState<MemorySourceSummary[]>([]);
 const [agent,setAgent]=useState(scopedAgentId ?? new URLSearchParams(location.search).get('agent') ?? 'all'),[from,setFrom]=useState(''),[until,setUntil]=useState('');
 const [route,setRoute]=useState(location.search),[records,setRecords]=useState<MemoryRevision[]>([]),[collections,setCollections]=useState<MemoryCollection[]>([]),[jobs,setJobs]=useState<MemoryJob[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(true);
 const [query,setQuery]=useState(''),[status,setStatus]=useState('active'),[order,setOrder]=useState('newest'),[editing,setEditing]=useState<MemoryRevision|null>(null),[text,setText]=useState(''),[busy,setBusy]=useState(false),[source,setSource]=useState<MemorySource|null>(null);
 const [category,setCategory]=useState<MemoryGroup|'all'>('all'),[showSources,setShowSources]=useState(false),[historyOpen,setHistoryOpen]=useState(false),[retracting,setRetracting]=useState<string|null>(null);
 const [pages,setPages]=useState({key:'',current:1,history:1});

 const followMemoryPage:typeof followAssetPage = event=>{if(busy||editing){event.preventDefault();return;}followAssetPage(event);};
 const params=new URLSearchParams(route),project=params.get('project'),taskId=params.get('taskId'),conversationId=params.get('conversationId'),recordId=params.get('recordId');
 const exitExactSelection=()=>{
  if(!recordId)return;
  const query=new URLSearchParams(location.search);query.delete('recordId');
  history.pushState(null,'',location.pathname+(query.size?'?'+query:''));
  setRoute(location.search);dispatchEvent(new PopStateEvent('popstate'));
 };
 useEffect(()=>setAgent(scopedAgentId??new URLSearchParams(route).get('agent')??'all'),[route,scopedAgentId]);
 const changeAgent=(value:string)=>{const query=new URLSearchParams(location.search);query.delete('recordId');query.delete('conversationId');query.delete('taskId');if(value==='all')query.delete('agent');else query.set('agent',value);setAgent(value);history.pushState(null,'',location.pathname+'?'+query);dispatchEvent(new PopStateEvent('popstate'));};
 const filters=new URLSearchParams({...project!==null?{projectId:project}:{},...taskId?{taskId}:{},...conversationId?{conversationId}:{}}).toString();
 useEffect(()=>{const update=()=>setRoute(location.search);addEventListener('popstate',update);return()=>removeEventListener('popstate',update);},[]);
 useLayoutEffect(()=>{onNavigationLockChange?.(busy||!!editing);return()=>onNavigationLockChange?.(false);},[busy,editing,onNavigationLockChange]);
 async function refresh(){const [data,nextJobs]=await Promise.all([request<{records:MemoryRevision[];collections:MemoryCollection[];sources?:MemorySourceSummary[]}>('records?'+filters),request<MemoryJob[]>('jobs')]);setRecords(data.records);setSourceSummaries(data.sources??[]);setCollections(data.collections);setJobs(nextJobs);setError('');}
 useEffect(()=>{
  let active=true,timer:ReturnType<typeof setTimeout>;
  setLoading(true);
  const load=async()=>{
   if(document.hidden){timer=setTimeout(load,5000);return;}
   await Promise.allSettled([
    request<{records:MemoryRevision[];collections:MemoryCollection[];sources?:MemorySourceSummary[]}>('records?'+filters).then(data=>{if(active){setRecords(data.records);setSourceSummaries(data.sources??[]);setCollections(data.collections);setError('');}}).catch(e=>{if(active)setError((e as Error).message);}).finally(()=>{if(active)setLoading(false);}),
    request<MemoryJob[]>('jobs').then(next=>{if(active)setJobs(next);}).catch(()=>{if(active)setJobs([]);}),
   ]);
   if(active)timer=setTimeout(load,5000);
  };
  void load();return()=>{active=false;clearTimeout(timer);};
 },[filters]);
 useEffect(()=>{if(!source)return;let active=true;const stop=startPolling(signal=>request<MemorySource>('sources/'+source.id,'GET',undefined,signal).then(next=>{if(active)setSource(next);}).catch(()=>{if(active){setSource(null);setError(say('来源已变更或不可访问。','Source changed or is unavailable.'));}}),2000,{immediate:false});return()=>{active=false;stop();};},[source?.id]);
 async function change(record:MemoryRevision,action:'correct'|'retract'){setBusy(true);setError('');try{await request('records/'+record.recordId+'/'+action,'POST',{expectedRevision:record.revision,...action==='correct'?{text:record.text.slice(0,record.text.length-memoryBody(record.text).length)+text}:{}});setEditing(null);setRetracting(null);await refresh();if(action==='retract')setHistoryOpen(true);}catch(e){const message=(e as Error).message;setError(actionErrors[message]?say(...actionErrors[message]):message);}finally{setBusy(false);}}
 const matchesCommon=(text:string,timestamp:string,collectionId:string,agentIds:string[]=[])=>{
  const c=collections.find(c=>c.id===collectionId),date=timestamp.slice(0,10);
  return (project===null||c?.projectId===(project||null))&&((scopedAgentId ?? agent)==='all'||agentIds.includes(scopedAgentId ?? agent)||c?.agentId===(scopedAgentId ?? agent))&&(!query||text.toLocaleLowerCase().includes(query.toLocaleLowerCase()))&&(!from||date>=from)&&(!until||date<=until);
 };
 const filteredRecords=records.filter(r=>matchesCommon(r.text,updatedAt(r),r.collectionId,r.sourceAgentIds??[])&&(status==='all'||r.status===status));
 const visible=records.filter(r=>((scopedAgentId??agent)==='all' || memoryMatchesAgent(r,collections,scopedAgentId??agent)) && (recordId?r.recordId===recordId:filteredRecords.includes(r)&&memoryGroup(r)!=='sessions'&&(category==='all'||memoryGroup(r)===category))).sort((a,b)=>{
  const left=Date.parse(updatedAt(a)),right=Date.parse(updatedAt(b));
  if(!Number.isFinite(left)||!Number.isFinite(right))return Number.isFinite(left)?-1:Number.isFinite(right)?1:a.recordId.localeCompare(b.recordId);
  return (order==='oldest'?1:-1)*(left-right)||a.recordId.localeCompare(b.recordId);
 });
 const currentRecords=visible.filter(r=>!legacyCandidate(r)&&(status!=='all'||['active','proposed'].includes(r.status))),historicalRecords=visible.filter(r=>legacyCandidate(r)||status==='all'&&!['active','proposed'].includes(r.status));
 useEffect(()=>{if(recordId&&historicalRecords.some(r=>r.recordId===recordId))setHistoryOpen(true);},[recordId,records]);
 const viewKey=JSON.stringify([filters,category,status,query,order,agent,from,until]),viewPages=pages.key===viewKey?pages:{key:viewKey,current:1,history:1};
 const currentPage=Math.min(viewPages.current,Math.max(1,Math.ceil(currentRecords.length/PAGE_SIZE))),historyPage=Math.min(viewPages.history,Math.max(1,Math.ceil(historicalRecords.length/PAGE_SIZE)));
 useEffect(()=>{setPages(previous=>previous.key===viewKey&&previous.current===currentPage&&previous.history===historyPage?previous:{key:viewKey,current:currentPage,history:historyPage});},[viewKey,currentPage,historyPage]);
 const sourceRefs=[...new Map(visible.flatMap(r=>r.evidence).map(ref=>[ref.sourceId,ref])).values()];
 const openSource=(id:string)=>{setSource(null);void request<MemorySource>('sources/'+id).then(setSource).catch(e=>setError(e.message));};
 const activeJobs=jobs.filter(job=>{
  const collection=collections.find(c=>c.id===job.collectionId),kind=job.kind??'request';
  const enabled=config.system?.memory?.[kind]?.generate??config.system?.memoryCapture!==false;
  const runtime=config.system?.tasks?.memory?.cli??config.system?.cli??conversations.find(chat=>chat.id===job.conversationId)?.cli??config.agents.find(a=>a.id===collection?.agentId)?.defaultCli;
  return ((scopedAgentId??agent)==='all' || collection?.agentId===(scopedAgentId??agent) || job.principal.agentId===(scopedAgentId??agent))&&kind==='request'&&enabled&&(!runtime||enabledRuntimes(config).includes(runtime))&&(project===null||collection?.projectId===(project||null))&&
   (job.state==='running'||job.state==='queued'&&!needsCorrection(job)||job.state==='pending'&&job.error==='needs_chunking');
 });
 const processingCount=activeJobs.filter(job=>job.state==='running').length,waitingCount=activeJobs.length-processingCount;
 const conversationTitle=(id:string)=>sourceSummaries.find(source=>source.conversationId===id&&source.title)?.title||conversations.find(chat=>chat.id===id)?.title||say('对话 · ','Conversation · ')+id.slice(0,8);
 const names=new Map<string,string>([...conversations.flatMap(chat=>chat.title?[[chat.id,chat.title] as [string,string]]:[]),...sourceSummaries.flatMap(info=>{const id=info.kind==='task'?info.taskId:info.conversationId;return info.title&&id?[[id,info.title] as [string,string]]:[];})]);
 const locked=busy||!!editing;
 const sourcesFor=(r:MemoryRevision)=>{
  const chatIds=[...new Set([r.conversationId,...r.conversationIds??[]].filter((id):id is string=>!!id))],taskIds=[...new Set([r.taskId,...r.taskIds??[]].filter((id):id is string=>!!id))],basis=r.layer==='L1'?[]:r.dependencies??[];
  const count=basis.length+chatIds.length+taskIds.length+r.evidence.length;
  if(!count)return null;
  return <Disclosure className="memory-sources" title={<><Icon name="layers" size={13}/>{say('来源','Sources')} · {count}</>}>
   {basis.length>0&&<div className="memory-source-group"><span>{say('依据','Based on')}</span>{basis.map(ref=>{const parent=records.find(record=>record.recordId===ref.recordId),label=parent?readableIds(parent.legacy?.title||parent.text.match(/summary:\s*([^\n]+)/)?.[1]||compactPaths(memoryBody(parent.text).replace(/[#*`]/g,'').replace(/\s+/g,' ').trim()).slice(0,90),names):say('依据暂不可用','Basis unavailable');
    return parent?<a key={ref.recordId} href={'/mana?tab=memory&recordId='+encodeURIComponent(ref.recordId)} aria-disabled={locked} onClick={followMemoryPage}>{label}{parent.revision!==ref.revision?' · '+say('已有新版本','Updated since'):''}</a>:<span key={ref.recordId}>{label}</span>;})}</div>}
   {chatIds.length>0&&<div className="memory-source-group"><span>{say('对话','Conversations')}</span>{chatIds.map(id=><Button key={id} aria-label={say('打开来源对话：','Open source conversation: ')+conversationTitle(id)} disabled={locked} onClick={()=>onOpenConversation?.(id)}><Icon name="message" size={13}/>{conversationTitle(id)}</Button>)}</div>}
   {taskIds.length>0&&<div className="memory-source-group"><span>{say('任务','Tasks')}</span>{taskIds.map(id=>{const title=names.get(id)??say('任务 · ','Task · ')+id.slice(0,8);return <a key={id} href={'/tasks/'+id} aria-label={say('打开来源任务：','Open source task: ')+title} aria-disabled={locked} onClick={followMemoryPage}><Icon name="plan" size={13}/>{title}</a>;})}</div>}
   {r.evidence.length>0&&<div className="memory-source-group"><span>{say('原文片段','Snippets')}</span>{r.evidence.map((ref,index)=>{const known=sourceSummaries.find(info=>info.id===ref.sourceId)?.title,title=known?known+(r.evidence.length>1?' · '+(index+1):''):say('片段','Snippet')+' '+(index+1);return <Button key={ref.sourceId+':'+ref.sourceRevision} aria-label={say('查看片段：','View snippet: ')+title} disabled={locked} onClick={()=>openSource(ref.sourceId)}><Icon name="file" size={13}/>{title}</Button>;})}</div>}
  </Disclosure>;
 };
 const advancedFilterCount=Number(agent!=='all')+Number(!!from)+Number(!!until)+Number(status!=='active')+Number(order!=='newest');
 const recordCard=(r:MemoryRevision)=>{const collection=collections.find(c=>c.id===r.collectionId),group=groups[memoryGroup(r)],timestamp=updatedAt(r),correcting=editing?.recordId===r.recordId;return <article key={r.recordId} data-record-id={r.recordId} data-tier={r.layer} aria-label={r.legacy?.title??say('记忆 ','Memory ')+(memoryGroup(r)==='sessions'?say('历史整合上下文','Historical consolidated context'):say(...group.label))} className={'memory-record memory-card memory-tone-'+memoryGroup(r)}>
  <header><div className="memory-card-identity"><span className="memory-type-icon"><Icon name={group.icon} size={14}/></span><strong>{r.legacy?.title??say(...group.label)}</strong>{memoryGroup(r)==='sessions'?<span className="memory-layer-tag">{say('整合上下文','Consolidated context')}</span>:r.status==='proposed'&&r.legacyLevel==='L3'?<span className="memory-layer-tag">{say('旧版 L3','Legacy L3')}</span>:null}{r.layer==='L1'&&contentTypes[r.contentType]&&<span className="memory-content-type">{say(...contentTypes[r.contentType])}</span>}</div>{r.status!=='active'&&<span className={'memory-status memory-status-'+r.status}><Icon name={r.status==='proposed'?'clock':'info'} size={12}/>{r.status==='proposed'?(r.verification==='legacy_user_managed'?say('旧版候选','Legacy candidate'):say('候选 · 未验证','Candidate · Unverified')):say(...states[r.status])}</span>}</header>
  {correcting?<form className="memory-correction" onSubmit={e=>{e.preventDefault();void change(r,'correct');}}><label>{say('纠正内容','Correction text')}<Textarea aria-label={say('纠正内容','Correction text')} value={text} onChange={e=>setText(e.target.value)} required maxLength={6000} autoFocus/></label><p>{say('更改用于后续请求；已有对话会收到更正提示，原生 CLI 历史无法删除。','Changes apply to subsequent requests; existing chats receive correction notices. Native CLI history cannot be erased.')}</p><div className="memory-card-commands"><Button type="submit" disabled={busy}>{say('保存纠正','Save correction')}</Button><Button type="button" disabled={busy} onClick={()=>setEditing(null)}>{say('取消','Cancel')}</Button></div></form>:<MemoryContent record={r} compact names={names}/>}
  <div className="memory-card-meta"><span><Icon name="project" size={12}/>{config.projects.find(p=>p.id===collection?.projectId)?.name??say('个人','Personal')}</span><span><Icon name="agent" size={12}/>{(r.sourceAgentIds??(collection?.agentId?[collection.agentId]:[])).map(id=>config.agents.find(a=>a.id===id)?.name??id).join(', ')||say('我','Me')}</span><span>{timestamp?<time dateTime={timestamp} title={say('内容更新于 ','Content updated at ')+new Date(timestamp).toLocaleString(language)+' · v'+r.revision}>{new Date(timestamp).toLocaleString(language,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</time>:say('时间未知','Unknown time')}</span></div>
  {r.verification==='legacy_user_managed'&&<p className="field-hint">{r.status==='proposed'?say('旧版未采用记录，仅保留历史，不会提供给对话。','Historical legacy candidate; retained for reference and not used in chats.'):say('旧版记录，来源未验证；保留原状态与范围。','Legacy record; provenance unverified. Original status and scope retained.')}</p>}
  {r.verification==='user_confirmation'&&r.legacyLevel==='L3'&&<p className="field-hint">{say('已由用户确认，保留为基础规程；长期上下文由场景记忆整合生成。','Confirmed by the user as a source rule; long-term context is consolidated from scene memory.')}</p>}
  {!correcting&&<div className="memory-actions">
   {sourcesFor(r)}
   {r.status==='active'&&(retracting===r.recordId?<div className="memory-retract-confirm" role="group" aria-label={say('确认撤回','Confirm withdrawal')}><p>{say('撤回后，之后的对话不再使用这条记忆，它会移到「历史与失效记录」。','Later chats stop using this memory. It moves to Historical and inactive memories.')}</p><div className="memory-card-commands"><Button disabled={busy} onClick={()=>void change(r,'retract')}>{say('确认撤回','Withdraw')}</Button><Button disabled={busy} onClick={()=>setRetracting(null)}>{say('取消','Cancel')}</Button></div></div>:<div className="memory-card-commands"><Button disabled={locked} onClick={()=>{setRetracting(null);setEditing(r);setText(memoryBody(r.text));}}><Icon name="edit" size={13}/>{say('纠正','Correct')}</Button><Button disabled={locked} onClick={()=>setRetracting(r.recordId)}><Icon name="undo-2" size={13}/>{say('撤回','Withdraw')}</Button></div>)}
  </div>}</article>;};
 return <section className="memory-workspace" aria-label={say('记忆索引','Memory index')}>
   {!loading&&<section className="memory-overview" aria-label={say('记忆类型','Memory types')}>{(['all',...groupKeys] as const).map(key=>{const label=key==='all'?say('全部记忆','All memories'):say(...groups[key].label),count=filteredRecords.filter(r=>key==='all'?memoryGroup(r)!=='sessions':memoryGroup(r)===key).length;return <Button key={key} className={'memory-type-filter'+(key==='all'?'':' memory-tone-'+key)} title={key==='all'?undefined:say(...groups[key].description)} aria-label={label+say('，'+count+' 条匹配',', '+count+' matching')} aria-pressed={category===key} disabled={busy||!!editing} onClick={()=>{exitExactSelection();setCategory(key==='all'||category===key?'all':key);}}>{key!=='all'&&<Icon name={groups[key].icon} size={14}/>}<span>{key==='all'?say('全部','All'):label}</span><strong>{count}</strong></Button>;})}</section>}
  <div className="memory-filters">
   <label>{say('搜索记忆','Search memories')}<span className="memory-search-field"><Icon name="search" size={16}/><Input type="search" placeholder={say('搜索事实、场景或约定…','Search facts, scenes or conventions…')} value={query} onChange={e=>{exitExactSelection();setQuery(e.target.value);}}/></span></label>
   <label>{say('项目范围','Project scope')}<Select ariaLabel={say('项目范围','Project scope')} value={project??'all'} onChange={value=>{const p=new URLSearchParams(location.search);p.delete('recordId');p.delete('conversationId');p.delete('taskId');value==='all'?p.delete('project'):p.set('project',value);history.pushState(null,'',(scopedAgentId ? '/agents/'+encodeURIComponent(scopedAgentId)+'/memory' : '/mana')+'?'+p);dispatchEvent(new PopStateEvent('popstate'));}} options={[{value:"all",label:(say('全部项目与个人','All projects and personal'))},{value:"",label:(say('个人','Personal'))},...config.projects.map(p=>({value:p.id,label:(p.name),icon:<IdentityAvatar identity={p} kind="project" size={20}/>}))]} disabled={!!editing||busy}/></label>
  </div>
  {agent!=='all'&&<p className="field-hint">{say('智能体：','Agent: ')}{config.agents.find(item=>item.id===agent)?.name??agent}</p>}
  <Disclosure className="memory-advanced-filters" title={<>{say('高级筛选','Advanced filters')}{advancedFilterCount>0?' · '+advancedFilterCount:''}</>}>
   <div className="memory-filters memory-filter-options">
   <label>Agent<Select ariaLabel="Agent" value={scopedAgentId ?? agent} onChange={changeAgent} options={[...(!scopedAgentId ? [{value:'all',label:say('全部 Agent','All agents')}] : []),...config.agents.map(a=>({value:a.id,label:a.name,icon:<IdentityAvatar identity={a} kind="agent" size={20}/>}))]} disabled={!!scopedAgentId||busy||!!editing}/></label>
   <label>{say('开始日期','Start date')}<Input aria-label={say('开始日期','Start date')} type="date" disabled={busy||!!editing} value={from} onChange={e=>setFrom(e.target.value)}/></label>
   <label>{say('结束日期','End date')}<Input aria-label={say('结束日期','End date')} type="date" disabled={busy||!!editing} value={until} onChange={e=>setUntil(e.target.value)}/></label>
   <label>{say('状态','Status')}<Select ariaLabel={say('状态','Status')} value={status} onChange={value=>{exitExactSelection();setStatus(value);}} options={[{value:"all",label:(say('全部','All'))},...Object.entries(states).map(([key,label])=>({value:key,label:(say(...label))}))]} disabled={busy||!!editing}/></label>
   <label>{say('排序','Sort')}<Select ariaLabel={say('记忆排序','Memory order')} value={order} disabled={busy||!!editing} onChange={value=>{exitExactSelection();setOrder(value);}} options={[{value:'newest',label:say('最近更新','Recently updated'),icon:<Icon name="arrowDown" size={15}/>},{value:'oldest',label:say('最早更新','Oldest update'),icon:<Icon name="arrowUp" size={15}/>}]} /></label>
   </div>
  </Disclosure>
  {advancedFilterCount>0&&<Button className="memory-clear-filters" disabled={busy||!!editing} onClick={()=>{exitExactSelection();changeAgent(scopedAgentId ?? 'all');setFrom('');setUntil('');setStatus('active');setOrder('newest');}}>{say('清除高级筛选','Clear advanced filters')}</Button>}
  {(taskId||conversationId)&&<p>{say('当前仅显示关联工作来源。','Showing associated work sources.')} <a href="/mana?tab=memory" aria-disabled={busy||!!editing} onClick={followMemoryPage}>{say('查看全部记忆','View all memories')}</a></p>}
  {error&&<p role="alert">{error}</p>}{loading&&<LoadingState label={say('正在读取记忆','Loading memories')}/>}
  <div className="memory-library-heading"><div><h2>{say('记忆库','Memory library')}</h2><span>{currentRecords.length+' '+say('条','memories')}</span>{activeJobs.length>0&&<span className="memory-processing" role="status"><Icon name="activity" size={13}/>{say('后台加工','Background processing')} · {[processingCount?processingCount+' '+say('项处理中','processing'):'',waitingCount?waitingCount+' '+say('项待处理','waiting'):''].filter(Boolean).join(' · ')}</span>}</div><Button disabled={locked} aria-expanded={showSources} onClick={()=>setShowSources(!showSources)}><Icon name="file" size={14}/>{say('来源片段','Source snippets')} <span className="memory-source-count">{sourceRefs.length}</span></Button></div>
  {showSources&&<section className="memory-source-list" aria-label={say('关联来源','Related sources')}>
   <header className="memory-section-heading"><Icon name="file" size={18}/><h2>{say('关联来源','Related sources')}</h2><span className="memory-layer-tag">L0</span><span className="memory-source-count">{sourceRefs.length} {say('个片段','snippets')} · {new Set(sourceSummaries.filter(s=>sourceRefs.some(ref=>ref.sourceId===s.id)&&s.conversationId).map(s=>s.conversationId)).size} {say('个对话','conversations')}</span></header>
   <p className="field-hint">{say('同一对话可以包含多份原始片段。查看原文，或打开对应对话。','One conversation can contribute several source snippets. Read the evidence or open its conversation.')}</p>
   <div>{sourceRefs.map(ref=>{const info=sourceSummaries.find(s=>s.id===ref.sourceId),title=info?.title||say(info?.kind==='task'?'来源任务':'来源对话',info?.kind==='task'?'Source task':'Source conversation'),timestamp=info?.observedAt||info?.capturedAt;return <article className="memory-source-card" key={ref.sourceId}>
    <Button className="memory-source-entry" aria-label={say('查看来源：','View source: ')+title} disabled={busy||!!editing} onClick={()=>openSource(ref.sourceId)}><Icon name={info?.kind==='task'?'plan':'message'} size={17}/><span><strong>{title}</strong><small>{info?.excerpt||say('查看原始片段','Read source snippet')}</small></span><Icon name="arrowRight" size={14}/></Button>
    <footer>{timestamp&&<time dateTime={timestamp}>{new Date(timestamp).toLocaleString(language,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</time>}{info?.conversationId&&<Button aria-label={say('打开来源对话：','Open source conversation: ')+title} disabled={busy||!!editing} onClick={()=>onOpenConversation?.(info.conversationId!)}><Icon name="message" size={13}/>{say('打开对话','Open conversation')}</Button>}{info?.taskId&&<a href={'/tasks/'+info.taskId} aria-disabled={busy||!!editing} onClick={followMemoryPage}>{say('打开任务','Open task')}</a>}</footer>
   </article>;})}</div>
  </section>}
  <div className="memory-records memory-card-grid">{currentRecords.slice((currentPage-1)*PAGE_SIZE,currentPage*PAGE_SIZE).map(recordCard)}</div>
  <MemoryPagination total={currentRecords.length} page={currentPage} label={say('记忆翻页','Memory pagination')} disabled={busy||!!editing} onPage={current=>setPages({...viewPages,current})}/>
  {historicalRecords.length>0&&<Disclosure className="memory-history" open={historyOpen} onToggle={e=>{if(e.target===e.currentTarget)setHistoryOpen(e.currentTarget.open);}} title={<> <Icon name="clock" size={15}/>{say('历史与失效记录','Historical and inactive memories')} · {historicalRecords.length} </>}>{historyOpen&&<><div className="memory-card-grid">{historicalRecords.slice((historyPage-1)*PAGE_SIZE,historyPage*PAGE_SIZE).map(recordCard)}</div><MemoryPagination total={historicalRecords.length} page={historyPage} label={say('历史记忆翻页','Historical memory pagination')} disabled={busy||!!editing} onPage={history=>setPages({...viewPages,history})}/></>}</Disclosure>}
  {!loading&&!error&&!visible.length&&<EmptyState className="memory-empty" icon="memory"><strong>{records.length?say('没有匹配的记忆','No matching memories'):say('还没有生成记忆','No memories yet')}</strong><p>{records.length?say('调整搜索词或筛选条件。','Try different search terms or filters.'):activeJobs.length?say('记忆正在后台整理。','Memories are being organized in the background.'):say('对话结束后，系统会提取有来源支持的事实。','Supported facts are extracted after a conversation turn ends.')}</p></EmptyState>}
  {source&&<Dialog label={say('来源详情','Source details')} className="memory-source-dialog" onClose={()=>setSource(null)}><section className="memory-source" aria-label={say('来源详情','Source details')}><header><h2><Icon name="file" size={18}/><span className="memory-layer-tag">L0</span>{say('来源详情','Source details')}</h2><Button onClick={()=>setSource(null)}><Icon name="close" size={14}/>{say('关闭','Close')}</Button></header>
   <p>{source.kind==='task'?say('任务','Task'):say('对话','Conversation')} · {config.agents.find(a=>a.id===((source as MemorySource & {agentId?:string|null}).agentId??collections.find(c=>c.id===source.collectionId)?.agentId))?.name??say('我','Me')} · {new Date(source.capturedAt).toLocaleString(language)}</p>
   {source.conversationId&&<Button disabled={busy||!!editing} onClick={()=>{const id=source.conversationId!;setSource(null);onOpenConversation?.(id);}}>{say('查看来源对话','Open source conversation')}</Button>}
   {source.taskId&&<a href={'/tasks/'+source.taskId} aria-disabled={busy||!!editing} onClick={followMemoryPage}>{say('查看来源任务','Open source task')}</a>}
   <Disclosure  title={<> {say('事件','Events')} · {source.eventIds.length} </>}><p>{source.eventIds.join(', ')}</p></Disclosure><pre>{source.text}</pre></section></Dialog>}
  <Disclosure className="memory-explanation" title={<> {say('记忆如何生成','How memory is generated')} </>}><p>{say('请求结束后提炼有来源支持的事实，再整合为场景知识与长期上下文。L0 原始来源 · L1 原子事实 · L2 场景整合 · L3 稳定上下文。','Supported facts are extracted after requests, then consolidated into scenes and stable context. L0 sources · L1 atomic facts · L2 scenes · L3 stable context.')}</p></Disclosure>
 </section>;
}
