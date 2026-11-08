import {useEffect,useState} from 'react';
import type {Config} from '../shared/types';
import {enabledRuntimes,runtimeLabel} from '../shared/runtimes';
import {api} from './api';
import {useLanguage} from './i18n';
import Disclosure from './ui/Disclosure';
import Select from './ui/Select';
import Button from './ui/Button';

type NativeMcp={name:string;path:string;enabled?:boolean};
export default function NativeMcpPanel({config}:{config:Config}){
 const {text: localize}=useLanguage(),say=(zh:string,en:string)=>localize(zh, en);
 const runtimes=enabledRuntimes(config).filter(cli=>cli==='codex'||cli==='omp');
 const [open,setOpen]=useState(false),[choice,setChoice]=useState<'codex'|'omp'|''>(''),[projectId,setProjectId]=useState(''),[refresh,setRefresh]=useState(0);
 const cli=choice&&runtimes.includes(choice)?choice:undefined,project=config.projects.find(item=>item.id===projectId);
 const query=new URLSearchParams({cli:cli??'',...(project?{projectId:project.id}:{})}).toString();
 const [result,setResult]=useState<{key:string;items:NativeMcp[];error:string}>();
 const key=query+':'+refresh;
 useEffect(()=>{
  if(!open||!cli)return;let active=true;
  api<{mcp:NativeMcp[]}>('/capabilities?'+query).then(data=>{if(active)setResult({key,items:data.mcp,error:''});}).catch((error:Error)=>{if(active)setResult({key,items:[],error:error.message});});
  return()=>{active=false;};
 },[open,cli,key]);
 return <Disclosure title={say('本地已注册的 MCP','Locally registered MCPs')} onToggle={event=>setOpen(event.currentTarget.open)}>
  <p className="field-hint">{say('只读发现 Codex / OMP 原生配置；不会复制凭据或修改注册。空清单也可能表示执行端未安装或读取失败。','Read-only discovery of Codex / OMP native configuration. Credentials and registrations are unchanged. An empty list may also mean the CLI is missing or discovery failed.')}</p>
  {runtimes.length?<><div className="system-profile-fields"><label>{say('发现执行端','Discovery CLI')}<Select ariaLabel={say('发现执行端','Discovery CLI')} value={cli??''} onChange={value=>setChoice(value as 'codex'|'omp')} options={runtimes.map(value=>({value,label:runtimeLabel(value)}))}/></label>
   <label>{say('发现范围','Discovery scope')}<Select ariaLabel={say('发现范围','Discovery scope')} value={project?.id??''} onChange={setProjectId} options={[{value:'',label:say('仅用户级配置','User configuration only')},...config.projects.map(item=>({value:item.id,label:item.name}))]}/></label></div>
   <Button disabled={!cli} onClick={()=>setRefresh(value=>value+1)}>{say('刷新本地 MCP','Refresh local MCPs')}</Button>
   <p className="field-hint" role="status">{!cli?say('请选择要查看的执行端。','Choose a runtime to inspect.'):result?.key!==key?say('正在发现 MCP…','Discovering MCPs…'):result.error||say('已发现，尚未测试连接','Discovered; connection untested')}</p>
   {result?.key===key&&!result.error&&(result.items.length?<ul>{result.items.map(item=><li key={item.name}><strong>{item.name}</strong>{item.enabled===false?' · '+say('已停用','Disabled'):''}<p className="field-hint">{item.path}</p></li>)}</ul>:<p className="field-hint">{say('当前范围未发现 MCP。','No MCPs discovered in this scope.')}</p>)}
  </>:<p className="field-hint">{say('启用 Codex 或 OMP 后可发现原生 MCP。','Enable Codex or OMP to discover native MCPs.')}</p>}
 </Disclosure>;
}
