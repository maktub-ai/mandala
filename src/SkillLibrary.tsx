import MetadataList from './ui/MetadataList';
import Field from './ui/Field';
import Notice from './ui/Notice';
import Input from './ui/Input';
import Textarea from './ui/Textarea';
import Button from './ui/Button';
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { Config, SkillDefinition } from "../shared/types";
import { validateManagedSkillContent } from "../shared/skills";
import { api } from "./api";
import type { AssetVersion } from "../shared/assets";
import Disclosure from "./ui/Disclosure";
import LoadingState from "./ui/LoadingState";
import Dialog from "./Dialog";
import { useLanguage } from "./i18n";
import Icon from "./ui/Icon";
import IdentityAvatar from "./IdentityAvatar";
import "./team-capabilities.css";

export type ChangeTeamConfig = Dispatch<SetStateAction<Config>>;
const contentError = (name: string, content: string) => {
  const error = validateManagedSkillContent(name, content);
  if (!error) return undefined;
  return error === "Skill content must contain 1 to 200000 characters" ? "技能内容不能为空，且不能超过 200000 个字符。" as const : "技能头部必须包含对应的 name 和非空 description。" as const;
};

export function RegisterSkill({ config, onRegister, onCancel, assign = false, reservedNames = [] }: {
  config: Config; onRegister: (skill: SkillDefinition) => void; onCancel: () => void; assign?: boolean; reservedNames?: string[];
}) {
  const { t } = useLanguage();
  const [name, setName] = useState(""), [content, setContent] = useState("---\nname: new-skill\ndescription: Describe when to use this skill.\n---\n\n# Skill instructions\n\nDescribe the steps here.\n"), [error, setError] = useState("");
  return <form className="team-skill-form" onSubmit={event => {
    event.preventDefault();
    const identifier = name.trim();
    if (!/^[A-Za-z0-9_-]+$/.test(identifier) || !content.trim()) { setError(t("请填写有效的技能标识和非空技能内容。")); return; }
    if ((config.skillLibrary?.some(skill => skill.name === identifier) || reservedNames.includes(identifier))) { setError(t("系统中已有此技能标识，请选择已有技能。")); return; }
    const invalidContent = contentError(identifier, content);
    if (invalidContent) { setError(t(invalidContent)); return; }
    onRegister({ id: crypto.randomUUID(), name: identifier, path: "", content });
  }}>
    <p className="field-hint">{t("技能内容保存在系统中，分配后供智能体使用。")}</p>
    <Field label={t("技能标识")} hint={t("使用字母、数字、连字符或下划线，作为执行时的技能名称。")}><Input aria-label={t("技能标识")} value={name} onChange={event => { setName(event.target.value); setContent(value => value.replace(/^name:.*$/m, `name: ${event.target.value.trim()}`)); }} required maxLength={100} /></Field>
    <label>{t("SKILL.md 内容")}<Textarea aria-label={t("SKILL.md 内容")} rows={10} maxLength={200000} value={content} onChange={event => setContent(event.target.value)} required /></label>
    {error && <Notice as="p" className="field-error">{error}</Notice>}
    <div className="team-capability-actions"><Button type="button" onClick={onCancel}>{t("取消")}</Button><Button type="submit" className="primary">{t(assign ? "注册并添加" : "注册技能")}</Button></div>
  </form>;
}

export default function SkillLibrary({ config, onChange, onReload, busy=false }: { config: Config; onChange: ChangeTeamConfig; onReload?:()=>void; busy?:boolean }) {
  const {text: localize,  t } = useLanguage();
  const say=(zh:string,en:string)=>localize(zh, en);
  const [selectedId, setSelectedId] = useState(() => typeof location==='undefined'?'':new URLSearchParams(location.search).get('skill')??''), [query, setQuery] = useState(""), [register, setRegister] = useState(false), [confirmDelete, setConfirmDelete] = useState(false);
  const [learning,setLearning]=useState<{id:string;conversationId:string;agentId:string;state:string;error:string|null}[]>([]);
  useEffect(()=>{let active=true,pending=false;const update=async()=>{if(document.hidden||pending)return;pending=true;try{const result=await api<{items:typeof learning}>('/skill-learning');if(active)setLearning(result.items);}catch{/* Skill history errors are displayed with the selected item. */}finally{pending=false;}};void update();const timer=setInterval(()=>void update(),30000);return()=>{active=false;clearInterval(timer);};},[]);
  const skills = config.skillLibrary ?? [];
  const selected = skills.find(item => item.id === selectedId) ?? skills[0];
  const [history,setHistory]=useState<{id:string;versions:AssetVersion[];suggestions:{id:string;content:string;agentId:string;expectedVersionId:string|null;status:string;createdAt:string;source?:SkillDefinition['source']}[]}>();
  const [historyError,setHistoryError]=useState(''),[deciding,setDeciding]=useState(false);
  useEffect(()=>{let active=true;setHistory(undefined);setHistoryError('');if(selected)api<{versions:AssetVersion[];suggestions:NonNullable<typeof history>['suggestions']}>('/skills/'+selected.id).then(data=>{if(active)setHistory({id:selected.id,...data});}).catch(error=>{if(active)setHistoryError(error.message);});return()=>{active=false;};},[selected?.id,selected?.versionRef?.versionId]);
  const decide=async(suggestionId:string,action:'accept'|'reject')=>{
    if(!selected)return;setDeciding(true);setHistoryError('');
    try{await api('/skills/'+selected.id+'/suggestions/'+suggestionId+'/'+action,'POST',{expectedVersionId:selected.versionRef?.versionId??null});const data=await api<{versions:AssetVersion[];suggestions:NonNullable<typeof history>['suggestions']}>('/skills/'+selected.id);setHistory({id:selected.id,...data});onReload?.();}
    catch(error){setHistoryError((error as Error).message);}finally{setDeciding(false);}
  };
  const owners = selected ? [...config.agents, ...config.projects].filter(owner => owner.skillIds?.includes(selected.id)) : [];
  const projects = selected ? config.projects.filter(project => project.skillIds?.includes(selected.id)) : [];
  const patchSkill = (patch: Partial<SkillDefinition>) => onChange(current => ({ ...current, skillLibrary: current.skillLibrary?.map(skill => skill.id === selected?.id ? { ...skill, ...patch } : skill) }));
  return <section className="team-skill-library" aria-label={t("技能库")}>
    <div className="team-capability-heading"><div><p className="field-hint">{t("系统托管的共享技能，内容与智能体分配在这里管理。")}</p></div><Button type="button" onClick={() => setRegister(true)}><Icon name="plus" size={16} />{t("注册技能")}</Button></div>
    <label className="team-assignment-row"><span>{say('自动提炼新对话经验','Learn reusable experience from new dialogue')}<small>{say('新技能供创建 Agent 下轮使用；共享内容先生成修改建议。','New Skills are assigned to their creator for the next turn; shared changes require review.')}</small></span><Input type="checkbox" aria-label={say('自动提炼新对话经验','Learn reusable experience from new dialogue')} checked={config.system?.skillLearning!==false} onChange={event=>{const enabled=event.target.checked;onChange(current=>({...current,system:{...current.system,skillLearning:enabled}}));}} /></label>
    {learning.length>0&&<Disclosure title={say('最近技能提炼','Recent Skill learning')}>{learning.map(job=><p key={job.id}><a className="team-learning-agent" href={'/?conversation='+encodeURIComponent(job.conversationId)}>{config.agents.find(agent=>agent.id===job.agentId)?.name??job.agentId}</a>{' · '}{job.state==='completed'?say('已处理','Processed'):job.state==='failed'?say('未发布','Not published'):say('处理中','Pending')}{job.error&&<span role="status">{' · '+job.error}</span>}</p>)}</Disclosure>}
    <div className="team-library-layout"><aside className="team-skill-index"><Input type="search" aria-label={t("查找系统技能")} placeholder={t("查找系统技能")} value={query} onChange={event => setQuery(event.target.value)} />
      {skills.filter(skill => skill.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(skill => <Button type="button" key={skill.id} aria-pressed={selected?.id === skill.id} onClick={() => setSelectedId(skill.id)}><Icon name="book" size={16} /><span>{skill.name}</span></Button>)}
    </aside><div className="team-skill-detail">{selected ? <>
      <div className="team-capability-heading"><h3>{selected.name}</h3><Button type="button" disabled={owners.length > 0} onClick={() => setConfirmDelete(true)}><Icon name="trash" size={16} />{t("删除系统技能")}</Button></div>
      {owners.length > 0 && <p className="field-hint">{t("取消所有智能体和项目的引用后才能删除。")}</p>}
      {selected.creatorAgentId&&<p className="field-hint">{say('创建 Agent：','Created by: ')}{config.agents.find(agent=>agent.id===selected.creatorAgentId)?.name??selected.creatorAgentId}{selected.humanMaintained?say(' · 人工维护',' · Human maintained'):''}</p>}
      {selected.source&&<p className="field-hint">{say('来源：','Source: ')}{selected.source.method==='dialogue'?say('对话提炼','Dialogue distillation'):selected.source.method==='agent'?say('Agent 注册','Agent registration'):say('人工编辑','Manual edit')}{' · '}{selected.source.verification==='verified'?say('已验证','Verified'):say('草稿经验，待实际验证','Draft experience; verification required')}{selected.source.conversationId&&<> · <a href={'/?conversation='+encodeURIComponent(selected.source.conversationId)}>{say('来源对话','Source conversation')}</a></>}</p>}
      {selected.unavailable&&<p role="alert" className="field-error">{say('来源或版本已不可用，此技能不会提供给 Agent。','The source or version is unavailable. This Skill will not be supplied to Agents.')}</p>}
      {typeof selected.content === "string" ? <div className="team-skill-form"><MetadataList items={[{label:say('存储','Storage'),value:t("系统托管"),icon:'book'},{label:say('维护方式','Maintenance'),value:selected.humanMaintained?say('人工维护','Human maintained'):say('共享定义','Shared definition'),icon:'users'}]}/>
        <label>{t("SKILL.md 内容")}<Textarea aria-label={t("SKILL.md 内容")} rows={12} maxLength={200000} value={selected.content} onChange={event => patchSkill({ content: event.target.value })} /></label>
        {contentError(selected.name, selected.content) && <p role="alert" className="field-error">{t(contentError(selected.name, selected.content)!)}</p>}
      </div> : <div className="team-legacy-source"><h4>{t("外部目录引用")}</h4><code>{selected.path}</code><p className="field-hint">{t("外部目录仅保留引用；请在源文件中编辑内容。")}</p></div>}
      <section className="team-assignment-section" aria-label={say('版本与修改建议','Versions and suggestions')}>
        {historyError&&<p role="alert" className="field-error">{historyError}</p>}
        {!history&&!historyError&&<LoadingState label={say('读取版本与建议','Loading versions and suggestions')}/>}
        {history?.id===selected.id&&<>
          <h3>{say('修改建议','Suggestions')}</h3>
          {history.suggestions.length===0&&<p className="field-hint">{say('暂无修改建议。','No suggestions.')}</p>}
          {history.suggestions.map(suggestion=><div key={suggestion.id} className="team-skill-form">
            <p>{config.agents.find(agent=>agent.id===suggestion.agentId)?.name??suggestion.agentId}{' · '}{suggestion.status==='pending'?say('待维护者确认','Pending review'):suggestion.status==='accepted'?say('已采纳','Accepted'):say('已拒绝','Rejected')}</p>
            <p className="field-hint">{say('版本基线：','Version baseline: ')}{suggestion.expectedVersionId??say('外部目录','External directory')}{' · '}{new Date(suggestion.createdAt).toLocaleString()}</p>
            <Disclosure title={say('查看建议正文','Read suggested content')}><pre className="team-skill-suggestion-content">{suggestion.content}</pre></Disclosure>
            {suggestion.status==='pending'&&<div className="team-capability-actions"><Button type="button" disabled={busy||deciding} onClick={()=>void decide(suggestion.id,'reject')}>{say('拒绝建议','Reject suggestion')}</Button><Button type="button" disabled={busy||deciding||selected.unavailable} onClick={()=>void decide(suggestion.id,'accept')}>{say('采纳并发布','Accept and publish')}</Button></div>}
          </div>)}
          <Disclosure title={say('版本记录','Version history')}>
            {history.versions.length===0&&<p className="field-hint">{say('尚无托管版本。','No managed versions.')}</p>}
            {history.versions.map(version=><div key={version.id}><p>v{version.ordinal}{' · '}{new Date(version.createdAt).toLocaleString()}{version.id===selected.versionRef?.versionId?' · '+say('当前版本','Current version'):''}</p><a href={'/api/v2/assets/'+version.assetId+'/versions/'+version.id+'/files/0'}>{say('下载完整内容','Download full content')}</a><p className="field-hint">{version.provenance.sourceVersions.length}{' '+say('项资料来源','source versions')}</p></div>)}
          </Disclosure>
        </>}
      </section>
      <section className="team-assignment-section"><div className="team-capability-heading"><h3>{t("分配给智能体")}</h3><span className="field-hint">{t("同一份内容，共享维护")}</span></div>
        {config.agents.map(agent => {
          const assigned = agent.skillIds?.includes(selected.id) ?? false;
          const nameConflict = !assigned && (agent.skills.some(skill => skill.name === selected.name) || skills.some(skill => skill.id !== selected.id && skill.name === selected.name && agent.skillIds?.includes(skill.id)));
          return <label key={agent.id} className="team-assignment-row"><span className="team-assignment-avatar"><IdentityAvatar identity={agent} kind="agent" size={20} /></span><span>{agent.name}<small>{t(assigned ? agent.disabledSkillIds?.includes(selected.id) ? "已暂停" : "已分配" : "未分配")}</small></span>
            <Input type="checkbox" aria-label={t("分配给 {name}", { name: agent.name })} checked={assigned} disabled={nameConflict} title={nameConflict ? t("此智能体已有同名技能。") : undefined} onChange={event => {
              const checked = event.target.checked, id = selected.id;
              onChange(current => ({ ...current, agents: current.agents.map(item => item.id === agent.id ? { ...item, skillIds: checked ? [...new Set([...(item.skillIds ?? []), id])] : item.skillIds?.filter(value => value !== id), disabledSkillIds: item.disabledSkillIds?.filter(value => value !== id) } : item) }));
            }} /></label>;
        })}
        {projects.length > 0 && <p className="field-hint">{t("项目引用：{names}", { names: projects.map(project => project.name).join(" · ") })}</p>}
      </section>
    </> : <p className="field-hint">{t("注册第一个系统技能。")}</p>}</div></div>
    {register && <Dialog label={t("注册技能")} className="team-capability-dialog" onClose={() => setRegister(false)}><h2>{t("注册技能")}</h2><RegisterSkill config={config} onCancel={() => setRegister(false)} onRegister={skill => {
      onChange(current => ({ ...current, skillLibrary: [...(current.skillLibrary ?? []), skill] })); setSelectedId(skill.id); setQuery(""); setRegister(false);
    }} /></Dialog>}
    {confirmDelete && selected && <Dialog label={t("删除此系统技能？")} onClose={() => setConfirmDelete(false)}><h2>{t("删除此系统技能？")}</h2><p>{selected.name}</p><div className="team-capability-actions"><Button type="button" onClick={() => setConfirmDelete(false)}>{t("取消")}</Button><Button type="button" disabled={owners.length > 0} onClick={() => {
      const id = selected.id;
      onChange(current => [...current.agents, ...current.projects].some(owner => owner.skillIds?.includes(id)) ? current : { ...current, skillLibrary: current.skillLibrary?.filter(skill => skill.id !== id) }); setConfirmDelete(false);
    }}>{t("删除系统技能")}</Button></div></Dialog>}
  </section>;
}
