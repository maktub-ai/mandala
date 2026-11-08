import { devicePreferences } from './devicePreferences';
import SegmentedControl from './ui/SegmentedControl';
import Button from './ui/Button';
import Input from './ui/Input';
import { runtimeLabel, runtimeIds } from "../shared/runtimes";
import { useEffect, useRef, useState } from "react";
import type { Config, Conversation, Task } from "../shared/types";
import { api } from "./api";
import { useLanguage } from "./i18n";
import type { WorkbenchSnapshot } from "../shared/workbench";
import UsagePanel from "./UsagePanel";
import RuntimeIcon from "./ui/RuntimeIcon";
import IdentityAvatar from "./IdentityAvatar";
import Icon, { type IconName } from "./ui/Icon";
import Disclosure from "./ui/Disclosure";
import { organizationGraph, filterOrganization, organizationOrder, organizationLayout, type OrganizationFilters } from "./organization";
import Select from './ui/Select';
import "./organization.css";

const copy = {
  canvas: ["组织关系", "Organization relationships"], search: ["搜索项目或智能体", "Find a project or Agent"],
  projects: ["项目", "Projects"], agents: ["智能体", "Agents"], fit: ["适应画布", "Fit canvas"],
  zoomIn: ["放大画布", "Zoom in"], zoomOut: ["缩小画布", "Zoom out"], reset: ["取消聚焦", "Clear focus"],
  guide: ["选择节点查看关联，拖动空白处平移", "Select a node to inspect its connections; drag the background to pan"],
  empty: ["请先创建项目或智能体。", "Create a project or Agent first."],
  none: ["没有匹配的对象", "No matching identities"], default: ["默认执行端", "Default CLI"],
  running: ["运行中的会话", "Running conversations"], idle: ["暂无当前执行", "No current executions"],
  conversations: ["会话数", "Conversations"], dispatches: ["接收派发数", "Received dispatches"],
  metrics: ["统计来自平台会话及派发记录；不包含 CLI 内部工具调用。", "Counts cover platform conversations and received dispatches, excluding internal CLI tool calls."],
  relationships: ["关联对象", "Connections"], editLinks: ["编辑关联", "Edit connections"], save: ["保存关联", "Save connections"],
  saving: ["保存中…", "Saving…"], cancel: ["取消", "Cancel"], close: ["关闭详情", "Close details"],
  details: ["节点详情", "Node details"], settings: ["完整配置", "Full settings"], recent: ["最近对话", "Recent conversations"],
  noChats: ["暂无会话", "No conversations yet"], noLinks: ["暂无关联", "No connections yet"],
  changes: ["关联已保存", "Connections saved"], conflict: ["关联已被其他操作修改，请取消后重新编辑。", "Connections changed elsewhere. Cancel and reopen the editor."],
  overview: ["关联概览", "Connections overview"], loading: ["正在读取运行状态…", "Loading runtime status…"],
  unnamed: ["未命名对话", "Untitled conversation"],
} as const;
type Point = { x: number; y: number };
type Selection = { kind: "project" | "agent"; id: string };
export default function OrganizationCanvas({ config, conversations, onEdit, onOpenConversation, onConfigSaved, initialSelection, onOpenPath }: {
  config: Config; conversations: Conversation[]; tasks: Task[];
  initialSelection?: Selection;
  onOpenPath?: (href: string) => void;
  onEdit?: (kind: Selection["kind"], id: string) => void;
  onOpenConversation?: (id: string) => void;
  onConfigSaved?: () => Promise<void> | void;
}) {
  const {text: localize,  language, errorText, t } = useLanguage();
  const text = (key: keyof typeof copy) => localize(copy[key][0], copy[key][1]);
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(location.search).get("node") ?? (initialSelection ? `${initialSelection.kind}:${initialSelection.id}` : null));
  const graph = organizationGraph(config);
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot | null>(null);
  const [runtimeError, setRuntimeError] = useState("");
  useEffect(() => {
    let active = true, inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (!active || inFlight || document.hidden) return;
      inFlight = true;
      try {
        const value = await api<WorkbenchSnapshot>("/workbench");
        if (active) { setSnapshot(value); setRuntimeError(""); }
      } catch (reason) {
        if (active) { setSnapshot(null); setRuntimeError(reason instanceof Error ? reason.message : String(reason)); }
      } finally {
        inFlight = false;
        if (active && !document.hidden) timer = setTimeout(load, 5000);
      }
    };
    const visibility = () => { clearTimeout(timer); if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", visibility);
    void load();
    return () => { active = false; clearTimeout(timer); document.removeEventListener("visibilitychange", visibility); };
  }, []);
  const statusKnown = !!snapshot && !snapshot.errors?.includes("tasks");
  const executions = snapshot?.agents.flatMap(agent => agent.executions) ?? [];
  const scopedExecutions = (kind: Selection["kind"], id: string) => executions.filter(item => kind === "agent" ? item.agentId === id : item.projectId === id);
  const stateLabel = (state: string) => ({ running: localize("运行", "Running"), approval: localize("等待审批", "Approval"), queued: localize("排队", "Queued"), unknown: localize("未知", "Unknown") }[state] ?? state);
  const stateIcons: Record<string, IconName> = { running: 'activity', approval: 'approval', queued: 'clock', unknown: 'info' };
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<'projects' | 'agents' | 'graph'>(() => {
    if (initialSelection || new URLSearchParams(location.search).has('node')) return 'graph';
    const saved = devicePreferences.getItem('mana-team-view-v2');
    return saved === 'agents' || saved === 'projects' ? saved : 'graph';
  });
  const [projectFilter, setProjectFilter] = useState(''), [cliFilter, setCliFilter] = useState('');
  const [activityFilter, setActivityFilter] = useState<OrganizationFilters['activity']>('all');
  const [expanded, setExpanded] = useState<string[]>([]);
  const say = (zh: string, en: string) => localize(zh, en);
  const filtered = filterOrganization(config, { search, project: projectFilter, cli: cliFilter, activity: activityFilter }, executions);
  const hasFilters = !!(search || projectFilter || cliFilter || activityFilter !== 'all');
  useEffect(() => { devicePreferences.setItem('mana-team-view-v2', mode); }, [mode]);
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const viewport = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLElement>(null);
  const selectionTrigger = useRef<HTMLButtonElement | null>(null);
  const drag = useRef<{ node?: string; start: Point; origin: Point; moved: boolean } | null>(null);
  const [editing, setEditing] = useState<{ original: string[]; chosen: string[] } | null>(null);
  const [saving, setSaving] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(false);
  const [viewportSize, setViewportSize] = useState({ width: 800, height: 600 });
  const nodeWidth = viewportSize.width < 480 ? 176 : 232;
  const nodeHeight = 108;
  const related = (nodeId: string) => new Set([nodeId, ...graph.edges.flatMap(edge =>
    nodeId === `project:${edge.projectId}` ? [`agent:${edge.agentId}`] : nodeId === `agent:${edge.agentId}` ? [`project:${edge.projectId}`] : [])]);
  const highlighted = selected ? related(selected) : null;
  const chosen = graph.nodes.find(n => n.id === selected);
  const links = chosen ? graph.nodes.filter(n => n.id !== selected && related(selected!).has(n.id)) : [];
  const ownChats = chosen ? conversations.filter(c => chosen.kind === "agent" ? c.agentId === chosen.identity.id : c.projectId === chosen.identity.id)
    .sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt)) : [];
  const visibleNodes = organizationOrder(filtered).filter(node => !selected || highlighted?.has(node.id));
  const visibleIds = new Set(visibleNodes.map(n => n.id));
  const visibleGraph = { nodes: visibleNodes, edges: filtered.edges.filter(e => visibleIds.has(`project:${e.projectId}`) && visibleIds.has(`agent:${e.agentId}`)) };
  const layout = organizationLayout(visibleGraph, viewportSize, nodeWidth, nodeHeight);
  const { width, height } = layout;
  const point = (node: typeof graph.nodes[number]): Point => positions[node.id] ?? layout.positions[node.id];
  const currentExecutions = chosen ? scopedExecutions(chosen.kind, chosen.identity.id) : [];
  const fit = (readable = false) => {
    const rect = viewport.current?.getBoundingClientRect(); if (!rect) return;
    viewport.current?.scrollTo(0, 0);
    if (rect.width < 480) {
      const target = visibleNodes.find(node => node.id === selected) ?? visibleNodes[0];
      const position = target ? point(target) : { x: 0, y: 0 };
      setView({ x: (rect.width - nodeWidth) / 2 - position.x, y: (rect.height - nodeHeight) / 2 - position.y, scale: 1 });
      return;
    }
    const points = visibleNodes.map(point);
    const minX = points.length ? Math.min(...points.map(p => p.x)) - 24 : 0;
    const minY = Math.min(0, ...layout.groups.map(group => group.y), ...points.map(p => p.y - 24));
    const maxX = points.length ? Math.max(...points.map(p => p.x + nodeWidth)) + 24 : width;
    const maxY = points.length ? Math.max(...points.map(p => p.y + nodeHeight)) + 24 : height;
    const heightScale = (rect.height - 32) / (maxY - minY);
    const scale = Math.max(.1, Math.min(1, (rect.width - 32) / (maxX - minX),
      readable && (selected || layout.groups.length === 1) ? Math.max(.8, heightScale) : heightScale));
    setView({ x: Math.max(16, (rect.width - (maxX - minX) * scale) / 2) - minX * scale,
      y: Math.max(16, (rect.height - (maxY - minY) * scale) / 2) - minY * scale, scale });
  };
  useEffect(() => {
    const observer = new ResizeObserver(entries => { setViewportSize({ width: entries[0].contentRect.width, height: entries[0].contentRect.height }); });
    if (viewport.current) observer.observe(viewport.current);
    return () => observer.disconnect();
  }, [mode]);
  useEffect(() => { fit(true); }, [config, width, height, viewportSize.width, viewportSize.height, search, projectFilter, cliFilter, activityFilter, selected, mode]);
  const focus = (id: string | null, restoreFocus = true) => {
    if (saving || editing) return;
    if (!id && selected && restoreFocus) {
      const trigger = selectionTrigger.current;
      if (trigger?.isConnected) trigger.focus();
      else viewport.current?.querySelector<HTMLButtonElement>(`[data-node-id="${CSS.escape(selected)}"]`)?.focus();
    }
    if (id !== selected) setPositions({});
    setSelected(id); setError(""); setNotice(false);
    requestAnimationFrame(() => {
      const layout = root.current?.querySelector<HTMLElement>('.organization-layout');
      if (id && layout && layout.clientWidth <= 680) layout.querySelector<HTMLElement>('.organization-detail')?.scrollIntoView({ block: 'start' });
    });
    const url = new URL(location.href); if (id) url.searchParams.set("node", id); else url.searchParams.delete("node");
    history.replaceState(null, "", url.pathname + url.search);
  };
  const startEditing = () => {
    if (!chosen) return;
    const original = links.map(n => n.identity.id);
    setEditing({ original, chosen: [...original] }); setError(""); setNotice(false);
  };
  const saveLinks = async () => {
    if (!chosen || !editing || saving) return;
    setSaving(true); setError("");
    try {
      const fresh = await api<{ config: Config; revision: string }>("/config");
      const current = chosen.kind === "agent" ? fresh.config.projects.filter(p => p.agentIds.includes(chosen.identity.id)).map(p => p.id)
        : fresh.config.projects.find(p => p.id === chosen.identity.id)?.agentIds.filter(id=>fresh.config.agents.some(a=>a.id===id&&!a.systemRole));
      const equal = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
      const available = chosen.kind === "agent" ? fresh.config.projects : fresh.config.agents.filter(a=>!a.systemRole);
      if (!current || !equal(current, editing.original) || editing.chosen.some(id => !available.some(n => n.id === id)) ||
          !fresh.config[chosen.kind === "agent" ? "agents" : "projects"].some(n => n.id === chosen.identity.id)) throw new Error(text("conflict"));
      fresh.config.projects = fresh.config.projects.map(p => chosen.kind === "project"
        ? p.id === chosen.identity.id ? { ...p, agentIds: editing.chosen } : p
        : { ...p, agentIds: editing.chosen.includes(p.id) ? [...new Set([...p.agentIds, chosen.identity.id])] : p.agentIds.filter(id => id !== chosen.identity.id) });
      await api("/config", "PUT", fresh);
      await onConfigSaved?.(); setEditing(null); setNotice(true);
    } catch (failure) { setError((failure as Error).message); }
    finally { setSaving(false); }
  };
  const zoom = (factor: number) => {
    const rect = viewport.current?.getBoundingClientRect(); if (!rect) return;
    setView(v => { const scale = Math.max(.1, Math.min(1.8, v.scale * factor));
      const centerX = (viewport.current?.scrollLeft ?? 0) + rect.width / 2, centerY = (viewport.current?.scrollTop ?? 0) + rect.height / 2;
      return { scale, x: centerX - (centerX - v.x) * scale / v.scale,
        y: centerY - (centerY - v.y) * scale / v.scale }; });
  };
  const priority = (node: typeof graph.nodes[number]) => scopedExecutions(node.kind, node.identity.id).reduce((total, e) => total + (e.state === 'approval' || e.state === 'unknown' ? 2 : 1), 0);
  const rosterNodes = [...filtered.nodes].sort((a, b) => priority(b) - priority(a) || a.identity.name.localeCompare(b.identity.name, language));
  const rosterAgents = rosterNodes.filter(n => n.kind === 'agent');
  const status = (entries: typeof executions) => !statusKnown ? <span>{runtimeError || snapshot?.errors?.includes('tasks') ? say('状态未知', 'Status unknown') : text('loading')}</span>
    : entries.length ? (['approval', 'unknown', 'running', 'queued'] as const).filter(s => entries.some(e => e.state === s)).map(s => <span key={s} data-state={s}>{stateLabel(s)} <b>{entries.filter(e => e.state === s).length}</b></span>) : <span aria-label={say('空闲', 'Idle')}>—</span>;
  const rosterRow = (node: typeof rosterAgents[number], project?: string) => {
    const memberships = config.projects.filter(p => p.agentIds.includes(node.identity.id));
    const names = memberships.map(p => p.name).join(' · ');
    return <Button type="button" className="organization-roster-row" data-team-agent={node.identity.id} key={node.id} disabled={saving || !!editing} aria-pressed={selected === node.id} onClick={event => { selectionTrigger.current = event.currentTarget; focus(node.id); }}>
      <IdentityAvatar identity={node.identity} kind="agent" size={28}/><span className="organization-roster-name"><strong>{node.identity.name}</strong>{mode === 'agents' && <small title={names}>{names || say('未分组', 'Ungrouped')}</small>}</span>
      <span className="organization-roster-cli"><RuntimeIcon cli={node.identity.defaultCli} size={14}/>{runtimeLabel(node.identity.defaultCli)}</span>
      <span className="organization-roster-status">{status(scopedExecutions('agent', node.identity.id).filter(e => project === undefined || e.projectId === project || !project && !e.projectId))}</span><Icon name="chevronRight" size={14}/>
    </Button>;
  };
  const groups = [...rosterNodes.filter(n => n.kind === 'project').map(node => ({ id: node.id, node, members: rosterAgents.filter(a => node.identity.agentIds.includes(a.identity.id)) })),
    { id: 'unassigned', node: null, members: rosterAgents.filter(a => !config.projects.some(p => p.agentIds.includes(a.identity.id))) }].filter(group => group.node || group.members.length);
  return <section className="organization" ref={root} aria-label={text("canvas")}>
    <div className="organization-view-bar"><SegmentedControl role="group" label={say('团队视图', 'Team view')} value={mode} disabled={saving || !!editing} onChange={value=>{if(value!==mode)setPositions({});setMode(value as 'projects'|'agents'|'graph');}} options={(['projects', 'agents', 'graph'] as const).map(value=>({value,label:<><Icon name={value === 'projects' ? 'project' : value === 'agents' ? 'agent' : 'workflow'} size={15}/>{value === 'projects' ? say('按项目', 'By project') : value === 'agents' ? say('智能体列表', 'Agent list') : say('关系图', 'Relationship graph')}</>}))}/><span className="organization-result-count">{say(`${filtered.nodes.filter(n => n.kind === 'project').length} 个项目 · ${rosterAgents.length} 个智能体`, `${filtered.nodes.filter(n => n.kind === 'project').length} projects · ${rosterAgents.length} Agents`)}</span></div>
    <div className="organization-toolbar"><label><Icon name="search" size={16} /><Input type="search" aria-label={text("search")}
      placeholder={text("search")} value={search} disabled={saving || !!editing} onChange={e => { setSearch(e.target.value); focus(null, false); }} /></label>
      <Select ariaLabel={say('筛选项目', 'Filter project')} value={projectFilter} disabled={saving || !!editing} onChange={value => { setProjectFilter(value); focus(null, false); }} options={[{ value: '', label: say('全部项目', 'All projects') }, ...config.projects.map(p => ({ value: `project:${p.id}`, label: p.name })), { value: 'unassigned', label: say('未分组', 'Ungrouped') }]}/>
      <Select ariaLabel={say('筛选执行端', 'Filter CLI')} value={cliFilter} disabled={saving || !!editing} onChange={value => { setCliFilter(value); focus(null, false); }} options={[{ value: '', label: say('全部执行端', 'All runtimes') }, ...runtimeIds.filter(cli => config.agents.some(a => a.defaultCli === cli)).map(cli => ({ value: cli, label: runtimeLabel(cli) }))]}/>
      <Select ariaLabel={say('筛选活动', 'Filter activity')} value={activityFilter} disabled={saving || !!editing} onChange={value => { setActivityFilter(value as OrganizationFilters['activity']); focus(null, false); }} options={[{ value: 'all', label: say('全部状态', 'All activity') }, { value: 'active', label: say('有执行活动', 'Active work') }, { value: 'attention', label: say('待处理', 'Needs attention') }]}/>
      {hasFilters && <Button className="organization-clear" type="button" disabled={saving || !!editing} onClick={() => { setSearch(''); setProjectFilter(''); setCliFilter(''); setActivityFilter('all'); focus(null, false); }}>{say('清除筛选', 'Clear filters')}</Button>}</div>
    <p className="organization-count-note">{say('状态数字表示当前执行数；排队是等待执行，未知是尚未确认运行状态。', 'Counts describe current executions. Queued means waiting to run; Unknown means the state is unconfirmed.')}</p>
    <div className={`organization-layout ${mode === 'graph' ? 'is-graph' : ''} ${chosen ? "has-detail" : ""}`}>
      {mode !== 'graph' ? <div className="organization-roster" aria-label={say('团队成员', 'Team members')}>
        {!filtered.nodes.length && <p className="organization-roster-empty">{text('none')}</p>}
        {mode === 'agents' ? rosterAgents.map(node => rosterRow(node)) : groups.map(group => <section className="organization-project-group" data-team-project={group.node?.identity.id} key={group.id}>
          <header>{group.node ? <Button type="button" disabled={saving || !!editing} aria-pressed={selected === group.id} onClick={event => { selectionTrigger.current = event.currentTarget; focus(group.id); }}><IdentityAvatar identity={group.node.identity} kind="project" size={24}/><h3>{group.node.identity.name}</h3><Icon name="chevronRight" size={14}/></Button> : <h3>{say('未分组', 'Ungrouped')}</h3>}<span>{say(`${group.members.length} 位智能体`, `${group.members.length} Agents`)}</span></header>
          {!group.members.length && <p className="organization-no-members">{say('暂无成员', 'No members')}</p>}
          {group.members.slice(0, expanded.includes(group.id) ? undefined : 4).map(node => rosterRow(node, group.node?.identity.id ?? ''))}
          {group.members.length > 4 && <Button type="button" className="organization-expand" aria-expanded={expanded.includes(group.id)} onClick={() => setExpanded(ids => ids.includes(group.id) ? ids.filter(id => id !== group.id) : [...ids, group.id])}>{expanded.includes(group.id) ? say('收起成员', 'Show fewer') : say(`展开其余 ${group.members.length - 4} 位成员`, `Show ${group.members.length - 4} more members`)}<Icon name={expanded.includes(group.id) ? 'chevronDown' : 'chevronRight'} size={14}/></Button>}
        </section>)}
        {mode === 'agents' && !rosterAgents.length && !!filtered.nodes.length && <p className="organization-roster-empty">{say('没有匹配的智能体；可切换到按项目查看空项目。', 'No matching Agents. Switch to By project to see empty projects.')}</p>}
      </div> : <div className="organization-viewport" ref={viewport} role="region" aria-label={text("overview")}
        onPointerDown={e => {
          if (e.button !== 0) return;
          const node = (e.target as Element).closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
          drag.current = { node, start: { x: e.clientX, y: e.clientY }, origin: node ? point(graph.nodes.find(n => n.id === node)!) : { x: view.x, y: view.y }, moved: false };
          e.currentTarget.setPointerCapture(e.pointerId);
        }} onPointerMove={e => {
          const d = drag.current; if (!d) return;
          const dx = e.clientX - d.start.x, dy = e.clientY - d.start.y;
          if (Math.abs(dx) + Math.abs(dy) < 4 && !d.moved) return; d.moved = true;
          if (d.node) setPositions(p => ({ ...p, [d.node!]: { x: d.origin.x + dx / view.scale, y: d.origin.y + dy / view.scale } }));
          else setView(v => ({ ...v, x: d.origin.x + dx, y: d.origin.y + dy }));
        }} onPointerUp={() => { const d = drag.current; drag.current = null; if (d?.node && !d.moved) focus(d.node); }} onPointerCancel={() => { drag.current = null; }}>
        <div className="organization-world" style={{ width, height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
          {layout.groups.map((group, i) => <div key={i}>
            {group.projects > 0 && <span className="organization-column-label" style={{ left: group.x, top: group.y, width: nodeWidth }}><Icon name="project" size={14}/>{text('projects')} · {group.projects}</span>}
            {group.agents > 0 && <span className="organization-column-label" style={{ left: group.x + (group.projects ? nodeWidth + 64 : 0), top: group.y, width: nodeWidth }}><Icon name="agent" size={14}/>{text('agents')} · {group.agents}</span>}
          </div>)}
          <svg className="organization-edges" width={width} height={height} aria-hidden="true">{visibleGraph.edges.filter(edge => visibleNodes.some(node => node.id === `project:${edge.projectId}`) && visibleNodes.some(node => node.id === `agent:${edge.agentId}`)).map(edge => {
            const a = point(graph.nodes.find(n => n.id === `project:${edge.projectId}`)!);
            const b = point(graph.nodes.find(n => n.id === `agent:${edge.agentId}`)!);
            const from = { x: a.x + nodeWidth, y: a.y + nodeHeight / 2 }, to = { x: b.x, y: b.y + nodeHeight / 2 };
            const active = (!highlighted || highlighted.has(`project:${edge.projectId}`) && highlighted.has(`agent:${edge.agentId}`)) &&
              (!selected || selected === `project:${edge.projectId}` || selected === `agent:${edge.agentId}`);
            return <path key={`${edge.projectId}:${edge.agentId}`} data-connection={`${edge.projectId}:${edge.agentId}`} className={active ? "connected" : "dimmed"}
              d={`M${from.x},${from.y} C${from.x + 32},${from.y} ${to.x - 32},${to.y} ${to.x},${to.y}`} />;
          })}</svg>
          {visibleNodes.map(node => {
            const p = point(node), entries = scopedExecutions(node.kind, node.identity.id);
            const states = (['approval', 'unknown', 'running', 'queued'] as const).filter(state => entries.some(item => item.state === state));
            return <Button key={node.id} type="button" data-node-id={node.id} data-graph-agent={node.kind === "agent" ? node.identity.id : undefined} data-graph-project={node.kind === "project" ? node.identity.id : undefined} aria-label={`${node.kind === "project" ? text("projects") : t("智能体")} · ${node.identity.name}`}
              aria-pressed={selected === node.id} className={`organization-node ${node.kind} ${highlighted && !highlighted.has(node.id) ? "dimmed" : ""}`}
              title={node.identity.name} style={{ left: p.x, top: p.y, width: nodeWidth, height: nodeHeight }} onClick={e => { selectionTrigger.current = null; if (e.detail === 0) focus(node.id); }}>
              <IdentityAvatar identity={node.identity} kind={node.kind} size={28} /><span className="organization-node-label"><strong>{node.identity.name}</strong><small>{node.kind === "project" ? say("项目", "Project") : say("智能体", "Agent")}<span aria-hidden="true">·</span>{node.kind === "agent" && <RuntimeIcon cli={(node.identity as Config["agents"][number]).defaultCli} size={13}/ >}{node.kind === "project" ? say(`${(node.identity as Config["projects"][number]).agentIds.filter(id=>config.agents.some(a=>a.id===id&&!a.systemRole)).length} 位智能体`, `${(node.identity as Config["projects"][number]).agentIds.filter(id=>config.agents.some(a=>a.id===id&&!a.systemRole)).length} Agents`) : runtimeLabel((node.identity as Config["agents"][number]).defaultCli)}</small></span>
              {(entries.length > 0 || !statusKnown) && <span className={`organization-node-status ${states.length > 1 ? 'is-mixed' : ''}`}>
                {statusKnown ? states.map(state => {
                  const count = entries.filter(item => item.state === state).length, label = `${stateLabel(state)} ${count}`;
                  return <span key={state} data-state={state} title={label} aria-label={label}><Icon name={stateIcons[state]} size={12}/><span className="organization-node-state-label">{stateLabel(state)}</span><b>{count}</b></span>;
                }) : <span title={runtimeError || snapshot?.errors?.includes('tasks') ? say('状态未知', 'Status unknown') : text('loading')} aria-label={runtimeError || snapshot?.errors?.includes('tasks') ? say('状态未知', 'Status unknown') : text('loading')}><Icon name="info" size={12}/>{say('状态未知', 'Status unknown')}</span>}
              </span>}
            </Button>;
          })}
        </div>
        {!graph.nodes.length && <p className="organization-empty">{text("empty")}</p>}
        {!!graph.nodes.length && !visibleNodes.length && <p className="organization-empty">{text("none")}</p>}
      </div>}
      {chosen && <aside className="organization-detail" aria-label={text("details")}>
        <header><IdentityAvatar identity={chosen.identity} kind={chosen.kind} size={34} /><div className="organization-detail-identity"><h2>{chosen.identity.name}</h2><span>{chosen.kind === "project" ? say('项目', 'Project') : t("智能体")}</span></div>
          <Button type="button" aria-label={text("close")} disabled={saving || !!editing} onClick={() => focus(null)}><Icon name="close" size={16} /></Button></header>
        <Button className="organization-settings" type="button" disabled={!onEdit || saving || !!editing} onClick={() => onEdit?.(chosen.kind, chosen.identity.id)}><Icon name="settings" size={16} />{text("settings")}<Icon name="arrowRight" size={14} /></Button>
        <dl className="organization-stats">{(['running','approval','queued','unknown'] as const).map(state => <div key={state}><dt>{stateLabel(state)}</dt><dd>{statusKnown ? currentExecutions.filter(item => item.state === state).length : '—'}</dd></div>)}</dl>
        {chosen.kind === 'agent' && <dl className="organization-runtime"><dt>{text('default')}</dt><dd><RuntimeIcon cli={(chosen.identity as Config['agents'][number]).defaultCli} size={20}/>{runtimeLabel((chosen.identity as Config['agents'][number]).defaultCli)}</dd><dt>{localize('默认模型', 'Default model')}</dt><dd>{(chosen.identity as Config['agents'][number]).models[(chosen.identity as Config['agents'][number]).defaultCli] || (localize('执行端默认', 'Runtime default'))}</dd></dl>}
        {chosen.kind === "project" && <p className="organization-path">{(chosen.identity as Config["projects"][number]).cwd}</p>}
        <section><div className="organization-section-heading"><h3>{text("relationships")}</h3><Button type="button" disabled={saving || !!editing} onClick={startEditing}><Icon name="link" size={14} />{text("editLinks")}</Button></div>
          {editing ? <form onSubmit={e => { e.preventDefault(); void saveLinks(); }}><fieldset disabled={saving}>
            {(chosen.kind === "agent" ? config.projects : config.agents.filter(a=>!a.systemRole)).map(identity => <label className="organization-link-option" key={identity.id}>
              <Input type="checkbox" checked={editing.chosen.includes(identity.id)} onChange={e => setEditing({ ...editing, chosen: e.target.checked ? [...editing.chosen, identity.id] : editing.chosen.filter(id => id !== identity.id) })} />
              <IdentityAvatar identity={identity} kind={chosen.kind === "agent" ? "project" : "agent"} size={20} />{identity.name}</label>)}
            <div className="organization-edit-actions"><Button className="primary" type="submit" disabled={JSON.stringify([...editing.original].sort()) === JSON.stringify([...editing.chosen].sort())}><Icon name="check" size={14} />{text(saving ? "saving" : "save")}</Button><Button type="button" onClick={() => { setEditing(null); setError(""); }}><Icon name="close" size={14} />{text("cancel")}</Button></div>
          </fieldset></form> : <div className="organization-links">{links.map(node => <Button key={node.id} type="button" onClick={() => focus(node.id)}><IdentityAvatar identity={node.identity} kind={node.kind} size={20} /><span>{node.identity.name}</span><Icon name="arrowRight" size={14} /></Button>)}{!links.length && <p>{text("noLinks")}</p>}</div>}
          {error && <p role="alert" className="form-error">{errorText(error)}</p>}{notice && <p role="status" className="organization-notice">{text("changes")}</p>}
        </section>
        <UsagePanel compact config={config} agentId={chosen.kind === 'agent' ? chosen.identity.id : undefined} projectId={chosen.kind === 'project' ? chosen.identity.id : undefined} onOpenPath={onOpenPath} />
        <Disclosure className="organization-activity" open={!statusKnown || currentExecutions.length > 0} title={localize('当前执行', 'Current executions')}>{!statusKnown ? <p>{runtimeError || snapshot?.errors?.includes('tasks') ? (localize('状态未知', 'Status unknown')) : text('loading')}</p> : !currentExecutions.length ? <p>{text('idle')}</p> : <div className="organization-executions">{currentExecutions.map(entry => {
          const chat = entry.kind === "run" ? undefined : conversations.find(item => item.id === entry.conversationId);
          return <div key={entry.id}><strong>{entry.title ?? text('unnamed')}</strong><span>{stateLabel(entry.state)}</span><dl className="organization-runtime"><dt>{localize('本次执行端', 'Actual CLI')}</dt><dd>{chat ? runtimeLabel(chat.cli) : (localize('未知', 'Unknown'))}</dd><dt>{localize('本次模型', 'Actual model')}</dt><dd>{chat?.model || (localize('未知', 'Unknown'))}</dd></dl>{entry.accessible && entry.href && <a href={entry.href} onClick={event => { if (onOpenPath) { event.preventDefault(); onOpenPath(entry.href!); } else if (entry.conversationId && onOpenConversation) { event.preventDefault(); onOpenConversation(entry.conversationId); } }}>{localize('打开执行', 'Open execution')}</a>}</div>;
        })}</div>}</Disclosure>
        <Disclosure className="organization-activity" title={text("recent")}><div className="organization-recent">{ownChats.slice(0, 4).map(chat => <Button key={chat.id} type="button" disabled={!onOpenConversation || saving || !!editing} onClick={() => onOpenConversation?.(chat.id)}><Icon name="message" size={15} /><span>{chat.title ?? text("unnamed")}</span><small>{runtimeLabel(chat.cli)}</small></Button>)}{!ownChats.length && <p>{text("noChats")}</p>}</div></Disclosure>
      </aside>}
    </div>
    <footer className="organization-footer"><span>{mode === 'graph' ? text('guide') : say('待处理和运行中的对象优先显示；选择成员查看详情。', 'Needs attention and active work appear first. Select a member for details.')}</span><div>{mode === 'graph' && <><Button type="button" aria-label={text("zoomOut")} onClick={() => zoom(.8)}><Icon name="search" size={14} /><span>−</span></Button><output>{Math.round(view.scale * 100)}%</output><Button type="button" aria-label={text("zoomIn")} onClick={() => zoom(1.25)}><Icon name="plus" size={14} /></Button><Button type="button" aria-label={viewportSize.width<480?say("居中节点","Center node"):text("fit")} onClick={() => fit()}><Icon name="workflow" size={15} /></Button></>}{selected && <Button type="button" disabled={saving || !!editing} onClick={() => focus(null)}><Icon name="close" size={14} />{text("reset")}</Button>}</div></footer>
  </section>;
}
