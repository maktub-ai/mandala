import Button from './ui/Button';
import { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { useLanguage } from './i18n';
import Icon from './ui/Icon';
GlobalWorkerOptions.workerSrc=workerUrl;

export default function PdfPreview({url}:{url:string}){
 const {t}=useLanguage(),canvas=useRef<HTMLCanvasElement>(null),container=useRef<HTMLDivElement>(null);
 const [pdf,setPdf]=useState<PDFDocumentProxy|null>(null),[page,setPage]=useState(1),[width,setWidth]=useState(640),[text,setText]=useState(''),[error,setError]=useState(false),[loading,setLoading]=useState(true);
 useEffect(()=>{let active=true;const task=getDocument({url,useWasm:false});
  void task.promise.then(value=>{if(active)setPdf(value);}).catch(()=>{if(active){setError(true);setLoading(false);}});
  return()=>{active=false;void task.destroy();};
 },[url]);
 useEffect(()=>{const observer=new ResizeObserver(entries=>setWidth(entries[0].contentRect.width));if(container.current)observer.observe(container.current);return()=>observer.disconnect();},[]);
 useEffect(()=>{if(!pdf||!canvas.current)return;let active=true,render:RenderTask|undefined;setLoading(true);setText('');
  void (async()=>{
   const documentPage=await pdf.getPage(page);if(!active)return;
   const unit=documentPage.getViewport({scale:1}),viewport=documentPage.getViewport({scale:Math.min(1.5,Math.max(1,width-32)/unit.width,4096/unit.height)}),ratio=Math.min(devicePixelRatio||1,2),target=canvas.current!;
   target.width=Math.ceil(viewport.width*ratio);target.height=Math.ceil(viewport.height*ratio);target.style.width=viewport.width+'px';target.style.height=viewport.height+'px';
   render=documentPage.render({canvas:target,viewport,transform:ratio===1?undefined:[ratio,0,0,ratio,0,0]});await render.promise;
   const content=await documentPage.getTextContent();if(active){setText(content.items.map(item=>'str' in item?item.str:'').join(' '));setLoading(false);}
  })().catch(()=>{if(active){setError(true);setLoading(false);}});
  return()=>{active=false;render?.cancel();};
 },[pdf,page,width]);
 return <div className="asset-pdf-preview" ref={container}>
  {pdf&&<div className="asset-pdf-toolbar"><Button aria-label={t('上一页')} disabled={loading||page===1} onClick={()=>setPage(value=>value-1)}><Icon name="arrowLeft" size={16}/></Button><span>{page} / {pdf.numPages}</span><Button aria-label={t('下一页')} disabled={loading||page===pdf.numPages} onClick={()=>setPage(value=>value+1)}><Icon name="arrowRight" size={16}/></Button></div>}
  {error?<p role="alert">{t('预览无法加载，请使用本机应用打开。')}</p>:<>{loading&&<p role="status">{t('加载中…')}</p>}<div className="asset-pdf-page" aria-busy={loading}><canvas ref={canvas} role="img" aria-label={t('PDF 预览')}/><p className="sr-only">{text}</p></div></>}
 </div>;
}
