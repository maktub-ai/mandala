import {useEffect,useRef,useState} from 'react';
import type {TelegramTaskStatus} from '../shared/telegram';
import {telegramRequest} from './telegram-api';
import {useLanguage} from './i18n';
import Input from './ui/Input';
import Button from './ui/Button';
import './telegram.css';

export default function TelegramTaskNotification({taskId,disabled=false}:{taskId:string;disabled?:boolean}){
 const {text:t}=useLanguage(),[state,setState]=useState<TelegramTaskStatus>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const generation=useRef(0),working=useRef(false),invalidated=useRef(false),mounted=useRef(true);
 useEffect(()=>{
  let active=true;mounted.current=true;
  const load=()=>{const version=++generation.current;if(working.current){invalidated.current=true;setState(undefined);return;}void telegramRequest<TelegramTaskStatus>('/tasks/'+encodeURIComponent(taskId)).then(value=>{if(active&&version===generation.current){setState(value);setError('');}}).catch(()=>{if(active&&version===generation.current)setState(undefined);});};
  setState(undefined);setError('');load();window.addEventListener('mandala-telegram-changed',load);
  return()=>{active=false;mounted.current=false;generation.current++;window.removeEventListener('mandala-telegram-changed',load);};
 },[taskId]);
 const update=async(enabled:boolean)=>{
  if(working.current)return;working.current=true;invalidated.current=false;setBusy(true);setError('');const version=++generation.current;let succeeded=false;
  try{const value=await telegramRequest<TelegramTaskStatus>('/tasks/'+encodeURIComponent(taskId),'PUT',{enabled});succeeded=true;if(version===generation.current)setState(value);}
  catch(reason){if(version===generation.current)setError((reason as Error).message);}
  finally{working.current=false;if(mounted.current)setBusy(false);if(succeeded||invalidated.current)window.dispatchEvent(new Event('mandala-telegram-changed'));}
 };
 if(!state?.available)return null;
 return <div className="telegram-task-notification"><label className="telegram-option"><Input type="checkbox" checked={state.enabled} disabled={disabled||busy||state.automatic} onChange={event=>void update(event.target.checked)}/><span>{t('完成后通知手机','Notify my phone on completion')}</span></label>{state.automatic&&<span className="form-note">{t('手机发起的任务会自动回复','Phone-origin tasks reply automatically')}</span>}{error&&<span role="alert" className="form-error">{error} <Button disabled={busy} onClick={()=>void update(!state.enabled)}>{t('重试','Retry')}</Button></span>}</div>;
}
