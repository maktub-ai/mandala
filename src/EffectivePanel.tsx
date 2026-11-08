import Button from './ui/Button';
import Input from './ui/Input';
import { startPolling } from './polling';
import Disclosure from './ui/Disclosure';
import { useEffect, useState } from "react";
import { api } from "./api";
import { useLanguage, type Message } from "./i18n";
import type { Cli, Resource } from "../shared/types";
import Icon from "./ui/Icon";
import Select from "./ui/Select";
import "./effective.css";
import LoadingState from "./ui/LoadingState";
import RuntimeIcon from "./ui/RuntimeIcon";
import { runtimeLabel } from "../shared/runtimes";
import type { ComposerReferenceItem } from "../shared/composer-references";
import { selectableReference } from "./ComposerReferences";

type Item = { name: string; source: "native" | "agent" | "project" | "system";
  scope: string; definition?: { path?: string };
  overridden: string[]; status: "available" | "unverified" | "effective" | "error" | "pending" | "restart" };
type Effective = { context?: { agent: { name: string; instructions: string } | null; project: { name: string; background: string } | null;
    documents: { id: string; title: string; status: "missing" | "denied" | "candidate" | "eligible" }[] }; mcp: Item[]; skills: Item[];
  resources: (Resource & { access: string })[];
  runtime?: { args: string[]; env: Record<string, string>; missing: string[]; status: string } };
const sources: Record<Item["source"], Message> = {
  project: "Project 层", agent: "Agent 层", native: "CLI 原生", system: "平台内置",
};
const statuses: Record<Item["status"], Message> = {
  available: "已发现", effective: "已验证加载", pending: "待应用",
  restart: "需重启", error: "加载失败", unverified: "未验证",
};
const priority: Record<Item["status"], number> = {
  error: 0, restart: 1, pending: 2, unverified: 3, effective: 4, available: 5,
};
const needsAttention = (item: Item) => ["error", "pending", "restart"].includes(item.status);
const sourceOrder: Record<Item["source"], number> = { agent: 0, project: 1, system: 2, native: 3 };

export default function EffectivePanel({ projectId, agentId, cli, conversationId, workspaceId, cwd, view = "all", visible = true, references = [], onReference }: {
  view?: "all" | "sources" | "capabilities"; visible?: boolean;
  references?: ComposerReferenceItem[]; onReference?: (item: ComposerReferenceItem) => void;
  projectId: string; agentId: string; cli: Cli; conversationId?: string; workspaceId?: string | null; cwd?: string;
}) {
  const {text: localize,  t, errorText } = useLanguage();
  const say = (zh: string, en: string) => localize(zh, en);
  const [reload, setReload] = useState(0);
  const [data, setData] = useState<Effective | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [source, setSource] = useState("all");
  const [status, setStatus] = useState("all");
  const [expanded, setExpanded] = useState({ mcp: false, skills: false });
  const [kindFilter, setKindFilter] = useState<"all" | "skills" | "mcp">("all");
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    setData(null);
    setError("");
  }, [projectId, agentId, cli, conversationId, workspaceId, cwd, reload]);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    const query = new URLSearchParams({ projectId, agentId, cli });
    if (workspaceId !== undefined) query.set("workspaceId", workspaceId ?? "");
    if (cwd) query.set("cwd", cwd);
    if (conversationId) query.set("conversationId", conversationId);
    const refresh = (signal: AbortSignal) => api<Effective>("/effective?" + query, 'GET', undefined, signal).then((value) => {
      if (active) { setData(value); setError(""); }
    }).catch((e) => { if (active) setError(e.message); });
    const controller = new AbortController();
    const stop = conversationId ? startPolling(refresh, 3000) : () => controller.abort();
    if (!conversationId) void refresh(controller.signal);
    return () => { active = false; stop(); };
  }, [projectId, agentId, cli, conversationId, workspaceId, cwd, reload, visible]);
  const failure = error && <div className="effective-error" role="alert"><p>{errorText(error)}</p><Button type="button" onClick={() => setReload(value => value + 1)}>{say("重新检测", "Retry detection")}</Button></div>;
  if (!data) return failure || <LoadingState label={t("检测中…")} />;
  const contextSources = data.context && <Disclosure className="effective-context" title={<> <Icon name="book" size={15} />{say("基础指令与候选资料", "Instructions and available sources")} </>}>
      {data.context.agent && <section><h4>{t("智能体")} · {data.context.agent.name}</h4><p>{data.context.agent.instructions}</p></section>}
      {data.context.project && <section><h4>{t("项目背景")} · {data.context.project.name}</h4><p>{data.context.project.background}</p></section>}
      <ul>{data.context.documents.map(doc => <li key={doc.id}><span>{doc.title}</span><small>{t(doc.status === "eligible" ? "按任务相关性检索" : doc.status === "candidate" ? "候选" : doc.status === "denied" ? "无使用权限" : "引用已不可用")}</small></li>)}</ul>
      <p className="field-hint">{t("此处为已保存的来源。实际加载的资料见本轮执行过程；未引用文档不会自动进入上下文。")}</p>
    </Disclosure>;
  if (view === "sources") return <>{failure}{contextSources}</>;
  const runtimePreview = data.runtime && <Disclosure className="runtime-preview" title={<><Icon name="terminal" size={16} />{t("运行参数")}</>}>
      <p className="field-hint">{t(data.runtime.status === "passed" ? "已传给执行端" : data.runtime.missing.length ? "环境变量未定义" : "待启动")}</p>
      <dl><div><dt>{t("启动参数")}</dt><dd>{data.runtime.args.length ? <code>{JSON.stringify(data.runtime.args)}</code> : t("沿用原生设置")}</dd></div>
      <div><dt>{t("环境变量引用")}</dt><dd>{Object.entries(data.runtime.env).length ? Object.entries(data.runtime.env).map(([name, ref]) => <div key={name}><code>{name} = {ref}</code>{data.runtime!.missing.includes(name) && <span> · {t("环境变量未定义")}</span>}</div>) : t("沿用原生设置")}</dd></div></dl>
    </Disclosure>;
  const linkedResources = !!data.resources.length && <section><h3><Icon name="folder" size={16} />{t("关联资源")}</h3>
      {data.resources.map((r) => <div className="effective-row" key={r.id}>
        <strong>{r.label}</strong><span>{r.kind}</span>
        <span>{t(r.access === "not-checked-out" ? "尚无工作副本" :
          r.access === "missing" ? "目录不存在" : r.access === "passed-to-cli" ? "已传给 CLI，访问未验证" : "未验证目录访问")}</span>
      </div>)}
    </section>;
  if (view === "capabilities") {
    const term = search.trim().toLowerCase();
    return <div className="effective-panel capability-browser">
      {failure}
      <div className="capability-toolbar">
        {(["all", "skills", "mcp"] as const).map(value => <Button key={value} type="button" className="capability-chip" aria-pressed={kindFilter === value} onClick={() => setKindFilter(value)}>
          {value === "all" ? say("全部", "All") : value === "mcp" ? "MCP" : "Skills"}{value !== "all" && <small>{data[value].length}</small>}</Button>)}
        <Button type="button" className="icon-button" aria-label={say("搜索能力", "Search capabilities")} aria-expanded={searching || !!search}
          onClick={() => { if (searching || search) { setSearching(false); setSearch(""); } else setSearching(true); }}><Icon name={searching || search ? "close" : "search"} size={15} /></Button>
      </div>
      {(searching || !!search) && <Input type="search" className="capability-search" autoFocus aria-label={t("能力名称搜索")} placeholder={t("输入能力名称")} value={search} onChange={(event) => setSearch(event.target.value)} />}
      {(["skills", "mcp"] as const).filter(kind => kindFilter === "all" || kindFilter === kind).map(kind => {
        const filtered = data[kind].filter(item => item.name.toLowerCase().includes(term))
          .sort((a, b) => priority[a.status] - priority[b.status] || sourceOrder[a.source] - sourceOrder[b.source] || a.name.localeCompare(b.name));
        const shown = expanded[kind] ? filtered : filtered.slice(0, 8);
        return <section className="effective-capabilities" key={kind} aria-labelledby={`effective-${kind}`}>
          <div className="effective-list-heading"><h3 id={`effective-${kind}`}>{kind === "mcp" ? "MCP" : "Skills"}</h3><small>{filtered.length}</small></div>
          {shown.length ? <ul className="capability-rows">{shown.map(item => {
            const reference = references.find(ref => ref.kind === (kind === "mcp" ? "mcp" : "skill") && ref.name === item.name);
            return <li key={item.name} className="capability-row">
              <span className={`capability-dot capability-dot-${item.status}`} aria-hidden="true" />
              <div><strong title={item.name}>{kind === "skills" && <span className="capability-prefix">/</span>}{item.name}</strong>
                <small>{t(sources[item.source])} · {t(statuses[item.status])}</small></div>
              {reference && onReference && selectableReference(reference) && <Button type="button" className="capability-insert" aria-label={say("插入 ", "Insert ") + item.name} onClick={() => onReference(reference)}>{say("插入", "Insert")}</Button>}
            </li>;
          })}</ul> : <p className="field-hint">{t(data[kind].length ? "没有匹配的能力。" : "未发现能力")}</p>}
          {filtered.length > 8 && <Button className="effective-expand" type="button"
            onClick={() => setExpanded((value) => ({ ...value, [kind]: !value[kind] }))}>
            <Icon name={expanded[kind] ? "arrowUp" : "chevronDown"} size={14} />{t(expanded[kind] ? "收起清单" : "展开全部")}</Button>}
        </section>;
      })}
      {onReference && <p className="field-hint">{say("点「插入」把能力加到正在写的消息里，发送时一起交给 Agent。", "Insert adds a capability to the message you are writing.")}</p>}
      <Disclosure className="effective-help" title={<> <Icon name="info" size={14} />{t("配置说明")} </>}>
        <p>{t("保存不等于生效。已生效仅表示 CLI 已报告加载。")}</p>
        <p>{t("优先显示加载失败、待应用和需重启的能力。")}</p>
        <p>{t("CLI 原生清单来自只读发现，可能未覆盖全部扩展来源。")}</p>
        {cli === "omp" && <p>{t("OMP 尚未提供逐项 MCP 状态；未验证不代表加载失败。")}</p>}
      </Disclosure>
      {runtimePreview}
      {linkedResources}
    </div>;
  }
  const items = [...data.mcp, ...data.skills];
  const summary: { label: Message; count: number }[] = [
    { label: "已发现", count: items.filter((item) => item.status === "available").length },
    { label: "已验证加载", count: items.filter((item) => item.status === "effective").length },
    { label: "待应用 / 需重启", count: items.filter((item) => item.status === "pending" || item.status === "restart").length },
    { label: "加载失败", count: items.filter((item) => item.status === "error").length },
    { label: "未验证", count: items.filter((item) => item.status === "unverified").length },
  ];
  return <div className="effective-panel">
    {failure}
    <header className="effective-runtime-heading"><RuntimeIcon cli={cli} size={24}/><div><h3>{runtimeLabel(cli)}</h3><p>{say("能力加载状态", "Capability loading status")}</p></div></header>
    <p className="effective-boundary"><Icon name="info" size={14} />{t("保存不等于生效。已生效仅表示 CLI 已报告加载。")}</p>
    {view === "all" && contextSources}

    <section className="effective-summary" aria-label={t("配置状态摘要")}>
      <dl>{summary.map((item) => <div key={item.label}>
        <dt>{t(item.label)}</dt><dd>{item.count}</dd>
      </div>)}</dl>
    </section>
    <div className="effective-filters">
      <label className="effective-search">{t("能力名称搜索")}
        <Input type="search" value={search} placeholder={t("输入能力名称")}
          onChange={(event) => setSearch(event.target.value)} /></label>
      <label>{t("来源筛选")}<Select ariaLabel={t("来源筛选")} value={source} onChange={setSource} searchable={false}
        options={[{ value: "all", label: t("全部来源") }, ...Object.entries(sources).map(([value, label]) => ({ value, label: t(label) }))]} /></label>
      <label>{t("状态筛选")}<Select ariaLabel={t("状态筛选")} value={status} onChange={setStatus} searchable={false}
        options={[{ value: "all", label: t("全部状态") }, { value: "attention", label: t("需处理") },
          ...Object.entries(statuses).map(([value, label]) => ({ value, label: t(label) }))]} /></label>
    </div>
    <Disclosure className="effective-help" title={<> <Icon name="info" size={14} />{t("配置说明")} </>}>
      <p>{t("优先显示加载失败、待应用和需重启的能力。")}</p>
      <p>{t("CLI 原生清单来自只读发现，可能未覆盖全部扩展来源。")}</p>
      {items.some((item) => item.overridden.includes("native")) &&
        <p>{t("同名覆盖是平台预期顺序；CLI 原生能力仍可能同时加载，需单独验证执行选择。")}</p>}
      {cli === "omp" && <p>{t("OMP 尚未提供逐项 MCP 状态；未验证不代表加载失败。")}</p>}
    </Disclosure>
    {(["mcp", "skills"] as const).map((kind) => {
      const filtered = data[kind].filter((item) =>
        item.name.toLowerCase().includes(search.trim().toLowerCase()) &&
        (source === "all" || item.source === source) &&
        (status === "all" || (status === "attention" ? needsAttention(item) : item.status === status)))
        .sort((a, b) => priority[a.status] - priority[b.status] || a.name.localeCompare(b.name));
      const visible = expanded[kind] ? filtered : filtered.slice(0, 6);
      return <section className="effective-capabilities" key={kind} aria-labelledby={`effective-${kind}`}>
        <div className="effective-list-heading"><h3 id={`effective-${kind}`}><Icon name={kind === "mcp" ? "tool" : "sparkles"} size={16} />{kind === "mcp" ? "MCP" : "Skills"}</h3>
          <small>{t("显示 {shown} / {total} 项", { shown: visible.length, total: filtered.length })}</small></div>
        {visible.length ? <ul className="effective-items">{visible.map((item) => <li className="effective-capability" key={item.name}>
          <div className="effective-capability-heading"><strong>{item.name}</strong>
            <span className={`effective-status effective-status-${item.status}`}>{t(statuses[item.status])}</span></div>
          <div className="effective-capability-meta"><span>{t(sources[item.source])}</span><small>{item.scope}</small>
            {item.overridden.length > 0 && <small>{t("覆盖")}: {item.overridden.map((origin) =>
              t(sources[origin as Item["source"]])).join(", ")}</small>}</div>
          {item.source === "native" && item.definition?.path?.startsWith("/") &&
            <Disclosure className="effective-path" title={say("来源路径", "Source path")}><code>{item.definition.path}</code></Disclosure>}
        </li>)}</ul> : <p className="field-hint">{t(data[kind].length ? "没有匹配的能力。" : "未发现能力")}</p>}
        {filtered.length > 6 && <Button className="effective-expand" type="button"
          onClick={() => setExpanded((value) => ({ ...value, [kind]: !value[kind] }))}>
          <Icon name={expanded[kind] ? "arrowUp" : "chevronDown"} size={14} />{t(expanded[kind] ? "收起清单" : "展开全部")}</Button>}
      </section>;
    })}
    {runtimePreview}
    {linkedResources}
  </div>;
}
