import {useMemo} from 'react';
import type {NativeSubagent} from '../shared/native-subagents';
import {nativeSubagents} from '../shared/native-subagents';
import {runtimeLabel} from '../shared/runtimes';
import type {Cli} from '../shared/types';
import type {ChatTurn} from './chatTurns';
import IdentityAvatar from './IdentityAvatar';
import {useLanguage} from './i18n';
import Disclosure from './ui/Disclosure';
import StatusLabel from './ui/StatusLabel';
import './native-subagents.css';

const states = {
  running:['运行中','Running','play','active'],
  completed:['已完成','Completed','check','success'],
  failed:['失败','Failed','error','danger'],
  interrupted:['已中断','Interrupted','stop','warning'],
  dispatching:['派发中','Dispatching','clock','neutral'],
  dispatched:['已派发','Dispatched','send','neutral'],
  unknown:['状态未上报','Status unknown','clock','neutral'],
} as const;

type AvatarScope = {cli:Cli;conversationId:string};

export function NativeSubagentList({rows,scope}:{rows:NativeSubagent[];scope?:AvatarScope}) {
  const {text:label}=useLanguage();
  if(!rows.length)return null;
  const count=rows.filter(row=>row.agentId).length;
  return <section className="native-subagent-list" aria-label={label('子代理','Subagents')}>
    <header><strong>{label('子代理','Subagents')}</strong>{count>0&&<span>{label(`${count} 个`,String(count))}</span>}</header>
    {rows.map(row=>{
      const id=row.agentId;
      const name=row.name||(id&&id.length>24?id.slice(0,12)+'…'+id.slice(-6):id);
      const title=row.task||name||label('派发回执','Dispatch receipt');
      const [zh,en,icon,tone]=states[row.status];
      const subtitle=row.task&&name!==title?name:undefined;
      const seed=scope&&row.agentId?JSON.stringify([scope.cli,scope.conversationId,row.agentId]):undefined;
      const summary=<>{seed&&<IdentityAvatar kind="agent" size={26} identity={{id:seed,name:name??title}}/>}
        <span className="native-subagent-name"><strong>{title}</strong>{subtitle&&<small>{subtitle}</small>}</span>
        <StatusLabel filled icon={icon} tone={tone}>{row.status==='failed'&&!row.agentId?label('派发失败','Dispatch failed'):label(zh,en)}</StatusLabel></>;
      return row.text||row.agentId?<Disclosure key={row.id} className="native-subagent-row" title={summary}>
        {row.text&&<p className="native-subagent-text">{row.text}</p>}
        {row.agentId&&<small className="native-subagent-id">{label('子代理 ID','Subagent ID')} · {row.agentId}</small>}
      </Disclosure>:<div key={row.id} className="native-subagent-row native-subagent-receipt">{summary}</div>;
    })}
  </section>;
}

export default function ConversationSubagents({turns,cli,conversationId}:{turns:ChatTurn[]}&AvatarScope) {
  const {text:label}=useLanguage();
  const groups=useMemo(()=>turns.flatMap((turn,index)=>{
    const rows=nativeSubagents(turn.events,cli);
    return rows.length?[{key:turn.key,number:index+1,request:turn.messages.find(message=>message.kind==='user')?.text,rows}]:[];
  }).reverse(),[turns,cli]);
  if(!groups.length)return <p className="native-subagent-empty">{label('此对话还没有子代理记录。','No subagent activity in this chat yet.')}</p>;
  return <div className="native-subagent-history">{groups.map(group=><section key={group.key} className="native-subagent-turn">
    <header><h3>{label(`第 ${group.number} 轮`,`Turn ${group.number}`)}</h3><span>{runtimeLabel(cli)}</span></header>
    {group.request&&<p className="native-subagent-request" title={group.request}>{group.request}</p>}
    <NativeSubagentList rows={group.rows} scope={{cli,conversationId}}/>
  </section>)}</div>;
}
