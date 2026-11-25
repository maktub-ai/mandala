import {useEffect,useRef,useState} from 'react';
import {api} from './api';
import {useLanguage} from './i18n';
import {voiceModels,voiceLanguages,type VoiceStatus,type VoiceSettings as Settings} from '../shared/voice';
import Button from './ui/Button';
import Input from './ui/Input';
import Select from './ui/Select';
import Notice from './ui/Notice';
import Icon from './ui/Icon';
import {SettingsGroup,SettingRow,SettingSwitch} from './ui/SettingsLayout';
import './voice.css';

type Editable=Omit<Settings,'hasApiKey'>;

/** Voice input settings. Choices save as soon as they change; the API key and model downloads are explicit actions. */
export default function VoiceSettings(){
 const {text:l}=useLanguage();
 const [status,setStatus]=useState<VoiceStatus>(),[key,setKey]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[savedNote,setSavedNote]=useState(false);
 const alive=useRef(true);
 useEffect(()=>{alive.current=true;const controller=new AbortController();void api<VoiceStatus>('/voice','GET',undefined,controller.signal).then(setStatus).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>{alive.current=false;controller.abort();};},[]);
 const downloading=status?.models.some(model=>model.downloading);
 useEffect(()=>{if(!downloading)return;const controller=new AbortController();const timer=setInterval(()=>{void api<VoiceStatus>('/voice','GET',undefined,controller.signal).then(setStatus).catch(e=>{if(!controller.signal.aborted)setError(e.message);});},1000);return()=>{clearInterval(timer);controller.abort();};},[downloading]);
 async function action(run:()=>Promise<VoiceStatus>,saved=false){
  setBusy(true);setError('');setSavedNote(false);
  try{const result=await run();if(!alive.current)return;setStatus(result);if(saved){setSavedNote(true);window.dispatchEvent(new Event('mandala:voice-settings'));}}
  catch(e){if(!alive.current)return;setError((e as Error).message);if(saved)void api<VoiceStatus>('/voice').then(value=>{if(alive.current)setStatus(value);}).catch(()=>{});}finally{if(alive.current)setBusy(false);}
 }
 const save=(change:Partial<Editable>&{apiKey?:string})=>{
  if(status)setStatus({...status,settings:{...status.settings,...change,hasApiKey:change.apiKey===undefined?status.settings.hasApiKey:!!change.apiKey}});
  void action(()=>api('/voice','PUT',change),true);
 };
 const settings=status?.settings;
 return <>
  <SettingsGroup title={l('语音输入','Voice input')} label={l('语音输入','Voice input')} scope={l('仅这台设备','This device only')}
   actions={busy?<span className="settings-autosave" role="status"><Icon name="refresh" size={15}/>{l('保存中…','Saving…')}</span>:savedNote?<span className="settings-autosave" role="status"><Icon name="circleCheck" size={15}/>{l('已保存','Saved')}</span>:undefined}>
   {error&&<Notice>{error}</Notice>}
   {!settings?<p className="field-hint">{l('正在读取语音设置…','Loading voice settings…')}</p>:<>
    <SettingSwitch label={l('启用语音输入','Enable voice input')} hint={l('将语音转成可编辑草稿，由你确认发送。每次最多 2 分钟。','Dictate an editable draft, then send it yourself. Up to 2 minutes per recording.')} checked={settings.enabled} disabled={busy} onChange={enabled=>save({enabled})}/>
    <SettingRow label={l('识别方式','Transcription')} hint={settings.provider==='local'?l('在本机识别，不上传录音。','Transcribed on this computer; audio is never uploaded.'):l('录音会发送至 OpenAI，按其 API 价格计费。','Audio is sent to OpenAI and billed at its API rates.')}>
     <Select ariaLabel={l('识别方式','Transcription')} value={settings.provider} disabled={busy} searchable={false} options={[{value:'local',label:l('本地 · 离线','Local · Offline')},{value:'openai',label:'OpenAI · '+l('云端','Cloud')}]} onChange={value=>save({provider:value as Settings['provider']})}/>
    </SettingRow>
    <SettingRow label={l('识别语言','Language')}>
     <Select ariaLabel={l('识别语言','Language')} value={settings.language} disabled={busy} searchable={false} options={voiceLanguages.map(value=>({value,label:({auto:l('自动识别','Automatic'),zh:'中文',en:'English',ja:'日本語',ko:'한국어',fr:'Français',de:'Deutsch',es:'Español'})[value]}))} onChange={value=>save({language:value})}/>
    </SettingRow>
   </>}
  </SettingsGroup>
  {settings?.provider==='local'&&<SettingsGroup title={l('识别模型','Transcription model')} description={l('两档都支持中文和多语言。下载需要连接 Hugging Face。','Both support Chinese and multiple languages. Downloads connect to Hugging Face.')}>
   <div className="voice-models" role="radiogroup" aria-label={l('识别模型','Transcription model')}>{voiceModels.map((model,index)=>{const state=status?.models.find(item=>item.id===model.id),selected=settings.localModel===model.id;return <div className="setting-resource voice-model" data-selected={selected} key={model.id}>
    <label><Input type="radio" name="voice-model" checked={selected} disabled={busy} onChange={()=>save({localModel:model.id})}/><span className="setting-resource-text"><strong>{model.name} <small>· {index===0?l('轻量','Lightweight'):l('标准','Standard')}</small></strong><span>{Math.round(model.bytes/1e6)} MB · {state?.installed?l('已下载','Downloaded'):l('未下载','Not downloaded')}</span></span></label>
    <div className="setting-resource-actions">
     {selected&&state?.installed&&<span className="setting-resource-current">{l('使用中','In use')}</span>}
     {state?.downloading?<><progress aria-label={model.name} value={state.downloaded} max={model.bytes}/><Button disabled={busy} onClick={()=>void action(()=>api('/voice/models/'+model.id,'DELETE'))}>{l('取消下载','Cancel download')}</Button></>
      :state?.installed?<Button variant="ghost" disabled={busy} onClick={()=>void action(()=>api('/voice/models/'+model.id,'DELETE'))}>{l('删除模型','Remove model')}</Button>
      :<Button disabled={busy} onClick={()=>void action(()=>api('/voice/models/'+model.id,'POST'))}>{l('下载模型','Download model')}</Button>}
    </div>
    {state?.error&&<Notice>{l('下载失败，请检查网络后重试。','Download failed. Check your connection and retry.')}</Notice>}
   </div>;})}</div>
  </SettingsGroup>}
  {settings?.provider==='openai'&&<SettingsGroup title="OpenAI" description={l('API Key 仅保存在本机私有配置文件中，不写入对话。转写模型：gpt-transcribe。','The key stays in a private configuration file on this computer, outside conversations. Transcription model: gpt-transcribe.')}>
   <SettingRow stacked label="OpenAI API Key" htmlFor="voice-api-key" hint={settings.hasApiKey?l('已配置；填写新密钥可替换。','Configured; enter a new key to replace it.'):l('填写具有音频转写权限的 API Key。','Enter an API key with audio transcription access.')}>
    <form className="setting-inline-form" onSubmit={event=>{event.preventDefault();if(key.trim()){save({apiKey:key.trim()});setKey('');}}}>
     <Input id="voice-api-key" type="password" autoComplete="off" value={key} disabled={busy} onChange={e=>setKey(e.target.value)}/>
     <Button type="submit" disabled={busy||!key.trim()}>{l('保存密钥','Save key')}</Button>
     {settings.hasApiKey&&<Button variant="ghost" disabled={busy} onClick={()=>save({apiKey:''})}>{l('删除已保存的 API Key','Remove saved API key')}</Button>}
    </form>
   </SettingRow>
  </SettingsGroup>}
 </>;
}
