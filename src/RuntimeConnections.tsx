import Button from './ui/Button';
import { runtimeLabel, runtimeIds, runtimeCatalog } from '../shared/runtimes';
import { useEffect, useState } from 'react';
import type { Cli, CliStatus, RuntimeConfig } from '../shared/types';
import { api } from './api';
import { useLanguage } from './i18n';
import Icon from './ui/Icon';
import RuntimeIcon from './ui/RuntimeIcon';
import StatusLabel from './ui/StatusLabel';
import RuntimeEvidenceBadge from './RuntimeEvidenceBadge';

export default function RuntimeConnections({ enabled, defaults, refreshKey, onRefresh, onNavigate }: {
 enabled:Cli[];defaults?:RuntimeConfig;refreshKey:number;onRefresh:()=>void;onNavigate:(path:string)=>void;
}) {
 const {text: localize, t}=useLanguage(),say=(zh:string,en:string)=>localize(zh, en);
 const [statuses,setStatuses]=useState<Partial<Record<Cli,CliStatus>>>({});
 const [scanDisabled,setScanDisabled]=useState(0);
 const [launchers,setLaunchers]=useState<Partial<Record<Cli,NonNullable<CliStatus['diagnostics']>['executable']>>>({});
 const signature=JSON.stringify([enabled,defaults]);
 useEffect(()=>{let active=true;setStatuses({});for(const cli of enabled)void api<CliStatus>('/cli/status?scope=runtime&explain=1&cli='+cli).then(status=>{if(active)setStatuses(value=>({...value,[cli]:status}));}).catch(()=>{if(active)setStatuses(value=>({...value,[cli]:{status:'unavailable',version:null}}));});return()=>{active=false;};},[signature,refreshKey]);
 useEffect(()=>{
  if(!scanDisabled)return;
  let active=true;
  setLaunchers({});
  for(const cli of runtimeIds.filter(cli=>!enabled.includes(cli)))void api<Pick<NonNullable<CliStatus['diagnostics']>,'executable'>>('/cli/launcher?cli='+cli)
   .then(({executable})=>{if(active)setLaunchers(value=>({...value,[cli]:executable}));})
   .catch(()=>{if(active)setLaunchers(value=>({...value,[cli]:'not-verified'}));});
  return()=>{active=false;};
 },[signature,scanDisabled]);
 const launcherLabel=(cli:Cli)=>{
  if(!scanDisabled)return undefined;
  switch(launchers[cli]){
   case 'executable':return say('已找到启动命令','Launcher found');
   case 'missing':return say('未找到启动命令','Launcher not found');
   case 'broken':case 'blocked':return say('启动命令不可执行','Launcher is not executable');
   case 'not-verified':return say('未能检测启动命令','Launcher could not be checked');
   default:return t('正在检测…');
  }
 };
 return <div className="runtime-connections"><div className="settings-section-title"><p className="field-hint">{say('选择并配置原生 CLI。已启用的执行端检查账户、连接或版本；未启用的只检查启动命令。检测不会运行任务，也不验证模型权限或额度。','Choose and configure a native CLI. Checks for enabled CLIs look at the account, connection or version. For disabled CLIs, only the launcher is checked. Checks do not run a task or verify model access or quota.')}</p><div className="runtime-actions"><Button type="button" onClick={()=>{setScanDisabled(value=>value+1);onRefresh();}}><Icon name="refresh" size={15}/>{t('重新检测')}</Button><Button type="button" className="primary" onClick={()=>onNavigate('/settings/runtimes/new')}><Icon name="plus" size={15}/>{say('新增 CLI','Add CLI')}</Button></div></div>
 <div className="runtime-connection-rows">{runtimeIds.map(cli=>{const active=enabled.includes(cli),status=statuses[cli];return <section key={cli} className="runtime-connection" aria-label={runtimeLabel(cli)}><div className="runtime-connection-identity"><RuntimeIcon cli={cli} size={20}/><div><h2>{runtimeLabel(cli)}</h2><code>{runtimeCatalog[cli].command}</code></div></div><div className="runtime-connection-status" role="status">{active&&status?<RuntimeEvidenceBadge status={status}/>:<StatusLabel icon={active?'refresh':'clock'}>{active?t('正在检测…'):say('未启用','Not enabled')}</StatusLabel>}{active&&(status?.diagnostics?.nativeVersion??status?.version)&&<code>{status?.diagnostics?.nativeVersion??status?.version}</code>}{!active&&<small>{launcherLabel(cli)}</small>}</div><Button type="button" data-runtime-configure={cli} onClick={()=>onNavigate(active?'/settings/runtimes/'+cli:'/settings/runtimes/new?runtime='+cli)}>{active?t('配置'):say('设置','Set up')}</Button></section>;})}</div>
 </div>;
}
