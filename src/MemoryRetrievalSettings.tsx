import {useEffect,useState} from 'react';
import type {MemoryRetrievalSettings as Settings} from '../shared/memory-retrieval';
import {api} from './api';
import {useLanguage} from './i18n';
import Button from './ui/Button';
import Input from './ui/Input';
import Select from './ui/Select';
import {SettingsGroup,SettingRow,SettingSwitch} from './ui/SettingsLayout';
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
 const dirty=!!draft&&(JSON.stringify(draft)!==JSON.stringify(saved)||!!key||removeKey);
 return <SettingsGroup title={l('检索方式','Retrieval')} label={l('记忆检索','Memory retrieval')}
  description={l('默认使用关键词搜索和自动召回，无需模型服务。向量检索是独立选项，不影响记忆生成。连接外部服务需确认后保存。','Keyword search and automatic recall work without a model service. Vector retrieval is optional and independent of memory generation. Connecting an external service is saved only when you confirm.')}
  actions={draft&&<>{done&&<span className="settings-autosave" role="status">{l('已保存','Saved')}</span>}<Button className={dirty?'primary':undefined} disabled={busy||!dirty} onClick={()=>void save()}>{l('保存检索设置','Save retrieval settings')}</Button></>}>
  {error&&<Notice>{error}</Notice>}
  {!draft?<p className="field-hint">{l('正在读取检索设置…','Loading retrieval settings…')}</p>:<>
   <SettingSwitch label={l('启用向量检索','Enable vector retrieval')} ariaLabel={l('启用向量检索','Enable vector retrieval')} hint={<span role="status">{saved?.enabled?l('已启用向量检索；服务不可用时退回关键词。','Vector retrieval enabled; keywords remain available if the service fails.'):l('关键词检索（默认）','Keyword retrieval (default)')}</span>} checked={draft.enabled} disabled={busy} onChange={enabled=>patch({enabled})}/>
   {draft.enabled&&<>
    <SettingRow label={l('向量提供方','Embedding provider')}><Select ariaLabel={l('向量提供方','Embedding provider')} value={draft.provider} disabled={busy} searchable={false} options={[{value:'openai',label:l('OpenAI 兼容接口','OpenAI-compatible API')},{value:'ollama',label:'Ollama'}]} onChange={provider=>patch({provider:provider as Settings['provider']})}/></SettingRow>
    <SettingRow label={l('嵌入模型','Embedding model')} htmlFor="memory-embedding-model" hint={l('填写该服务可用的嵌入模型名称。','Enter an embedding model available on this service.')}><Input id="memory-embedding-model" value={draft.model} disabled={busy} onChange={e=>patch({model:e.target.value})}/></SettingRow>
    <SettingRow stacked label={l('服务地址','Service URL')} htmlFor="memory-service-url" hint={<>{draft.provider==='openai'?l('填写 API 基础地址，包含服务要求的路径，例如 /v1。','Enter the API base URL, including its required path, such as /v1.'):l('填写 Ollama 服务地址，不含 /api/embed。','Enter the Ollama server URL without /api/embed.')} {l('保存后，记忆文本与检索词会发送到此地址；远程服务会离开本机，且可能收费。','After saving, memory text and search queries are sent to this URL; a remote service receives this data outside your computer and may charge for usage.')}</>}><Input id="memory-service-url" type="url" value={draft.baseUrl} disabled={busy} onChange={e=>patch({baseUrl:e.target.value})}/></SettingRow>
    <SettingRow stacked label="API Key" htmlFor="memory-api-key" hint={sameEndpoint&&saved?.hasApiKey?l('已配置；留空保留。密钥仅存于本机私有配置。','Configured; leave blank to keep it. Stored only in private local settings.'):l('可选；服务需要认证时填写。更换地址或提供方不会沿用旧密钥。','Optional; enter if the service requires authentication. Changing the URL or provider clears the saved key.')}>
     <div className="setting-inline-form"><Input id="memory-api-key" type="password" autoComplete="off" value={key} disabled={busy||removeKey} onChange={e=>{setKey(e.target.value);setRemoveKey(false);setDone(false);}}/>
      {sameEndpoint&&saved?.hasApiKey&&<Button variant="ghost" aria-pressed={removeKey} disabled={busy} onClick={()=>{setRemoveKey(!removeKey);setKey('');setDone(false);}}>{removeKey?l('保留已保存的 API Key','Keep saved API key'):l('删除已保存的 API Key','Remove saved API key')}</Button>}</div>
    </SettingRow>
   </>}
  </>}
 </SettingsGroup>;
}
