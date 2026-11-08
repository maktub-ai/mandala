import { useEffect, useState } from 'react';
import { requestJson } from './api';
import { useLanguage } from './i18n';
import Button from './ui/Button';
import Icon from './ui/Icon';
import './file-preview.css';

export default function LocalFileActions({url,body,compact=false}:{url:string;body:{href:string}|{path:string};compact?:boolean}){
 const {text:label,errorText}=useLanguage(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[opened,setOpened]=useState(false);
 const name=label('用默认应用打开','Open in default app');
 useEffect(()=>{if(!compact||!opened)return;const timer=setTimeout(()=>setOpened(false),2500);return()=>clearTimeout(timer);},[compact,opened]);
 return <div className="local-file-actions" data-compact={compact||undefined}><Button busy={busy} variant={compact?'ghost':undefined} className={compact?'icon-button':undefined} aria-label={compact?name:undefined} title={compact?name:undefined} onClick={async()=>{
  setBusy(true);setError('');setOpened(false);
  try{await requestJson(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});setOpened(true);}
  catch(error){setError(errorText((error as Error).message));}finally{setBusy(false);}
 }}><Icon name="external-link" size={15}/>{!compact&&name}</Button>
 {opened&&<span role="status">{label('已用默认应用打开','Opened in default app')}</span>}{error&&<span role="alert">{error}</span>}
 </div>;
}
