import Button from './ui/Button';
import Input from './ui/Input';
import Textarea from './ui/Textarea';
import Disclosure from './ui/Disclosure';
import MemoryWorkspace from "./MemoryWorkspace";
import AutomationWorkspace from "./AutomationWorkspace";
import { useEffect, useLayoutEffect, useState, type FormEvent } from "react";
import AppSidebar, { type SidebarNavigation } from "./AppSidebar";
import { manaTabs as tabs, type ManaTab as Tab } from "./ManaNavigation";
import type { Config, KnowledgeAccess, KnowledgeEntry, Conversation, Task } from "../shared/types";
import { api } from "./api";
import { useLanguage, type Message } from "./i18n";
import MarkdownMessage from "./MarkdownMessage";
import IdentityAvatar from "./IdentityAvatar";
import Icon from "./ui/Icon";
import {WorkspacePage,PageHeader,ListDetail} from "./ui/WorkspacePage";
import StatusLabel from "./ui/StatusLabel";
import LoadingState from "./ui/LoadingState";
import EmptyState from "./ui/EmptyState";
import Select from "./ui/Select";
import "./mana.css";
import "./compact-mana.css";
import OrganizationCanvas from "./OrganizationCanvas";
import ProjectNavigation from "./ProjectNavigation";

type Draft = Pick<KnowledgeEntry, "kind" | "title" | "content" | "scope" | "status"> & {
  access?: KnowledgeAccess; id?: string; projectId: string; agentId: string; level: string; sourceConversationId: string; sourceEventId?: number;
};
const scopes: Record<KnowledgeEntry["scope"], Message> = { global: "工作区资料", project: "项目资料", agent: "Agent 资料" };

function currentTab(): Tab {
  const value = new URLSearchParams(location.search).get("tab");
  return value && value in tabs ? value as Tab : "memory";
}

export default function ManaWorkspace({ navigation, mobileNav, onMobileNav, config, conversations = [], tasks = [], onOpenConversation, onEdit, onConfigSaved, onManageSkills, onNavigationLockChange, onOpenPath }: {
  onOpenPath: (path: string) => void;
  navigation: SidebarNavigation; mobileNav: boolean; onMobileNav: (open: boolean) => void;
  config: Config; conversations?: Conversation[]; tasks?: Task[]; onOpenConversation?: (id: string) => void;
  onManageSkills?: () => void; onNavigationLockChange?: (locked: boolean) => void;
  onEdit?: (kind: "project" | "agent", id: string) => void; onConfigSaved?: () => Promise<void> | void;
}) {
  const {text: localize,  t, errorText, language } = useLanguage();
  const [tab, setTab] = useState<Tab>(currentTab);
  const [automationEditing, setAutomationEditing] = useState(false);
  const [memoryEditing,setMemoryEditing] = useState(false);
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [selectedKnowledgeId,setSelectedKnowledgeId]=useState(()=>new URLSearchParams(location.search).get("knowledgeId"));
  const [owner, setOwner] = useState(() => { const project = new URLSearchParams(location.search).get("project"); return project ? `project:${project}` : "all"; });
  useEffect(() => {
    const update = () => { const query = new URLSearchParams(location.search); setTab(currentTab()); setSelectedKnowledgeId(query.get("knowledgeId")); setOwner(query.get("project") ? `project:${query.get("project")}` : "all"); };
    addEventListener("popstate", update); return () => removeEventListener("popstate", update);
  }, []);
  const exitExactSelection=()=>{
    if(!selectedKnowledgeId)return;
    const query=new URLSearchParams(location.search);query.delete("knowledgeId");
    history.pushState(null,"",location.pathname+(query.size?"?"+query:""));
    setSelectedKnowledgeId(null);dispatchEvent(new PopStateEvent("popstate"));
  };
  const [level, setLevel] = useState("all");
  const [status, setStatus] = useState("all");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  useLayoutEffect(() => { onNavigationLockChange?.(saving || !!draft || automationEditing || memoryEditing); return () => onNavigationLockChange?.(false); }, [saving, !!draft, automationEditing, memoryEditing, onNavigationLockChange]);
  useEffect(() => {
    if (tab !== 'document' && tab !== 'skill') return;
    let active = true;
    api<KnowledgeEntry[]>("/knowledge").then((data) => { if (active) setEntries(data); })
      .catch((failure) => { if (active) setError(failure.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [tab]);
  const ownerName = (entry: Pick<KnowledgeEntry, "scope" | "projectId" | "agentId">) => entry.scope === "global"
    ? t("工作区资料") : entry.scope === "project" ? config.projects.find((project) => project.id === entry.projectId)?.name ?? entry.projectId
      : config.agents.find((agent) => agent.id === entry.agentId)?.name ?? entry.agentId;
  const edit = (entry?: KnowledgeEntry) => {
    setError(""); setDeleting(null);
    setDraft(entry ? { ...entry, projectId: entry.projectId ?? "", agentId: entry.agentId ?? "", level: entry.level ?? "",
      sourceConversationId: entry.sourceConversationId ?? "" } : {
      kind: tab === "organization" || tab === "automation" ? "memory" : tab, title: "", content: "", scope: "global", status: "candidate",
      projectId: "", agentId: "", level: tab === "memory" ? "L1" : "", sourceConversationId: "",
    });
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    if (draft.scope === "project" && !draft.projectId || draft.scope === "agent" && !draft.agentId) {
      setError(t("请先选择资料归属。")); return;
    }
    setSaving(true); setError("");
    try {
      const saved = await api<KnowledgeEntry>(draft.id ? `/knowledge/${encodeURIComponent(draft.id)}` : "/knowledge", draft.id ? "PATCH" : "POST", {
        kind: draft.kind, title: draft.title, content: draft.content, scope: draft.scope, status: draft.status,
        projectId: draft.scope !== "global" && draft.projectId ? draft.projectId : null,
        agentId: draft.scope === "agent" ? draft.agentId : null,
        level: draft.kind === "memory" && draft.level ? draft.level : null,
        sourceConversationId: draft.sourceConversationId.trim() || null,
        sourceEventId: draft.sourceEventId ?? null, access: draft.access ?? { mode: "owner" },
      });
      setEntries((current) => draft.id ? current.map((entry) => entry.id === saved.id ? saved : entry) : [...current, saved]);
      setDraft(null);
    } catch (failure) { setError((failure as Error).message); }
    finally { setSaving(false); }
  };
  const confirm = async (entry: KnowledgeEntry, status: KnowledgeEntry["status"] = "active") => {
    setSaving(true); setError("");
    try {
      const saved = await api<KnowledgeEntry>(`/knowledge/${encodeURIComponent(entry.id)}`, "PATCH", { status });
      setEntries((current) => current.map((item) => item.id === entry.id ? saved : item));
    } catch (failure) { setError((failure as Error).message); }
    finally { setSaving(false); }
  };
  const remove = async (id: string) => {
    setSaving(true); setError("");
    try {
      await api(`/knowledge/${encodeURIComponent(id)}`, "DELETE");
      setEntries((current) => current.filter((entry) => entry.id !== id)); setDeleting(null);if(selectedKnowledgeId===id)exitExactSelection();
    } catch (failure) { setError((failure as Error).message); }
    finally { setSaving(false); }
  };
  useEffect(()=>{const unload=(event:BeforeUnloadEvent)=>{if(saving||draft||memoryEditing||automationEditing){event.preventDefault();event.returnValue="";}};addEventListener("beforeunload",unload);return()=>removeEventListener("beforeunload",unload);},[saving,!!draft,memoryEditing,automationEditing]);
  const accessLabels = { owner: "归属范围可用", private: "仅保存，不向对话提供", selected: "指定 Agent 或项目", all: "所有对话可用" } as const;
  const filtered = entries.filter((entry) => entry.kind === tab && (selectedKnowledgeId ? entry.id === selectedKnowledgeId :
    `${entry.title}\n${entry.content}`.toLowerCase().includes(search.trim().toLowerCase()) &&
    (owner === "all" || owner === "global" && entry.scope === "global" || owner === `project:${entry.projectId}` && entry.scope === "project" || owner === `agent:${entry.agentId}` && entry.scope === "agent") &&
    (tab !== "memory" || level === "all" || entry.level === level) && (status === "all" || entry.status === status)))
    .sort((a, b) => Number(a.status !== "candidate") - Number(b.status !== "candidate") || b.updatedAt.localeCompare(a.updatedAt));

  const selectEntry=(id:string)=>{const query=new URLSearchParams(location.search);query.set('knowledgeId',id);history.pushState(null,'',location.pathname+'?'+query);setSelectedKnowledgeId(id);dispatchEvent(new PopStateEvent('popstate'));};
  const selectedEntry=filtered.find(entry=>entry.id===selectedKnowledgeId);
  const editor=draft && <form className="mana-editor" onSubmit={save} aria-label={t(draft.id ? "编辑资料" : "新增资料")}>
        <h2>{t(draft.id ? "编辑资料" : "新增资料")}</h2><fieldset disabled={saving}>
          <label>{t("资料标题")}<Input required maxLength={200} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
          <div className="mana-editor-scope"><label>{t("资料归属")}<Select ariaLabel={t("资料归属")} value={draft.scope} disabled={saving} searchable={false}
            onChange={(scope) => setDraft({ ...draft, scope: scope as Draft["scope"], projectId: "", agentId: "" })}
            options={Object.entries(scopes).map(([value, label]) => ({ value, label: t(label) }))} /></label>
            {draft.scope === "project" && <label>{t("项目")}<Select ariaLabel={t("项目")} value={draft.projectId} disabled={saving}
              onChange={(projectId) => setDraft({ ...draft, projectId })} options={[
                { value: "", label: t("选择项目") }, ...config.projects.map((project) => ({ value: project.id, label: project.name, icon: <IdentityAvatar identity={project} kind="project" size={20} /> })),
              ]} /></label>}
            {draft.scope === "agent" && <><label>{t("智能体")}<Select ariaLabel={t("智能体")} value={draft.agentId} disabled={saving}
              onChange={(agentId) => setDraft({ ...draft, agentId, projectId: "" })} options={[
                { value: "", label: t("选择 Agent") }, ...config.agents.map((agent) => ({ value: agent.id, label: agent.name, icon: <IdentityAvatar identity={agent} kind="agent" size={20} /> })),
              ]} /></label>
              <label>{t("项目")}<Select ariaLabel={t("项目")} value={draft.projectId} disabled={saving} onChange={(projectId) => setDraft({ ...draft, projectId })}
                options={[{ value: "", label: t("全部范围") }, ...config.projects.filter((project) => project.agentIds.includes(draft.agentId)).map((project) => ({
                  value: project.id, label: project.name, icon: <IdentityAvatar identity={project} kind="project" size={20} />,
                }))]} /></label></>}
            {draft.kind === "memory" && <label>{t("层级")}<Select ariaLabel={t("层级")} value={draft.level} disabled={saving} searchable={false}
              onChange={(level) => setDraft({ ...draft, level })} options={[{ value: "", label: t("不分层") }, ...["L1", "L2", "L3", "L4"].map((value) => ({ value, label: value }))]} /></label>}</div>
          <label>{t("使用范围")}<Select ariaLabel={t("使用范围")} value={draft.access?.mode ?? "owner"} searchable={false}
            onChange={mode => setDraft({ ...draft, access: { mode: mode as KnowledgeAccess["mode"] } })} options={Object.entries(accessLabels).map(([value, label]) => ({ value, label: t(label) }))} /></label>
          {draft.access?.mode === "selected" && <div className="knowledge-access-list">{[...config.agents.map(item => ({ ...item, type: "agentIds" as const })), ...config.projects.map(item => ({ ...item, type: "projectIds" as const }))].map(item => <label key={item.type + item.id}>
            <Input type="checkbox" checked={draft.access?.[item.type]?.includes(item.id) ?? false} onChange={e => setDraft({ ...draft, access: { ...draft.access!, [item.type]: e.target.checked ? [...(draft.access?.[item.type] ?? []), item.id] : draft.access?.[item.type]?.filter(id => id !== item.id) } })} />
            {item.name} <small>{item.type === "agentIds" ? t("智能体") : t("项目")}</small></label>)}</div>}
          <label>{t("资料内容")}<Textarea required rows={7} maxLength={100000} value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} /></label>
          <Disclosure className="mana-editor-source" title={<> <Icon name="link" size={15} />{t("来源对话 ID")} </>}><label>{t("来源对话 ID")}<Input value={draft.sourceConversationId} onChange={(event) => setDraft({ ...draft, sourceConversationId: event.target.value, sourceEventId: undefined })} /></label></Disclosure>
          <div className="mana-editor-actions"><Button className="primary" type="submit"><Icon name="check" size={16} />{saving ? t("保存中…") : t("保存资料")}</Button>
            <Button type="button" onClick={() => setDraft(null)}><Icon name="close" size={16} />{t("取消")}</Button></div>
        </fieldset>
      </form>;
  const renderEntry=(entry:KnowledgeEntry)=><article className="mana-entry" key={entry.id} aria-label={entry.title}>
        <div className="mana-entry-heading"><h2>{entry.title}</h2><span className={`mana-status mana-status-${entry.status}`}>{t(entry.status === "candidate" ? "候选" : "已采用")}</span></div>
        <div className="mana-entry-meta"><span>{entry.scope === "global" ? ownerName(entry) : `${t(scopes[entry.scope])} · ${ownerName(entry)}`}{entry.scope === "agent" && entry.projectId && ` · ${config.projects.find((project) => project.id === entry.projectId)?.name ?? entry.projectId}`}</span>{entry.level && <span>{entry.level}</span>}
          <span>{t(accessLabels[entry.access?.mode ?? "owner"])}</span><time dateTime={entry.updatedAt}>{new Date(entry.updatedAt).toLocaleString(language)}</time></div>
        <Disclosure className="mana-content" title={<> <Icon name="book" size={15} />{t("查看内容")} </>}><MarkdownMessage text={entry.content} /></Disclosure>
        <div className="mana-entry-actions">
          {entry.sourceConversationId && <Button type="button" disabled={!onOpenConversation || saving || !!draft} onClick={() => onOpenConversation?.(entry.sourceConversationId!)}><Icon name="message" size={15} />{t("查看来源对话")}</Button>}
          {entry.status === "candidate" && <Button className="primary" type="button" disabled={saving || !!draft} onClick={() => void confirm(entry)}><Icon name="check" size={15} />{t("确认采用")}</Button>}
          {entry.kind === "memory" && entry.status === "active" && <Button type="button" disabled={saving || !!draft} onClick={() => void confirm(entry, "candidate")}>{t("撤销采用")}</Button>}
          <Button type="button" disabled={saving || !!draft} onClick={() => edit(entry)}><Icon name="edit" size={15} />{t("编辑资料")}</Button>
          <Button className="mana-delete-action" type="button" disabled={saving || !!draft} onClick={() => setDeleting(entry.id)}><Icon name="trash" size={15} />{t("删除资料")}</Button></div>
        {deleting === entry.id && <div className="mana-delete-confirm"><span>{t("删除这条资料？")}</span>
          <Button type="button" disabled={saving} onClick={() => void remove(entry.id)}><Icon name="trash" size={15} />{t("确认删除")}</Button>
          <Button type="button" disabled={saving} onClick={() => setDeleting(null)}><Icon name="close" size={15} />{t("取消删除")}</Button></div>}
      </article>;
  return <div className="app-shell mana-page" data-detail-open={!!draft||!!selectedEntry}>
    <AppSidebar navigation={navigation} open={mobileNav} onClose={() => onMobileNav(false)} />
    <main data-page-width="standard" className="mana-workspace" aria-label={t("MANA 工作区")}>

    <WorkspacePage width="standard" className="mana-frame"><PageHeader onMobileNav={()=>onMobileNav(true)} title={tab==='skill'?t('Skill 草稿'):t(tabs[tab])} icon={tab==='memory'?'memory':tab==='automation'?'schedule':'book'} actions={tab!=='memory'&&tab!=='organization'&&tab!=='automation'?<Button className="primary" disabled={saving||!!draft} onClick={()=>edit()}><Icon name="plus" size={15}/>{t(tab==='skill'?'新增 Skill 草稿':'新增资料')}</Button>:undefined}/>

    {tab==='skill'&&<nav className="mana-skill-navigation" aria-label={t('Skills')}><Button disabled={saving||!!draft} onClick={onManageSkills}><Icon name="book" size={14}/>{t('管理可用 Skills')}</Button></nav>}
    {tab === "memory" && <ProjectNavigation project={config.projects.find(project => project.id === new URLSearchParams(location.search).get("project"))} active="memory" disabled={saving || !!draft || automationEditing || memoryEditing} />}
    {tab === "document" && <Disclosure className="mana-help" title={<> <Icon name="info" size={15} />{t("使用说明")} </>}>
      <p>{t("自动提炼的 L1/L2 记忆默认采用；L3/L4 和同名冲突保留候选。可撤销采用，编辑记忆后需重新确认。")}</p>
      <p>{t("使用范围控制平台向对话提供的资料；本机 CLI 的文件访问仍遵循原生权限。")}</p>
    </Disclosure>}
    {error && <p role="alert" className="form-error">{errorText(error)}</p>}
    {tab === "memory" ? <MemoryWorkspace config={config} conversations={conversations} onOpenConversation={onOpenConversation} onNavigationLockChange={setMemoryEditing}/> : tab === "automation" ? <AutomationWorkspace config={config} onOpenConversation={onOpenConversation} onEditingChange={setAutomationEditing} /> : tab === "organization" ? <OrganizationCanvas config={config} conversations={conversations} tasks={tasks}
      onOpenConversation={onOpenConversation} onEdit={onEdit} onConfigSaved={onConfigSaved} /> : <>
      {tab === "skill" && <div className="mana-boundary"><p>{t("这里保存 Skill 草稿，不等于原生 CLI 已加载。")}</p></div>}
      <div className="mana-filters"><label className="mana-search">{t("资料搜索")}<div className="mana-search-input"><Icon name="search" size={16} /><Input type="search" aria-label={t("资料搜索")} value={search} onChange={(event) => {exitExactSelection();setSearch(event.target.value);}} /></div></label>
        <label>{t("资料归属")}<Select ariaLabel={t("资料归属")} value={owner} onChange={value=>{exitExactSelection();setOwner(value);}} options={[
          { value: "all", label: t("全部范围"), icon: <Icon name="layers" size={16} /> },
          { value: "global", label: t("工作区资料"), icon: <Icon name="globe" size={16} /> },
          ...config.projects.map((project) => ({ value: `project:${project.id}`, label: project.name, description: t("项目资料"), icon: <IdentityAvatar identity={project} kind="project" size={20} /> })),
          ...config.agents.map((agent) => ({ value: `agent:${agent.id}`, label: agent.name, description: t("Agent 资料"), icon: <IdentityAvatar identity={agent} kind="agent" size={20} /> })),
        ]} /></label>
        <label>{t("状态筛选")}<Select ariaLabel={t("状态筛选")} value={status} onChange={value=>{exitExactSelection();setStatus(value);}} searchable={false}
          options={[{ value: "all", label: t("全部状态") }, { value: "candidate", label: t("候选") }, { value: "active", label: t("已采用") }]} /></label></div>


      <ListDetail className="mana-list-detail" list={loading?<LoadingState label={t('正在读取资料…')}/>:filtered.length?<div className="mana-entry-list">{filtered.map(entry=><Button className="mana-entry-row" key={entry.id} aria-label={entry.title} aria-current={selectedKnowledgeId===entry.id?'true':undefined} disabled={saving||!!draft} onClick={()=>selectEntry(entry.id)}><Icon name="file" size={18}/><span><strong>{entry.title}</strong><small>{ownerName(entry)} · {new Date(entry.updatedAt).toLocaleDateString(language)}</small></span><StatusLabel icon={entry.status==='candidate'?'clock':'circleCheck'}>{t(entry.status==='candidate'?'候选':'已采用')}</StatusLabel></Button>)}</div>:error?null:<EmptyState icon="book">{t(entries.some(entry=>entry.kind===tab)?'没有匹配的资料。':'暂无资料。')}</EmptyState>} detail={draft?<div className="mana-detail"><Button className="mana-detail-back" disabled={saving} onClick={()=>{setDraft(null);exitExactSelection();}}><Icon name="arrowLeft" size={14}/>{localize('返回草稿', 'Back to drafts')}</Button>{editor}</div>:selectedEntry?<div className="mana-detail"><Button className="mana-detail-back" onClick={exitExactSelection}><Icon name="arrowLeft" size={14}/>{localize('返回草稿', 'Back to drafts')}</Button>{renderEntry(selectedEntry)}</div>:undefined}/>
    </>}
  </WorkspacePage></main></div>;
}
