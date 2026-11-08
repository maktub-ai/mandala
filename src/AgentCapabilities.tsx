import Button from './ui/Button';
import Input from './ui/Input';
import IdentityAvatar from "./IdentityAvatar";
import { runtimeLabel } from "../shared/runtimes";
import { useEffect, useState } from "react";
import type { Agent, Config, McpConnection, McpServer, SkillDefinition } from "../shared/types";
import { projectWorkspaces } from "../shared/workspaces";
import { api } from "./api";
import CapabilityEditor from "./CapabilityEditor";
import Dialog from "./Dialog";
import { useLanguage } from "./i18n";
import { RegisterSkill, type ChangeTeamConfig } from "./SkillLibrary";
import Icon from "./ui/Icon";
import Select from "./ui/Select";
import LoadingState from "./ui/LoadingState";
import "./team-capabilities.css";

type Kind = "skills" | "mcp";
type NativeCapability = { name: string; path: string; scope?: "user" | "directory"; enabled?: boolean };

function NativeInventory({ config, savedConfig, agent, kind }: { config: Config; savedConfig: Config; agent: Agent; kind: Kind }) {
  const { t } = useLanguage();
  const projects = config.projects.filter(project => project.agentIds.includes(agent.id) && savedConfig.projects.some(saved => saved.id === project.id));
  const routeProject = new URLSearchParams(window.location.search).get("project");
  const [choice, setChoice] = useState({ owner: "", projectId: "" }), [workspaceId, setWorkspaceId] = useState("");
  const projectId = choice.owner === agent.id ? choice.projectId : routeProject ?? "";
  const project = savedConfig.projects.find(item => item.id === projectId && projects.some(candidate => candidate.id === item.id));
  const workspaces = projectWorkspaces(project);
  const workspace = workspaces.find(item => item.id === workspaceId) ?? workspaces[0];
  const query = new URLSearchParams({ cli: agent.defaultCli, ...(kind === "skills" ? { kind: "skills" } : {}), ...(project ? { projectId: project.id } : {}), ...(workspace ? { workspaceId: workspace.id } : {}) }).toString();
  const [refresh, setRefresh] = useState(0);
  const key = `${agent.id}:${query}:${workspace?.cwd ?? ""}:${refresh}`;
  const [result, setResult] = useState<{ key: string; items: NativeCapability[]; error?: string }>();
  useEffect(() => {
    let active = true;
    api<{ skills: NativeCapability[]; mcp: NativeCapability[] }>("/capabilities?" + query).then(data => {
      if (active) setResult({ key, items: data[kind] });
    }).catch((error: Error) => { if (active) setResult({ key, items: [], error: error.message }); });
    return () => { active = false; };
  }, [key]);
  const current = result?.key === key ? result : undefined;
  const rows = (items: NativeCapability[]) => items.length ? <div className="team-capability-list">{items.map(item => <article className="team-capability-row" key={item.path + item.name}>
    <Icon name={kind === "skills" ? "book" : "tool"} size={20} /><div className="team-capability-copy"><strong>{item.name}</strong><code>{item.path}</code><small>{t("已发现，未验证加载")}{item.enabled === false ? ` · ${t("已暂停")}` : ""}</small></div>
  </article>)}</div> : <p className="field-hint">{t("未发现能力；尚未验证执行时加载情况。")}</p>;
  return <div className="team-native-capabilities" data-native-capabilities>
    <div className="team-discovery-controls">
      {projects.length > 0 && <label>{t("发现上下文")}<Select ariaLabel={t("发现上下文")} value={project?.id ?? ""} onChange={value => { setChoice({ owner: agent.id, projectId: value }); setWorkspaceId(""); }} options={[{ value: "", label: t("仅执行环境") }, ...projects.map(item => ({ value: item.id, label: item.name, icon:<IdentityAvatar identity={item} kind="project" size={20}/> }))]} /></label>}
      {workspaces.length > 1 && <label>{t("目录组")}<Select ariaLabel={t("目录组")} value={workspace?.id ?? ""} onChange={setWorkspaceId} options={workspaces.map(item => ({ value: item.id, label: item.name, description: item.cwd }))} /></label>}
    </div>
    <section className="team-capability-section" aria-label={t("执行环境自带")}><div className="team-capability-heading"><div><h3>{t("执行环境自带")}</h3><p className="field-hint">{runtimeLabel(agent.defaultCli)} · {t("只读")}</p></div><Button type="button" aria-label={t("刷新能力清单")} disabled={!current} onClick={() => setRefresh(value => value + 1)}><Icon name="refresh" size={16} /></Button></div>
      {!current ? <LoadingState label={t("正在读取能力…")} rows={2} /> : current.error ? <p role="alert">{current.error}</p> : rows(current.items.filter(item => kind !== "skills" || item.scope !== "directory"))}
      <p className="field-hint">{t("此清单只展示已有定义；实际加载状态请查看具体对话。")}</p>
    </section>
    {kind === "skills" && project && <section className="team-capability-section" aria-label={t("项目附带技能")}><div className="team-capability-heading"><div><h3>{t("项目附带技能")}</h3><p className="field-hint">{project.name} · {workspace?.name} · {t("只读")}</p></div></div>{!current ? <LoadingState label={t("正在读取能力…")} rows={2} /> : current.error ? <p role="alert">{current.error}</p> : rows(current.items.filter(item => item.scope === "directory"))}</section>}
  </div>;
}

function ConnectionForm({ config, initial, onSave, onCancel, reservedNames = [] }: { config: Config; initial?: McpConnection; onSave: (connection: McpConnection) => void; onCancel: () => void; reservedNames?: string[] }) {
  const { t } = useLanguage();
  const [value, setValue] = useState<McpServer>(initial ?? { name: "", transport: "http", url: "" }), [error, setError] = useState("");
  return <form onSubmit={event => {
    event.preventDefault();
    let endpointValid = !!value.command?.trim();
    if (value.transport === "http") {
      try {
        const url = new URL(value.url ?? "");
        endpointValid = ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash && ![...url.searchParams.keys()].some(key => /token|secret|password|api.?key/i.test(key));
      } catch { endpointValid = false; }
    }
    const duplicate = config.connections?.some(item => item.name === value.name && item.id !== initial?.id) || reservedNames.includes(value.name) || (initial && [...config.agents, ...config.projects].some(owner => owner.connectionIds?.includes(initial.id) && owner.mcp.some(item => item.name === value.name)));
    const validEnv = Object.entries(value.env ?? {}).every(([key, ref]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(ref));
    if (!/^[A-Za-z0-9_-]+$/.test(value.name) || (value.name === "mandala_tasks" || value.name === "openmana_tasks") || duplicate || !endpointValid || !validEnv) { setError(t("连接名称已存在或配置不完整。")); return; }
    onSave({ ...value, id: initial?.id ?? crypto.randomUUID() });
  }}><CapabilityEditor mode="mcp" compact canRemove={false} mcp={[value]} skills={[]} onMcp={items => setValue(items[0])} onSkills={() => {}} />{error && <p role="alert">{error}</p>}<div className="team-capability-actions"><Button type="button" onClick={onCancel}>{t("取消")}</Button><Button type="submit" className="primary">{t(initial ? "保存" : "注册并添加")}</Button></div></form>;
}

export default function AgentCapabilities({ config, savedConfig, agent, onChange, onOpenLibrary, initialKind = 'skills' }: { config: Config; savedConfig: Config; agent: Agent; onChange: ChangeTeamConfig; onOpenLibrary?: () => void; initialKind?: Kind }) {
  const { t } = useLanguage();
  const [kind, setKind] = useState<Kind>(initialKind), [picker, setPicker] = useState(false), [newItem, setNewItem] = useState(false), [query, setQuery] = useState(""), [picked, setPicked] = useState<string[]>([]);
  const [skillDetail, setSkillDetail] = useState<SkillDefinition>(), [connectionDetail, setConnectionDetail] = useState<McpConnection>();
  const isSkill = kind === "skills", refsKey = isSkill ? "skillIds" : "connectionIds", disabledKey = isSkill ? "disabledSkillIds" : "disabledConnectionIds";
  const library = isSkill ? config.skillLibrary ?? [] : config.connections ?? [];
  const refs = agent[refsKey] ?? [], disabled = agent[disabledKey] ?? [];
  const assigned = library.filter(item => refs.includes(item.id));
  const inline = isSkill ? agent.skills : agent.mcp;
  const assignedNames = new Set([...assigned, ...inline].map(item => item.name));
  const pickedNames = new Set(library.filter(item => picked.includes(item.id)).map(item => item.name));
  const patchAgent = (update: (current: Agent) => Agent) => onChange(current => ({ ...current, agents: current.agents.map(item => item.id === agent.id ? update(item) : item) }));
  const assign = (ids: string[]) => patchAgent(current => ({ ...current, [refsKey]: [...new Set([...(current[refsKey] ?? []), ...ids])], [disabledKey]: current[disabledKey]?.filter(id => !ids.includes(id)) }));
  const closePicker = () => { setPicker(false); setQuery(""); setPicked([]); setNewItem(false); };
  return <div className="team-capabilities">
    <nav className="team-capability-nav" aria-label={t("能力分类")}>{(["skills", "mcp"] as const).map(value => <Button type="button" aria-pressed={kind === value} key={value} onClick={() => setKind(value)}>{value === "skills" ? t("技能") : "MCP"}</Button>)}</nav>
    <div className="team-capability-body"><section className="team-capability-section"><div className="team-capability-heading"><div><h3>{t(isSkill ? "已配置技能" : "已配置连接")}</h3><p className="field-hint">{t(isSkill ? "来自技能库，可按需启用；移除后仍保留在库中。" : "配置此智能体使用的连接，开关只影响此处的使用。")}</p></div><Button type="button" onClick={() => setPicker(true)}><Icon name="plus" size={16} />{t(isSkill ? "添加技能" : "添加连接")}</Button></div>
      <div className="team-capability-list">{assigned.map(item => <article className="team-capability-row" key={item.id} {...{ [isSkill ? "data-configured-skill" : "data-configured-connection"]: item.id }}>
        <Icon name={isSkill ? "book" : "tool"} size={20} /><div className="team-capability-copy"><Button type="button" className="team-skill-link" onClick={() => isSkill ? setSkillDetail(item as SkillDefinition) : setConnectionDetail(item as McpConnection)}>{item.name}</Button>
          <small>{t(isSkill ? "系统技能库" : "系统连接")} · {t(disabled.includes(item.id) ? "已暂停" : "已配置，执行时生效")}</small>
        </div><div className="team-capability-actions"><Button type="button" className="team-capability-switch" role="switch" aria-label={t(disabled.includes(item.id) ? "启用 {name}" : "暂停 {name}", { name: item.name })} aria-checked={!disabled.includes(item.id)} onClick={() => { const enabled = disabled.includes(item.id); patchAgent(current => ({ ...current, [disabledKey]: enabled ? (current[disabledKey] ?? []).filter(id => id !== item.id) : [...new Set([...(current[disabledKey] ?? []), item.id])] })); }}><span /></Button>
          <Button type="button" aria-label={t("移除 {name} 的分配", { name: item.name })} onClick={() => patchAgent(current => ({ ...current, [refsKey]: current[refsKey]?.filter(id => id !== item.id), [disabledKey]: current[disabledKey]?.filter(id => id !== item.id) }))}><Icon name="close" size={16} /></Button></div>
      </article>)}</div>
      {!assigned.length && <p className="field-hint">{t(isSkill ? "尚未配置技能。" : "尚未配置连接。")}</p>}
      {!!inline.length && <section className="team-legacy-source"><h4>{t("旧版专用配置")}</h4><p className="field-hint">{t("已有的专用配置继续生效，不属于共享技能库。")}</p>{inline.map(item => <div key={item.name} className="team-capability-row"><Icon name={isSkill ? "book" : "tool"} size={18} /><div className="team-capability-copy"><strong>{item.name}</strong><code>{"path" in item ? item.path : item.command ?? item.url}</code></div></div>)}</section>}
    </section><NativeInventory key={agent.id + kind} config={config} savedConfig={savedConfig} agent={agent} kind={kind} /></div>
    {picker && <Dialog label={t(isSkill ? "添加技能" : "添加连接")} className="team-capability-dialog" onClose={closePicker}><h2>{t(isSkill ? "添加技能" : "添加连接")}</h2><div className="team-picker-tabs"><Button type="button" aria-pressed={!newItem} onClick={() => setNewItem(false)}>{t(isSkill ? "从技能库添加" : "选择系统连接")}</Button><Button type="button" aria-pressed={newItem} onClick={() => setNewItem(true)}>{t(isSkill ? "注册新技能" : "注册新连接")}</Button></div>
      {newItem ? isSkill ? <RegisterSkill config={config} reservedNames={agent.skills.map(skill => skill.name)} assign onCancel={closePicker} onRegister={skill => { onChange(current => ({ ...current, skillLibrary: [...(current.skillLibrary ?? []), {...skill,creatorAgentId:agent.id,humanMaintained:true,source:{method:"manual",verification:"draft"}}], agents: current.agents.map(item => item.id === agent.id ? { ...item, skillIds: [...(item.skillIds ?? []), skill.id] } : item) })); closePicker(); }} /> : <ConnectionForm config={config} reservedNames={agent.mcp.map(connection => connection.name)} onCancel={closePicker} onSave={connection => { onChange(current => ({ ...current, connections: [...(current.connections ?? []), connection], agents: current.agents.map(item => item.id === agent.id ? { ...item, connectionIds: [...(item.connectionIds ?? []), connection.id] } : item) })); closePicker(); }} /> : <>
        <Input type="search" aria-label={t("查找已有能力")} placeholder={t("查找已有能力")} value={query} onChange={event => setQuery(event.target.value)} />
        <div className="team-picker-list">{library.filter(item => item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(item => <label key={item.id} className="team-assignment-row"><Input type="checkbox" aria-label={item.name} checked={refs.includes(item.id) || picked.includes(item.id)} disabled={assignedNames.has(item.name) || (!picked.includes(item.id) && pickedNames.has(item.name))} onChange={event => setPicked(values => event.target.checked ? [...values, item.id] : values.filter(id => id !== item.id))} /><span>{item.name}{assignedNames.has(item.name) && <small>{t(refs.includes(item.id) ? "已添加" : "已配置同名能力")}</small>}</span></label>)}{!library.some(item => item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) && <p className="field-hint">{t("没有匹配项，可注册新的内容。")}</p>}</div>
        <div className="team-capability-actions"><Button type="button" onClick={closePicker}>{t("取消")}</Button><Button type="button" className="primary" disabled={!picked.length} onClick={() => { assign(picked); closePicker(); }}>{t("添加所选")}</Button></div>
      </>}
    </Dialog>}
    {skillDetail && <Dialog label={skillDetail.name} className="team-capability-dialog" onClose={() => setSkillDetail(undefined)}><h2>{skillDetail.name}</h2>{typeof skillDetail.content === "string" ? <pre className="team-skill-content">{skillDetail.content}</pre> : <><code>{skillDetail.path}</code><p className="field-hint">{t("外部目录仅保留引用；请在源文件中编辑内容。")}</p></>}<div className="team-capability-actions"><Button type="button" onClick={() => setSkillDetail(undefined)}>{t("关闭")}</Button>{onOpenLibrary && <Button type="button" onClick={() => { setSkillDetail(undefined); onOpenLibrary(); }}>{t("查看技能库")}</Button>}</div></Dialog>}
    {connectionDetail && <Dialog label={t("编辑共享连接")} className="team-capability-dialog" onClose={() => setConnectionDetail(undefined)}><h2>{t("编辑共享连接")}</h2><p className="field-hint">{t("修改将影响所有引用此连接的对象。")}</p><ConnectionForm config={config} initial={connectionDetail} onCancel={() => setConnectionDetail(undefined)} onSave={connection => { onChange(current => ({ ...current, connections: current.connections?.map(item => item.id === connection.id ? connection : item) })); setConnectionDetail(undefined); }} /></Dialog>}
  </div>;
}
