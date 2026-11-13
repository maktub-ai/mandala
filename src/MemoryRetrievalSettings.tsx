import {useEffect,useState} from 'react';
import type {MemoryRetrievalSettings as Settings} from '../shared/memory-retrieval';
import {api} from './api';
import {useLanguage} from './i18n';
import Button from './ui/Button';
import Input from './ui/Input';
import Select from './ui/Select';
import Field from './ui/Field';
import Notice from './ui/Notice';
export default function MemoryRetrievalSettings(){
 const {text:l}=useLanguage();
 const [saved,setSaved]=useState<Settings>(),[draft,setDraft]=useState<Settings>(),[key,setKey]=useState(''),[removeKey,setRemoveKey]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[done,setDone]=useState(false);
 useEffect(()=>{const controller=new AbortController();void api<Settings>('/v2/memory/retrieval','GET',undefined,controller.signal).then(value=>{setSaved(value);setDraft(value);}).catch(()=>{if(!controller.signal.aborted)setError(l('无法读取检索设置，请刷新重试。','Could not load retrieval settings. Refresh to retry.'));});return()=>controller.abort();},[l]);
 const patch=(value:Partial<Settings>)=>{setDraft(d=>({...d!,...value}));setDone(false);setError('');if(value.baseUrl!==undefined||value.provider!==undefined){setKey('');setRemoveKey(false);}};
 const sameEndpoint=draft?.provider===saved?.provider&&draft?.baseUrl.replace(/\/+$/,'')===saved?.baseUrl;
 async function save(){
  if(!draft)return;
  if(draft.enabled&&(!draft.baseUrl.trim()||!draft.model.trim())){setError(l('请填写服务地址和嵌入模型。','Enter the service URL and embedding model.'));return;}
  setBusy(true);setDone(false);setError('');
  try{const {hasApiKey,...settings}=draft;const value=await api<Settings>('/v2/memory/retrieval','PUT',{...settings,...removeKey?{apiKey:''}:key?{apiKey:key.trim()}:{}});setSaved(value);setDraft(value);setKey('');setRemoveKey(false);setDone(true);}
  catch{setError(l('无法保存，请检查服务地址和模型后重试。','Could not save. Check the service URL and model, then retry.'));}finally{setBusy(false);}
 }
 return <section className="settings-card" aria-label={l('记忆检索','Memory retrieval')}>
  <h2>{l('记忆检索','Memory retrieval')}</h2>
  <p className="field-hint">{l('默认使用关键词搜索和自动召回，无需模型服务。向量检索是独立选项，不影响记忆生成。','Keyword search and automatic recall work without a model service. Vector retrieval is optional and independent of memory generation.')}</p>
  {error&&<Notice>{error}</Notice>}
  {!draft?<p>{l('正在读取检索设置…','Loading retrieval settings…')}</p>:<>
   <p role="status">{saved?.enabled?l('已启用向量检索；服务不可用时退回关键词。','Vector retrieval enabled; keywords remain available if the service fails.'):l('关键词检索（默认）','Keyword retrieval (default)')}</p>
   <label className="system-feature-toggle"><span>{l('启用向量检索','Enable vector retrieval')}</span><Input type="checkbox" role="switch" aria-label={l('启用向量检索','Enable vector retrieval')} checked={draft.enabled} disabled={busy} onChange={e=>patch({enabled:e.target.checked})}/></label>
   {draft.enabled&&<>
    <div className="system-profile-fields">
     <Field label={l('向量提供方','Embedding provider')}><Select ariaLabel={l('向量提供方','Embedding provider')} value={draft.provider} disabled={busy} searchable={false} options={[{value:'openai',label:l('OpenAI 兼容接口','OpenAI-compatible API')},{value:'ollama',label:'Ollama'}]} onChange={provider=>patch({provider:provider as Settings['provider']})}/></Field>
     <Field label={l('嵌入模型','Embedding model')} hint={l('填写该服务可用的嵌入模型名称。','Enter an embedding model available on this service.')}><Input value={draft.model} disabled={busy} onChange={e=>patch({model:e.target.value})}/></Field>
    </div>
    <Field label={l('服务地址','Service URL')} hint={draft.provider==='openai'?l('填写 API 基础地址，包含服务要求的路径，例如 /v1。','Enter the API base URL, including its required path, such as /v1.'):l('填写 Ollama 服务地址，不含 /api/embed。','Enter the Ollama server URL without /api/embed.')}><Input type="url" value={draft.baseUrl} disabled={busy} onChange={e=>patch({baseUrl:e.target.value})}/></Field>
    <p className="field-hint">{l('开启并保存后，记忆文本与检索词会发送到此地址。选择远程服务即会离开本机；服务可能收费。','After enabling and saving, memory text and search queries are sent to this URL. A remote service receives this data outside your computer and may charge for usage.')}</p>
    <Field label="API Key" hint={sameEndpoint&&saved?.hasApiKey?l('已配置；留空保留。密钥仅存于本机私有配置。','Configured; leave blank to keep it. Stored only in private local settings.'):l('可选；服务需要认证时填写。更换地址或提供方不会沿用旧密钥。','Optional; enter if the service requires authentication. Changing the URL or provider clears the saved key.')}><Input type="password" autoComplete="off" value={key} disabled={busy} onChange={e=>{setKey(e.target.value);setRemoveKey(false);setDone(false);}}/></Field>
    {sameEndpoint&&saved?.hasApiKey&&<label className="system-feature-toggle"><span>{l('删除已保存的 API Key','Remove saved API key')}</span><Input type="checkbox" checked={removeKey} disabled={busy} onChange={e=>{setRemoveKey(e.target.checked);setDone(false);}}/></label>}
   </>}
   <div className="settings-keyboard-actions"><Button disabled={busy} onClick={()=>void save()}>{l('保存检索设置','Save retrieval settings')}</Button>{done&&<span role="status">{l('已保存','Saved')}</span>}</div>
  </>}
 </section>;
}
