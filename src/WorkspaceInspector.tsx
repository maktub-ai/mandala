import { devicePreferences } from './devicePreferences';
import Button from './ui/Button';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import Icon from './ui/Icon';
import { useLanguage } from './i18n';
import './workspace-inspector.css';

export default function WorkspaceInspector({ title, open, onClose, children, id, className = '', preserveContent = false, resizable = false, compact = false, returnFocusRef, overlay = false }: {
 title: string; open: boolean; onClose: () => void; children: ReactNode; id?: string; className?: string; preserveContent?: boolean; resizable?: boolean; compact?: boolean; returnFocusRef?: RefObject<HTMLElement|null>; overlay?: boolean;
}) {
 const {t}=useLanguage(),panel=useRef<HTMLElement>(null),backdrop=useRef<HTMLButtonElement>(null),trigger=useRef<HTMLElement|null>(null);
 const [viewportNarrow,setViewportNarrow]=useState(()=>matchMedia('(max-width: 1100px)').matches);
 const narrow=viewportNarrow||overlay;
 const visited=useRef(false),drag=useRef<{x:number;width:number}|null>(null);
 if(open)visited.current=true;
 const [width,setWidth]=useState(()=>{try{const saved=Number(devicePreferences.getItem('mana-content-width'));return saved>=360&&saved<=800?saved:440;}catch{return 440;}});
 const resize=(value:number)=>setWidth(Math.max(360,Math.min(800,innerWidth*.55,value)));
 useEffect(()=>{if(resizable)try{devicePreferences.setItem('mana-content-width',String(width));}catch{/* Layout preferences are optional. */}},[width,resizable]);
 const close=()=>{onClose();requestAnimationFrame(()=>{
  if(document.activeElement!==document.body&&!panel.current?.contains(document.activeElement))return;
  const opener=trigger.current;
  (opener?.isConnected&&opener!==document.body&&!panel.current?.contains(opener)?opener:returnFocusRef?.current)?.focus();
 });};
 useEffect(()=>{const media=matchMedia('(max-width: 1100px)'),update=()=>setViewportNarrow(media.matches);media.addEventListener('change',update);return()=>media.removeEventListener('change',update);},[]);
 useLayoutEffect(()=>{
  if(!open)return;
  if(!panel.current?.contains(document.activeElement))trigger.current=document.activeElement as HTMLElement;
  // Only an opening the user just triggered moves focus in; a panel that opens on load leaves focus alone.
  if((navigator.userActivation?.isActive??true)&&!narrow&&returnFocusRef&&document.activeElement===document.body)panel.current?.querySelector<HTMLButtonElement>('.inspector-heading button')?.focus();
 },[open,narrow,returnFocusRef]);
 useEffect(()=>{
  if(!open||!narrow)return;
  // A removed reader control can briefly leave focus on body during navigation.
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!event.defaultPrevented){event.preventDefault();close();}};
  document.addEventListener('keydown',escape);
  return()=>document.removeEventListener('keydown',escape);
 },[open,narrow,onClose]);
 useLayoutEffect(()=>{
  if(!open||!narrow)return;
  // Disable siblings on the path to the shell, never the inspector's own ancestor.
  const disabled:{node:HTMLElement;wasInert:boolean}[]=[];
  let branch=panel.current;
  while(branch?.parentElement){
   for(const sibling of Array.from(branch.parentElement.children))if(sibling!==branch&&sibling!==backdrop.current&&sibling instanceof HTMLElement){disabled.push({node:sibling,wasInert:sibling.inert});sibling.inert=true;}
   branch=branch.parentElement;if(branch.classList.contains('app-shell'))break;
  }
  const first=Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]')??[]).find(item=>item.offsetParent!==null);
  (first??panel.current)?.focus();
  return()=>{for(const {node,wasInert} of disabled)node.inert=wasInert;};
 },[open,narrow]);
 if(!open&&(!preserveContent||!visited.current))return null;
 return <>
  {open&&narrow&&<Button ref={backdrop} className="inspector-backdrop" aria-hidden="true" tabIndex={-1} onClick={close}/>}
  <aside ref={panel} tabIndex={-1} id={id} hidden={!open} style={resizable?{'--content-width':width+'px'} as CSSProperties:undefined} className={'workspace-inspector '+className+(compact?' is-compact':'')+(narrow?' is-overlay':'')} role={narrow?'dialog':'region'} aria-modal={open&&narrow?true:undefined} aria-label={title} onKeyDown={event=>{
   if(event.defaultPrevented)return;
   if(event.key==='Escape'){event.preventDefault();close();}
   if(narrow&&event.key==='Tab'){
    const items=Array.from(panel.current!.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex="0"]')).filter(item=>item.offsetParent!==null&&(item.tagName==='SUMMARY'||!item.closest('details:not([open])')));
    const target=!items.includes(document.activeElement as HTMLElement)?(event.shiftKey?items.at(-1):items[0]):event.shiftKey&&document.activeElement===items[0]?items.at(-1):!event.shiftKey&&document.activeElement===items.at(-1)?items[0]:null;
    if(target){event.preventDefault();target.focus();}
   }
  }}>
   {resizable&&!narrow&&<div className="content-resize" role="separator" aria-label={t('调整右侧栏宽度')} aria-orientation="vertical" aria-valuemin={360} aria-valuemax={Math.min(800,innerWidth*.55)} aria-valuenow={width} tabIndex={0}
    onPointerDown={event=>{event.preventDefault();event.currentTarget.focus();event.currentTarget.setPointerCapture(event.pointerId);drag.current={x:event.clientX,width:panel.current!.getBoundingClientRect().width};}}
    onPointerMove={event=>{if(drag.current)resize(drag.current.width+drag.current.x-event.clientX);}}
    onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}
    onDoubleClick={()=>resize(440)} onKeyDown={event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();resize(event.key==='Home'?360:event.key==='End'?800:width+(event.key==='ArrowLeft'?24:-24));}}/>}
   <header className="inspector-heading">{!compact&&<h2>{title}</h2>}<Button type="button" className="icon-button" aria-label={t(compact?'收起右侧栏':'收起信息')} title={t(compact?'收起右侧栏':'收起信息')} onClick={close}><Icon name={compact?"panel":"close"} size={18}/></Button></header>
   <div className="inspector-content">{children}</div>
  </aside>
 </>;
}
export function WorkspaceLayout({title,children,inspector,defaultOpen,minPrimaryWidth}:{title:string;children:ReactNode;inspector:ReactNode;defaultOpen?:boolean;minPrimaryWidth?:number}){
 const {t}=useLanguage(),[open,setOpen]=useState(()=>defaultOpen??!matchMedia('(max-width: 1100px)').matches);
 const layout=useRef<HTMLDivElement>(null),[overlay,setOverlay]=useState(false);
 useLayoutEffect(()=>{
  if(!minPrimaryWidth||!layout.current)return;
  const update=()=>setOverlay(layout.current!.clientWidth<minPrimaryWidth+330);
  update();const observer=new ResizeObserver(update);observer.observe(layout.current);return()=>observer.disconnect();
 },[minPrimaryWidth]);
 return <div ref={layout} className={'connected-workspace'+(open?' inspector-open':'')+(overlay?' inspector-overlay':'')}>
  <div className="workspace-primary"><div className="inspector-toolbar"><Button type="button" aria-label={t('查看{title}',{title})} aria-expanded={open} onClick={()=>setOpen(v=>!v)}><Icon name="info" size={16}/>{title}</Button></div>{children}</div>
  <WorkspaceInspector title={title} overlay={overlay} open={open} onClose={()=>setOpen(false)}>{inspector}</WorkspaceInspector>
 </div>;
}
