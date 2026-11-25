import { composingKey } from './shortcuts';
import { useEffect,useMemo,useRef,useState,type MouseEvent } from 'react';
import type { Asset,AssetBinding,AssetFile,AssetVersion,AssetSummary } from '../shared/assets';
import type { Config } from '../shared/types';
import { librarySections } from '../shared/data-plugins';
import { useUiExtensions } from './UiExtensions';
import { LibraryFiles, useLibraryFiles } from './LibraryFiles';
import { LibraryTabs } from './LibraryTabs';
import { TabPanel } from './ui/Tabs';
import { requestJson } from './api';
import AppSidebar,{type SidebarNavigation} from './AppSidebar';
import Button from './ui/Button';
import Input from './ui/Input';
import Textarea from './ui/Textarea';
import Select from './ui/Select';
import Icon from './ui/Icon';
import LoadingState from './ui/LoadingState';
import Notice from './ui/Notice';
import Disclosure from './ui/Disclosure';
import EmptyState from './ui/EmptyState';
import StatusLabel from './ui/StatusLabel';
import {WorkspacePage,PageHeader,ListDetail,DetailSection} from './ui/WorkspacePage';
import {DropdownMenu,DropdownMenuTrigger,DropdownMenuContent,DropdownMenuItem} from './components/ui/dropdown-menu';
import {WikiCreate,WikiOrAssetDetail} from './KnowledgeBase';
import AssetFileIcon from './AssetFileIcon';
import IdentityAvatar from './IdentityAvatar';
import {fileExtension} from '../shared/file-types';
import {useLanguage} from './i18n';
import {DirectoryLink} from './SettingsObjectBrowser';
import './assets.css';
import './asset-library.css';
export const assetScopeLabels={owner:'仅归属方',private:'不共享',selected:'指定对象',all:'全部 Agent'} as const;
const englishKindLabels={document:'Document',file:'File',wiki:'Wiki',skill:'Skill',memory_collection:'Memory collection',external_reference:'External reference'} as const;
export const assetKindLabels={document:'文档',file:'文件',wiki:'Wiki',skill:'Skill',memory_collection:'记忆集合',external_reference:'外部引用'} as const;
export function navigateAssetPage(path:string){history.pushState(null,'',path);dispatchEvent(new PopStateEvent('popstate'));}
export function followAssetPage(event:MouseEvent<HTMLAnchorElement>){if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||event.currentTarget.target||event.currentTarget.hasAttribute('download'))return;event.preventDefault();navigateAssetPage(event.currentTarget.pathname+event.currentTarget.search);}
export function assetRequest<T>(path:string,method='GET',data?:unknown,key?:string,signal?:AbortSignal):Promise<T>{return requestJson('/api/v2/assets'+path,{method,signal,headers:{'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},...(data===undefined?{}:{body:JSON.stringify(data)})});}
type Version=AssetVersion&{downloads:AssetFile[]};
type LibraryRow={asset:AssetSummary;binding?:AssetBinding;pinned?:Version|null};
export async function libraryRows(type:string,id:string,recentFiles=false):Promise<LibraryRow[]> {
 const query=id?'?ownerType='+encodeURIComponent(type)+'&ownerId='+encodeURIComponent(id):'';
 const [assets,bindings]=await Promise.all([assetRequest<AssetSummary[]>(query),id?assetRequest<AssetBinding[]>('/bindings'+query):Promise.resolve([])]);
 // The assets endpoint orders the scoped summaries by most recent activity.
 const visible=recentFiles?assets.filter(asset=>asset.kind==='file'||asset.kind==='document').slice(0,5):assets.filter(asset=>asset.kind!=='memory_collection');
 return Promise.all(visible.map(async asset=>{
  const binding=bindings.find(binding=>binding.assetId===asset.id);
  if(binding?.versionPolicy!=='pinned')return {asset,binding};
  const pinned=await assetRequest<Version>('/'+asset.id+'/versions/'+binding.versionId).catch(error=>{
   if(recentFiles&&error.status!==403&&error.status!==404)throw error;
   return null;
  });
  return {asset,binding,pinned};
 }));
}
function rowSource(row:LibraryRow):'manual'|'attachment'|'agent'|'unavailable'|'unknown' {if(row.binding?.versionPolicy==='pinned'){if(!row.pinned)return 'unavailable';return row.pinned.provenance.runId?'agent':row.pinned.id===row.asset.headVersionId?row.asset.source==='attachment'?'attachment':'manual':'unknown';}return row.asset.source==='manual'?'manual':row.asset.source==='attachment'?'attachment':'agent';}
function rowFile(row:LibraryRow){return row.binding?.versionPolicy==='pinned'?row.pinned?.downloads[0]:row.asset.file;}
function availability(row:LibraryRow){return row.binding?.versionPolicy==='pinned'?row.pinned?(row.pinned.downloads.some(file=>file.availability==='missing')?'missing':row.asset.kind==='external_reference'?'host_reference':'managed_local'):'access_denied':row.asset.availability;}
function resourcePath(row:LibraryRow,projectId='',agentId='',wiki=false) {const query=new URLSearchParams();if(wiki)query.set('tab','wiki');if(row.binding?.versionPolicy==='pinned')query.set('version',row.binding.versionId!);if(projectId)query.set('project',projectId);if(agentId)query.set('agent',agentId);return '/library/'+encodeURIComponent(row.asset.id)+(query.size?'?'+query:'');}
function ResourceRows({rows,selectedId,projectId='',agentId='',disabled=false,onOpen,onRemove,onFeature}:{rows:LibraryRow[];selectedId?:string;projectId?:string;agentId?:string;disabled?:boolean;onOpen?:(path:string)=>void;onRemove?:(row:LibraryRow)=>void;onFeature?:(row:LibraryRow)=>void}){
 const {text: localize, language, t}=useLanguage(),say=(zh:string,en:string)=>localize(zh, en);
 return <div className="asset-list library-resource-rows">{rows.map(row=>{const asset=row.asset,file=rowFile(row),origin=rowSource(row),state=availability(row),pinned=row.binding?.versionPolicy==='pinned',version=pinned?row.pinned?.ordinal:asset.versionOrdinal,time=asset.recentAt??(pinned?row.pinned?.createdAt:asset.updatedAt),href=resourcePath(row,projectId,agentId,!!onFeature);
  return <article className="library-resource-row" data-availability={state} key={asset.id} data-selected={selectedId===asset.id}>
   <a href={href} title={asset.title} aria-label={asset.title} aria-current={selectedId===asset.id?'page':undefined} aria-disabled={disabled||undefined} onClick={event=>{if(disabled){event.preventDefault();return;}if(onOpen&&event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();onOpen(href);}else followAssetPage(event);}}>
    <span className="asset-row-icon"><AssetFileIcon name={file?.name??asset.title} mediaType={file?.mediaType} kind={asset.kind} size={28}/></span>
    <span className="asset-row-content"><strong>{asset.title}</strong><span className="library-row-meta">{onFeature && asset.featuredAt && <span><Icon name="pin" size={12}/>{t('已置顶')}</span>}<span>{asset.kind==='wiki'?'Wiki':fileExtension(file?.name??'').toUpperCase()||(localize(assetKindLabels[asset.kind], englishKindLabels[asset.kind]))}</span><span>{pinned?say('固定版本','Pinned')+' '+(version?'v'+version:say('不可用','unavailable')):version?'v'+version:say('未发布','Unpublished')}</span>{(state==='missing'||state==='access_denied')&&<span className="library-row-warning"><Icon name="error" size={12}/>{state==='missing'?say('内容缺失','Missing content'):say('来源不可读','Source unavailable')}</span>}<span><Icon name={origin==='attachment'?'paperclip':origin==='manual'?'upload':origin==='unknown'?'file':'agent'} size={12}/>{origin==='attachment'?say('对话附件','Chat attachment'):origin==='manual'?say('手工导入','Manual'):origin==='unavailable'?say('版本不可用','Version unavailable'):origin==='unknown'?say('历史版本来源','Historical source'):say('Agent 输出','Agent output')}</span>{asset.accessPolicy.mode!=='owner'&&<span className="asset-sharing"><Icon name="users" size={12}/>{localize(assetScopeLabels[asset.accessPolicy.mode], ({private:'Private',selected:'Selected access',all:'All Agents'}[asset.accessPolicy.mode]))}</span>}</span></span>
    <span className="library-row-status">{/* Rows show state only when it differs from the normal, readable case. */}{state!=='managed_local'&&<StatusLabel tone={state==='missing'||state==='access_denied'?'warning':'neutral'} icon={state==='host_reference'?'link':state==='unpublished'?'clock':'error'}>{state==='missing'?say('内容缺失','Missing content'):state==='access_denied'?say('来源不可读','Source unavailable'):state==='host_reference'?say('主机引用','Host reference'):say('未发布','Unpublished')}</StatusLabel>}{time&&<time dateTime={time}>{new Date(time).toLocaleDateString(language,{month:'short',day:'numeric'})}</time>}</span><Icon name="chevronRight" size={14}/>
   </a>{onFeature && <DropdownMenu><DropdownMenuTrigger asChild><Button className="library-row-menu" variant="ghost" disabled={disabled} aria-label={t('更多操作')+' · '+asset.title}><Icon name="more" size={16}/></Button></DropdownMenuTrigger>
     <DropdownMenuContent align="end"><DropdownMenuItem onSelect={()=>onFeature(row)}><Icon name={asset.featuredAt?'pinOff':'pin'} size={15}/>{asset.featuredAt?t('取消置顶'):t('置顶')}</DropdownMenuItem></DropdownMenuContent>
   </DropdownMenu>}{onRemove&&row.binding&&!(asset.owner.projectId&&row.binding.ownerType==='project'&&asset.owner.projectId===row.binding.ownerId)&&<Button disabled={disabled} aria-label={say('移除关联 · ','Remove association · ')+asset.title} onClick={()=>onRemove(row)}><Icon name="close" size={14}/>{say('移除关联','Remove association')}</Button>}
  </article>;
 })}</div>;
}
export default function AssetLibrary({navigation,mobileNav,onMobileNav,config,onOpenPath,onNavigationLockChange}:{navigation:SidebarNavigation;mobileNav:boolean;onMobileNav:(value:boolean)=>void;config:Config;onOpenPath:(path:string)=>void;onNavigationLockChange?:(locked:boolean)=>void}) {
 const {text: localize,t}=useLanguage(),say=(zh:string,en:string)=>localize(zh, en);
 const [route,setRoute]=useState(location.pathname+location.search),[rows,setRows]=useState<LibraryRow[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[search,setSearch]=useState(''),[kind,setKind]=useState('all'),[source,setSource]=useState('all'),[sort,setSort]=useState('recent');
 const query=new URLSearchParams(route.split('?')[1]),id=route.split('?')[0].match(/^\/(?:assets|library)\/([^/]+)$/)?.[1],projectId=query.get('project')??'',agentId=query.get('agent')??'',scopeType=projectId?'project':agentId?'agent':'',scopeId=projectId||agentId;
 const {snapshot, error:extensionError, refresh:refreshExtensions}=useUiExtensions();
 const sections=useMemo(()=>librarySections(snapshot),[snapshot]),requestedTab=query.get('tab')??(query.has('plan')?'plan':'recent');
 const section=sections.find(item=>item.id===requestedTab),tab=section?.id??(requestedTab==='wiki'?'wiki':'recent');
 const isWiki=tab==='wiki',hasSection=!!section;
 const pendingTab=!snapshot && requestedTab!=='wiki' && requestedTab!=='recent';
 const files=useLibraryFiles(sections,section?.id,projectId);
 useEffect(()=>{
   if(!snapshot || requestedTab===tab)return;
   const url=new URL(location.href);
   if(requestedTab==='plan'&&!section){
     const plan=url.searchParams.get('plan');
     const matches=config.projects.filter(p=>!p.archivedAt&&p.planId&&(!projectId||p.id===projectId)&&(!plan||plan===p.planId));
     if(matches.length){
       const path=matches.length===1?'/projects/'+encodeURIComponent(matches[0].id)+'/overview':'/projects';
       history.replaceState(history.state,'',path);
       dispatchEvent(new PopStateEvent('popstate'));return;
     }
   }
   url.searchParams.set('tab',tab);
   history.replaceState(history.state,'',url.pathname+url.search);
   setRoute(url.pathname+url.search);
 },[snapshot,requestedTab,tab,section,config.projects,projectId]);
 const [create,setCreate]=useState<'document'|'file'|'wiki'|null>(null),[title,setTitle]=useState(''),[text,setText]=useState(''),[file,setFile]=useState<File|null>(null),[busy,setBusy]=useState(false),[readerLocked,setReaderLocked]=useState(false),[wikiLocked,setWikiLocked]=useState(false),[pendingAttachments,setPendingAttachments]=useState(0),[revision,setRevision]=useState(0);
 const sequence=useRef(0),retry=useRef<{submissionId:string;key:string}|null>(null);
 const dirty=!!create&&(!!title.trim()||!!text||!!file),locked=readerLocked||wikiLocked||busy||dirty;
 useEffect(()=>{const update=()=>{setRoute(location.pathname+location.search);setCreate(null);};addEventListener('popstate',update);return()=>removeEventListener('popstate',update);},[]);
 useEffect(()=>{onNavigationLockChange?.(locked);const unload=(event:BeforeUnloadEvent)=>{if(locked){event.preventDefault();event.returnValue='';}};addEventListener('beforeunload',unload);return()=>{onNavigationLockChange?.(false);removeEventListener('beforeunload',unload);};},[locked,onNavigationLockChange]);
 useEffect(()=>{if(hasSection || pendingTab)return;const current=++sequence.current;setRows([]);setLoading(true);setError('');void libraryRows(scopeType,scopeId).then(value=>{if(current===sequence.current)setRows(value);}).catch(reason=>{if(current===sequence.current)setError(reason.message);}).finally(()=>{if(current===sequence.current)setLoading(false);});void assetRequest<{state:string}[]>('/attachment-imports').then(value=>{if(current===sequence.current)setPendingAttachments(value.filter(item=>item.state==='pending').length);}).catch(()=>{});return()=>{sequence.current++;};},[hasSection,pendingTab,scopeType,scopeId,revision]);
 const matchingKind=isWiki?'wiki':kind;
 const activity=(row:LibraryRow)=>Date.parse(row.asset.recentAt??row.asset.updatedAt??'')||0;
 const visible=rows.filter(row=>(matchingKind==='all'||row.asset.kind===matchingKind)&&(source==='all'||rowSource(row)===source)&&row.asset.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).sort((a,b)=>{
   if(isWiki) return (b.asset.featuredAt??'').localeCompare(a.asset.featuredAt??'') || activity(b)-activity(a);
   if(sort==='name')return a.asset.title.localeCompare(b.asset.title);
   if(sort==='type')return a.asset.kind.localeCompare(b.asset.kind)||a.asset.title.localeCompare(b.asset.title);
   return activity(b)-activity(a);
 });
 const feature=async(row:LibraryRow)=>{
   if(locked)return;
   setBusy(true);setError('');
   try {
     const {featuredAt}=await assetRequest<{featuredAt:string|null}>('/'+encodeURIComponent(row.asset.id)+'/featured','PUT',{featured:!row.asset.featuredAt,...projectId?{projectId}:{}});
     setRows(current=>current.map(item=>item.asset.id===row.asset.id?{...item,asset:{...item.asset,featuredAt:featuredAt??undefined}}:item));
   } catch(reason){setError((reason as Error).message);}
   finally{setBusy(false);}
 };
 const changeTab=(value:string)=>{
   // Radix can activate a tab on pointer-down and focus before React has re-rendered.
   if(locked || value===tab || new URLSearchParams(location.search).get('tab')===value)return;
   const params=new URLSearchParams();
   if(projectId)params.set('project',projectId);
   if(agentId)params.set('agent',agentId);
   params.set('tab',value);
   onOpenPath('/library?'+params);
 };
 const start=(mode:typeof create)=>{if(locked)return;if(id){const params=new URLSearchParams();if(isWiki)params.set('tab','wiki');if(projectId)params.set('project',projectId);if(agentId)params.set('agent',agentId);onOpenPath('/library'+(params.size?'?'+params:''));}setCreate(mode);setTitle('');setText('');setFile(null);retry.current=null;setError('');};
 const publish=async()=>{if(busy)return;setBusy(true);setError('');try{if(!retry.current){const content=create==='file'?file!:new File([text],'document.md',{type:'text/markdown'}),response=await fetch('/api/v2/assets/uploads?name='+encodeURIComponent(content.name),{method:'POST',body:content}),stage=await response.json();if(!response.ok)throw Error(stage.error??say('导入失败','Import failed'));retry.current={submissionId:stage.submissionId,key:crypto.randomUUID()};}const saved=await assetRequest<{asset:Asset;version:AssetVersion}>('/imports','POST',{kind:create==='file'?'file':'document',title,submissionId:retry.current.submissionId},retry.current.key);if(scopeId)await assetRequest('/'+saved.asset.id+'/bindings','POST',{ownerType:scopeType,ownerId:scopeId,versionPolicy:'latest'});setCreate(null);setTitle('');setText('');setFile(null);retry.current=null;setRevision(value=>value+1);navigateAssetPage('/library/'+saved.asset.id+'?version='+saved.version.id+(projectId?'&project='+encodeURIComponent(projectId):''));}catch(reason){setError((reason as Error).message);}finally{setBusy(false);}};
 const chooseScope=(value:string)=>{
   const [type,...parts]=value.split(':'),params=new URLSearchParams();
   if(parts.length)params.set(type==='agent'?'agent':'project',parts.join(':'));
   if(query.has('tab'))params.set('tab',tab);
   onOpenPath('/library'+(params.size?'?'+params:''));
 };
 const filterCount=(scopeId?1:0)+(!isWiki&&kind!=='all'?1:0)+(source!=='all'?1:0)+(!isWiki&&sort!=='recent'?1:0);
 const scopeControl=<Select ariaLabel={say('项目或智能体范围','Project or Agent scope')} value={scopeId?scopeType+':'+scopeId:''} disabled={locked} onChange={chooseScope} options={[{value:'',label:say('全部可读资料','All readable resources')},...config.projects.map(project=>({value:'project:'+project.id,label:project.name,icon:<IdentityAvatar identity={project} kind="project" size={18}/>,description:say('项目使用关联与交付来源','Project associations and output provenance')})),...config.agents.map(agent=>({value:'agent:'+agent.id,label:agent.name,icon:<IdentityAvatar identity={agent} kind="agent" size={18}/>,description:say('智能体使用关联与归属','Agent associations and ownership')}))]}/>;
 const filterControls=<div className="library-filter-options">{!isWiki&&<Select ariaLabel={say('资料类型','Resource type')} value={kind} disabled={locked} onChange={setKind} options={[{value:'all',label:say('全部类型','All types')},...(['document','file','wiki','skill','external_reference'] as const).map(value=>({value,label:value==='wiki'?'Wiki':(localize(assetKindLabels[value], englishKindLabels[value]))}))]}/>}<Select ariaLabel={say('资料来源','Resource source')} value={source} disabled={locked} onChange={setSource} options={[{value:'all',label:say('全部来源','All sources')},{value:'manual',label:say('手工导入','Manual')},{value:'attachment',label:say('对话附件','Chat attachments')},{value:'agent',label:say('Agent 输出','Agent outputs')}]}/>{!isWiki&&<Select ariaLabel={say('排序','Sort')} value={sort} disabled={locked} onChange={setSort} options={[{value:'recent',label:say('最近活动','Recent activity')},{value:'name',label:say('名称','Name')},{value:'type',label:say('类型','Type')}]}/>}</div>;
 const heading=<PageHeader onMobileNav={()=>onMobileNav(true)} title={say('资料库','Library')} icon="book" context={<>{!hasSection&&!pendingTab&&!loading&&String(visible.length)}{scopeId&&<>{!hasSection&&!pendingTab&&!loading&&' · '}{config.projects.find(project=>project.id===projectId)?.name??config.agents.find(agent=>agent.id===agentId)?.name??scopeId}</>}</>} actions={!hasSection&&!pendingTab&&<><DropdownMenu><DropdownMenuTrigger asChild><Button className="primary" disabled={locked}><Icon name="plus" size={15}/>{say('新建','New')}<Icon name="chevronDown" size={12}/></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={()=>start('document')}><Icon name="file" size={15}/>{say('新建文档','New document')}</DropdownMenuItem><DropdownMenuItem onSelect={()=>start('wiki')}><Icon name="book" size={15}/>{say('新建知识库','New knowledge base')}</DropdownMenuItem></DropdownMenuContent></DropdownMenu><Button disabled={locked} onClick={()=>start('file')}><Icon name="upload" size={15}/>{say('导入文件','Import file')}</Button></>}/>;
 const hasWiki=rows.some(row=>row.asset.kind==='wiki');
 const canClear=isWiki?hasWiki:!!rows.length;
 const list=<>
  <div className="library-filters"><Input type="search" aria-label={say('搜索资料库','Search Library')} placeholder={say('搜索名称…','Search titles…')} value={search} disabled={locked} onChange={event=>setSearch(event.target.value)}/>{id?<Disclosure className="library-narrow-filters" title={<><Icon name="filter" size={14}/>{say('筛选与排序','Filters and sort')}{!!filterCount&&<span>{filterCount}</span>}</>}>{scopeControl}{filterControls}</Disclosure>:<>{scopeControl}{filterControls}</>}</div>
  {create==='wiki'&&<WikiCreate config={config} initialProjectId={projectId} onCreated={()=>setRevision(value=>value+1)} onNavigationLockChange={setWikiLocked} onCancel={()=>setCreate(null)}/>}
  {(create==='file'||create==='document')&&<section className="asset-import library-create" aria-label={say(create==='file'?'导入文件':'新建文档',create==='file'?'Import file':'New document')}><h2>{say(create==='file'?'导入文件':'新建文档',create==='file'?'Import file':'New document')}</h2><label>{say('名称','Title')}<Input autoFocus aria-label={say('文件名称','File name')} value={title} disabled={busy} onChange={event=>{setTitle(event.target.value);retry.current=null;}} onKeyDown={event=>{if(event.key!=='Enter'||composingKey(event.nativeEvent))return;event.preventDefault();event.currentTarget.closest('section')?.querySelector<HTMLElement>('textarea,input[type=file]')?.focus();}}/></label>{create==='file'?<label>{say('选择文件','Choose file')}<Input type="file" disabled={busy} onChange={event=>{setFile(event.target.files?.[0]??null);retry.current=null;}}/></label>:<label>{say('文档正文','Document body')}<Textarea aria-label={say('文档正文','Document body')} rows={8} disabled={busy} value={text} onChange={event=>{setText(event.target.value);retry.current=null;}}/></label>}<p className="field-hint">{say(scopeId?'个人归属，并关联当前范围；关联不会扩大使用权限。':'个人归属；关联不会扩大使用权限。',scopeId?'Personal ownership, associated with this scope. Association does not expand access.':'Personal ownership; association does not expand access.')}</p><div className="library-create-actions"><Button disabled={busy} onClick={()=>{setCreate(null);setTitle('');setText('');setFile(null);retry.current=null;}}>{say('取消','Cancel')}</Button><Button className="primary" disabled={busy||!title.trim()||(create==='file'?!file:!text.trim())} onClick={()=>void publish()}>{say(create==='file'?'导入并发布':'创建文档',create==='file'?'Import and publish':'Create document')}</Button></div></section>}
  {error&&<Notice><span>{error}</span><Button disabled={busy} onClick={()=>setRevision(value=>value+1)}>{say('重新读取','Reload')}</Button></Notice>}
  {loading?<LoadingState label={say('读取资料…','Loading resources…')}/>:visible.length?<ResourceRows rows={visible} selectedId={id} projectId={projectId} agentId={agentId} disabled={locked} onOpen={onOpenPath} onFeature={isWiki?feature:undefined}/>:error?null:<EmptyState icon={search?'search':'book'} action={canClear?<Button disabled={locked} onClick={()=>{setSearch('');setKind('all');setSource('all');}}>{say('清除筛选','Clear filters')}</Button>:<Button disabled={locked} onClick={()=>start(isWiki?'wiki':'document')}><Icon name="plus" size={14}/>{isWiki?say('新建知识库','New knowledge base'):say('新建文档','New document')}</Button>}>{canClear?say('没有匹配的资料。','No matching resources.'):isWiki?t('尚无知识库。'):say('尚无资料。新建文档或导入文件以开始。','No resources yet. Create a document or import a file to begin.')}</EmptyState>}
  {!isWiki&&pendingAttachments>0&&<Notice>{say('已提交附件待导入：','Submitted attachments awaiting import: ')}{pendingAttachments}<Button onClick={()=>setRevision(value=>value+1)}>{say('重新读取','Reload')}</Button></Notice>}
 </>;
 const selectedRow=id?rows.find(row=>row.asset.id===decodeURIComponent(id)):undefined;
 const projectReference=projectId&&selectedRow?.binding?.versionPolicy==='pinned'&&selectedRow.binding.versionId!==(query.get('version')??selectedRow.asset.headVersionId)?selectedRow:undefined;
 const detail=id?<> {projectReference&&<Notice className="library-version-context"><span>{say('项目引用固定版本','Project references pinned version')} {projectReference.pinned?'v'+projectReference.pinned.ordinal:say('不可用','unavailable')}{say('；当前正在查看其他版本。','; this reader is viewing another version.')}</span><Button disabled={locked} onClick={()=>onOpenPath(resourcePath(projectReference,projectId,agentId,isWiki))}>{say('查看项目引用版本','View Project reference')}</Button></Notice>}<WikiOrAssetDetail key={id+'?'+query.toString()} id={decodeURIComponent(id)} config={config} onAssetChange={()=>setRevision(value=>value+1)} assetKind={rows.find(row=>row.asset.id===decodeURIComponent(id))?.asset.kind} onNavigationLockChange={setReaderLocked} onOpenPath={onOpenPath}/></>:undefined;
 return <div className="app-shell"><AppSidebar navigation={navigation} open={mobileNav} onClose={()=>onMobileNav(false)}/><main data-page-width="fluid" className="workspace-main library-main" onClickCapture={event=>{if(locked&&event.target instanceof Element&&event.target.closest('a')&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();event.stopPropagation();}}}><WorkspacePage width="fluid">{heading}
  <LibraryTabs value={tab} disabled={locked} onChange={changeTab} plugins={sections.map(item=>{const badge=files.results?.get(item.id)?.badge??0;return {value:item.id,label:<><Icon name={item.icon} size={15}/><span>{localize(item.label.zh,item.label.en)}</span>{badge>0 && <span className="library-tab-count">{badge}</span>}</>}})}/>
  <TabPanel id="library-tab" value={sections.slice(2).some(item=>item.id===tab)?':overflow':tab}>
    {pendingTab ? extensionError ? <Notice>{extensionError}<Button onClick={()=>void refreshExtensions()}>{t('重试')}</Button></Notice> : <LoadingState label={t('读取文件…')}/>
      : section ? <LibraryFiles projectId={projectId} fileId={query.get('file')??query.get('plan')} section={section} onFollow={followAssetPage} {...files.results?.get(section.id)} retry={files.retry}/>
      : <ListDetail className="library-list-detail" list={list} detail={detail}/>}
  </TabPanel></WorkspacePage></main></div>;
}
export function ProjectAssets({projectId,disabled=false,recentFiles=false,onOpen}:{projectId:string;disabled?:boolean;recentFiles?:boolean;onOpen?:(path:string)=>void}){
 const {text: localize}=useLanguage(),say=(zh:string,en:string)=>localize(zh, en);
 const [rows,setRows]=useState<LibraryRow[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[revision,setRevision]=useState(0);
 useEffect(()=>{let active=true;setLoading(true);setRows([]);setError('');void libraryRows('project',projectId,recentFiles).then(value=>{if(active)setRows(value);}).catch(reason=>{if(active)setError(reason.message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[projectId,recentFiles,revision]);
 const library=recentFiles?'/projects/'+encodeURIComponent(projectId)+'/library':'/library?project='+encodeURIComponent(projectId);
 const remove=(row:LibraryRow)=>void assetRequest('/'+row.asset.id+'/bindings','DELETE',{ownerType:'project',ownerId:projectId}).then(()=>setRevision(value=>value+1)).catch(reason=>setError(reason.message));
 return <DetailSection title={recentFiles?say('最近文件','Recent files'):say('项目资料库','Project Library')} icon={recentFiles?'file':'book'} actions={<DirectoryLink href={library} disabled={disabled} onNavigate={onOpen??navigateAssetPage}>{say('打开资料库','Open Library')}<Icon name="arrowRight" size={14}/></DirectoryLink>}>
  {loading?<LoadingState label={say('读取项目资料…','Loading Project resources…')}/>:rows.length?<ResourceRows rows={rows} projectId={projectId} disabled={disabled} onOpen={onOpen} onRemove={recentFiles?undefined:remove}/>:error?null:<EmptyState>{recentFiles?say('暂无项目文件','No project files'):say('尚无关联资料或项目交付物。','No associated resources or Project outputs yet.')}</EmptyState>}
  {error&&<Notice>{say('暂不可用','Unavailable')} · {error}<Button onClick={()=>setRevision(value=>value+1)}>{say('重试','Retry')}</Button></Notice>}
 </DetailSection>;
}
