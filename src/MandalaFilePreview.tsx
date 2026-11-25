import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { AssetFile } from '../shared/assets';
import { fileMediaType, filePreviewKind } from '../shared/file-types';
import { withoutFileLine } from '../shared/local-file-links';
import { api } from './api';
import AssetPreview, { AssetLocalActions } from './AssetPreview';
import type { ContentTarget } from './ContentPreviewContext';
import { ReaderImage, ReaderText, readAttachment } from './ConversationWorkspace';
import LocalFileActions from './LocalFileActions';
import WorkspaceInspector from './WorkspaceInspector';
import { useLanguage } from './i18n';

const PdfPreview = lazy(() => import('./PdfPreview'));

export default function MandalaFilePreview({conversationId, target, onClose}: {
  conversationId:string; target:ContentTarget; onClose:()=>void;
}) {
  const {t} = useLanguage();
  const name = target.kind === 'file' ? withoutFileLine(target.href).split(/[\\/]/).pop() : target.kind === 'asset' ? target.title : target.name;
  const key = target.kind === 'file' ? target.href : target.kind === 'asset' ? JSON.stringify([target.assetId,target.versionId,target.fileId]) : target.src;
  return <WorkspaceInspector open overlayBelow={820} title={t('文件预览')} className="mandala-file-preview" heading={name} closeLabel={t('关闭文件预览')} onClose={onClose}>
    <FileContents key={key} conversationId={conversationId} target={target}/>
  </WorkspaceInspector>;
}

function FileContents({conversationId,target}:{conversationId:string;target:ContentTarget}) {
  const {t,errorText,text:localize} = useLanguage();
  const [file,setFile] = useState<{name:string;text:string;binary?:boolean;asset?:AssetFile}>();
  const [error,setError] = useState('');
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { body.current?.focus({preventScroll:true}); }, []);
  const localBase = '/conversations/'+encodeURIComponent(conversationId)+'/local-file';
  const assetBase = target.kind === 'asset' ? '/v2/assets/'+encodeURIComponent(target.assetId)+'/versions/'+encodeURIComponent(target.versionId) : '';
  const assetUrl = target.kind === 'asset' ? '/api'+assetBase+'/files/'+encodeURIComponent(target.fileId) : '';
  const mediaType = target.kind === 'file' ? fileMediaType(withoutFileLine(target.href)) : target.kind === 'attachment' ? fileMediaType(target.name,target.mimeType) : '';
  const inlineMedia = ['application/pdf','image/png','image/jpeg','image/gif','image/webp'].includes(mediaType);
  const mediaUrl = target.kind === 'file' && inlineMedia ? '/api'+localBase+'/media?href='+encodeURIComponent(target.href)
    : target.kind === 'attachment' && inlineMedia ? target.src : '';
  useEffect(() => {
    if (target.kind === 'image' || mediaUrl) return;
    const controller = new AbortController(), {signal} = controller;
    async function load() {
      if (target.kind === 'file') return api<{name:string;text:string}>(localBase,'POST',{href:target.href},signal);
      if (target.kind === 'attachment') return readAttachment(target,signal);
      if (target.kind !== 'asset') return;
      const version = await api<{downloads:AssetFile[]}>(assetBase,'GET',undefined,signal);
      const asset = version.downloads.find(item=>item.fileId===target.fileId);
      if (asset?.availability !== 'managed_local') throw new Error(t('内容缺失，请从备份恢复。'));
      const kind = filePreviewKind(asset.name,asset.mediaType);
      const needsText = kind==='text' || kind==='table';
      const binary = !kind || needsText && asset.size>1024*1024;
      let text = '';
      if (needsText && !binary) {
        const response = await fetch(assetUrl,{signal});
        if (!response.ok) throw new Error(response.statusText);
        text = await response.text();
      }
      return {name:asset.name,text,asset,binary};
    }
    void load().then(value=>{if (!signal.aborted) setFile(value);})
      .catch(cause=>{if (!signal.aborted) setError(String(cause.message));});
    return ()=>controller.abort();
  },[conversationId,target,assetBase,assetUrl,localBase,mediaUrl]);
  const unsupported = localize('此格式或大小暂不支持预览。','Preview is unavailable for this format or size.');
  const loading = <p role="status">{t('加载中…')}</p>;
  return <div className="mandala-file-body" ref={body} tabIndex={-1}>
    {target.kind==='asset' && file?.asset && <div className="content-reader-actions"><a href={assetUrl} download={file.name}>{t('下载固定版本')}</a><AssetLocalActions assetId={target.assetId} versionId={target.versionId} file={file.asset} compact/></div>}
    {target.kind==='attachment' && <a href={target.src} download={target.name}>{localize('下载附件','Download attachment')}</a>}
    {target.kind==='file' && file && <LocalFileActions url={'/api'+localBase+'/open'} body={{href:target.href}} compact/>}
    {error ? <p role="alert">{errorText(error)}</p>
      : mediaUrl && mediaType==='application/pdf' ? <Suspense fallback={loading}><PdfPreview url={mediaUrl}/></Suspense>
      : mediaUrl && (target.kind==='file' || target.kind==='attachment') ? <ReaderImage src={mediaUrl} name={target.kind==='file'?target.href:target.name}/>
      : target.kind==='image' ? <ReaderImage src={target.src} name={target.name}/>
      : !file ? loading : file.binary ? <p>{unsupported}</p>
      : file.asset ? <AssetPreview file={file.asset} url={assetUrl} text={file.text}/>
      : <ReaderText name={file.name} text={file.text} previewUrl={target.kind==='file'?'/api'+localBase+'/preview?href='+encodeURIComponent(target.href):undefined}/>}
  </div>;
}
