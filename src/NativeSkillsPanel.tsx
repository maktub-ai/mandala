import Input from './ui/Input';
import Button from './ui/Button';
import IdentityAvatar from "./IdentityAvatar";
import RuntimeIcon from "./ui/RuntimeIcon";
import { runtimeLabel, runtimeIds } from "../shared/runtimes";
import Disclosure from './ui/Disclosure';
import { linkedCapabilities } from "../shared/catalog";
import React, { useEffect, useState } from "react";
import type { Cli, Config } from "../shared/types";
import { projectWorkspaces } from "../shared/workspaces";
import { api } from "./api";
import { useLanguage } from "./i18n";
import Icon from "./ui/Icon";
import Select from "./ui/Select";
import "./native-skills.css";

type NativeSkill = { name: string; path: string; source: "native"; scope?: "user" | "directory" };
const messages = {
  title: ["执行环境自带", "Runtime capabilities"], projectTitle: ["项目附带技能", "Project directory skills"], readonly: ["只读", "Read-only"],
  cli: ["Skills 执行端", "Skills CLI"], context: ["Skills 项目上下文", "Skills project context"],
  workspace: ["Skills 目录组", "Skills directory group"], global: ["仅用户级配置", "User configuration only"],
  search: ["搜索原生 Skills", "Search native Skills"], refresh: ["刷新原生 Skills", "Refresh native Skills"],
  loading: ["正在发现 Skills…", "Discovering Skills…"], empty: ["未发现匹配的 Skills", "No matching Skills discovered"],
  user: ["用户级", "User-level"], directory: ["工作目录", "Working directory"], unknown: ["原生配置", "Native configuration"],
  status: ["已发现 · 未验证加载", "Discovered · Loading unverified"],
  project: ["Project 覆盖（待验证）", "Project override (unverified)"],
  agent: ["智能体覆盖（待验证）", "Agent override (unverified)"],
  more: ["显示更多", "Show more"], scope: ["发现范围", "Discovery scope"],
  hint: ["清单读取已保存的工作目录；覆盖关系按当前平台草稿预览。", "Discovery uses saved directories; override previews use the current platform draft."],
  boundary: ["这里发现的是 CLI 用户目录、共享 Skills 目录及所选工作目录中的定义，不是该智能体独有的技能。插件或自定义加载目录可能未包含；实际加载请查看会话配置。", "These definitions come from CLI user directories, shared Skills directories and the selected working directory; they are not exclusive to this Agent. Plugin or custom loading directories may be absent. Check a chat's configuration for loading evidence."],
} as const;

export default function NativeSkillsPanel({ config, savedConfig, projectId, agentId, directoryOnly = false }: {
  config: Config; savedConfig: Config; projectId?: string; agentId?: string; directoryOnly?: boolean;
}) {
  const { language } = useLanguage();
  const label = (key: keyof typeof messages) => messages[key][language === "zh-CN" ? 0 : 1];
  const owner = projectId ? `project:${projectId}` : `agent:${agentId ?? ""}`;
  const agent = config.agents.find(item => item.id === agentId);
  const [cliChoice, setCliChoice] = useState({ owner: "", value: "" as Cli | "" });
  const cli = cliChoice.owner === owner ? cliChoice.value : agent?.defaultCli ?? "";
  const [contextChoice, setContextChoice] = useState({ owner: "", value: "" });
  const projects = config.projects.filter(item => agentId ? item.agentIds.includes(agentId) : true);
  const projectContext = projectId ?? (contextChoice.owner === owner && projects.some(item => item.id === contextChoice.value) ? contextChoice.value : "");
  const context = savedConfig.projects.find(item => item.id === projectContext);
  const workspaces = projectWorkspaces(context);
  const [workspaceChoice, setWorkspaceChoice] = useState({ projectId: "", value: "" });
  const workspace = workspaces.find(item => item.id === (workspaceChoice.projectId === context?.id ? workspaceChoice.value : "")) ?? workspaces[0];
  const query = new URLSearchParams({ cli, kind: "skills", ...(context ? { projectId: context.id } : {}),
    ...(workspace ? { workspaceId: workspace.id } : {}) }).toString();
  const directory = workspace?.cwd ?? "";
  const [refresh, setRefresh] = useState(0), [search, setSearch] = useState(""), [limit, setLimit] = useState(12);
  const [result, setResult] = useState<{ key: string; items: NativeSkill[]; error: string; loading: boolean }>();
  const key = `${query}:${directory}:${refresh}`;
  useEffect(() => {
    if (!cli) return;
    let active = true;
    setLimit(12);
    setResult({ key, items: [], error: "", loading: true });
    api<{ skills: NativeSkill[] }>("/capabilities?" + query).then(data => {
      if (active) setResult({ key, items: data.skills, error: "", loading: false });
    }).catch((error: Error) => {
      if (active) setResult({ key, items: [], error: error.message, loading: false });
    });
    return () => { active = false; };
  }, [key]);
  const current = result?.key === key ? result : undefined;
  const rows = (current?.items ?? []).filter(item => !directoryOnly || item.scope === "directory").filter(item => `${item.name} ${item.path}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  const project = config.projects.find(item => item.id === projectContext);
  return <section className="native-skills-panel settings-card" aria-label={label(directoryOnly ? "projectTitle" : "title")}>
    <div className="native-skills-heading"><h2><Icon name="book" size={17} />{label(directoryOnly ? "projectTitle" : "title")}</h2><span>{label("readonly")}</span></div>
    <div className="native-skills-controls">
      <label>{label("cli")}<Select ariaLabel={label("cli")} value={cli} onChange={value => setCliChoice({ owner, value: value as Cli })}
        options={runtimeIds.map(value=>({value,label:runtimeLabel(value),icon:<RuntimeIcon cli={value}/>}))} /></label>
      {!projectId && <label>{label("context")}<Select ariaLabel={label("context")} value={context?.id ?? ""}
        onChange={value => setContextChoice({ owner, value })} options={[{ value: "", label: label("global") },
          ...projects.filter(item => savedConfig.projects.some(saved => saved.id === item.id)).map(item => ({ value: item.id, label: item.name, icon:<IdentityAvatar identity={item} kind="project" size={20}/> }))]} /></label>}
      {workspaces.length > 1 && <label>{label("workspace")}<Select ariaLabel={label("workspace")} value={workspace!.id}
        onChange={value => setWorkspaceChoice({ projectId: context!.id, value })} options={workspaces.map(item => ({ value: item.id, label: item.name, description: item.cwd }))} /></label>}
    </div>
    <div className="native-skills-toolbar"><label><Input type="search" aria-label={label("search")}
      placeholder={label("search")} value={search} onChange={event => { setSearch(event.target.value); setLimit(12); }} /></label>
      <Button type="button" aria-label={label("refresh")} title={label("refresh")} disabled={!cli || current?.loading}
        onClick={() => setRefresh(value => value + 1)}><Icon name="refresh" size={16} /></Button></div>
    {!cli ? <p role="status">{language==='zh-CN'?'请选择要查看的执行端。':'Choose a runtime to inspect.'}</p> : !current || current.loading ? <p role="status">{label("loading")}</p> : current.error ? <p role="alert">{current.error}</p> : <>
      <p className="native-skills-count" role="status">{rows.length} Skills</p>
      {!rows.length && <p className="field-hint">{label("empty")}</p>}
      <div className="native-skills-list">{rows.slice(0, limit).map(item => {
        const override = project && linkedCapabilities(config, project).skills.some(skill => skill.name === item.name) ? "project" : agent && linkedCapabilities(config, agent).skills.some(skill => skill.name === item.name) ? "agent" : null;
        return <article key={item.path} aria-label={item.name} className="native-skill-row">
          <div className="native-skill-name"><strong>{item.name}</strong><span>{runtimeLabel(cli)} · {label(item.scope === "user" ? "user" : item.scope === "directory" ? "directory" : "unknown")}</span></div>
          <code>{item.path}</code><div className="native-skill-state"><span>{label("status")}</span>{override && <span className="native-skill-override">{label(override)}</span>}</div>
        </article>;
      })}</div>
      {rows.length > limit && <Button type="button" className="native-skills-more" onClick={() => setLimit(value => value + 12)}>{label("more")} ({Math.min(limit, rows.length)} / {rows.length})</Button>}
    </>}
    <Disclosure className="native-skills-help" title={<> {label("scope")} </>}><p>{label("hint")}</p><p>{label("boundary")}</p></Disclosure>
  </section>;
}
