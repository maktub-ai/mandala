import {useState} from 'react';
import IdentityAvatar from './IdentityAvatar';
import type {Config} from '../shared/types';
import type {DisplayEvent} from '../shared/types';
import {managedValueText,type ManagementProposal} from '../shared/mandala-coordination';
import Button from './ui/Button';
import Disclosure from './ui/Disclosure';
import StatusLabel from './ui/StatusLabel';
import Icon from './ui/Icon';
import OperationCard,{OperationLink} from './OperationCard';
import {requestJson} from './api';
import {useLanguage} from './i18n';

export default function MandalaCoordinationCards({events,allEvents,onOpen,config}:{config:Config;events:DisplayEvent[];allEvents:DisplayEvent[];onOpen:(path:string)=>void}) {
 const {text:t}=useLanguage();
 const [pending,setPending]=useState(''),[errors,setErrors]=useState<Record<string,string>>({}),[resolved,setResolved]=useState<Record<string,ManagementProposal>>({});
 const latest=new Map<string,ManagementProposal>(),groups=new Map<string,ManagementProposal[]>(),seen=new Set<string>();
 for(const event of allEvents){const proposal=event.kind==='metadata'&&(event.data as {mandalaProposal?:ManagementProposal}).mandalaProposal;if(proposal)latest.set(proposal.id,proposal);}
 for(const event of events){
  const data=event.data as {sourceEventId?:number|null;mandalaProposal?:ManagementProposal};
  if(event.kind!=='metadata'||!data.mandalaProposal||!Object.hasOwn(data,'sourceEventId')||seen.has(data.mandalaProposal.id))continue;
  seen.add(data.mandalaProposal.id);
  const p=resolved[data.mandalaProposal.id]??latest.get(data.mandalaProposal.id)??data.mandalaProposal;
  if(p.unchanged||p.failure||!['applied','pending'].includes(p.status))continue;
  const key=data.sourceEventId?`${data.sourceEventId}:${p.change.action}`:p.id;
  groups.set(key,[...groups.get(key)??[],p]);
 }
 const decide=async(proposal:ManagementProposal,decision:'approve'|'reject')=>{
  setPending(proposal.id);setErrors(current=>({...current,[proposal.id]:''}));
  try{const result=await requestJson<ManagementProposal>('/api/mandala/proposals/'+encodeURIComponent(proposal.id),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:proposal.version,decision})});setResolved(current=>({...current,[result.id]:result}));}
  catch(error){setErrors(current=>({...current,[proposal.id]:error instanceof Error?error.message:String(error)}));}finally{setPending('');}
 };
 const fields:Record<string,string>={name:t('名称','Name'),instructions:t('职责说明','Instructions'),defaultCli:t('执行端','Runtime'),models:t('模型','Models'),maxParallel:t('并发数','Concurrency'),responseStyle:t('回复风格','Response style'),mcp:t('MCP 连接','MCP connections'),skills:t('Skill','Skills'),skillIds:t('Skill 绑定数量','Skill bindings'),connectionIds:t('连接绑定数量','Connection bindings'),agentIds:t('成员数量','Members'),cwd:t('工作目录','Working directory'),workspaces:t('工作空间','Workspaces'),background:t('项目介绍','Project introduction'),runtime:t('执行端配置','Runtime settings')};
 const state=(p:ManagementProposal)=>p.status==='failed'?t('未应用','Not applied'):p.failure||errors[p.id]?t('结果待确认','Result unconfirmed'):p.status==='applied'?t('已应用','Applied'):p.status==='rejected'?t('已拒绝','Rejected'):t('待确认','Approval needed');
 const detail=(p:ManagementProposal)=>{
  const after=p.summary?.after??Object.fromEntries(Object.entries(p.change.values??{}).filter(([key])=>key!=='id').map(([key,value])=>[key,managedValueText(key,value)]));
  return <Disclosure className="operation-change-disclosure" title="" summaryLabel={t('查看具体变更：','Review exact changes: ')+String(p.objectName??p.change.values?.name??'')}><dl className="operation-change-list">{Object.entries(after).map(([key,value])=><div key={key} style={{display:'contents'}}><dt>{fields[key]??key}</dt><dd>{p.summary?.before[key]&&p.summary.before[key]!=='—'&&<><span className="operation-row-note">{p.summary.before[key]}</span>{' → '}</>}{value||t('空','Empty')}</dd></div>)}</dl>{!Object.keys(after).length&&<p>{t('保留已有历史与身份。','Existing identity and history are retained.')}</p>}</Disclosure>;
 };
 const item=(p:ManagementProposal)=>{
  const name=String(p.objectName||p.change.values?.name||p.summary?.before.name||t(p.change.kind==='agent'?'智能体':'项目',p.change.kind==='agent'?'Agent':'Project'));
  const path=p.change.kind==='agent'?'/agents?agent='+encodeURIComponent(String(p.change.id??p.change.values?.id??'')):'/projects/'+encodeURIComponent(String(p.change.id??p.change.values?.id??''));
  const id=String(p.change.id??p.change.values?.id??''),identity=(p.change.kind==='agent'?config.agents:config.projects).find(item=>item.id===id);
  return <div className="operation-row" key={p.id}>{identity?<IdentityAvatar identity={identity} kind={p.change.kind} size={28}/>:<Icon name={p.change.kind==='agent'?'agent':'project'} size={24}/>}<div className="operation-row-main"><OperationLink path={path} onOpen={onOpen} iconOnly={false}>{name}</OperationLink>{detail(p)}{(p.failure||errors[p.id])&&<p role="alert" className="operation-card-error">{errors[p.id]||p.failure?.code} {t('请先核对当前配置；若配置已变化，请让 Mandala 重新提出变更。','Check current configuration first; ask Mandala for an updated proposal if it changed.')}</p>}{p.status==='pending'&&!p.failure&&<div className="operation-card-actions">{!errors[p.id]&&<Button variant="primary" busy={pending===p.id} disabled={!!pending} onClick={()=>void decide(p,'approve')}>{t('确认此变更','Confirm this change')}</Button>}<Button disabled={!!pending} onClick={()=>void decide(p,'reject')}>{t('拒绝','Reject')}</Button></div>}</div>{p.status!=='applied'&&<StatusLabel filled icon="clock" tone={p.failure||errors[p.id]?'warning':'neutral'}>{state(p)}</StatusLabel>}</div>;
 };
 return <>{events.filter(event=>event.kind==='metadata').map(event=>{
  const request=(event.data as {mandalaRequest?:{taskId:string;text:string;blocked:boolean}}).mandalaRequest;
  return request?<OperationCard key={event.id} flat icon="approval" title={request.blocked?t('目标受阻','Goal blocked'):t('需要你的决定','Your decision is needed')} status={t('等待你回复','Awaiting your reply')} tone="warning" footer={t('在当前对话回复即可继续。','Reply in this conversation to continue.')} actions={<OperationLink path={'/tasks/'+encodeURIComponent(request.taskId)} onOpen={onOpen}>{t('查看任务','View task')}</OperationLink>}><p>{request.text}</p></OperationCard>:null;
 })}{[...groups.entries()].map(([key,items])=>{
  const p=items[0],applied=items.filter(p=>p.status==='applied').length,waiting=items.some(p=>p.status==='pending'),attention=items.some(p=>p.failure||errors[p.id]),allApplied=applied===items.length;
  const priority=(p:ManagementProposal)=>p.failure||errors[p.id]?0:p.status==='pending'?1:2;
  const ordered=[...items].sort((a,b)=>priority(a)-priority(b));
  const nouns=p.change.kind==='agent'?t('智能体','Agents'):t('项目','Projects');
  const identities=[...new Map(items.flatMap(item=>{const id=String(item.change.id??item.change.values?.id??''),identity=(item.change.kind==='agent'?config.agents:config.projects).find(value=>value.id===id);return identity?[{identity,kind:item.change.kind}]:[];}).map(item=>[item.kind+item.identity.id,item])).values()];
  const kinds=new Set(items.map(item=>item.change.kind));
  const verbs={create:t('创建','Created'),update:t('更新','Updated'),archive:t('归档','Archived'),promote:t('保留为长期智能体','Kept as permanent')};
  const title=kinds.size>1?t(`配置变更 · ${items.filter(item=>item.change.kind==='agent').length} 个智能体、${items.filter(item=>item.change.kind==='project').length} 个项目`,`Configuration · ${items.length} changes`):attention?t(`配置操作待核对 · 已应用 ${applied}/${items.length} 项`,`Configuration needs review · ${applied}/${items.length} applied`):allApplied?t(`已${verbs[p.change.action]} ${items.length} 个${nouns}`,`${verbs[p.change.action]} ${items.length} ${nouns}`):applied?t(`已应用 ${applied}/${items.length} 项变更`,`Applied ${applied}/${items.length} changes`):waiting?t('配置变更待确认','Configuration changes awaiting approval'):t('配置变更已拒绝','Configuration changes rejected');
  return <OperationCard key={key} open={waiting||attention||undefined} icon="settings" summary={<span className="operation-avatar-stack">{identities.slice(0,4).map(({identity,kind})=><IdentityAvatar key={kind+identity.id} identity={identity} kind={kind} size={24}/>)}{identities.length>4&&<small>+{identities.length-4}</small>}</span>} title={title} label={waiting&&!attention?t('配置变更提案','Configuration proposal'):t('配置操作结果','Configuration result')} status={attention?t('需要关注','Needs attention'):allApplied?t('已应用','Applied'):waiting?t('待确认','Approval needed'):t('已拒绝','Rejected')} tone={attention?'warning':allApplied?'success':'neutral'}><div className="operation-rows operation-config-rows">{ordered.map(item)}</div></OperationCard>;
 })}</>;
}
