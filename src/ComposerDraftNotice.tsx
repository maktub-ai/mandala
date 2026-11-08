import { useLanguage } from './i18n';
import Button from './ui/Button';
import Icon from './ui/Icon';
import type { useComposerDraft } from './composer-drafts';
export default function ComposerDraftNotice({draft,onReselect}:{draft:ReturnType<typeof useComposerDraft>;onReselect?:()=>void}) {
 const {text: localize}=useLanguage(),say=(zh:string,en:string)=>localize(zh, en);
 const actionable=['buffered','error','conflict'].includes(draft.status);
 if(!actionable&&!draft.value.missingAttachments.length)return null;
 return <div className="composer-draft-feedback">
  {actionable&&<span role="status"><Icon name={draft.status==='buffered'?'file':'error'} size={13}/>{draft.status==='buffered'?say('草稿仅暂存于此浏览器；尚未保存到电脑','Draft buffered in this browser; not saved on the computer'):draft.status==='conflict'?say('草稿已在其他窗口更新，当前输入仍保留','Draft changed in another window; your input is retained'):say('无法保存草稿，当前输入仍保留','Draft could not be saved; your input is retained')}</span>}
  {draft.status==='conflict'&&<Button onClick={()=>void draft.reload().catch(()=>{})}>{say('加载已保存草稿','Load saved draft')}</Button>}
  {(draft.status==='buffered'||draft.status==='error')&&<Button onClick={()=>void draft.flush().catch(()=>{})}>{say('重试保存','Retry save')}</Button>}
  {!!draft.value.missingAttachments.length&&<div role="alert" className="composer-missing-files"><Icon name="paperclip" size={14}/><span>{say('需重新选择附件：','Reselect attachments: ')}{draft.value.missingAttachments.map(item=>item.name).join(', ')}</span>{onReselect&&<Button onClick={onReselect}>{say('重新选择','Reselect')}</Button>}<Button onClick={()=>draft.setValue(value=>({...value,missingAttachments:[]}))}>{say('移除缺失附件','Remove missing attachments')}</Button></div>}
 </div>;
}
