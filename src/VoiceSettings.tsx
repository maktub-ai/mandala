import {useEffect,useState} from 'react';
import {api} from './api';
import {useLanguage} from './i18n';
import {voiceModels,voiceLanguages,type VoiceStatus,type VoiceSettings as Settings} from '../shared/voice';
import Button from './ui/Button';
import Input from './ui/Input';
import Select from './ui/Select';
import Field from './ui/Field';
import Notice from './ui/Notice';
import './voice.css';

export default function VoiceSettings(){
 const {text:l}=useLanguage();
 const [status,setStatus]=useState<VoiceStatus>(),[draft,setDraft]=useState<Settings>(),[key,setKey]=useState(''),[removeKey,setRemoveKey]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false);
 useEffect(()=>{const controller=new AbortController();void api<VoiceStatus>('/voice','GET',undefined,controller.signal).then(value=>{setStatus(value);setDraft(value.settings);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>controller.abort();},[]);
 const downloading=status?.models.some(model=>model.downloading);
 useEffect(()=>{if(!downloading)return;const controller=new AbortController();const timer=setInterval(()=>{void api<VoiceStatus>('/voice','GET',undefined,controller.signal).then(setStatus).catch(e=>{if(!controller.signal.aborted)setError(e.message);});},1000);return()=>{clearInterval(timer);controller.abort();};},[downloading]);
 const patch=(value:Partial<Settings>)=>{setDraft(d=>({...d!,...value}));setSaved(false);};
 async function action(run:()=>Promise<VoiceStatus>,saving=false){setBusy(true);setError('');setSaved(false);try{const result=await run();setStatus(result);if(saving){setDraft(result.settings);setKey('');setRemoveKey(false);setSaved(true);window.dispatchEvent(new Event('mandala:voice-settings'));}}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <section className="settings-card voice-settings" aria-label={l('语音输入','Voice input')}>
  <h2>{l('语音输入','Voice input')}</h2>
  <p className="field-hint">{l('将语音转成可编辑草稿，由你确认发送。每次最多 2 分钟。','Dictate an editable draft, then send it yourself. Up to 2 minutes per recording.')}</p>
  {error&&<Notice>{error}</Notice>}
  {!draft?<p>{l('正在读取语音设置…','Loading voice settings…')}</p>:<>
   <label className="voice-enable"><Input type="checkbox" checked={draft.enabled} disabled={busy} onChange={e=>patch({enabled:e.target.checked})}/>{l('启用语音输入','Enable voice input')}</label>
   <div className="voice-settings-fields">
    <Field label={l('识别方式','Transcription')}><Select ariaLabel={l('识别方式','Transcription')} value={draft.provider} disabled={busy} searchable={false} options={[{value:'local',label:l('本地 · 离线','Local · Offline')},{value:'openai',label:'OpenAI · '+l('云端','Cloud')}]} onChange={value=>patch({provider:value as Settings['provider']})}/></Field>
    <Field label={l('识别语言','Language')}><Select ariaLabel={l('识别语言','Language')} value={draft.language} disabled={busy} searchable={false} options={voiceLanguages.map(value=>({value,label:({auto:l('自动识别','Automatic'),zh:'中文',en:'English',ja:'日本語',ko:'한국어',fr:'Français',de:'Deutsch',es:'Español'})[value]}))} onChange={value=>patch({language:value})}/></Field>
   </div>
   {draft.provider==='local'?<>
    <p className="field-hint">{l('模型由你选择下载；识别在本机完成，不上传录音。两档都支持中文和多语言。下载需要连接 Hugging Face。','Download a model to transcribe on this computer without uploading audio. Both support Chinese and multiple languages. Downloads connect to Hugging Face.')}</p>
    <div className="voice-models">{voiceModels.map((model,index)=>{const state=status?.models.find(item=>item.id===model.id);return <div className="voice-model" key={model.id}>
     <label><Input type="radio" name="voice-model" checked={draft.localModel===model.id} disabled={busy} onChange={()=>patch({localModel:model.id})}/><span>{index===0?l('轻量','Lightweight'):l('标准','Standard')} · {model.name}<small>{Math.round(model.bytes/1e6)} MB · {state?.installed?l('已下载','Downloaded'):l('未下载','Not downloaded')}</small></span></label>
     {state?.downloading?<><progress aria-label={model.name} value={state.downloaded} max={model.bytes}/><Button disabled={busy} onClick={()=>void action(()=>api('/voice/models/'+model.id,'DELETE'))}>{l('取消下载','Cancel download')}</Button></>:<Button disabled={busy} onClick={()=>void action(()=>api('/voice/models/'+model.id,state?.installed?'DELETE':'POST'))}>{state?.installed?l('删除模型','Remove model'):l('下载模型','Download model')}</Button>}
     {state?.error&&<Notice>{l('下载失败，请检查网络后重试。','Download failed. Check your connection and retry.')}</Notice>}
    </div>;})}</div>
   </>:<>
    <p className="field-hint">{l('录音会发送至 OpenAI，按其 API 价格计费。API Key 仅保存在本机私有配置文件中，不写入对话。','Audio is sent to OpenAI and billed at its API rates. The key stays in a private configuration file on this computer, outside conversations.')}</p>
    <Field label="OpenAI API Key" hint={status?.settings.hasApiKey?l('已配置；留空保留原密钥。','Configured; leave blank to keep the saved key.'):l('填写具有音频转写权限的 API Key。','Enter an API key with audio transcription access.')}><Input type="password" autoComplete="off" value={key} disabled={busy} onChange={e=>{setKey(e.target.value);setRemoveKey(false);setSaved(false);}}/></Field>
    {status?.settings.hasApiKey&&<label className="voice-enable"><Input type="checkbox" checked={removeKey} disabled={busy} onChange={e=>{setRemoveKey(e.target.checked);setSaved(false);}}/>{l('删除已保存的 API Key','Remove saved API key')}</label>}
    <p className="field-hint">{l('转写模型','Transcription model')}: gpt-transcribe</p>
   </>}
   <div className="voice-actions"><Button className="primary" disabled={busy} onClick={()=>void action(()=>{const {hasApiKey,...settings}=draft;return api('/voice','PUT',{...settings,...removeKey?{apiKey:''}:key?{apiKey:key.trim()}:{}});},true)}>{l('保存语音设置','Save voice settings')}</Button>{saved&&<span role="status">{l('已保存','Saved')}</span>}</div>
  </>}
 </section>;
}
