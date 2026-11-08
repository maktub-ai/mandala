import Input from './ui/Input';
import Button from './ui/Button';
import { useEffect, useRef, useState } from 'react';
import type { CodeGraphSettings, CodeGraphStatus } from '../shared/code-graph';
import { api } from './api';
import { useLanguage } from './i18n';
import Select from './ui/Select';
import LoadingState from './ui/LoadingState';
export default function CodeGraphBinding({ projectId, workspaceId, bindingId, settings, remote=false, onChange }: {
 projectId:string; workspaceId:string; bindingId:string; settings?:CodeGraphSettings; remote?:boolean; onChange:(settings:CodeGraphSettings)=>void;
}) {
 const {t,errorText}=useLanguage(),[status,setStatus]=useState<CodeGraphStatus>(),[error,setError]=useState(''),[refreshing,setRefreshing]=useState(false);
 const value=settings??{enabled:false,scope:'directory'},path=`/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/code-graph`;
 const identity=useRef('');identity.current=path+'/'+bindingId+'/'+value.enabled+'/'+value.scope;
 useEffect(()=>{
  let active=true,busy=false;setStatus(undefined);setError('');setRefreshing(false);
  const load=async()=>{if(busy||document.hidden)return;busy=true;try{const rows=await api<CodeGraphStatus[]>(path);if(active){setStatus(rows.find(row=>row.bindingId===bindingId));setError('');}}catch(e){if(active)setError(e instanceof Error?e.message:String(e));}finally{busy=false;}};
  void load();const timer=setInterval(()=>void load(),3000);return()=>{active=false;clearInterval(timer);};
 },[path,bindingId,value.enabled,value.scope]);
 const names={disabled:'未启用',missing:'目录不存在','not-checked-out':'远程引用尚未检出',unsupported:'暂无支持的 TS / JS 代码',pending:'等待建立索引',indexing:'正在建立索引',ready:'索引可用',stale:'源码已变化，等待同步',error:'索引失败，请刷新重试'} as const;
 return <div className="code-graph-binding">
  <label className="workspace-clone-default"><Input type="checkbox" aria-label={t('启用代码索引')} checked={value.enabled&&!remote} disabled={remote} onChange={e=>onChange({...value,enabled:e.target.checked})}/>{t('代码索引')}</label>
  {!remote&&<label>{t('索引范围')}<Select ariaLabel={t('索引范围')} value={value.scope} searchable={false} onChange={scope=>onChange({...value,scope:scope as CodeGraphSettings['scope']})} options={[{value:'directory',label:t('所选目录')},{value:'repository',label:t('整个仓库'),disabled:!status?.repositoryRoot,description:status?.repositoryRoot??t('未检测到 Git 仓库')}]} /></label>}
  <div className="code-graph-status" aria-live="polite">{!remote&&!status?<LoadingState label={t('读取索引状态…')} rows={1}/>:<span>{remote?t('远程引用尚未检出'):status&&t(names[status.status])}</span>}
   {status?.root&&<span className="field-hint">{t('实际索引范围')}：<code>{status.root}</code></span>}
   {status?.status==='ready'&&<span className="field-hint">{status.files} {t('文件')} · {status.nodes} {t('符号')} · {t('快照')} {status.snapshot?.slice(0,8)}</span>}
  </div>
  {value.enabled&&!remote&&<Button type="button" disabled={refreshing} onClick={async()=>{const request=identity.current;setRefreshing(true);setError('');try{const result=await api<CodeGraphStatus>(path+'/refresh','POST',{bindingId});if(identity.current===request)setStatus(result);}catch(e){if(identity.current===request)setError(e instanceof Error?e.message:String(e));}finally{if(identity.current===request)setRefreshing(false);}}}>{t(refreshing?'刷新中…':'刷新索引')}</Button>}
  {value.scope==='repository'&&status?.repositoryRoot&&<p className="field-hint">{t('此绑定将读取整个仓库')}：<code>{status.repositoryRoot}</code></p>}
  {error&&<p className="form-error" role="alert">{errorText(error)}</p>}
 </div>;
}
