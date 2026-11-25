import {BlueprintRouteReview} from './BlueprintRouteReview';
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
 const changes=(p:ManagementProposal)=>{
  const after=p.summary?.after??Object.fromEntries(Object.entries(p.change.values??{}).filter(([key])=>key!=='id').map(([key,value])=>[key,managedValueText(key,value)]));
  return Object.entries(after).map(([key,value])=>{const before=p.summary?.before[key];return {key,label:fields[key]??key,before:before&&before!=='—'?before:'',after:value||t('空','Empty')};});
 };
 const detail=(p:ManagementProposal)=>{
  const list=changes(p);
  return <Disclosure className="operation-change-disclosure" title={t('查看差异','Review changes')} summaryLabel={t('查看具体变更：','Review exact changes: ')+String(p.objectName??p.change.values?.name??'')}><dl className="operation-change-list">{list.map(change=><div key={change.key} style={{display:'contents'}}><dt>{change.label}</dt><dd>{change.before&&<><span className="operation-row-note">{change.before}</span>{' → '}</>}{change.after}</dd></div>)}</dl>{!list.length&&<p>{t('保留已有历史与身份。','Existing identity and history are retained.')}</p>}</Disclosure>;
 };
 const verbChip={create:t('新建','New'),update:t('更新','Update'),archive:t('归档','Archive'),promote:t('转为长期','Keep')};
 const item=(p:ManagementProposal)=>{
  const name=String(p.objectName||p.change.values?.name||p.summary?.before.name||t(p.change.kind==='agent'?'智能体':'项目',p.change.kind==='agent'?'Agent':'Project'));
  const path=p.change.kind==='agent'?'/agents?agent='+encodeURIComponent(String(p.change.id??p.change.values?.id??'')):'/projects/'+encodeURIComponent(String(p.change.id??p.change.values?.id??''));
  const id=String(p.change.id??p.change.values?.id??''),identity=(p.change.kind==='agent'?config.agents:config.projects).find(item=>item.id===id);
  const list=changes(p).filter(change=>change.key!=='name'||p.change.action==='update');
  const inline=list.slice(0,2).map(change=>change.label+' '+(change.before?change.before+' → ':'')+change.after).join('；');
  const folded=list.length>2||list.some(change=>(change.before+change.after).length>60);
  const failed=Boolean(p.failure||errors[p.id]);
  return <div className="operation-row" key={p.id}>
   {identity?<IdentityAvatar identity={identity} kind={p.change.kind} size={22}/>:<Icon name={p.change.kind==='agent'?'agent':'project'} size={20}/>}
   <div className="operation-row-main">
    <div className="operation-row-line"><OperationLink path={path} onOpen={onOpen} iconOnly={false} className="operation-row-name">{name}</OperationLink><span className="operation-chip">{verbChip[p.change.action]}</span>{inline&&<span className="operation-diff" title={inline}>{inline}</span>}</div>
    {folded&&<div className="operation-message-actions">{detail(p)}</div>}
    {failed&&<p role="alert" className="operation-card-error">{errors[p.id]||p.failure?.code} {t('请先核对当前配置；若配置已变化，请让 Mandala 重新提出变更。','Check current configuration first; ask Mandala for an updated proposal if it changed.')}</p>}
   </div>
   <div className="operation-row-side">
    {p.status==='pending'&&!p.failure?<>{<Button size="sm" disabled={!!pending} onClick={()=>void decide(p,'reject')}>{t('拒绝','Reject')}</Button>}{!errors[p.id]&&<Button size="sm" variant="primary" busy={pending===p.id} disabled={!!pending} onClick={()=>void decide(p,'approve')}>{t('确认此变更','Confirm this change')}</Button>}</>
     :<StatusLabel filled icon={p.status==='applied'?'check':'clock'} tone={failed?'warning':p.status==='applied'?'success':'neutral'}>{state(p)}</StatusLabel>}
   </div>
  </div>;
 };
 return <>{events.filter(event=>event.kind==='metadata').map(event=>{
  const reviewId=(event.data as {blueprintRouteReview?:string}).blueprintRouteReview;
  if(reviewId)return <BlueprintRouteReview key={reviewId} reviewId={reviewId} onOpen={onOpen}/>;
  const request=(event.data as {mandalaRequest?:{taskId:string;text:string;blocked:boolean}}).mandalaRequest;
  return request?<OperationCard key={event.id} attention icon="approval" title={request.blocked?t('目标受阻','Goal blocked'):t('需要你的决定','Your decision is needed')} status={t('等待你回复','Awaiting your reply')} tone="warning" footer={t('在当前对话回复即可继续。','Reply in this conversation to continue.')} actions={<OperationLink path={'/tasks/'+encodeURIComponent(request.taskId)} onOpen={onOpen} iconOnly={false}>{t('查看任务','View task')}</OperationLink>}><p>{request.text}</p></OperationCard>:null;
 })}{[...groups.entries()].map(([key,items])=>{
  const p=items[0],applied=items.filter(p=>p.status==='applied').length,waiting=items.some(p=>p.status==='pending'),attention=items.some(p=>p.failure||errors[p.id]),allApplied=applied===items.length;
  const priority=(p:ManagementProposal)=>p.failure||errors[p.id]?0:p.status==='pending'?1:2;
  const ordered=[...items].sort((a,b)=>priority(a)-priority(b));
  const nouns=p.change.kind==='agent'?t('智能体','Agents'):t('项目','Projects');
  const kinds=new Set(items.map(item=>item.change.kind));
  const verbs={create:t('创建','Created'),update:t('更新','Updated'),archive:t('归档','Archived'),promote:t('保留为长期智能体','Kept as permanent')};
  const title=kinds.size>1?t(`配置变更 · ${items.filter(item=>item.change.kind==='agent').length} 个智能体、${items.filter(item=>item.change.kind==='project').length} 个项目`,`Configuration · ${items.length} changes`):attention?t(`配置操作待核对 · 已应用 ${applied}/${items.length} 项`,`Configuration needs review · ${applied}/${items.length} applied`):allApplied?t(`已${verbs[p.change.action]} ${items.length} 个${nouns}`,`${verbs[p.change.action]} ${items.length} ${nouns}`):applied?t(`已应用 ${applied}/${items.length} 项变更`,`Applied ${applied}/${items.length} changes`):waiting?t('配置变更待确认','Configuration changes awaiting approval'):t('配置变更已拒绝','Configuration changes rejected');
  const pendingCount=items.filter(p=>p.status==='pending').length;
  const counts=[applied&&t(`${applied} 项已应用`,`${applied} applied`),pendingCount&&t(`${pendingCount} 项待确认`,`${pendingCount} awaiting approval`)].filter(Boolean).join(' · ');
  return <OperationCard key={key} attention={waiting||attention} icon="settings" summary={counts||undefined} title={title} label={waiting&&!attention?t('配置变更提案','Configuration proposal'):t('配置操作结果','Configuration result')} status={attention?t('需要关注','Needs attention'):undefined} tone={attention?'warning':'neutral'}><div className="operation-rows">{ordered.map(item)}</div></OperationCard>;
 })}</>;
}
