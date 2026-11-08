import {useEffect,useState} from 'react';
import type {Config,ExecutionMachine} from '../shared/types';
import type {SshProbe} from '../shared/ssh-execution';
import {isValidSshHost} from '../shared/execution-machines';
import {runtimeIds,runtimeLabel} from '../shared/runtimes';
import {projectWorkspaces} from '../shared/workspaces';
import {api} from './api';
import {useLanguage} from './i18n';
import {sshErrorText} from './ssh-errors';
import {DetailSection} from './ui/WorkspacePage';
import Field from './ui/Field';
import Input from './ui/Input';
import Button from './ui/Button';
import Notice from './ui/Notice';
import EmptyState from './ui/EmptyState';
import Disclosure from './ui/Disclosure';
import StatusLabel from './ui/StatusLabel';
import Icon from './ui/Icon';
import './execution-machines.css';

type Check={at:string;ok:boolean;probe?:SshProbe;error?:string};
type Usage={projectId:string;projectName:string;workspaceName:string};

export default function ExecutionMachinesSettings({config,disabled=false,onChange,onOpenPath}:{config:Config;disabled?:boolean;onChange:(machines:ExecutionMachine[])=>void;onOpenPath?:(path:string)=>void}) {
 const {text}=useLanguage(),machines=config.executionMachines??[];
 const [adding,setAdding]=useState(false),[editing,setEditing]=useState(''),[checks,setChecks]=useState<Record<string,Check>>({}),[checking,setChecking]=useState('');
 useEffect(()=>{let live=true;api<Record<string,Check>>('/execution-machines/status').then(value=>{if(live)setChecks(current=>({...value,...current}));}).catch(()=>{});return()=>{live=false;};},[]);
 const probe=async(host:string):Promise<Check>=>{
  setChecking(host);
  try{const result:Check={at:new Date().toISOString(),ok:true,probe:await api<SshProbe>('/execution-machines/probe','POST',{host})};setChecks(current=>({...current,[host]:result}));return result;}
  catch(error){const result:Check={at:new Date().toISOString(),ok:false,error:error instanceof Error?error.message:String(error)};setChecks(current=>({...current,[host]:result}));return result;}
  finally{setChecking(current=>current===host?'':current);}
 };
 const usage=(machine:ExecutionMachine):Usage[]=>config.projects.flatMap(project=>projectWorkspaces(project).filter(workspace=>workspace.machineId===machine.id).map(workspace=>({projectId:project.id,projectName:project.name,workspaceName:workspace.name==='Default'?text('默认目录组','Default'):workspace.name})));
 return <DetailSection title={text('远程机器','Remote machines')} actions={<Button disabled={disabled||adding} onClick={()=>{setAdding(true);setEditing('');}}><Icon name="plus" size={16}/>{text('添加机器','Add machine')}</Button>}>
  <p className="field-hint">{text('智能体默认在本机执行。添加可通过 SSH 登录的 Linux 机器后，可在项目的目录组中选择让智能体在那里执行。','Agents run on this computer by default. Add a Linux machine you can reach over SSH, then choose it for a project workspace to run Agents there.')}</p>
  <Requirements/>
  {adding&&<MachineEditor machine={{id:'',name:'',host:''}} machines={machines} disabled={disabled} checking={checking} checks={checks} onProbe={probe} onSave={value=>{onChange([...machines,{...value,id:crypto.randomUUID()}]);setAdding(false);}} onCancel={()=>setAdding(false)}/>}
  {machines.length>0&&<ul className="execution-machine-list" aria-label={text('远程机器列表','Remote machine list')}>{machines.map(machine=>editing===machine.id
   ?<li key={machine.id}><MachineEditor machine={machine} machines={machines} disabled={disabled} checking={checking} checks={checks} onProbe={probe} onSave={value=>{onChange(machines.map(item=>item.id===machine.id?value:item));setEditing('');}} onCancel={()=>setEditing('')}/></li>
   :<li key={machine.id}><MachineRow machine={machine} check={checks[machine.host]} checking={checking===machine.host} usage={usage(machine)} disabled={disabled} onProbe={()=>void probe(machine.host)} onEdit={()=>{setEditing(machine.id);setAdding(false);}} onRemove={()=>onChange(machines.filter(item=>item.id!==machine.id))} onOpenPath={onOpenPath}/></li>)}</ul>}
  {!machines.length&&!adding&&<EmptyState icon="server"><strong>{text('尚无远程机器','No remote machines')}</strong><span>{text('所有工作目录都在本机执行。','Every workspace runs on this computer.')}</span></EmptyState>}
 </DetailSection>;
}

function Requirements(){
 const {text}=useLanguage();
 return <Disclosure className="execution-machine-requirements" title={text('连接要求','Requirements')}>
  <ul>
   <li>{text('Linux，并已安装 Node.js 22.23.2 或更高版本；通过 SSH 非交互登录时也能直接找到 node。','Linux with Node.js 22.23.2 or later, available to non-interactive SSH logins.')}</li>
   <li>{text('需要的 CLI 已在这台机器上安装并登录。Mandala 不会复制本机的登录状态。','The CLIs you need are installed and signed in on that machine. Mandala never copies your local sign-ins.')}</li>
   <li>{text('使用系统的 OpenSSH 配置、密钥或 ssh-agent，不保存密码；端口、跳板机等在 ~/.ssh/config 中配置。','Uses your system OpenSSH configuration, keys or ssh-agent, and never stores passwords. Configure ports and jump hosts in ~/.ssh/config.')}</li>
   <li>{text('首次连接前，请先在终端运行一次 ssh，核对并接受主机指纹。','Before the first connection, run ssh once in a terminal to verify and accept the host key.')}</li>
  </ul>
 </Disclosure>;
}

function CheckResult({check,host}:{check:Check;host:string}){
 const {text,language}=useLanguage();
 if(!check.ok)return <Notice className="execution-machine-error">{sshErrorText(language,check.error??'',host)??check.error}</Notice>;
 const probe=check.probe!;
 return <div role="status" className="execution-machine-result">
  <ul className="execution-machine-checklist">
   <li data-ok><Icon name="check" size={14}/>{probe.platform==='linux'?'Linux':probe.platform}</li>
   <li data-ok><Icon name="check" size={14}/>Node {probe.nodeVersion}</li>
   {probe.runtimes.map(runtime=><li key={runtime.id} data-ok={runtime.installed||undefined}><Icon name={runtime.installed?'check':'close'} size={14}/>{runtimeIds.includes(runtime.id)?runtimeLabel(runtime.id):runtime.id}{runtime.installed?'':text('（未安装）',' (not installed)')}</li>)}
  </ul>
  <p className="field-hint">{text('“已安装”只说明能找到 CLI，不代表已登录；请确认它在这台机器上能直接使用。','Installed only means the CLI was found, not that it is signed in. Make sure it works on that machine.')}</p>
 </div>;
}

function checkedAt(at:string,language:string){
 const time=new Date(at);return Number.isNaN(time.getTime())?'':time.toLocaleTimeString(language==='zh-CN'?'zh-CN':'en',{hour:'2-digit',minute:'2-digit'});
}

function MachineRow({machine,check,checking,usage,disabled,onProbe,onEdit,onRemove,onOpenPath}:{machine:ExecutionMachine;check?:Check;checking:boolean;usage:Usage[];disabled:boolean;onProbe:()=>void;onEdit:()=>void;onRemove:()=>void;onOpenPath?:(path:string)=>void}){
 const {text,language}=useLanguage();
 const [details,setDetails]=useState(false);
 const status=checking?<StatusLabel icon="clock" tone="active">{text('检测中…','Checking…')}</StatusLabel>
  :!check?<StatusLabel icon="circle" tone="neutral">{text('未检测','Not checked')}</StatusLabel>
  :check.ok?<StatusLabel icon="circleCheck" tone="success" title={check.at}>{text(`可连接 · ${checkedAt(check.at,language)}`,`Reachable · ${checkedAt(check.at,language)}`)}</StatusLabel>
  :<StatusLabel icon="error" tone="danger" title={check.at}>{text(`连接失败 · ${checkedAt(check.at,language)}`,`Failed · ${checkedAt(check.at,language)}`)}</StatusLabel>;
 return <section className="execution-machine" aria-label={machine.name}>
  <div className="execution-machine-row">
   <Icon name="server" size={18}/>
   <div className="execution-machine-identity"><strong>{machine.name}</strong><span className="mono">{machine.host}</span></div>
   {check&&!checking?<button type="button" className="execution-machine-status" aria-expanded={details} onClick={()=>setDetails(value=>!value)} title={text('查看检测详情','Show check details')}>{status}</button>:status}
   <div className="execution-machine-actions">
    <Button busy={checking} disabled={disabled} onClick={()=>{setDetails(true);onProbe();}}>{text('测试连接','Test connection')}</Button>
    <Button disabled={disabled} onClick={onEdit}>{text('编辑','Edit')}</Button>
    <Button disabled={disabled||usage.length>0} title={usage.length?text('这台机器仍被目录组使用，请先在项目中改用其他机器。','A workspace still uses this machine. Switch it to another machine first.'):undefined} onClick={onRemove}>{text('移除','Remove')}</Button>
   </div>
  </div>
  {usage.length>0&&<p className="execution-machine-usage">{text('用于 ','Used by ')}{usage.map((item,index)=><span key={item.projectId+item.workspaceName}>{index>0&&'、'}<a href={`/projects/${item.projectId}/settings?tab=resources`} onClick={event=>{if(!onOpenPath||event.button||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();onOpenPath(`/projects/${item.projectId}/settings?tab=resources`);}}>{item.projectName} · {item.workspaceName}</a></span>)}</p>}
  {details&&check&&!checking&&<CheckResult check={check} host={machine.host}/>}
 </section>;
}

function MachineEditor({machine,machines,disabled,checking,checks,onProbe,onSave,onCancel}:{machine:ExecutionMachine;machines:ExecutionMachine[];disabled:boolean;checking:string;checks:Record<string,Check>;onProbe:(host:string)=>Promise<Check>;onSave:(machine:ExecutionMachine)=>void;onCancel:()=>void}) {
 const {text}=useLanguage();
 const isNew=!machine.id;
 const [name,setName]=useState(machine.name),[host,setHost]=useState(machine.host),[submitted,setSubmitted]=useState(false),[tested,setTested]=useState('');
 const cleanHost=host.trim(),cleanName=name.trim();
 const hostError=!isValidSshHost(cleanHost)?text('请输入有效的 OpenSSH 目标或别名。','Enter a valid OpenSSH target or alias.'):machines.some(item=>item.id!==machine.id&&item.host===cleanHost)?text('此 SSH 目标已存在。','This SSH target already exists.'):'';
 const valid=!!cleanName&&!hostError,busy=!!checking&&checking===cleanHost;
 const check=tested===cleanHost?checks[cleanHost]:undefined;
 const save=()=>onSave({...machine,name:cleanName,host:cleanHost});
 // New machines are tested before they are added, so a broken target is caught here rather than at the first run.
 const submit=async()=>{setSubmitted(true);if(!valid||busy)return;if(!isNew&&cleanHost===machine.host){save();return;}setTested(cleanHost);const result=await onProbe(cleanHost);if(result.ok)save();};
 return <section className="execution-machine execution-machine-editor" aria-label={isNew?text('新增远程机器','New remote machine'):text(`编辑 ${machine.name}`,`Edit ${machine.name}`)}>
  <form onSubmit={event=>{event.preventDefault();void submit();}}>
   <div className="execution-machine-fields">
    <Field label={text('机器名称','Machine name')} error={submitted&&!cleanName?text('机器名称不能为空','Machine name is required'):undefined}><Input autoFocus={isNew} value={name} placeholder={text('例如 构建服务器','For example Build server')} disabled={disabled||busy} onChange={event=>setName(event.target.value)}/></Field>
    <Field label={text('SSH 目标','SSH target')} hint={text('~/.ssh/config 中的别名，或 user@host。','An alias from ~/.ssh/config, or user@host.')} error={submitted?hostError||undefined:undefined}><Input value={host} placeholder="build-linux" disabled={disabled||busy} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={event=>setHost(event.target.value)}/></Field>
   </div>
   <div className="execution-machine-actions">
    <Button type="submit" variant="primary" busy={busy} disabled={disabled}>{busy?text('正在测试连接…','Testing connection…'):isNew?text('测试并添加','Test and add'):cleanHost===machine.host?text('保存','Save'):text('测试并保存','Test and save')}</Button>
    {check&&!check.ok&&!busy&&<Button disabled={disabled||!valid} onClick={save}>{isNew?text('仍然添加','Add anyway'):text('仍然保存','Save anyway')}</Button>}
    <Button disabled={busy} onClick={onCancel}>{text('取消','Cancel')}</Button>
   </div>
  </form>
  {check&&!busy&&<CheckResult check={check} host={cleanHost}/>}
 </section>;
}
