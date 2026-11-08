import Button from './ui/Button';
import Input from './ui/Input';
import { requestJson } from './api';
import LoadingState from './ui/LoadingState';
import { shortcutLabel, shortcutAria } from './shortcuts';
import type { ReferenceDocument } from '../shared/conversation-references';
import { followAssetPage } from './AssetLibrary';
import { copyText } from "./clipboard";
import { workspaceTree, type WorkspaceTreeNode } from './workspaceTree';
import WorkspaceCodePreview from './WorkspaceCodePreview';
import HtmlPreview from './HtmlPreview';
import LocalFileActions from './LocalFileActions';
import { fileReference } from './chat-references';
import Select from './ui/Select';
import Disclosure from './ui/Disclosure';
import { lazy, Suspense, useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import type { Asset, AssetFile, AssetVersion } from '../shared/assets';
import type { Config } from '../shared/types';
import { CodePreview, codeLanguage } from './CodePreview';
import type { ContentTarget } from './ContentPreviewContext';
import Icon, { type IconName } from './ui/Icon';
import DiffPreview from './DiffPreview';
import { type ConversationFile } from './conversationFiles';
import MarkdownMessage from './MarkdownMessage';
import {AssetLocalActions} from './AssetPreview';
import { useLanguage } from './i18n';
import './conversation-workspace.css';
import { useCopyFeedback } from './useCopyFeedback';

const TerminalPanel = lazy(() => import('./TerminalPanel'));

// Capture the opener before the optional terminal chunk resolves.
function DeferredTerminal({loadingLabel,...props}:ComponentProps<typeof TerminalPanel>&{loadingLabel:string}) {
 const focusOrigin=useRef<Element|null>(document.activeElement);
 useEffect(()=>{
  const cancel=()=>{focusOrigin.current=null;};
  document.addEventListener('keydown',cancel);document.addEventListener('pointerdown',cancel);
  return()=>{document.removeEventListener('keydown',cancel);document.removeEventListener('pointerdown',cancel);};
 },[]);
 return <Suspense fallback={<LoadingState label={loadingLabel}/>}><TerminalPanel {...props} focusOrigin={focusOrigin}/></Suspense>;
}

export type ConversationWorkspaceTab = 'references' | 'files' | 'changes' | 'materials' | 'terminal' | 'configuration';
type WorkspaceFile = { path: string; status: string; additions?: number | null; deletions?: number | null; binary?: boolean };
type Workspace = { cwd: string; git: boolean; files: WorkspaceFile[]; directories?: string[]; truncated: boolean; untracked?: number; comparison?: {baseRef:string;baseRefs:string[];mergeBase:string;head:string;headRef:string;error?:string} };
type FilePreview = { name: string; path: string; text: string; language?: string; diff: string | null; binary?: boolean };
type Material = ReferenceDocument&{fileId?:string};
type MaterialPreview = { asset: Asset; version: AssetVersion & { downloads: AssetFile[] }; file: AssetFile | null; text: string };
type Load<T> = { key: string; value: T | null; busy: boolean; error: string };

// Open files per conversation outlive tab and conversation switches for this app session.
const openFiles=new Map<string,{paths:string[];active:string|null;scroll:Map<string,number>}>(),maxOpenFiles=5;
function openFileMemory(id:string){let entry=openFiles.get(id);if(!entry)openFiles.set(id,entry={paths:[],active:null,scroll:new Map()});return entry;}

function read<T>(url: string, signal: AbortSignal, body?: unknown): Promise<T> {
 return requestJson(url,{signal,...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
}

export default function ConversationWorkspace({conversationId,projectId,activityVersion='',config,theme,onCloseTerminal,requestedContent,initialTab='references',onTabChange,onReference,configuration,contextSources}: {
 conversationId: string; projectId: string; config: Config; requestedContent?: ContentTarget | null;
 configuration?: ReactNode; contextSources?: ReactNode; activityVersion?: string;
 theme: string; onCloseTerminal: () => void;
 onReference: (value:string)=>void;
 initialTab?: ConversationWorkspaceTab; onTabChange?: (tab: ConversationWorkspaceTab) => void;
}) {
 const {text: localize, language,errorText}=useLanguage(),id=useId();
 const label=(zh:string,en:string)=>localize(zh, en);
 const [tab,setTab]=useState<ConversationWorkspaceTab>(initialTab==='materials'||initialTab==='configuration'||(initialTab==='references'&&requestedContent?.kind!=='asset')?'files':initialTab),[filter,setFilter]=useState('');
 const [showConfiguration,setShowConfiguration]=useState(initialTab==='configuration');
 const [capabilitiesVisited,setCapabilitiesVisited]=useState(initialTab==='configuration');
 useEffect(()=>{if(showConfiguration)setCapabilitiesVisited(true);},[showConfiguration]);
 const activeTab=showConfiguration?'configuration':tab;
 const [workspace,setWorkspace]=useState<Load<Workspace>|null>(null),[workspaceReload,setWorkspaceReload]=useState(0);
 const workspaceScope=conversationId+':'+activityVersion;
 const workspaceCache=useRef({scope:workspaceScope,views:new Map<string,{loadedAt:number;load:Load<Workspace>}>()});
 const restoredFile=()=>{const active=openFiles.get(conversationId)?.active;return active?{conversationId,path:active,attempt:0}:null;};
 const [selection,setSelection]=useState<{conversationId:string;path:string;attempt:number}|null>(()=>initialTab==='files'?restoredFile():null),[file,setFile]=useState<Load<FilePreview>|null>(null);
 const [materialSelection,setMaterialSelection]=useState<{scope:string;material:Material;attempt:number}|null>(null),[materialPreview,setMaterialPreview]=useState<Load<MaterialPreview>|null>(null);
 const [external,setExternal]=useState<Exclude<ContentTarget,{kind:'asset'}>|null>(requestedContent?.kind==='asset'?null:requestedContent??null),[externalFile,setExternalFile]=useState<Load<FilePreview>|null>(null);
 const [copied,setCopied,clearCopied,copySequence]=useCopyFeedback();
 const [copyError,setCopyError]=useState('');
 const [baseRef,setBaseRef]=useState('');
 const [diffScope,setDiffScope]=useState('all'),[showFile,setShowFile]=useState(false);
 const [openPaths,setOpenPaths]=useState(()=>openFiles.get(conversationId)?.paths??[]),restoredScroll=useRef<string|null>(null);
 const reader=useRef<HTMLElement>(null),search=useRef<HTMLInputElement>(null);
 const needsWorkspace=(tab==='files'||tab==='changes')&&!external,scope=conversationId+':'+projectId;
 const workspaceKey=conversationId+(tab==='changes'?':'+diffScope+':'+baseRef:'');
 const listing=workspace?.key===workspaceKey?workspace:null;
 const selected=selection?.conversationId===conversationId?selection:null;
 const fileKey=conversationId+':'+tab+':'+diffScope+':'+baseRef+':'+(selected?.path??'')+':'+(selected?.attempt??0);
 const fileResult=file?.key===fileKey?file:null;
 const materialChoice=materialSelection?.scope===scope?materialSelection:null;
 const materialKey=scope+':'+(materialChoice?.material.assetId??'')+':'+(materialChoice?.material.versionId??'')+':'+(materialChoice?.material.fileId??'')+':'+(materialChoice?.attempt??0);
 const materialResult=materialPreview?.key===materialKey?materialPreview:null;
 const tabs: {key:ConversationWorkspaceTab;name:string;icon:IconName}[]=[
  // Context lives in the chat's context popover; 'references' remains only as the document reader.
  ...(configuration?[{key:'configuration' as const,name:label('能力','Capabilities'),icon:'sparkles' as IconName}]:[]),{key:'files',name:label('文件','Files'),icon:'file'},
  {key:'changes',name:label('改动','Changes'),icon:'gitBranch'},{key:'terminal',name:label('终端','Terminal'),icon:'terminal'},
 ];
 // Tabs read as words; only when the panel is too narrow for every label do they fold to icons (names stay as tooltips).
 const tabList=useRef<HTMLDivElement>(null),labelsWidth=useRef(0),[compactTabs,setCompactTabs]=useState(false);
 useEffect(()=>{
  const list=tabList.current;if(!list)return;
  const check=()=>{
   if(list.dataset.compact!=='true')labelsWidth.current=list.scrollWidth;
   setCompactTabs(labelsWidth.current>list.clientWidth+1);
  };
  const observer=new ResizeObserver(check);observer.observe(list);check();
  return()=>observer.disconnect();
 },[language,tabs.length]);
 const chooseTab=(next:ConversationWorkspaceTab)=>{
  setShowConfiguration(next==='configuration');
  if(next!=='configuration'){
   if(!showConfiguration||next!==tab){setExternal(null);setSelection(next==='files'?restoredFile():null);setMaterialSelection(null);setShowFile(false);setFilter('');}
   setTab(next);
  }
  onTabChange?.(next);
 };
 useEffect(()=>{setShowConfiguration(initialTab==='configuration');if(initialTab!=='configuration')setTab(initialTab==='materials'||(initialTab==='references'&&requestedContent?.kind!=='asset')?'files':initialTab);},[initialTab]);
 useEffect(()=>{
  setExternal(requestedContent?.kind==='asset'?null:requestedContent??null);if(requestedContent)setSelection(null);
  if(requestedContent?.kind==='asset'){
   setShowConfiguration(false);setTab('references');onTabChange?.('references');
   setMaterialSelection({scope,material:{...requestedContent,ordinal:0,relations:['output']},attempt:0});
  }else{
   setMaterialSelection(null);
   if(requestedContent?.kind==='file'){setShowConfiguration(false);setTab('files');onTabChange?.('files');}
  }
 },[requestedContent]);
 useEffect(()=>{
  clearCopied();setCopyError('');
  if(external||selected||materialChoice){reader.current?.focus();reader.current?.scrollTo(0,0);}
 },[external,selected?.path,materialChoice?.material.assetId,tab]);
 useEffect(()=>{
  if(external?.kind!=='file'&&external?.kind!=='attachment')return;
  const controller=new AbortController(),key=conversationId+':'+(external.kind==='file'?external.href:external.src);
  setExternalFile({key,value:null,busy:true,error:''});
  void (external.kind==='file'?read<FilePreview>('/api/conversations/'+encodeURIComponent(conversationId)+'/local-file',controller.signal,{href:external.href}):readAttachment(external,controller.signal))
   .then(value=>{if(!controller.signal.aborted)setExternalFile({key,value,busy:false,error:''});})
   .catch(error=>{if(!controller.signal.aborted)setExternalFile({key,value:null,busy:false,error:(error as Error).message});});
  return()=>controller.abort();
 },[conversationId,external]);
 useEffect(()=>{setFilter('');},[conversationId]);
 useEffect(()=>{
  restoredScroll.current=null;
  if(tab!=='files'||external)return;
  const entry=openFileMemory(conversationId),path=selected?.path??null;
  entry.active=path;
  if(path&&!entry.paths.includes(path))entry.paths=[...entry.paths,path].slice(-maxOpenFiles);
  setOpenPaths(entry.paths);
 },[conversationId,tab,external,selected?.path]);
 useEffect(()=>{
  if(tab!=='files'||!selected||!fileResult?.value)return;
  const path=selected.path,top=openFiles.get(conversationId)?.scroll.get(path)??0;
  requestAnimationFrame(()=>{if(top)reader.current?.scrollTo(0,top);restoredScroll.current=path;});
 },[fileResult?.value]);
 const closeFile=(path:string)=>{
  const entry=openFileMemory(conversationId),at=entry.paths.indexOf(path);
  entry.paths=entry.paths.filter(item=>item!==path);entry.scroll.delete(path);setOpenPaths(entry.paths);
  if(selected?.path===path){const next=entry.paths[Math.min(at,entry.paths.length-1)];setSelection(next?{conversationId,path:next,attempt:0}:null);}
 };

 useEffect(()=>{
  if(workspaceCache.current.scope!==workspaceScope)workspaceCache.current={scope:workspaceScope,views:new Map()};
  if(!conversationId||!needsWorkspace||workspace?.key===workspaceKey&&workspace.value)return;
  const cached=workspaceCache.current.views.get(workspaceKey);
  if(cached&&Date.now()-cached.loadedAt<10000){setWorkspace(cached.load);return;}
  const controller=new AbortController();
  setWorkspace({key:workspaceKey,value:null,busy:true,error:''});
  void read<Workspace>('/api/conversations/'+encodeURIComponent(conversationId)+'/workspace'+(tab==='changes'?'?scope='+diffScope+(baseRef?'&base='+encodeURIComponent(baseRef):''):''),controller.signal)
   .then(value=>{if(!controller.signal.aborted){const load={key:workspaceKey,value,busy:false,error:value.comparison?.error??''};workspaceCache.current.views.set(workspaceKey,{loadedAt:Date.now(),load});setWorkspace(load);}})
   .catch(error=>{if(!controller.signal.aborted){workspaceCache.current.views.clear();setWorkspace({key:workspaceKey,value:null,busy:false,error:(error as Error).message});}});
  return()=>controller.abort();
 },[workspaceKey,workspaceScope,needsWorkspace,workspaceReload]);

 useEffect(()=>{
  if(!needsWorkspace||!selected)return;
  const controller=new AbortController();
  setFile({key:fileKey,value:null,busy:true,error:''});
  void read<FilePreview>('/api/conversations/'+encodeURIComponent(conversationId)+'/workspace-file',controller.signal,{path:selected.path,scope:tab==='changes'?diffScope:'all',base:baseRef||undefined})
   .then(value=>{if(!controller.signal.aborted)setFile({key:fileKey,value,busy:false,error:''});})
   .catch(error=>{if(!controller.signal.aborted)setFile({key:fileKey,value:null,busy:false,error:(error as Error).message});});
  return()=>controller.abort();
 },[conversationId,tab,diffScope,baseRef,selected?.path,selected?.attempt]);

 useEffect(()=>{
  if(tab!=='references'||!materialChoice)return;
  const controller=new AbortController(),reference=materialChoice.material;
  setMaterialPreview({key:materialKey,value:null,busy:true,error:''});
  void (async()=>{
   // Recheck access; conversation references always open their recorded version.
   const asset=await read<Asset>('/api/v2/assets/'+encodeURIComponent(reference.assetId),controller.signal);
   const versionId=reference.versionId;
   if(!versionId)throw new Error(label('尚未发布','Not published'));
   const base='/api/v2/assets/'+encodeURIComponent(asset.id)+'/versions/'+encodeURIComponent(versionId);
   const version=await read<MaterialPreview['version']>(base,controller.signal);
   const preview=version.downloads.find(item=>(reference.fileId===undefined||item.fileId===reference.fileId)&&item.availability==='managed_local'&&(isImage(item.mediaType)||item.size<=1024*1024&&(item.mediaType.startsWith('text/')||/^(?:application\/(?:json|javascript))$/.test(item.mediaType))))??null;
   let text='';
   if(preview&&!isImage(preview.mediaType)){
    const response=await fetch(base+'/files/'+encodeURIComponent(preview.fileId),{signal:controller.signal});
    if(!response.ok){const data=await response.json();throw new Error(data.error??response.statusText);}
    text=await response.text();
   }
   if(!controller.signal.aborted)setMaterialPreview({key:materialKey,value:{asset,version,file:preview,text},busy:false,error:''});
  })().catch(error=>{if(!controller.signal.aborted)setMaterialPreview({key:materialKey,value:null,busy:false,error:(error as Error).message});});
  return()=>controller.abort();
 },[scope,tab,materialChoice?.material.assetId,materialChoice?.material.versionId,materialChoice?.material.fileId,materialChoice?.attempt]);

 const refreshWorkspace=()=>{workspaceCache.current.views.clear();setWorkspace(null);setSelection(null);setWorkspaceReload(value=>value+1);};
 const visibleFiles=(listing?.value?.files??[]).filter(item=>(tab!=='changes'||item.status.trim())&&item.path.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()));
 const trackedFiles=tab==='changes'?visibleFiles.filter(item=>item.status!=='??'):visibleFiles,untrackedFiles=tab==='changes'?visibleFiles.filter(item=>item.status==='??'):[];
 const changeOrder=[...trackedFiles,...untrackedFiles];
 const treeNodes=workspaceTree(trackedFiles, tab==='files'&&!filter.trim()?listing?.value?.directories:[]);
 const trackedChanges=(listing?.value?.files??[]).filter(item=>item.status.trim()&&item.status!=='??');
 const untrackedTotal=listing?.value?.untracked??(listing?.value?.files??[]).filter(item=>item.status==='??').length;
 const statusLabel=(status:string)=>status==='??'?label('未跟踪文件','Untracked file'):status==='D?'?label('替换','Replaced'):status.includes('D')?label('删除','Deleted'):status.includes('A')?label('新增','Added'):status.includes('R')?label('重命名','Renamed'):status.trim()?label('修改','Modified'):'';
 const selectedStatus=listing?.value?.files.find(item=>item.path===selected?.path)?.status??'';
 const loading=label('加载中…','Loading…'),retry=label('重试','Retry');
 const choose=(path:string)=>setSelection({conversationId,path,attempt:(selection?.attempt??0)+1});

 const directKey=external?.kind==='file'?external.href:external?.kind==='attachment'?external.src:'';
 const directFile=directKey&&externalFile?.key===conversationId+':'+directKey?externalFile:null;
 const activeFile=external&&external.kind!=='image'?directFile:fileResult;
 const reading=!!(external||selected||materialChoice);
 // 'references' is only the document reader; without a document (and none on its way) fall back to files.
 useEffect(()=>{if(tab==='references'&&!reading&&requestedContent?.kind!=='asset'){setTab('files');onTabChange?.('files');}},[tab,reading,requestedContent]);
 const path=external?.kind==='file'?(directFile?.value?.path??external.href):selected?.path;
 const title=external&&external.kind!=='file'?external.name:materialChoice?.material.title??(path?path.split(/[\\/]/).pop():'');
 const localTarget=external?.kind==='file'?{kind:'local-file',body:{href:external.href},query:'href='+encodeURIComponent(external.href)}:selected&&tab==='files'?{kind:'workspace-file',body:{path:selected.path},query:'path='+encodeURIComponent(selected.path)}:null;
 const fileEndpoint=localTarget?'/api/conversations/'+encodeURIComponent(conversationId)+'/'+localTarget.kind:'';
 const back=()=>{if(tab==='references'){setTab('files');onTabChange?.('files');}setShowFile(false);setExternal(null);setSelection(null);setFile(null);setMaterialSelection(null);requestAnimationFrame(()=>(search.current??document.getElementById(id+'-'+tab))?.focus());};
 const retryFile=()=>{if(external)setExternal({...external});else if(selected)setSelection({...selected,attempt:selected.attempt+1});};
 const materialUrl=(preview:MaterialPreview,item:AssetFile)=>'/api/v2/assets/'+encodeURIComponent(preview.asset.id)+'/versions/'+encodeURIComponent(preview.version.id)+'/files/'+encodeURIComponent(item.fileId);

 return <section className="conversation-workspace">
  <div ref={tabList} data-compact={compactTabs||undefined} className="conversation-workspace-tabs" role="tablist" aria-label={label('侧栏视图','Sidebar views')} onKeyDown={event=>{
   const at=tabs.findIndex(item=>item.key===activeTab);
   const next=event.key==='ArrowRight'?(at+1)%tabs.length:event.key==='ArrowLeft'?(at+tabs.length-1)%tabs.length:event.key==='Home'?0:event.key==='End'?tabs.length-1:-1;
   if(next<0)return;event.preventDefault();chooseTab(tabs[next].key);document.getElementById(id+'-'+tabs[next].key)?.focus();
  }}>
   {tabs.map(item=><Button type="button" role="tab" key={item.key} id={id+'-'+item.key} title={item.key==='terminal'?item.name+' · '+shortcutLabel('terminal'):compactTabs?item.name:undefined} aria-keyshortcuts={item.key==='terminal'?shortcutAria('terminal'):undefined} aria-selected={activeTab===item.key} aria-controls={id+'-panel'} tabIndex={activeTab===item.key?0:-1} onClick={()=>chooseTab(item.key)}><Icon name={item.icon} size={16}/><span className="workspace-tab-label">{item.name}</span></Button>)}
  </div>
  <div role="tabpanel" id={id+'-panel'} aria-labelledby={activeTab==='references'?undefined:id+'-'+activeTab} aria-label={activeTab==='references'?label('预览','Preview'):undefined}>
   {(showConfiguration||capabilitiesVisited)&&<div className="content-browser chat-capabilities" hidden={!showConfiguration}>{configuration}{contextSources&&<section className="chat-instructions" aria-label={label('指令与候选资料','Instructions and available sources')}>{contextSources}</section>}</div>}
   <div className="conversation-workspace-content" hidden={showConfiguration}>
   {tab==='files'&&!external&&openPaths.length>0&&<div className="open-file-tabs" role="group" aria-label={label('打开的文件','Open files')}>
    <Button type="button" className="icon-button" aria-label={label('文件列表','File list')} title={label('文件列表','File list')} aria-pressed={!selected} onClick={back}><Icon name="files" size={15}/></Button>
    {openPaths.map(item=>{const name=item.split('/').pop()??item;return <span key={item} className="open-file-tab" data-active={selected?.path===item||undefined}>
     <Button type="button" title={item} aria-pressed={selected?.path===item} onClick={()=>setSelection({conversationId,path:item,attempt:selected?.path===item?selected.attempt:0})}>{name}</Button>
     <Button type="button" className="icon-button" aria-label={label('关闭 ','Close ')+name} onClick={()=>closeFile(item)}><Icon name="close" size={12}/></Button>
    </span>;})}
   </div>}
   {tab==='terminal'?<DeferredTerminal loadingLabel={label('正在打开终端…','Opening terminal…')} conversationId={conversationId} theme={theme} onClose={onCloseTerminal} onReference={onReference}/>:reading?<>
    <header className="content-reader-heading">
     <div className="content-reader-bar">
      {(()=>{const backLabel=tab==='references'?label('关闭预览','Close preview'):tab==='changes'?label('返回改动','Back to changes'):label('返回文件','Back to files');return <Button type="button" variant="ghost" className="content-reader-back icon-button" aria-label={backLabel} title={backLabel} onClick={back}><Icon name="arrowLeft" size={15}/></Button>;})()}
      <div className="content-reader-title"><Icon name={external?.kind==='image'?'image':tab==='changes'?'layers':'file'} size={16}/>
       <div className="content-reader-name"><h3 title={title}>{title}</h3>
        {path?<button type="button" className="content-reader-location" aria-label={label('复制路径','Copy path')} title={(activeFile?.value?.path??path)+' · '+label('点击复制路径','Click to copy path')} data-copied={!!copied||undefined} onClick={async()=>{try{await copyText(activeFile?.value?.path??path);setCopyError('');setCopied(label('路径已复制','Path copied'));}catch{clearCopied();setCopyError(label('复制失败','Copy failed'));}}}>{copied?<><Icon name="check" size={12}/>{String(copied)}</>:external?(external.kind==='file'?label('本地文件','Local file'):label('上传附件','Attachment')):materialChoice?label('引用文档','Referenced document')+(materialResult?.value?' · '+label('固定版本','Pinned version')+' · v'+materialResult.value.version.ordinal:''):tab==='changes'?(diffScope==='branch'?label('分支已提交','Branch commits'):diffScope==='staged'?label('已暂存','Staged'):diffScope==='unstaged'?label('未暂存','Unstaged'):label('全部未提交','All uncommitted'))+' · '+path:path}</button>:<p className="content-reader-location">{external?(external.kind==='file'?label('本地文件','Local file'):label('上传附件','Attachment')):materialChoice?label('引用文档','Referenced document')+(materialResult?.value?' · '+label('固定版本','Pinned version')+' · v'+materialResult.value.version.ordinal:''):tab==='changes'?(diffScope==='branch'?label('分支已提交','Branch commits'):diffScope==='staged'?label('已暂存','Staged'):diffScope==='unstaged'?label('未暂存','Unstaged'):label('全部未提交','All uncommitted'))+' · '+path:path}</p>}
       </div>
      </div>
      <div className="content-reader-actions">
       {path&&onReference&&activeFile?.value&&<Button type="button" variant="ghost" className="content-reader-reference" aria-label={label('引用文件','Reference file')} title={label('引用文件','Reference file')} onClick={()=>onReference(fileReference(activeFile.value!.path??path,undefined,undefined,language !== 'zh-CN'))}><Icon name="quote" size={14}/><span>{label('引用','Reference')}</span></Button>}
       {materialChoice&&materialResult?.value&&(()=>{const value=materialResult.value!,item=value.version.downloads.find(file=>file.fileId===value.file?.fileId)??value.version.downloads[0];return <>
        {item?.availability==='managed_local'&&<><a className="icon-button" download={item.name} href={materialUrl(value,item)} aria-label={label('下载固定版本','Download pinned version')} title={label('下载固定版本','Download pinned version')}><Icon name="download" size={15}/></a><AssetLocalActions key={value.version.id+item.fileId} assetId={value.asset.id} versionId={value.version.id} file={item} compact/></>}
        <a className="icon-button" href={'/assets/'+encodeURIComponent(value.asset.id)+'?version='+encodeURIComponent(value.version.id)} onClick={followAssetPage} aria-label={label('查看文件详情','View file details')} title={label('查看文件详情','View file details')}><Icon name="info" size={15}/></a>
       </>;})()}
       {localTarget&&activeFile?.value&&<LocalFileActions key={fileEndpoint+localTarget.query} url={fileEndpoint+'/open'} body={localTarget.body} compact/>}
       {external?.kind==='attachment'&&<a className="attachment-download icon-button" href={external.src} download={external.name} aria-label={label('下载附件','Download attachment')} title={label('下载附件','Download attachment')}><Icon name="download" size={15}/></a>}
      </div>
     </div>
     {tab==='changes'&&selected&&<div className="change-reader-actions"><ChangeStats file={listing?.value?.files.find(item=>item.path===selected.path)}/><Button type="button" aria-pressed={showFile} onClick={()=>setShowFile(value=>!value)}>{showFile?label('查看 diff','View diff'):label('查看文件','View file')}</Button><span className="change-navigation">{(['previous','next'] as const).map(direction=>{const index=changeOrder.findIndex(item=>item.path===selected.path)+(direction==='previous'?-1:1),item=changeOrder[index];return <Button type="button" key={direction} disabled={!item} aria-label={direction==='previous'?label('上一个改动','Previous change'):label('下一个改动','Next change')} onClick={()=>{setShowFile(false);setSelection({conversationId,path:item.path,attempt:0});}}><Icon name={direction==='previous'?'arrowUp':'arrowDown'} size={14}/></Button>;})}</span></div>}
     {copied&&<span key={"feedback-" + copySequence} role="status" className="sr-only">{copied}</span>}
     {copyError&&<span role="alert" className="field-hint">{copyError}</span>}
    </header>
    <section ref={reader} tabIndex={-1} onScroll={event=>{if(tab==='files'&&selected&&restoredScroll.current===selected.path)openFileMemory(conversationId).scroll.set(selected.path,event.currentTarget.scrollTop);}} className={"conversation-workspace-preview"+(tab==='changes'&&!showFile?' is-diff':'')} aria-label={label('内容预览','Content preview')}>
     {external?.kind==='image'?<ReaderImage key={external.src} src={external.src} name={external.name}/>:materialChoice?<>
      {!materialResult||materialResult.busy?<p role="status">{loading}</p>:materialResult.error?<div role="alert"><p>{errorText(materialResult.error)}</p><Button type="button" onClick={()=>setMaterialSelection({...materialChoice,attempt:materialChoice.attempt+1})}>{retry}</Button></div>:materialResult.value&&<>
       {materialResult.value.file?isImage(materialResult.value.file.mediaType)?<ReaderImage key={materialUrl(materialResult.value,materialResult.value.file)} src={materialUrl(materialResult.value,materialResult.value.file)} name={materialResult.value.file.name}/>:<ReaderText name={materialResult.value.file.name} text={materialResult.value.text} markdown={materialResult.value.file.mediaType.includes('markdown')}/>:<p>{label('暂不支持此格式或大小的预览。','This format or size cannot be previewed.')}</p>}
       {(()=>{const value=materialResult.value!,primary=value.version.downloads.find(file=>file.fileId===value.file?.fileId)??value.version.downloads[0],others=value.version.downloads.filter(file=>file!==primary);return <>
        {primary&&primary.availability!=='managed_local'&&<p role="alert">{label('内容缺失，请从备份恢复。','Content is missing; restore it from a backup.')}</p>}
        {others.length>0&&<footer className="content-reader-downloads"><h4>{label('此版本的其他文件','Other files in this version')}</h4>{others.map(item=><div key={item.fileId} className="conversation-workspace-download"><Icon name="file" size={14}/><span title={item.name}>{item.name}</span>{item.availability==='managed_local'?<span className="content-reader-file-actions"><a className="icon-button" download={item.name} href={materialUrl(value,item)} aria-label={label('下载固定版本','Download pinned version')+' · '+item.name} title={label('下载固定版本','Download pinned version')}><Icon name="download" size={15}/></a><AssetLocalActions key={value.version.id+item.fileId} assetId={value.asset.id} versionId={value.version.id} file={item} compact/></span>:<small>{label('内容缺失，请从备份恢复。','Content is missing; restore it from a backup.')}</small>}</div>)}</footer>}
       </>;})()}
      </>}
     </>:<>
      {!activeFile||activeFile.busy?<p role="status">{loading}</p>:activeFile.error?<div role="alert"><p>{errorText(activeFile.error)}</p><Button type="button" onClick={retryFile}>{retry}</Button></div>:activeFile.value&&<>
       {tab==='changes'&&!showFile?<DiffPreview key={fileKey} patch={activeFile.value.diff} binary={activeFile.value.binary}/>
       :activeFile.value.binary?<p>{label('此格式或大小暂不支持文本预览。','Text preview is unavailable for this format or size.')}</p>:selectedStatus.includes('D')&&!activeFile.value.text?<p>{label('文件已删除，可在改动页查看差异。','This file was deleted; view its diff in Changes.')}</p>:<ReaderText {...activeFile.value} previewUrl={localTarget?fileEndpoint+'/preview?'+localTarget.query:undefined} referencePath={activeFile.value.path??path} onReference={onReference}/>}

      </>}
     </>}
    </section>
   </>:<div className="content-browser">
    {tab==='files'&&<div className="conversation-workspace-toolbar"><span>{config.projects.find(project=>project.id===projectId)?.name??label('当前对话','Current chat')}</span><Button type="button" aria-label={label('刷新','Refresh')} title={label('刷新','Refresh')} onClick={refreshWorkspace}><Icon name="refresh" size={15}/></Button></div>}
    {tab==='changes'&&<div className="change-summary"><Select ariaLabel={label('改动范围','Change scope')} value={diffScope} onChange={value=>{setDiffScope(value);setBaseRef('');setSelection(null);}} options={[{value:"branch",label:label('分支已提交','Branch commits')},{value:"all",label:(label('全部未提交','All uncommitted'))},{value:"unstaged",label:(label('未暂存','Unstaged'))},{value:"staged",label:(label('已暂存','Staged'))}]}/>{listing?.value&&!listing.error&&<span>{trackedChanges.length} {label('个文件','files')} <ChangeStats file={{additions:trackedChanges.reduce((n,f)=>n+(f.additions??0),0),deletions:trackedChanges.reduce((n,f)=>n+(f.deletions??0),0)}}/>{trackedChanges.some(f=>f.additions==null||f.deletions==null)&&<small title={label('二进制或无法统计的文件不计入行数','Binary or unavailable counts are excluded')}> *</small>}</span>}<Button type="button" className="icon-button" aria-label={label('刷新','Refresh')} title={label('刷新','Refresh')} onClick={refreshWorkspace}><Icon name="refresh" size={15}/></Button></div>}
    {tab==='changes'&&<p className="field-hint">{diffScope==='branch'?label('比较共同祖先到当前分支的已提交改动，不等同于本次对话改动。','Committed changes since the common ancestor; not limited to this chat.'):label('仅显示当前工作区未提交的改动；已提交的改动请选“分支已提交”。','Shows uncommitted workspace changes. Choose Branch commits for committed changes.')}</p>}
    {tab==='changes'&&diffScope==='branch'&&listing?.value?.comparison&&<div className="change-summary"><Select ariaLabel={label('比较基线','Comparison base')} value={listing.value.comparison.baseRef} onChange={value=>{setBaseRef(value);setSelection(null);}} options={[...(listing.value.comparison.baseRef?[]:[{value:'',label:label('选择比较基线','Select a comparison base')}]),...listing.value.comparison.baseRefs.map(value=>({value,label:value.replace(/^refs\/(heads|remotes)\//,'')}))]}/>{!listing.value.comparison.error&&<span title={listing.value.comparison.headRef}>{listing.value.comparison.mergeBase.slice(0,7)} … {listing.value.comparison.head.slice(0,7)}</span>}</div>}
    {tab==='references'?null:<>
     {!listing||listing.busy?<p role="status">{loading}</p>:listing.error?<div role="alert"><p>{errorText(listing.error)}</p><Button type="button" onClick={refreshWorkspace}>{retry}</Button></div>:tab==='changes'&&!listing.value?.git?<div className="content-empty"><Icon name="layers" size={28}/><p>{label('此目录不是 Git 仓库。','This directory is not a Git repository.')}</p></div>:<>
      <div className="content-search"><Icon name="search" size={16}/><Input ref={search} type="search" className="conversation-workspace-search" aria-label={label('筛选文件','Filter files')} placeholder={label('搜索名称或路径','Search name or path')} value={filter} onChange={event=>setFilter(event.target.value)}/></div>
      {listing.value&&<p className="workspace-root-path" title={listing.value.cwd}><Icon name="folder" size={14}/><span className="workspace-root-path-text"><bdi>{listing.value.cwd}</bdi></span></p>}
      {listing.value?.truncated&&<p className="field-hint">{label('文件清单已截断，只展示部分文件。','The file list is truncated; only some files are shown.')}</p>}
      {!treeNodes.length&&!untrackedFiles.length?<div className="content-empty"><Icon name={tab==='changes'?'check':'file'} size={28}/><p>{filter.trim()?label('没有匹配的文件。','No matching files.'):tab==='changes'?label('当前没有 Git 改动。','No current Git changes.'):label('暂无可查看的文件','No files to preview')}</p></div>:<>
       {treeNodes.length?<WorkspaceTree key={workspaceKey+":"+workspaceReload} conversationId={tab==='files'?conversationId:undefined} nodes={tab==='changes'?compactFolders(treeNodes):treeNodes} expanded={!!filter.trim()} defaultOpen={tab==='changes'} onChoose={choose} renderMeta={item=>tab==='changes'?<span className="content-change-meta"><ChangeStats file={item}/><small className="content-item-status">{statusLabel(item.status)}</small></span>:item.status.trim()?<small className="content-item-status" title={item.status}>{statusLabel(item.status)}</small>:null}/>:<p className="field-hint">{label('已跟踪文件没有改动。','No tracked file changes.')}</p>}
       {untrackedFiles.length>0&&<Disclosure key={workspaceKey+":untracked:"+workspaceReload} className="untracked-changes" open={!!filter.trim()||undefined} summaryLabel={label('未跟踪文件','Untracked files')} title={<><span>{label('未跟踪 ','Untracked ')}{untrackedTotal}{label(' 个文件',' files')}</span><small>{label('不计入行数','Not counted in lines')}</small></>}>
        {untrackedTotal>untrackedFiles.length&&!filter.trim()&&<p className="field-hint">{label('只列出了其中 ','Showing ')}{untrackedFiles.length}{label(' 个。',' of them.')}</p>}
        <WorkspaceTree nodes={workspaceTree(untrackedFiles)} expanded={!!filter.trim()} onChoose={choose} renderMeta={item=><ChangeStats file={item}/>}/>
       </Disclosure>}
      </>}
     </>}
    </>}
   </div>}
   </div>
  </div>
 </section>;
}

function isImage(type:string){return /^image\/(png|jpeg|gif|webp)$/.test(type);}
function ReaderText({name,text,language,markdown=false,referencePath,onReference,previewUrl}:{name:string;text:string;language?:string;markdown?:boolean;referencePath?:string;onReference?:(text:string)=>void;previewUrl?:string}){
 if(markdown||/\.(md|markdown)$/i.test(name))return <MarkdownMessage text={text} frontmatter/>;
 const syntax=language??codeLanguage(name);
 const source=referencePath&&onReference?<WorkspaceCodePreview path={referencePath} text={text} language={syntax} onReference={onReference}/>:syntax?<CodePreview text={text} language={syntax}/>:<pre className="content-plain-text">{text}</pre>;
 return previewUrl&&/\.html?$/i.test(name)?<HtmlPreview key={previewUrl} name={name} url={previewUrl} source={source}/>:source;
}
function ReaderImage({src,name}:{src:string;name:string}){
 const {t}=useLanguage(),[failed,setFailed]=useState(false),[actualSize,setActualSize]=useState(false);
 return failed?<p role="alert">{t('图片无法加载')}</p>:<>
  <div className="content-image-toolbar"><Button type="button" aria-pressed={actualSize} onClick={()=>setActualSize(value=>!value)}>{t(actualSize?'适应宽度':'查看原尺寸')}</Button></div>
  <div className={'content-image'+(actualSize?' is-actual':'')} tabIndex={actualSize?0:undefined} aria-label={t('图片预览')}><img src={src} alt={name} onError={()=>setFailed(true)}/></div>
 </>;
}

function ChangeStats({file}:{file?:Pick<WorkspaceFile,'additions'|'deletions'|'binary'>}) {
 const {text: localize}=useLanguage();
 if(!file)return null;
 if(file.additions==null||file.deletions==null)return <small className="content-item-status">{file.binary?(localize('二进制', 'Binary')):(localize('无法统计', 'Unavailable'))}</small>;
 return <span className="change-stats"><span className="change-add">+{file.additions}</span><span className="change-remove">−{file.deletions}</span></span>;
}
async function readAttachment(target:Extract<ContentTarget,{kind:'attachment'}>,signal:AbortSignal):Promise<FilePreview> {
 const textFormat=target.mimeType.startsWith('text/')||/^(?:application\/(?:json|javascript|xml))$/.test(target.mimeType)||!!codeLanguage(target.name)||/\.(md|markdown|txt|csv)$/i.test(target.name);
 if(!textFormat||target.size>1024*1024)return {name:target.name,path:target.name,text:'',diff:null,binary:true};
 const response=await fetch(target.src,{signal});
 if(!response.ok)throw new Error((await response.json()).error??response.statusText);
 const data=await response.arrayBuffer();
 try {
  if(data.byteLength>1024*1024||new Uint8Array(data).includes(0))throw new Error('Not previewable text');
  const text=new TextDecoder('utf-8',{fatal:true}).decode(data);
  return {name:target.name,path:target.name,text,diff:null};
 } catch {return {name:target.name,path:target.name,text:'',diff:null,binary:true};}
}

type WorkspaceTreeProps = {nodes:WorkspaceTreeNode[];expanded:boolean;defaultOpen?:boolean;conversationId?:string;onChoose:(path:string)=>void;renderMeta:(file:WorkspaceFile)=>React.ReactNode};
/** Folder chains with a single sub-folder read as one row (`tests/billing/cases`), like an editor's compact folders. */
function compactFolders(nodes:WorkspaceTreeNode[],parent=''):(WorkspaceTreeNode&{label?:string})[]{
 return nodes.map(node=>{
  if(!node.children)return node;
  let current=node;
  while(current.children?.length===1&&current.children[0].children)current=current.children[0];
  const label=current.path.slice(parent?parent.length+1:0);
  return {...current,label,children:compactFolders(current.children??[],current.path)};
 });
}
function WorkspaceTree(props: WorkspaceTreeProps) {
 const {nodes,onChoose,renderMeta}=props;
 return <ul className="workspace-file-tree">{nodes.map(node=><li key={node.path}>{node.children?<WorkspaceFolder {...props} node={node}/>:<Button type="button" aria-label={node.path} title={node.path} onClick={()=>onChoose(node.path)}><Icon name={codeLanguage(node.path)?'code':'file'} size={16}/><span>{node.path.split('/').pop()}</span>{renderMeta(node)}</Button>}</li>)}</ul>;
}
function WorkspaceFolder({node,...props}: WorkspaceTreeProps & {node:WorkspaceTreeNode}) {
 const {text: localize, errorText}=useLanguage(),label=(zh:string,en:string)=>localize(zh, en);
 const [open,setOpen]=useState(!!props.defaultOpen),[attempt,setAttempt]=useState(0),[load,setLoad]=useState<Load<Workspace>|null>(null);
 const {conversationId,expanded}=props;
 useEffect(()=>{
  if(!open||expanded||!conversationId||load?.value)return;
  const controller=new AbortController();
  setLoad({key:node.path,value:null,busy:true,error:''});
  void read<Workspace>('/api/conversations/'+encodeURIComponent(conversationId)+'/workspace?directory='+encodeURIComponent(node.path),controller.signal)
   .then(value=>{if(!controller.signal.aborted)setLoad({key:node.path,value,busy:false,error:''});})
   .catch(error=>{if(!controller.signal.aborted)setLoad({key:node.path,value:null,busy:false,error:(error as Error).message});});
  return()=>controller.abort();
 },[open,expanded,conversationId,node.path,attempt]);
 let children=node.children??[];
 if(load?.value&&!expanded){
  children=workspaceTree(load.value.files,load.value.directories);
  let path='';
  for(const part of node.path.split('/')){path=path?path+'/'+part:part;children=children.find(item=>item.path===path)?.children??[];}
 }
 return <Disclosure className="workspace-tree-folder" open={expanded||open} onToggle={event=>{if(event.target===event.currentTarget)setOpen(event.currentTarget.open);}} summaryLabel={node.path} title={<><Icon name="folder" size={16}/><span title={node.path}>{(node as {label?:string}).label??node.path.split('/').pop()}</span></>}>
  {load?.busy&&<p role="status">{label('加载中…','Loading…')}</p>}
  {load?.error&&<p role="alert">{errorText(load.error)} <Button type="button" onClick={()=>setAttempt(value=>value+1)}>{label('重试','Retry')}</Button></p>}
  {load?.value?.truncated&&<p className="field-hint">{label('此目录仅显示部分内容，可继续展开子目录。','Only part of this directory is shown; expand a subfolder to load its contents.')}</p>}
  {!children.length&&!load?.busy&&!load?.error&&(!conversationId||load?.value&&!load.value.truncated)&&<p className="field-hint">{label('此文件夹没有可查看的内容','No previewable contents in this folder')}</p>}
  <WorkspaceTree {...props} nodes={children}/>
 </Disclosure>;
}
