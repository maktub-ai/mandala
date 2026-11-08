import Button from './ui/Button';
import Textarea from './ui/Textarea';
import Input from './ui/Input';
import { startPolling } from './polling';
import IdentityAvatar from "./IdentityAvatar";
import Select from './ui/Select';
import Disclosure from './ui/Disclosure';
import { AdoptPlan, FixedOutput, taskRequest } from './TaskWorkspace';
import { useEffect, useRef, useState } from 'react';
import type { Asset, AssetBinding, AssetFile, AssetVersion, FileMaintenanceStatus } from '../shared/assets';
import type { TaskSource } from '../shared/tasks';
import type { Config, KnowledgeAccess } from '../shared/types';
import { assetRequest, assetScopeLabels, followAssetPage } from './AssetLibrary';
import { useLanguage } from './i18n';
import { PageHeader, DetailSection } from './ui/WorkspacePage';
import LoadingState from './ui/LoadingState';
import './asset-reader.css';
import AssetPreview, { AssetLocalActions } from './AssetPreview';
import AssetFileIcon from './AssetFileIcon';
import { filePreviewKind } from '../shared/file-types';
import Icon from './ui/Icon';
import Dialog from './Dialog';
type Version=AssetVersion&{downloads:AssetFile[]};
export function useReaderNavigationLock(locked:boolean,onNavigationLockChange?:(locked:boolean)=>void){
 useEffect(()=>{onNavigationLockChange?.(locked);if(!locked)return;const prevent=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};addEventListener('beforeunload',prevent);return()=>{onNavigationLockChange?.(false);removeEventListener('beforeunload',prevent);};},[locked,onNavigationLockChange]);
}
export default function AssetDetail({id,config,onNavigationLockChange,onOpenPath}:{id:string;config:Config;onNavigationLockChange?:(locked:boolean)=>void;onOpenPath?:(path:string)=>void}){
 const {text: localize, t}=useLanguage();
 const projectContext=new URLSearchParams(location.search).get('project');
 const filesHref='/library'+(projectContext?'?project='+encodeURIComponent(projectContext):'');
 const versionHref=(versionId:string)=>'/library/'+encodeURIComponent(id)+'?version='+encodeURIComponent(versionId)+(projectContext?'&project='+encodeURIComponent(projectContext):'');
 const [asset,setAsset]=useState<Asset|null>(null),[versions,setVersions]=useState<AssetVersion[]>([]),[version,setVersion]=useState<Version|null>(null),[text,setText]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[project,setProject]=useState(''),[notice,setNotice]=useState(''),[editing,setEditing]=useState(false),[policy,setPolicy]=useState<KnowledgeAccess>({mode:'owner'});
 const [source,setSource]=useState<TaskSource|null>(null),[bindings,setBindings]=useState<AssetBinding[]>([]),[preview,setPreview]=useState<AssetFile|null>(null),[reading,setReading]=useState(true),[feedback,setFeedback]=useState('');
 const [origin,setOrigin]=useState<{kind:string;conversationId:string|null;title:string|null}|null>(null);
 const [maintenance,setMaintenance]=useState<FileMaintenanceStatus|null>(null),[maintEnabled,setMaintEnabled]=useState(false),[maintAgent,setMaintAgent]=useState(''),[maintProject,setMaintProject]=useState(''),[maintConditions,setMaintConditions]=useState('');
 const [settingsOpen,setSettingsOpen]=useState(false),[draft,setDraft]=useState('');
 const [latestHead,setLatestHead]=useState<{asset:Asset;version:Version;text:string}|null>(null);
 const maintenanceDirty=!!maintenance&&(maintEnabled!==maintenance.enabled||maintAgent!==(maintenance.agentId??asset?.owner.agentId??'')||maintProject!==(maintenance.projectId??'')||maintConditions!==(maintenance.conditions??''));
 const settingsDirty=!!asset&&(JSON.stringify(policy)!==JSON.stringify(asset.accessPolicy)||maintenanceDirty||!!project);
 const locked=busy||editing||settingsDirty||!!feedback.trim();
 useReaderNavigationLock(locked,onNavigationLockChange);
 const follow:typeof followAssetPage=event=>{if(locked){event.preventDefault();return;}if(onOpenPath&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();onOpenPath(event.currentTarget.pathname+event.currentTarget.search);}else followAssetPage(event);};
 const cancelSettings=()=>{setPolicy(asset?.accessPolicy??{mode:'owner'});setMaintEnabled(maintenance?.enabled??false);setMaintAgent(maintenance?.agentId??asset?.owner.agentId??'');setMaintProject(maintenance?.projectId??'');setMaintConditions(maintenance?.conditions??'');setProject('');setSettingsOpen(false);setError('');};
 const readLatest=async()=>{setBusy(true);try{const next=await assetRequest<Asset>('/'+id),v=await assetRequest<Version>('/'+id+'/versions/'+next.headVersionId);const file=v.downloads.find(file=>file.availability==='managed_local'&&filePreviewKind(file.name,file.mediaType)==='text');if(!file)throw new Error(t('来源不可访问，请检查使用范围。'));const response=await fetch('/api/v2/assets/'+id+'/versions/'+v.id+'/files/'+file.fileId);if(!response.ok)throw new Error(t('来源不可访问，请检查使用范围。'));setLatestHead({asset:next,version:v,text:await response.text()});}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 const sequence=useRef(0),feedbackCommand=useRef<{body:string;key:string}|null>(null);
 const loadSequence=useRef(0);
 const attempt=useRef<{submissionId:string;key:string;expectedHeadVersionId:string|null;sourceVersions:AssetVersion['provenance']['sourceVersions']}|null>(null);
 const sourcePath=(versionId:string)=>'/source?assetId='+encodeURIComponent(id)+'&versionId='+encodeURIComponent(versionId);
 const loadBindings=async()=>{
  const token=loadSequence.current;
  const rows=await assetRequest<AssetBinding[]>('/'+id+'/bindings');
  if(token===loadSequence.current)setBindings(rows);
 };
 const openVersion=async(_a:Asset,versionId:string|null)=>{
  const token=++sequence.current;setVersion(null);setSource(null);setText('');setPreview(null);setDraft('');setEditing(false);setLatestHead(null);attempt.current=null;setFeedback('');setReading(true);setError('');if(!versionId){setReading(false);return;}
  try{
   const v=await assetRequest<Version>('/'+id+'/versions/'+versionId);if(token!==sequence.current)return;setVersion(v);
   void assetRequest('/'+id+'/activity','POST',{kind:'view',versionId:v.id}).catch(e=>{if(token!==sequence.current)return;if((e as {status?:number}).status===403){sequence.current++;setReading(false);setVersion(null);setText('');setPreview(null);setSource(null);setDraft('');setLatestHead(null);setEditing(false);attempt.current=null;}setError((e as Error).message);});
   const readable=v.downloads.find(file=>{const kind=filePreviewKind(file.name,file.mediaType);return file.availability==='managed_local'&&kind&&(!['text','table'].includes(kind)||file.size<=1048576);});
   const [body,found]=await Promise.all([(async()=>{
    if(!readable||!['text','table'].includes(filePreviewKind(readable.name,readable.mediaType)??''))return '';
    const r=await fetch('/api/v2/assets/'+id+'/versions/'+v.id+'/files/'+readable.fileId);if(!r.ok)throw Object.assign(new Error('Content unavailable'),{status:r.status});return r.text();
   })(),taskRequest<TaskSource|null>(sourcePath(v.id))]);
   if(token!==sequence.current)return;
   setText(body);setPreview(readable??null);setSource(found);
  }catch(e){if(token!==sequence.current)return;if((e as {status?:number}).status===403){sequence.current++;setReading(false);setVersion(null);setSource(null);setText('');setPreview(null);setDraft('');setLatestHead(null);setEditing(false);attempt.current=null;}throw e;}finally{if(token===sequence.current)setReading(false);}
 };
 const load=async()=>{const token=++loadSequence.current;setError('');setReading(true);try{
  const a=await assetRequest<Asset>('/'+id);if(token!==loadSequence.current)return;setAsset(a);setPolicy(a.accessPolicy);
  await Promise.all([
   assetRequest<AssetVersion[]>('/'+id+'/versions').then(value=>{if(token===loadSequence.current)setVersions(value);}),
   openVersion(a,new URLSearchParams(location.search).get('version')??a.headVersionId).then(()=>{if(token===loadSequence.current)return loadBindings();}),
   assetRequest<FileMaintenanceStatus>('/'+id+'/maintenance').then(upkeep=>{if(token!==loadSequence.current)return;setMaintenance(upkeep);setMaintEnabled(upkeep.enabled);setMaintAgent(upkeep.agentId??a.owner.agentId??'');setMaintProject(upkeep.projectId??'');setMaintConditions(upkeep.conditions??'');}),
   assetRequest<{kind:string;conversationId:string|null;title:string|null}|null>('/'+id+'/origin').catch(()=>null).then(value=>{if(token===loadSequence.current)setOrigin(value);}),
  ]);
 }catch(e){if(token!==loadSequence.current)return;setReading(false);if((e as {status?:number}).status===403||(e as {status?:number}).status===404){sequence.current++;setAsset(null);setVersion(null);setSource(null);setText('');setPreview(null);setDraft('');setLatestHead(null);setEditing(false);attempt.current=null;}setError((e as Error).message);}};
 useEffect(()=>{void load();return()=>{loadSequence.current++;sequence.current++;};},[id]);
 useEffect(()=>{
  if(!version)return;
  let active=true;const refresh=(signal:AbortSignal)=>taskRequest<TaskSource|null>(sourcePath(version.id),'GET',undefined,undefined,signal).then(value=>{if(active)setSource(value);}).catch(e=>{if(active){setSource(null);if((e as {status?:number}).status===403){setVersion(null);setText('');setPreview(null);setDraft('');setLatestHead(null);setEditing(false);attempt.current=null;setError(t('来源不可访问，请检查使用范围。'));}}});
  const stop=startPolling(refresh,1800,{immediate:false});return()=>{active=false;stop();};
 },[version?.id]);
 useEffect(()=>{if(!maintenance?.enabled)return;let active=true;const stop=startPolling(signal=>assetRequest<FileMaintenanceStatus>('/'+id+'/maintenance','GET',undefined,undefined,signal).then(value=>{if(active)setMaintenance(value);}).catch(()=>{}),1800,{immediate:false});return()=>{active=false;stop();};},[id,maintenance?.enabled]);
 const saveMaintenance=async()=>{if(!asset||!maintenance)return;setBusy(true);setError('');try{const saved=await assetRequest<FileMaintenanceStatus>('/'+id+'/maintenance','PUT',{enabled:maintEnabled,conditions:maintConditions,...maintEnabled?{agentId:maintAgent,projectId:maintProject||null}:{},expectedRevision:maintenance.revision});setMaintenance(saved);setMaintEnabled(saved.enabled);setMaintAgent(saved.agentId??asset.owner.agentId??'');setMaintProject(saved.projectId??'');setMaintConditions(saved.conditions??'');setAsset(await assetRequest<Asset>('/'+id));await loadBindings();setNotice(t('已保存维护设置'));}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 const publish=async()=>{if(!asset)return;setBusy(true);setError('');try{
  if(!attempt.current){const r=await fetch('/api/v2/assets/uploads?name='+encodeURIComponent(version?.files[0]?.path??'document.md'),{method:'POST',body:draft});const stage=await r.json();if(!r.ok)throw new Error(stage.error);attempt.current={submissionId:stage.submissionId,key:crypto.randomUUID(),expectedHeadVersionId:asset.headVersionId,sourceVersions:version?.provenance.sourceVersions??[]};}
  const pending=attempt.current;const v=await assetRequest<AssetVersion>('/'+id+'/versions','POST',{submissionId:pending.submissionId,expectedHeadVersionId:pending.expectedHeadVersionId,provenance:{sourceVersions:pending.sourceVersions}},pending.key);
  history.replaceState(null,'',versionHref(v.id));attempt.current=null;setEditing(false);await load();setNotice(t('已发布新版本'));
 }catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 const feedbackAllowed=(value:TaskSource|null)=>Boolean(value&&version&&asset?.headVersionId===version.id&&version.downloads.length&&version.downloads.every(file=>file.availability==='managed_local')&&value.currentOutput&&value.run.state==='succeeded'&&['review','completed'].includes(value.task.state));
 const submitFeedback=async()=>{
  if(!version)return;setBusy(true);setError('');try{
   const current=await taskRequest<TaskSource|null>(sourcePath(version.id));setSource(current);
   if(!feedbackAllowed(current)||current?.task.revision!==source?.task.revision)throw new Error(t('当前版本来源未能验证；可查看记录，不提供任务反馈。'));
   const data={expectedRevision:current!.task.revision,expectedOutput:{assetId:id,versionId:version.id,runId:current!.run.id},reason:`v${version.ordinal} (${version.id}): ${feedback.trim()}`},body=JSON.stringify(data);
   if(feedbackCommand.current?.body!==body)feedbackCommand.current={body,key:crypto.randomUUID()};
   await taskRequest('/'+current!.task.id+'/'+(current!.task.state==='review'?'request_changes':'reopen'),'POST',data,feedbackCommand.current!.key);feedbackCommand.current=null;
   setSource(await taskRequest<TaskSource|null>(sourcePath(version.id)));setFeedback('');setNotice(t('已提交版本反馈'));
  }catch(e){setSource(null);if((e as {status?:number}).status===403){setVersion(null);setText('');setPreview(null);setDraft('');setLatestHead(null);setEditing(false);attempt.current=null;}setError((e as Error).message);}finally{setBusy(false);}
 };
 if(!asset)return <section className="asset-detail asset-reader"><nav className="asset-breadcrumb"><a className="ui-navigation-link" href={filesHref} onClick={follow}><Icon name="arrowLeft" size={16}/>{localize('返回资料库', 'Back to Library')}</a></nav>{error?<><p role="alert">{error==='forbidden'?t('来源不可访问，请检查使用范围。'):error}</p><Button onClick={()=>void load()}>{t('重试')}</Button></>:<LoadingState label={t('加载中…')}/>}</section>;
 const maintenanceError=maintenance?.lastCheck?.error;
 const budgetMessages={maintenance_summary_too_large:'记忆进展超过 12,000 个 UTF-16 字符；本次未调用模型。',maintenance_snapshot_too_large:'记忆进展及来源信息超过 128 KiB；本次未调用模型。',maintenance_prompt_too_large:'文件与记忆进展的单次输入超过 128 KiB；本次未调用模型。'} as const;
 const maintenanceErrorMessage=maintenanceError&&Object.hasOwn(budgetMessages,maintenanceError)?t(budgetMessages[maintenanceError as keyof typeof budgetMessages]):maintenanceError;
 const sourceProject=config.projects.find(p=>p.id===source?.task.projectId),sourceAgent=config.agents.find(a=>a.id===asset.owner.agentId);
 return <section className="asset-detail asset-reader" onClickCapture={event=>{if(locked&&event.target instanceof Element&&event.target.closest('a')){event.preventDefault();event.stopPropagation();}}}>

  <nav className="asset-breadcrumb"><a className="ui-navigation-link" href={filesHref} aria-disabled={locked||undefined} onClick={follow}><Icon name="arrowLeft" size={16}/>{localize('返回资料库', 'Back to Library')}</a></nav>
  <PageHeader title={asset.title} icon={asset.kind==='document'?'book':'file'} context={<span className="asset-reader-meta">{asset.kind==='document'?t('文档'):asset.kind==='file'?t('文件'):asset.kind} · {t(assetScopeLabels[asset.accessPolicy.mode])}</span>} actions={<><Select ariaLabel={t('固定版本')} value={version?.id??''} disabled={locked} onChange={value=>{history.replaceState(null,'',versionHref(value));setEditing(false);void openVersion(asset,value).catch(e=>setError(e.message));}} options={[{value:"",label:(t('尚未发布')),disabled:true},...versions.map(v=>({value:v.id,label:"v"+v.ordinal,description:new Date(v.createdAt).toLocaleString()}))]}/>{!reading&&!editing&&version&&preview&&version.downloads.some(file=>file.fileId===preview.fileId&&file.availability==='managed_local')&&<><a className="icon-button asset-reader-download" href={'/api/v2/assets/'+id+'/versions/'+version.id+'/files/'+preview.fileId} download={preview.name} aria-label={t('下载固定版本')} title={t('下载固定版本')}><Icon name="download" size={15}/></a><AssetLocalActions key={version.id+preview.fileId} assetId={id} versionId={version.id} file={version.downloads.find(file=>file.fileId===preview.fileId)!} compact/></>}<Button disabled={busy||editing} aria-expanded={settingsOpen} aria-controls="asset-settings-panel" onClick={()=>setSettingsOpen(v=>!v)}><Icon name="settings" size={15}/>{t('文件设置')}</Button>{editing?<><Button disabled={busy} onClick={()=>void publish()}>{t('发布新版本')}</Button><Button disabled={busy} onClick={()=>{setEditing(false);setDraft('');setLatestHead(null);attempt.current=null;setError('');}}>{t('取消编辑')}</Button></>:version&&preview&&version.downloads.length===1&&version.id===asset.headVersionId&&filePreviewKind(preview.name,preview.mediaType)==='text'&&preview.size<=1048576&&<Button disabled={busy||settingsDirty||!!feedback.trim()} onClick={()=>{setDraft(text);setEditing(true);}}>{t('编辑文件')}</Button>}</>}/>
  <section className="asset-content" aria-label={t('内容预览')}>
   {reading?<p>{t('加载中…')}</p>:error&&!editing&&!preview?<p>{t('加载失败')}</p>:editing?<><Textarea aria-label={t('文档正文')} value={draft} disabled={busy} onChange={e=>{setDraft(e.target.value);attempt.current=null;}}/></>:preview?<><AssetPreview key={version!.id+preview.fileId} file={preview} url={'/api/v2/assets/'+id+'/versions/'+version!.id+'/files/'+preview.fileId} text={text}/></>:version?<div className="asset-preview-unavailable"><AssetFileIcon name={version.downloads[0]?.name??asset.title} mediaType={version.downloads[0]?.mediaType} size={32}/><p>{version.downloads.some(file=>file.availability==='missing')?t('内容缺失，请从备份恢复。'):t('暂不支持此格式预览')}</p></div>:<p>{t('尚未发布')}</p>}
   {!reading&&!editing&&version&&version.downloads.filter(file=>file.availability==='managed_local'&&file.fileId!==preview?.fileId).map(file=><div className="asset-other-file" key={version.id+file.fileId}><Icon name="file" size={14}/><span title={file.name}>{file.name}</span><a className="icon-button" href={'/api/v2/assets/'+id+'/versions/'+version.id+'/files/'+file.fileId} download={file.name} aria-label={t('下载固定版本')+' · '+file.name} title={t('下载固定版本')}><Icon name="download" size={15}/></a><AssetLocalActions assetId={id} versionId={version.id} file={file} compact/></div>)}
  </section>
  {source&&<Disclosure className="asset-feedback" title={t('版本反馈')}>{feedbackAllowed(source)?<><label>{t('原因')}<Textarea value={feedback} onChange={e=>setFeedback(e.target.value)}/></label><Button disabled={busy||!feedback.trim()} onClick={()=>void submitFeedback()}>{t('提交版本反馈')}</Button><Button disabled={busy} onClick={()=>setFeedback('')}>{localize('取消', 'Cancel')}</Button></>:<p className="field-hint">{t('此版本不是任务当前交付，反馈请在来源任务查看。')}</p>}</Disclosure>}
  {asset.kind==='document'&&version&&<Disclosure title={localize('计划操作', 'Plan actions')}><AdoptPlan reference={{assetId:id,versionId:version.id}}/></Disclosure>}
  {settingsOpen&&<Dialog label={t('文件设置')} className="asset-settings-drawer" locked={busy} onClose={cancelSettings}>
   <header className="asset-settings-drawer-header"><div><h2>{t('文件设置')}</h2><p title={asset.title}>{asset.title}</p></div><Button variant="ghost" className="icon-button" aria-label={localize('关闭文件设置','Close file settings')} disabled={busy} onClick={cancelSettings}><Icon name="close" size={18}/></Button></header>
  <section className="asset-settings" id="asset-settings-panel"><DetailSection title={localize('使用权限', 'Access')} icon="user"><label>{t('使用范围')}<Select ariaLabel={t('使用范围')} value={policy.mode} onChange={value=>setPolicy({...policy,mode:value as KnowledgeAccess['mode']})} options={[...['owner','private','selected','all'].map(mode=>({value:mode,label:(t(assetScopeLabels[mode as KnowledgeAccess['mode']]))}))]}/></label>
   {policy.mode==='selected'&&<div>{config.agents.map(a=><label key={a.id}><Input type="checkbox" checked={policy.agentIds?.includes(a.id)??false} onChange={e=>setPolicy({...policy,agentIds:e.target.checked?[...(policy.agentIds??[]),a.id]:(policy.agentIds??[]).filter(id=>id!==a.id)})}/>{a.name}</label>)}{config.projects.map(p=><label key={p.id}><Input type="checkbox" checked={policy.projectIds?.includes(p.id)??false} onChange={e=>setPolicy({...policy,projectIds:e.target.checked?[...(policy.projectIds??[]),p.id]:(policy.projectIds??[]).filter(id=>id!==p.id)})}/>{p.name}</label>)}</div>}
   <Button disabled={busy} onClick={()=>{setBusy(true);void assetRequest<Asset>('/'+id+'/access','PUT',{policy,expectedRevision:asset.revision}).then(a=>{setAsset(a);setPolicy(a.accessPolicy);setNotice(t('已保存'));}).catch(e=>setError(e.message)).finally(()=>setBusy(false));}}>{t('保存使用范围')}</Button>
   </DetailSection><DetailSection title={localize('项目关联', 'Project association')} icon="project"><label>{t('关联项目')}<Select ariaLabel={t('关联项目')} value={project} onChange={value=>setProject(value)} options={[{value:"",label:(t('选择项目'))},...config.projects.map(p=>({value:p.id,label:(p.name),icon:<IdentityAvatar identity={p} kind="project" size={20}/>}))]}/></label><Button disabled={busy||!project||!version} onClick={()=>{setBusy(true);void assetRequest('/'+id+'/bindings','POST',{ownerType:'project',ownerId:project,versionPolicy:'pinned',versionId:version!.id}).then(async()=>{await loadBindings();setNotice(t('已关联项目'));setProject('');}).catch(e=>setError(e.message)).finally(()=>setBusy(false));}}>{t('关联项目')}</Button>
   <p>{t('关联不授予权限；移除关联不会删除资产。')}</p>
   </DetailSection><DetailSection title={t('持续维护')} icon="agent"><label><Input type="checkbox" checked={maintEnabled} disabled={busy||!maintenance} onChange={e=>setMaintEnabled(e.target.checked)}/>{t('持续维护')}</label>
   {maintEnabled&&<><label>{t('维护 Agent')}<Select ariaLabel={t('维护 Agent')} value={maintAgent} onChange={value=>{setMaintAgent(value);if(maintProject&&!config.projects.find(p=>p.id===maintProject)?.agentIds.includes(value))setMaintProject('');}} options={[{value:'',label:t('选择 Agent')},...config.agents.filter(a=>!asset.owner.agentId||a.id===asset.owner.agentId).map(a=>({value:a.id,label:a.name,icon:<IdentityAvatar identity={a} kind="agent" size={20}/>}))]}/></label>
    <label>{t('维护范围')}<Select ariaLabel={t('维护范围')} value={maintProject} onChange={setMaintProject} options={[{value:'',label:t('Agent 范围（含其项目对话）')},...config.projects.filter(p=>p.agentIds.includes(maintAgent)).map(p=>({value:p.id,label:p.name,description:t('指定项目'),icon:<IdentityAvatar identity={p} kind="project" size={20}/>}))]}/></label>
    <label>{localize('维护条件说明（可选）', 'Maintenance conditions (optional)')}<Textarea aria-label={localize('维护条件说明（可选）', 'Maintenance conditions (optional)')} rows={3} maxLength={4000} value={maintConditions} disabled={busy} onChange={e=>setMaintConditions(e.target.value)} placeholder={localize('例如：完成验收后更新验证章节；不修改其他计划。', 'For example: update the validation section only after acceptance.')}/></label>
    <p className="field-hint">{localize('留空时，仅根据已保存摘要中的相关新进展判断是否更新。', 'Leave empty to update only for relevant progress in a saved session summary.')}</p>
    <p className="field-hint">{t('启用后，所选 Agent 将成为此文件的归属 Agent，并使用最新版本关联。')}</p><p className="field-hint">{t('深层记忆加工完成后，仅有相关新进展才更新。无变化不产生版本；并发编辑不会被覆盖。')}</p>
   </>}
   <p className="field-hint">{t('支持仅归属方可用的单个 UTF-8 文本，最多 24,000 字符；维护 Agent 需使用已启用的 Codex 或 OMP。')}</p>
   <Button disabled={busy||!maintenance||maintEnabled&&!maintAgent} onClick={()=>void saveMaintenance()}>{t('保存维护设置')}</Button>
   {maintenance?.lastCheck&&<p role="status"><span>{t('最近维护检查')}</span> <span>{t(({pending:'等待检查',unchanged:'无变化',updated:'已更新',failed:'检查失败'} as const)[maintenance.lastCheck.state])}</span>{maintenanceErrorMessage&&<> <span title={maintenanceError??undefined}>{maintenanceErrorMessage}</span></>}{maintenance.lastCheck.versionId&&<> <a href={'/library/'+id+'?version='+encodeURIComponent(maintenance.lastCheck.versionId)} onClick={follow}>{t('查看更新版本')}</a></>}</p>}

   </DetailSection>
  </section>
   <footer className="asset-settings-drawer-footer">{notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error==='forbidden'?t('来源不可访问，请检查使用范围。'):error}</p>}<Button disabled={busy} onClick={cancelSettings}>{localize('取消设置', 'Cancel settings')}</Button></footer>
  </Dialog>}
  <Disclosure className="asset-provenance" title={t('来源与引用')}>
  <h3>{t('来源')}</h3>{origin?.conversationId&&<p><a href={'/?conversation='+encodeURIComponent(origin.conversationId)} onClick={follow}>{t('来源对话')}{origin.title&&<span className="asset-source-title">{origin.title}</span>}</a></p>}<p>{origin?.kind==='attachment'?t('对话附件'):origin?.kind==='agent_output'?t('Agent 输出'):source?t('Agent 输出'):version?.provenance.runId?t('当前版本来源未能验证；可查看记录，不提供任务反馈。'):t('手工导入')}</p>
  {source&&<><p><a href={'/tasks/'+source.task.id} onClick={follow}>{t('来源任务')}</a><span className="asset-source-title">{source.task.goal}</span></p>{source.run.routing?.destinationConversationId&&<p><a href={'/?conversation='+source.run.routing.destinationConversationId+'&project='+(source.task.projectId??'')} onClick={follow}>{t('来源对话')}</a></p>}{sourceProject&&<p><a className="asset-identity-link" href={'/projects/'+sourceProject.id+'/overview'} onClick={follow}>{sourceProject.name}</a></p>}{sourceAgent&&<p>{t('归属 Agent')} <a className="asset-identity-link" href={'/agents/'+encodeURIComponent(sourceAgent.id)} onClick={follow}>{sourceAgent.name}</a></p>}</>}
  {version?.provenance.runId&&<p>Run <code>{version.provenance.runId}</code></p>}{version?.provenance.sourceVersions.map(ref=><FixedOutput key={ref.versionId} reference={ref}/>)}
  <h3>{t('可用性')}</h3><p>{asset.kind==='external_reference'?t('需要执行主机在线；外部引用尚未接入。'):t('本地受管；下载需要本机服务在线。')}</p>
  {version?.downloads.map(file=><div className="asset-file" key={file.fileId}><p className="asset-file-name">{file.name}</p><p>{file.size.toLocaleString()} bytes</p><p>{t(file.availability==='missing'?'内容缺失，请从备份恢复。':'本地可用')}</p></div>)}
  <h3>{t('配置引用')}</h3><p className="field-hint">{t('已保存引用，不代表本轮实际采用。')}</p>{bindings.map(binding=><p key={binding.ownerType+binding.ownerId}>{binding.ownerType==='project'?<a className="asset-identity-link" onClick={follow} href={'/projects/'+binding.ownerId+'/overview'}>{config.projects.find(p=>p.id===binding.ownerId)?.name??binding.ownerId}</a>:<a className="asset-identity-link" onClick={follow} href={'/agents/'+encodeURIComponent(binding.ownerId)}>{config.agents.find(a=>a.id===binding.ownerId)?.name??binding.ownerId}</a>} <span className="asset-binding-version">{binding.versionPolicy==='pinned'?<a href={versionHref(binding.versionId!)} onClick={follow}>{t('固定版本')}</a>:t('最新版本')}</span></p>)}
  <Disclosure className="asset-diagnostics" title={<> {t('诊断信息')} </>}><code>{asset.id}</code><p>{version?.id}</p>{version?.files.map(file=><p key={file.path}><span className="asset-source-title">{file.path}</span><code>{file.blobHash}</code></p>)}</Disclosure></Disclosure>

  {!settingsOpen&&notice&&<p role="status">{notice}</p>}{!settingsOpen&&error&&<div role="alert"><p>{error==='forbidden'?t('来源不可访问，请检查使用范围。'):error}</p>{editing?<><Button disabled={busy} onClick={()=>void readLatest()}>{localize('读取最新版本', 'Read latest version')}</Button><p>{localize('当前输入已保留，请先比较最新版本再发布。', 'Your input is preserved. Compare the latest version before publishing again.')}</p></>:<Button disabled={locked} onClick={()=>void load()}>{t('重试')}</Button>}</div>}
  {latestHead&&editing&&<DetailSection title={localize('最新已保存版本', 'Latest saved version')} icon="file"><div className="asset-latest-preview"><pre>{latestHead.text}</pre></div><Button disabled={busy} onClick={()=>{setAsset(latestHead.asset);setVersion(latestHead.version);attempt.current=null;setLatestHead(null);setError('');}}>{localize('保留输入并以此版本为基础', 'Keep my draft and use this version as the base')}</Button></DetailSection>}
 </section>;
}
