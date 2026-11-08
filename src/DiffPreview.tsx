import Button from './ui/Button';
import { copyText } from "./clipboard";
import { useMemo, useState } from 'react';
import { diffRows, splitRows, type DiffRow } from './diffRows';
import { useLanguage } from './i18n';
import { useCopyFeedback } from './useCopyFeedback';
import './diff-preview.css';

export default function DiffPreview({patch,binary=false}:{patch:string|null;binary?:boolean}) {
 const {text: localize}=useLanguage(),label=(zh:string,en:string)=>localize(zh, en);
 const [mode,setMode]=useState<'unified'|'split'>('unified'),[limit,setLimit]=useState(1000),[copyError,setCopyError]=useState(''),[wrap,setWrap]=useState(true);
 const [copied,markCopied,clearCopied,copySequence]=useCopyFeedback();
 const rows=useMemo(()=>diffRows(patch??''),[patch]);
 const visible=rows.slice(0,limit);
 const cell=(row:DiffRow|undefined,side:'old'|'new')=><td className={'diff-cell '+(row?'diff-'+row.kind:'diff-empty')}><span className="diff-number">{side==='old'?row?.oldLine:row?.newLine}</span><code>{row?.text}</code></td>;
 return <div className="diff-view">
  <div className="diff-toolbar">
   <div role="group" aria-label={label('差异布局','Diff layout')}><Button type="button" aria-pressed={mode==='unified'} onClick={()=>setMode('unified')}>{label('逐行','Unified')}</Button><Button type="button" aria-pressed={mode==='split'} onClick={()=>setMode('split')}>{label('并排','Split')}</Button></div>
   <Button type="button" aria-pressed={wrap} onClick={()=>setWrap(value=>!value)}>{label('换行','Wrap')}</Button>
   {patch&&<Button type="button" aria-label={label('复制 diff','Copy diff')} data-copied={!!copied||undefined} onClick={async()=>{try{await copyText(patch);setCopyError('');markCopied('diff');}catch{clearCopied();setCopyError(label('复制失败','Copy failed'));}}}><span aria-live="polite"><span key={copySequence}>{copyError||(copied?label('已复制','Copied'):label('复制 diff','Copy diff'))}</span></span></Button>}
  </div>
  {binary?<p className="diff-notice">{label('二进制文件，无法显示逐行差异。','Binary file; line-by-line diff is unavailable.')}</p>:!rows.length?<p className="diff-notice">{patch?label('文件属性已更改，没有文本行差异。','File metadata changed; no text lines changed.'):label('此范围没有文本改动。','No text changes in this scope.')}</p>:<div className="diff-scroll" tabIndex={0} aria-label={label('逐行差异','Line-by-line diff')}>
   <table className={'diff-table '+mode+(wrap?' wrap':'')} aria-label={label('文件差异','File diff')}><tbody>
    {mode==='unified'?visible.map((row,i)=>row.kind==='hunk'||row.kind==='note'?<tr key={i} className={'diff-'+row.kind}><td colSpan={4}>{row.text}</td></tr>:<tr key={i} className={'diff-'+row.kind}><td className="diff-number">{row.oldLine}</td><td className="diff-number">{row.newLine}</td><td className="diff-sign">{row.kind==='add'?'+':row.kind==='remove'?'-':' '}</td><td><code>{row.text||' '}</code></td></tr>)
    :splitRows(visible).map((row,i)=>row.header?<tr key={i} className={'diff-'+row.header.kind}><td colSpan={2}>{row.header.text}</td></tr>:<tr key={i}>{cell(row.left,'old')}{cell(row.right,'new')}</tr>)}
   </tbody></table>
  </div>}
  {rows.length>limit&&<Button type="button" className="diff-more" onClick={()=>setLimit(value=>value+1000)}>{label('显示更多差异','Show more changes')} ({rows.length-limit})</Button>}
 </div>;
}
