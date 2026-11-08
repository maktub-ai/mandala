import {useEffect,useState,type Dispatch,type SetStateAction} from 'react';
import type {Agent,Config} from '../shared/types';
import {enabledRuntimes,runtimeLabel} from '../shared/runtimes';
import {identityColor} from '../shared/identity';
import {effectiveResponseStyle,responseStyles,responseStyleLabels,responseStyleDescriptions,type ResponseStyle} from '../shared/response-style';
import {useLanguage} from './i18n';
import AgentCapabilities from './AgentCapabilities';
import DocumentLinks from './DocumentLinks';
import IdentityAvatar from './IdentityAvatar';
import IdentityPicker from './IdentityPicker';
import ModelCatalogPicker,{type ModelCatalog} from './ModelCatalogPicker';
import RuntimeSettingsEditor,{AgentApprovalSettings} from './RuntimeSettingsEditor';
import Dialog from './Dialog';
import Button from './ui/Button';
import Input from './ui/Input';
import Textarea from './ui/Textarea';
import Select from './ui/Select';
import Field from './ui/Field';
import Disclosure from './ui/Disclosure';
import RuntimeIcon from './ui/RuntimeIcon';
import Icon from './ui/Icon';
import {DetailSection} from './ui/WorkspacePage';
import './agent-settings.css';

type Manager='skills'|'mcp'|'knowledge'|'appearance';
export function agentCapabilities(agent:Agent,config:Config,say:(zh:string,en:string)=>string) {
 const skills=[...(agent.skillIds??[]).map(id=>({name:config.skillLibrary?.find(item=>item.id===id)?.name??say('引用已不可用','Unavailable reference'),paused:agent.disabledSkillIds?.includes(id)})),...agent.skills.map(item=>({name:item.name,paused:false}))];
 const connections=[...(agent.connectionIds??[]).map(id=>({name:config.connections?.find(item=>item.id===id)?.name??say('引用已不可用','Unavailable reference'),paused:agent.disabledConnectionIds?.includes(id)})),...agent.mcp.map(item=>({name:item.name,paused:false}))];
 const summary=(items:typeof skills)=>items.map(item=>item.name+(item.paused?say('（已暂停）',' (paused)'):'')).join('、');
 return {skills,connections,summary};
}

export default function AgentSettings({agent,config,savedConfig,catalog,disabled,pending,initialTab,onChange,onRefresh,onNavigate}: {
 agent:Agent;config:Config;savedConfig:Config;catalog:ModelCatalog;disabled:boolean;pending:boolean;initialTab:string;
 onChange:Dispatch<SetStateAction<Config>>;onRefresh:()=>void;onNavigate:(path:string)=>void;
}) {
 const {text:say,t}=useLanguage();
 const [manager,setManager]=useState<Manager|null>(null);
 useEffect(()=>{setManager(initialTab==='capabilities'?'skills':initialTab==='knowledge'?'knowledge':null);},[initialTab]);
 const patch=(value:Partial<Agent>)=>onChange(current=>({...current,agents:current.agents.map(item=>item.id===agent.id?{...item,...value}:item)}));
 const runtimes=enabledRuntimes(config),cli=agent.defaultCli;
 const {skills,connections,summary}=agentCapabilities(agent,config,say);
 const policy=agent.runtime?.[cli]?.approvalMode;
 const policyLabel=policy?t(policy==='auto'?'自动批准':policy==='strict'?'严格审批':'按需审批'):say('沿用执行端默认','Use runtime default');
 const managerTitle=manager==='appearance'?say('名称与外观','Name and appearance'):manager==='knowledge'?say('参考知识','Reference knowledge'):manager==='mcp'?t('MCP 连接'):t('技能');
 return <div className="agent-settings-form">
  <DetailSection title={say('执行端与模型','CLI and model')} actions={<Button variant="ghost" disabled={disabled||pending} onClick={()=>onNavigate('/settings/runtimes')}>{say('管理执行端接入','Manage CLI adapters')}<Icon name="external-link" size={14}/></Button>}>
   <div className="agent-settings-fields">
    <Field label={say('执行端','CLI')} hint={!runtimes.includes(cli)?t('所选执行端已停用；请在执行端接入中启用，或选择其他执行端。'):say('已启用的执行端可在这里切换。','Choose from enabled CLI adapters.')}>
     <Select ariaLabel={t('默认执行端')} disabled={disabled||!runtimes.length} value={cli} onChange={value=>patch({defaultCli:value as Agent['defaultCli']})} options={[...new Set([...runtimes,cli])].map(value=>({value,label:runtimeLabel(value),icon:<RuntimeIcon cli={value}/>,disabled:!runtimes.includes(value)}))}/>
    </Field>
    <div className="agent-settings-model"><span className="agent-settings-label">{t('默认模型')}</span><ModelCatalogPicker catalog={catalog} value={agent.models[cli]??''} disabled={disabled} ariaLabel={`${runtimeLabel(cli)} ${t('默认模型')}`} defaultLabel={say('沿用对话／任务默认','Use Chat / Task defaults')} onChange={value=>patch({models:{...agent.models,[cli]:value||undefined}})} onRefresh={onRefresh}/><p className="field-hint">{say('留空时，对话和任务分别沿用各自默认设置。','An empty model leaves Chats and Tasks to use their respective defaults.')}</p></div>
   </div>
  </DetailSection>
  <DetailSection title={say('身份与回答','Identity and response')}>
   <div className="agent-settings-fields">
    <div className="agent-settings-name"><span className="agent-settings-label">{say('名称与外观','Name and appearance')}</span><div><Button className="agent-appearance-button" disabled={disabled} aria-label={say('编辑外观','Edit appearance')} onClick={()=>setManager('appearance')}><IdentityAvatar identity={agent} kind="agent" size={24}/></Button><Input aria-label={say('名称','Name')} disabled={disabled} value={agent.name} onChange={event=>patch({name:event.target.value})}/></div></div>
    <Field label={t('回答风格')} hint={t(responseStyleDescriptions[effectiveResponseStyle(config,agent)])}>
     <Select ariaLabel={t('Agent 回答风格')} disabled={disabled} searchable={false} value={agent.responseStyle??''} onChange={value=>patch({responseStyle:value as ResponseStyle||undefined})} options={[{value:'',label:t('继承全局（{style}）',{style:t(responseStyleLabels[effectiveResponseStyle(config)])})},...responseStyles.map(value=>({value,label:t(responseStyleLabels[value])}))]}/>
    </Field>
   </div>
   <Field className="agent-settings-instructions" label={t('职责与指令')} hint={say('修改后从下一次执行生效；当轮要求优先。','Changes apply on the next execution; instructions for the current turn take priority.')}>
    <Textarea aria-label={t('职责与指令')} disabled={disabled} rows={4} value={agent.instructions} onChange={event=>patch({instructions:event.target.value})}/>
   </Field>
  </DetailSection>
  <DetailSection title={say('工具与知识','Tools and knowledge')}>
   <div className="agent-resource-row"><span>{t('技能')}</span><p>{summary(skills)||say('尚未配置技能','No Agent skills configured')}</p><Button disabled={disabled} onClick={()=>setManager('skills')}><Icon name={skills.length?'settings':'plus'} size={14}/>{skills.length?say('管理技能','Manage skills'):t('添加技能')}</Button></div>
   <div className="agent-resource-row"><span>{t('MCP 连接')}</span><p>{summary(connections)||say('尚未配置连接','No Agent connections configured')}</p><Button disabled={disabled} onClick={()=>setManager('mcp')}><Icon name={connections.length?'settings':'plus'} size={14}/>{connections.length?say('管理连接','Manage connections'):t('添加连接')}</Button></div>
   <div className="agent-resource-row"><span>{say('参考知识','Reference knowledge')}</span><p>{agent.knowledgeIds?.length?say(`已引用 ${agent.knowledgeIds.length} 项资料`,`${agent.knowledgeIds.length} references`):say('尚未引用资料','No references selected')}</p><Button disabled={disabled} onClick={()=>setManager('knowledge')}><Icon name={agent.knowledgeIds?.length?'settings':'plus'} size={14}/>{agent.knowledgeIds?.length?say('管理资料','Manage references'):say('引用资料','Add references')}</Button></div>
   <p className="field-hint">{say('管理中可查看执行环境自带能力；已配置不代表实际加载结果。','Management also lists runtime-provided capabilities; configuration does not confirm loading.')}</p>
  </DetailSection>
  <Disclosure className="agent-settings-advanced" title={<><span>{say('权限与高级设置','Permissions and advanced settings')}</span><small>{say('默认审批：','Default approval: ')}{policyLabel} · {say('后台并行：','Background limit: ')}{agent.maxParallel??3}</small></>}>
   <Field label={say('后台并行上限','Background concurrency limit')} hint={say('默认 3；降低上限不会打断正在执行的工作。','Default 3. Existing executions continue when this is reduced.')}><Input type="number" min={1} step={1} disabled={disabled} value={agent.maxParallel??3} onChange={event=>{const value=Number(event.target.value);if(Number.isSafeInteger(value)&&value>0)patch({maxParallel:value});}}/></Field>
   <AgentApprovalSettings key={`${agent.id}:${cli}`} agentId={agent.id} cli={cli} value={agent.runtime} defaults={savedConfig.runtimeDefaults} savedValue={savedConfig.agents.find(item=>item.id===agent.id)?.runtime} available={savedConfig.agents.some(item=>item.id===agent.id)&&enabledRuntimes(savedConfig).includes(cli)} onChange={runtime=>patch({runtime})}/>
   <RuntimeSettingsEditor cli={cli} value={agent.runtime} defaults={savedConfig.runtimeDefaults} hideApproval onChange={runtime=>patch({runtime})}/>
  </Disclosure>
  {manager&&<Dialog label={managerTitle} className="agent-settings-manager" locked={disabled} onClose={()=>setManager(null)}>
   <div className="agent-manager-heading"><h2>{managerTitle}</h2><Button className="icon-button" disabled={disabled} aria-label={say('关闭','Close')} onClick={()=>setManager(null)}><Icon name="close" size={16}/></Button></div>
   {manager==='appearance'?<><IdentityPicker kind="agent" identity={agent} onChange={patch}/><div className="identity-settings-row"><label>{t('身份颜色')}<Input type="color" aria-label={t('身份颜色')} value={identityColor(agent,'agent')} onChange={event=>patch({color:event.target.value})}/></label><Button disabled={!agent.color} onClick={()=>patch({color:undefined})}>{t('恢复默认颜色')}</Button></div></>:manager==='knowledge'?<DocumentLinks embedded ids={agent.knowledgeIds??[]} agentId={agent.id} onChange={knowledgeIds=>patch({knowledgeIds})}/>:<AgentCapabilities key={manager} initialKind={manager} config={config} savedConfig={savedConfig} agent={agent} onChange={onChange} onOpenLibrary={()=>onNavigate('/mana/skills')}/>}
  </Dialog>}
 </div>;
}
