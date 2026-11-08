import type {Agent,Config} from '../shared/types';
import {effectiveResponseStyle,responseStyleLabels} from '../shared/response-style';
import {runtimeLabel} from '../shared/runtimes';
import {useLanguage} from './i18n';
import {ObjectAssociations,ObjectGroup,ObjectRow,ObjectText} from './ObjectExperience';
import {agentCapabilities} from './AgentSettings';
import ObjectSummary from './ObjectSummary';
import Button from './ui/Button';
import Icon from './ui/Icon';

export default function AgentOverview({agent,config,disabled,pending,onNavigate,onChange}: {
 agent:Agent;config:Config;disabled:boolean;pending:boolean;onNavigate:(path:string)=>void;onChange:(update:(config:Config)=>Config)=>void;
}) {
 const {text: localize, t}=useLanguage(),say=(zh:string,en:string)=>localize(zh, en);
 const configure=(tab:string)=>onNavigate('/agents/'+encodeURIComponent(agent.id)+'?tab='+tab);
 const {skills,connections,summary}=agentCapabilities(agent,config,say);
 const patch=(value:Partial<Agent>)=>onChange(current=>({...current,agents:current.agents.map(item=>item.id===agent.id?{...item,...value}:item)}));
 return <div className="agent-overview">
  <ObjectSummary kind="agent" id={agent.id} disabled={disabled||pending} onNavigate={onNavigate}/>
  <ObjectText maxLength={20000} label={say('职责与指令','Role and instructions')} value={agent.instructions} onChange={instructions=>patch({instructions})} disabled={disabled} pending={pending} footer={<>
   <ObjectRow label={say('回答风格','Response style')}>{t(responseStyleLabels[effectiveResponseStyle(config,agent)])}</ObjectRow>
   <ObjectRow label={say('执行端与模型','CLI and model')}>{runtimeLabel(agent.defaultCli)} · {agent.models[agent.defaultCli]||say('沿用对话／任务默认','Use Chat / Task defaults')}</ObjectRow>
  </>}/>
  <ObjectGroup title={say('能力与知识','Capabilities and knowledge')} actions={<Button disabled={disabled||pending} onClick={()=>configure('capabilities')}>{say('配置','Configure')}</Button>}>
   <ObjectRow label={say('技能','Skills')} hint={say('已配置的关联，不代表连接验证结果','Configured associations, not connection verification')}><span className={skills.length?undefined:'object-muted'}>{summary(skills)||say('尚未配置技能','No skills configured')}</span></ObjectRow>
   <ObjectRow label={say('MCP 连接','MCP connections')}><span className={connections.length?undefined:'object-muted'}>{summary(connections)||say('尚未配置连接','No connections configured')}</span></ObjectRow>
   <ObjectRow label={say('参考知识','Reference knowledge')}><Button disabled={disabled||pending} onClick={()=>configure('knowledge')}>{agent.knowledgeIds?.length??0} {say('项关联','references')}<Icon name="arrowRight" size={14}/></Button></ObjectRow>
  </ObjectGroup>
  <ObjectAssociations kind="agent" id={agent.id} config={config} disabled={disabled} pending={pending} onChange={onChange} onNavigate={onNavigate}/>
 </div>;
}
