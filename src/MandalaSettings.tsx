import { useEffect, useState } from 'react';
import type { Cli, Config, ModelChoice } from '../shared/types';
import { enabledRuntimes, runtimeLabel } from '../shared/runtimes';
import { api } from './api';
import Dialog from './Dialog';
import Button from './ui/Button';
import Field from './ui/Field';
import Input from './ui/Input';
import Textarea from './ui/Textarea';
import Select from './ui/Select';
import LoadingState from './ui/LoadingState';
import BrandMark from './ui/BrandMark';
import ModelCatalogPicker, { type ModelCatalog } from './ModelCatalogPicker';
import { useLanguage } from './i18n';
import PetSettings from './PetSettings';
import TelegramSettings from './TelegramSettings';
import './mandala.css';

export default function MandalaSettings({ onClose, onSaved }: {onClose:()=>void; onSaved:(config:Config,revision:string)=>void}) {
  const {text: localize}=useLanguage(), say=(zh:string,en:string)=>localize(zh, en);
  const [loaded,setLoaded]=useState<{config:Config;revision:string}>();
  const [name,setName]=useState(''),[soul,setSoul]=useState(''),[cli,setCli]=useState<Cli | ''>(''),[maxParallel,setMaxParallel]=useState('3');
  const [models,setModels]=useState<Config['agents'][number]['models']>({});
  const [catalog,setCatalog]=useState<ModelCatalog>({choices:[],loading:true,error:''});
  const [catalogRefresh,refreshCatalog]=useState(0);
  const [error,setError]=useState(''),[saving,setSaving]=useState(false);
  const load=()=>{setError('');void api<{config:Config;revision:string}>('/config').then(result=>{
    const agent=result.config.agents.find(a=>a.id===result.config.mandala?.agentId)!;
    setLoaded(result);setName(agent.name);setSoul(result.config.mandala!.soul);setCli(agent.defaultCli);setModels(agent.models);setMaxParallel(String(result.config.mandala!.maxParallel));
  }).catch(reason=>setError(reason.message));};
  useEffect(load,[]);
  useEffect(()=>{
    if(!loaded || !cli)return;
    let active=true;
    setCatalog({choices:[],loading:true,error:''});
    void api<ModelChoice[]>('/models?'+new URLSearchParams({cli,agentId:loaded.config.mandala!.agentId}))
      .then(choices=>{if(active)setCatalog({choices,loading:false,error:''});})
      .catch(reason=>{if(active)setCatalog({choices:[],loading:false,error:reason.message});});
    return()=>{active=false;};
  },[loaded,cli,catalogRefresh]);
  const save=async()=>{
    if(!loaded || !cli)return;setSaving(true);setError('');
    try{const result=await api<{config:Config;revision:string}>('/mandala','PUT',{revision:loaded.revision,settings:{name,soul,cli,models,maxParallel:Number(maxParallel)}});onSaved(result.config,result.revision);onClose();}
    catch(reason){setError((reason as Error).message);}finally{setSaving(false);}
  };
  return <Dialog label={say('Mandala 设置','Mandala settings')} onClose={onClose} locked={saving} className="mandala-settings">
    <div className="mandala-settings-heading"><BrandMark/><h2>{say('Mandala 设置','Mandala settings')}</h2></div>
    {error&&<div role="alert">{error}<Button disabled={saving} onClick={load}>{say('重新读取','Reload')}</Button></div>}
    {!loaded&&!error&&<LoadingState label={say('正在读取设置…','Loading settings…')}/>}
    {loaded&&<TelegramSettings/>}
    {loaded&&<PetSettings onBrowse={()=>{onClose();history.pushState(null,'','/market?source=mandala-pets');dispatchEvent(new PopStateEvent('popstate'));}}/>}
    {loaded&&<form onSubmit={event=>{event.preventDefault();void save();}}>
      <div><strong>{say('系统角色','System role')}</strong><p className="field-hint">{say('了解全局任务，协调项目与智能体，也可独立执行工作。系统智能体不属于项目成员；主对话用于协调，普通对话可以执行项目工作。','Understand workspace tasks, coordinate Projects and Agents, and execute work independently. The system Agent is not a Project member. The main chat coordinates; ordinary chats can execute Project work.')}</p></div>
      <Field label={say('名字','Name')}><Input value={name} maxLength={100} required disabled={saving} onChange={event=>setName(event.target.value)}/></Field>
      <Field label="soul.md" hint={say('性格、表达与协作偏好。系统规则和权限始终生效。','Personality, expression and collaboration preferences. System rules and permissions always apply.')}><Textarea rows={7} value={soul} maxLength={30000} disabled={saving} onChange={event=>setSoul(event.target.value)}/></Field>
      <Field label="Runtime" hint={say('Runtime 和模型从下一轮主对话生效；正在执行的工作保持当前设置。','Runtime and model apply to the next main-chat turn; active work keeps its current settings.')}><Select ariaLabel="Runtime" value={cli} disabled={saving} onChange={value=>setCli(value as Cli)} options={enabledRuntimes(loaded.config).map(value=>({value,label:runtimeLabel(value)}))}/></Field>
      <div className="system-model-field"><span>{say('模型','Model')}</span><ModelCatalogPicker ariaLabel={say('模型','Model')} catalog={catalog} value={cli?models[cli]??'':''} disabled={saving||!cli}
        onChange={value=>setModels(current=>({...current,[cli]:value}))} onRefresh={()=>refreshCatalog(value=>value+1)}/></div>
      <Field label={say('后台总并行上限','Background concurrency limit')} hint={say('主聊天不占用后台名额。','The main chat does not use a background slot.')}><Input type="number" min={1} required value={maxParallel} disabled={saving} onChange={event=>setMaxParallel(event.target.value)}/></Field>
      <p className="field-hint">{say('工作区、工具与规则由系统维护。','Workspace, tools and rules are managed by the system.')}</p>
      <div className="mandala-settings-actions"><Button disabled={saving} onClick={onClose}>{say('取消','Cancel')}</Button><Button variant="primary" type="submit" busy={saving} disabled={!name.trim()}>{say('保存','Save')}</Button></div>
    </form>}
  </Dialog>;
}
