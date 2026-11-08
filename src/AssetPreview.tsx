import Button from './ui/Button';
import { lazy, Suspense, useEffect, useState } from 'react';
import type { AssetFile } from '../shared/assets';
import { filePreviewKind, fileMediaType } from '../shared/file-types';
import { assetRequest } from './AssetLibrary';
import { useLanguage } from './i18n';
import MarkdownMessage from './MarkdownMessage';
import Icon from './ui/Icon';
import HtmlPreview from './HtmlPreview';
import { CodePreview, codeLanguage } from './CodePreview';
const PdfPreview=lazy(()=>import('./PdfPreview'));

function tableRows(text:string,separator:string){
 const rows:string[][]=[];let row:string[]=[],cell='',quoted=false;
 for(let i=0;i<text.length;i++){
  const char=text[i];
  if(char==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
  else if(!quoted&&char===separator){row.push(cell);cell='';}
  else if(!quoted&&(char==='\n'||char==='\r')){if(char==='\r'&&text[i+1]==='\n')i++;row.push(cell);rows.push(row);row=[];cell='';if(rows.length===201)return rows;}
  else cell+=char;
 }
 if(cell||row.length){row.push(cell);rows.push(row);}return rows;
}
export function AssetLocalActions({assetId,versionId,file,compact=false}:{assetId:string;versionId:string;file:AssetFile;compact?:boolean}){
 const {t}=useLanguage(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[opened,setOpened]=useState(false);
 useEffect(()=>{if(!compact||!opened)return;const timer=setTimeout(()=>setOpened(false),2500);return()=>clearTimeout(timer);},[compact,opened]);
 const open=async(action:'open'|'reveal')=>{setBusy(true);setError('');setOpened(false);try{await assetRequest('/'+assetId+'/versions/'+versionId+'/files/'+file.fileId+'/open','POST',{action});setOpened(true);}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 if(compact){const hint=t('打开的是此固定版本的本地副本。');return <span className="asset-local-actions" data-compact="true">
  <Button variant="ghost" className="icon-button" disabled={busy} aria-label={t('用默认应用打开')} title={t('用默认应用打开')+' · '+hint} onClick={()=>void open('open')}><Icon name="external-link" size={15}/></Button>
  <Button variant="ghost" className="icon-button" disabled={busy} aria-label={t('在文件夹中显示')} title={t('在文件夹中显示')+' · '+hint} onClick={()=>void open('reveal')}><Icon name="folder" size={15}/></Button>
  {opened&&<span role="status" className="reader-toast">{t('已打开本地副本')}</span>}{error&&<span role="alert" className="reader-toast">{error}</span>}
 </span>;}
 return <div className="asset-local-actions"><div><Button disabled={busy} onClick={()=>void open('open')}><Icon name="external-link" size={15}/>{t('用默认应用打开')}</Button><Button disabled={busy} onClick={()=>void open('reveal')}><Icon name="folder" size={15}/>{t('在文件夹中显示')}</Button></div><p className="field-hint">{t('打开的是此固定版本的本地副本。')}</p>{opened&&<p role="status">{t('已打开本地副本')}</p>}{error&&<p role="alert">{error}</p>}</div>;
}
export default function AssetPreview({file,url,text}:{file:AssetFile;url:string;text:string}){
 const {t}=useLanguage(),[failed,setFailed]=useState(false),kind=filePreviewKind(file.name,file.mediaType);
 if(failed)return <p role="alert">{t('预览无法加载，请使用本机应用打开。')}</p>;
 if(kind==='image')return <div className="asset-image-preview"><img src={url+'?preview=1'} alt={file.name} onError={()=>setFailed(true)}/></div>;
 if(kind==='pdf')return <Suspense fallback={<p>{t('加载中…')}</p>}><PdfPreview url={url}/></Suspense>;
 if(kind==='audio')return <audio className="asset-media-preview" aria-label={file.name} controls preload="metadata" src={url+'?preview=1'} onError={()=>setFailed(true)}/>;
 if(kind==='video')return <video className="asset-media-preview" aria-label={file.name} controls preload="metadata" src={url+'?preview=1'} onError={()=>setFailed(true)}/>;
 if(/\.html?$/i.test(file.name))return <HtmlPreview name={file.name} url={url+'?preview=1'} source={<CodePreview text={text} language={codeLanguage(file.name)}/>}/>;
 if(kind==='table'){
  const rows=tableRows(text.replace(/^\uFEFF/,''),fileMediaType(file.name,file.mediaType)==='text/tab-separated-values'?'\t':',');
  return <><div className="asset-table-preview" tabIndex={0} aria-label={file.name}><table><thead><tr>{rows[0]?.map((cell,i)=><th key={i} scope="col">{cell}</th>)}</tr></thead><tbody>{rows.slice(1,201).map((row,i)=><tr key={i}>{row.map((cell,j)=><td key={j}>{cell}</td>)}</tr>)}</tbody></table></div>{rows.length>200&&<p className="field-hint">{t('仅预览前 200 行，完整内容请下载。')}</p>}</>;
 }
 return fileMediaType(file.name,file.mediaType).includes('markdown')&&!/<(?:script|iframe|html)[\s>]/i.test(text)?<MarkdownMessage text={text} frontmatter/>:<pre>{text}</pre>;
}
