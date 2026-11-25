import {useState} from 'react';
import type {useRemoteOffline} from './useRemoteOffline';
import {useLanguage} from './i18n';
import Textarea from './ui/Textarea';
import Button from './ui/Button';
import Dialog from './Dialog';

type Call=<T>(path:string,method?:string,body?:unknown)=>Promise<T>;
export default function RemoteTaskCapture({offline,online,busy,run,call}:{offline:ReturnType<typeof useRemoteOffline>;online:boolean;busy:boolean;run:(work:()=>Promise<void>)=>Promise<void>;call:Call}) {
  const {text:t}=useLanguage(),[confirm,setConfirm]=useState(false);
  const {task,taskReadable,editable,saveTask,ownsEditor}=offline;
  const readOnly=!editable||!taskReadable;
  async function save() {
    if(!ownsEditor()||!online||!taskReadable)return;
    const original=offline.taskRef.current;
    const key=original.pending?.key??crypto.randomUUID();
    let receipt:{task:{id:string}|null};
    if(original.pending)receipt=await call('/api/remote/tasks/'+encodeURIComponent(key));
    else {
      if(!original.text.trim())return;
      saveTask({...original,pending:{key,action:'task'}},true);
      try{receipt=await call('/api/remote/tasks','POST',{goal:original.text,commandKey:key,projectId:null,assigneeAgentId:null});}
      catch(reason){
        const status=(reason as {status?:number}).status;
        if(status&&status>=400&&status<500&&status!==409&&ownsEditor())saveTask(original,true);
        throw reason;
      }
    }
    if(!receipt.task?.id)throw Error(t('暂未找到保存回执，请核对任务列表。','No save receipt yet. Check the task list.'));
    if(ownsEditor()&&offline.taskRef.current.pending?.key===key)saveTask({text:''},true);
  }
  return <form className="remote-task-capture" onSubmit={event=>{event.preventDefault();void run(save);}}>
    <label>{t('记录新事情','Capture a new task')}<Textarea value={task.text} rows={2} maxLength={1048576} disabled={readOnly||busy||!!task.pending} onChange={e=>saveTask({text:e.target.value})}/></label>
    <p className="remote-muted" role="status">{task.pending?t('保存结果待确认。','Save result unconfirmed.'):task.text?offline.errors.task?t('尚未保存到本设备','Not saved on this device'):t('已保存到本设备 · 未同步','Saved on this device · Not synced'):t('离线时可记录草稿。连接后手动保存到待办。','Capture a draft offline. Save it to your to-do list once connected.')}</p>
    <Button type="submit" disabled={!online||readOnly||busy||!task.text.trim()}>{task.pending?t('核对保存结果','Check save result'):t('保存任务','Save task')}</Button>
    {task.pending&&<Button type="button" disabled={busy||readOnly} onClick={()=>setConfirm(true)}>{t('恢复任务草稿','Restore task draft')}</Button>}
    {confirm&&<Dialog label={t('恢复任务草稿','Restore task draft')} onClose={()=>setConfirm(false)}><p>{t('先核对电脑上的任务列表。恢复草稿后，再次保存会创建新任务。','Check the task list on the computer first. Saving the restored draft will create a new task.')}</p><Button disabled={readOnly||busy} onClick={()=>{try{saveTask({...task,pending:undefined},true);setConfirm(false);}catch{/* Storage feedback stays visible. */}}}>{t('已核对，保留草稿','Checked, keep draft')}</Button></Dialog>}
  </form>;
}
