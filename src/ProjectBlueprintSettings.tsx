import {useEffect,useRef,useState} from 'react';
import type {BlueprintDraft,BlueprintState} from '../shared/blueprint';
import {api} from './api';
import {useLanguage} from './i18n';
import {ObjectGroup,ObjectRow} from './ObjectExperience';
import {blueprintPath} from './ProjectBlueprint';
import Button from './ui/Button';
import Input from './ui/Input';
import Textarea from './ui/Textarea';

type Action='enable'|'disable'|'bind'|'draft'|'confirm';
export default function ProjectBlueprintSettings({projectId,disabled,onBusyChange,onReload}:{projectId:string;disabled:boolean;onBusyChange:(busy:boolean)=>void;onReload:()=>void|Promise<void>}){
 const {text}=useLanguage(),path=blueprintPath(projectId);
 const [state,setState]=useState<BlueprintState|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState<Action|null>(null),[revision,setRevision]=useState(0);
 const [selection,setSelection]=useState(''),[draft,setDraft]=useState<BlueprintDraft|null>(null),[lines,setLines]=useState('');
 const mounted=useRef(false);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 useEffect(()=>{const controller=new AbortController();setError('');
  api<BlueprintState>(path,'GET',undefined,controller.signal).then(value=>{if(!controller.signal.aborted)setState(value);}).catch(reason=>{if(!controller.signal.aborted)setError(reason.message);});
  return()=>controller.abort();
 },[path,revision]);
 const generate=async()=>{
  setBusy('draft');const proposal=await api<BlueprintDraft>(path,'POST',{action:'draft'});
  if(mounted.current){setDraft(proposal);setLines(proposal.modules.join('\n'));}
 };
 const modules=lines.split('\n').map(s=>s.trim()).filter(Boolean);
 const act=async(action:Action)=>{
  if(busy||disabled)return;
  setBusy(action);setError('');
  try{
   if(action==='draft'){await generate();return;}
   let next:BlueprintState;
   onBusyChange(true);
   try{
    next=await api<BlueprintState>(path,'POST',{action,...(action==='bind'?{planId:selection}:action==='confirm'?{draftId:draft?.draftId,modules}:{})});
    if(mounted.current){setState(next);setDraft(null);setSelection('');}
    await onReload();
   }finally{onBusyChange(false);}
   if(mounted.current&&action==='enable'&&next.status==='uninitialized')await generate();
  }catch(reason){if(mounted.current)setError((reason as Error).message);}
  finally{if(mounted.current)setBusy(null);}
 };
 const reread=()=>{setDraft(null);setState(null);setRevision(v=>v+1);};
 const locked=disabled||!!busy;
 return <ObjectGroup id="blueprint" title={text('项目蓝图','Project blueprint')}>
  <ObjectRow label={text('开启蓝图','Enable blueprint')} hint={text('兼容 Omino 格式。关闭后保留已有记录和关联。','Compatible with the Omino format. Turning this off preserves existing records and links.')}>
   <Input type="checkbox" role="switch" aria-label={text('项目蓝图','Project blueprint')} checked={busy==='enable'||busy!=='disable'&&!!state?.enabled} disabled={!state||locked} onChange={e=>void act(e.target.checked?'enable':'disable')}/>
  </ObjectRow>
  {(state?.enabled||error||!state)&&<div className="blueprint-setup">
   {!state&&!error&&<span role="status">{text('正在读取蓝图…','Loading blueprint…')}</span>}
   {error&&<div role="alert">{error} {state&&state.status!=='unavailable'&&<Button disabled={locked} onClick={reread}>{text('重新读取蓝图','Reload blueprint')}</Button>}</div>}
   {(!state&&error||state?.status==='unavailable')&&<><p>{text('暂时无法读取蓝图。','Blueprint is unavailable.')}</p><Button disabled={locked} onClick={reread}>{text('重新读取蓝图','Reload blueprint')}</Button></>}
   {state?.status==='ready'&&<span>{text('已连接蓝图','Connected blueprint')} · {state.summary?.title||state.planId}</span>}
   {state?.status==='conflict'&&<fieldset disabled={locked}><legend>{text('选择已有蓝图','Choose an existing blueprint')}</legend>{state.candidates.map(id=><label key={id}><input type="radio" name="blueprint-plan" value={id} checked={selection===id} onChange={()=>setSelection(id)}/>{id}</label>)}<Button disabled={!selection||locked} onClick={()=>void act('bind')}>{text('绑定所选蓝图','Use selected blueprint')}</Button></fieldset>}
   {state?.status==='uninitialized'&&(draft?<>
    <label>{text('初始模块草案','Initial module draft')}<Textarea rows={4} value={lines} disabled={locked} onChange={e=>setLines(e.target.value)}/></label>
    <p>{text('每行一个模块。确认后才创建蓝图。','Use one module per line. Confirm to create the blueprint.')}</p>
    <Button variant="primary" disabled={locked||!modules.length||new Set(modules).size!==modules.length} onClick={()=>void act('confirm')}>{text('确认模块并创建蓝图','Confirm modules and create blueprint')}</Button>
   </>:<><p>{text('由观察者提出初始模块，确认后开始记录。','An observer proposes the initial modules. Recording begins after confirmation.')}</p><Button busy={busy==='draft'} disabled={locked} onClick={()=>void act('draft')}>{busy==='draft'?text('正在生成模块草案…','Generating module draft…'):text('生成模块草案','Generate module draft')}</Button></>)}
  </div>}
 </ObjectGroup>;
}
