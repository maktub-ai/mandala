import { useState, type ReactNode } from 'react';
import Button from './ui/Button';
import { useLanguage } from './i18n';
import './file-preview.css';

export default function HtmlPreview({name,url,source}:{name:string;url:string;source:ReactNode}){
 const {text:label}=useLanguage(),[showSource,setShowSource]=useState(false);
 return <div className="html-preview">
  <div className="html-preview-toolbar"><Button aria-pressed={showSource} onClick={()=>setShowSource(value=>!value)}>{showSource?label('预览','Preview'):label('查看源码','View source')}</Button></div>
  {showSource?source:<iframe title={name} src={url} sandbox="allow-scripts" referrerPolicy="no-referrer"/>}
 </div>;
}
