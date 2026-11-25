import {useEffect,useState,type ReactNode} from 'react';
import type {BlueprintRoute,RouteReview} from '../shared/blueprint-routing';
import {useLanguage} from './i18n';
import Button from './ui/Button';
import Select from './ui/Select';

export type ReadBlueprintReview=(url:string,method?:string,body?:unknown,signal?:AbortSignal)=>Promise<RouteReview>;
export function BlueprintDecision({url,call,initial,disabled=false,onCreated,onDismiss,created}:{url:string;call:ReadBlueprintReview;initial?:RouteReview;disabled?:boolean;onCreated?:(id:string)=>Promise<void>;onDismiss?:()=>void;created?:(id:string)=>ReactNode}){
 const {text:t}=useLanguage(),[review,setReview]=useState(initial),[selection,select]=useState<BlueprintRoute|undefined>(initial?.suggestion),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [attempt,setAttempt]=useState(0);
 useEffect(()=>{
  if(initial)return;
  setError('');
  const controller=new AbortController();
  void call(url,'GET',undefined,controller.signal).then(r=>{setReview(r);select(r.selection??r.suggestion);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
  return ()=>controller.abort();
 },[url,initial,attempt,call]);
 const decide=async(choice:BlueprintRoute|null)=>{
  setBusy(true);setError('');
  try{
   const result=await call(url,'POST',{selection:choice});
   setReview(result);
   if(result.taskId)await onCreated?.(result.taskId);else onDismiss?.();
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}
 };
 const project=review?.projects.find(p=>p.id===selection?.projectId);
 return <>
  {error&&<p role="alert">{error} {!review&&<Button type="button" onClick={()=>setAttempt(n=>n+1)}>{t('重试','Retry')}</Button>}</p>}
  {review&&<p>{review.goal}</p>}
  {review?.status==='pending'&&selection&&<>
   <div className="blueprint-route-fields">
   <label>{t('项目','Project')}<Select ariaLabel={t('建议项目','Suggested project')} disabled={busy||disabled} value={selection.projectId??''} options={[{value:'',label:t('无项目','No project')},...review.projects.map(p=>({value:p.id,label:p.name}))]} onChange={id=>select({projectId:id||null,lane:null,assigneeAgentId:null})}/></label>
   <label>{t('模块','Module')}<Select ariaLabel={t('建议模块','Suggested module')} disabled={busy||disabled||!project?.modules.length} value={selection.lane??''} options={[{value:'',label:t('无模块','No module')},...(project?.modules??[]).map(lane=>({value:lane,label:lane}))]} onChange={lane=>select({...selection,lane:lane||null})}/></label>
   <label>{t('负责的智能体','Responsible observer')}<Select ariaLabel={t('建议负责人','Suggested observer')} disabled={busy||disabled||!project?.observers.length} value={selection.assigneeAgentId??''} options={[{value:'',label:t('未分派','Unassigned')},...(project?.observers??[]).map(a=>({value:a.id,label:a.name}))]} onChange={id=>select({...selection,assigneeAgentId:id||null})}/></label>
   </div>
   <div className="operation-card-actions"><Button type="button" variant="primary" busy={busy} disabled={busy||disabled} onClick={()=>void decide(selection)}>{t('确认并创建任务','Confirm and create task')}</Button><Button type="button" disabled={busy||disabled} onClick={()=>void decide(null)}>{t('取消创建','Cancel creation')}</Button></div>
  </>}
  {review?.status==='dismissed'&&<p>{t('已取消创建','Creation cancelled')}</p>}
  {review?.taskId&&(created?created(review.taskId):onCreated?<Button type="button" disabled={disabled||busy} onClick={()=>void onCreated(review.taskId!).catch(e=>setError(e.message))}>{t('继续','Continue')}</Button>:<p>{t('任务已创建','Task created')}</p>)}
 </>;
}
