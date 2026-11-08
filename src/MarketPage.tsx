import { isUiExtension } from '../shared/ui-extensions';
import { useUiExtensions } from './UiExtensions';
import MarketExtensionDialog from './MarketExtensionDialog';
import { devicePreferences } from './devicePreferences';
import Button from './ui/Button';
import Input from './ui/Input';
import Select from './ui/Select';
import Disclosure from './ui/Disclosure';
import LoadingState from './ui/LoadingState';
import {WorkspacePage,PageHeader} from './ui/WorkspacePage';
import MetadataList from './ui/MetadataList';
import { useEffect, useRef, useState } from "react";
import type { Config } from "../shared/types";
import { marketSources, githubPluginSource, githubSkillSource, marketSourceOf, matchesMarketSource, marketSorts, sortMarketItems, type MarketSort, type MarketSource, type MarketSourceSnapshot, type MarketSourceId, type InstalledMarketItem, type MarketDetail, type MarketItem, type MarketKind, type MarketTarget } from "../shared/market";
import AppSidebar, { type SidebarNavigation } from "./AppSidebar";
import Dialog from "./Dialog";
import Icon, { type IconName } from "./ui/Icon";
import EmptyState from './ui/EmptyState';
import MarkdownMessage from "./MarkdownMessage";
import { api } from "./api";
import { readMarket } from "./market-read";
import { useLanguage } from "./i18n";
import "./market.css";

type Tab = "browse" | "installed";
type SearchResult = { items: MarketItem[]; nextCursor?: string; warnings?: string[] };
const builtinOrder: string[] = ["mandala-plugins", "clawhub", "anthropic", "mcp-registry", "mandala-themes", "mandala-languages", "mandala-pets"];
const initialFilters = () => {
  const params = new URLSearchParams(location.search), tab = params.get("tab"), kind = params.get("kind");
  return { sort: marketSorts.includes(params.get("sort") as MarketSort) ? params.get("sort") as MarketSort : "default" as const, tab: tab === "installed" ? "installed" as const : "browse" as const,
    kind: kind === "theme" || kind === "language" || kind === "pet" || kind === "plugin" ? kind as MarketKind : tab === "mcp" || kind === "mcp" ? "mcp" as const : tab === "skill" || kind === "skill" ? "skill" as const : "all" as const,
    source: (builtinOrder.includes(params.get("source") ?? "") || /^(?:github|plugins):[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(params.get("source") ?? "")) ? params.get("source") as MarketSourceId : "all" as const };
};
const savedSources = (): MarketSourceId[] => {
  try { const value = JSON.parse(devicePreferences.getItem("mana-market-sources") ?? "null");
    if (Array.isArray(value)) return builtinOrder.filter(id => value.includes(id));
  } catch { /* An unavailable preference does not prevent browsing. */ }
  return [...builtinOrder];
};
const capabilityIcon = (item: MarketItem): IconName => item.kind === "theme" ? "grid" : item.kind === "language" ? "globe" : item.kind === "pet" ? "sparkles" : /design|canvas|art|brand/.test(item.name) ? "grid" : /github|mcp-builder/.test(item.name) ? "code" : /pdf|doc|ppt|xls/.test(item.name) ? "file" : item.kind === "mcp" ? "tool" : "book";
export default function MarketPage({ navigation, mobileNav, onMobileNav, onConfigSaved, onNavigationLockChange }: {
  navigation: SidebarNavigation; mobileNav: boolean; onMobileNav: (open: boolean) => void; onConfigSaved: () => Promise<void>; onNavigationLockChange: (locked: boolean) => void;
}) {
  const {text: localize,  t, errorText, language } = useLanguage();
  const extensions = useUiExtensions();
  const [tab, setTab] = useState<Tab>(() => initialFilters().tab);
  const [kind, setKind] = useState<MarketKind | "all">(() => initialFilters().kind);
  const [sort, setSort] = useState<MarketSort>(() => initialFilters().sort);
  const [source, setSource] = useState<MarketSourceId | "all">(() => initialFilters().source);
  const [enabled, setEnabled] = useState<MarketSourceId[]>(savedSources);
  const [sourceSnapshot, setSourceSnapshot] = useState<MarketSourceSnapshot | null>(null);
  const [sourceDraft, setSourceDraft] = useState<{ sources: MarketSource[]; enabled: string[]; revision: string } | null>(null);
  const [addingSource, setAddingSource] = useState(false), [sourceLabel, setSourceLabel] = useState(""), [sourceUrl, setSourceUrl] = useState("");
  const [sourceType, setSourceType] = useState<"skill" | "plugin">("skill");
  const [sourceFormError, setSourceFormError] = useState("");
  const allSources: MarketSource[] = sourceSnapshot?.sources ?? [...marketSources];
  const sourceOrder = [...builtinOrder, ...allSources.filter(entry => !!entry.adapter).map(entry => entry.id)];
  const kindName = (value: MarketKind) => value === "plugin" ? localize("插件", "Plugins") : value === "theme" ? t("主题") : value === "language" ? t("语言包") : value === "pet" ? localize("桌宠", "Pets") : value === "skill" ? "Skill" : "MCP";
  const sourceName = (id: string) => allSources.find(entry => entry.id === id)?.name ?? id;
  const say = (english: string, chinese: string) => localize(chinese, english);
  const [query, setQuery] = useState(""), [submittedQuery, setSubmittedQuery] = useState("");
  const [items, setItems] = useState<MarketItem[]>([]), [cursors, setCursors] = useState<Partial<Record<MarketSourceId, string>>>({});
  const [snapshot, setSnapshot] = useState<{ config: Config; revision: string } | null>(null);
  const [libraryLoading, setLibraryLoading] = useState(true), [libraryError, setLibraryError] = useState("");
  const [capabilityInstallations, setInstallations] = useState<InstalledMarketItem[]>([]);
  const installations: InstalledMarketItem[] = [...capabilityInstallations, ...(extensions.snapshot?.plugins ?? []).map(item => ({ ...item, kind: "plugin" as const, id: item.catalogId, targets: [], missing: false, plugin: item })), ...(extensions.snapshot?.items ?? []).filter(item => !item.pluginId).map(item => ({ ...item, id: item.catalogId, targets: [], missing: false, extension: item }))];
  const [detail, setDetail] = useState<MarketDetail | null>(null), [selected, setSelected] = useState<MarketItem | null>(null);
  const [mode, setMode] = useState<"overview" | "install" | "contents">("overview");
  const [targetKind, setTargetKind] = useState<"agent" | "project">("agent"), [targetQuery, setTargetQuery] = useState("");
  const [targets, setTargets] = useState<MarketTarget[]>([]), [environment, setEnvironment] = useState<Record<string, string>>({});
  const [pendingSources, setPendingSources] = useState<string[]>([]);
  const loading = pendingSources.length > 0;
  const [sourcesLoading, setSourcesLoading] = useState(true), [sourcesError, setSourcesError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [sourceErrors, setSourceErrors] = useState<{ id: string; message: string }[]>([]), [notice, setNotice] = useState("");
  const request = useRef(0), detailRequest = useRef(0);
  const sourceRequests = useRef(new Map<string, AbortController>()), detailController = useRef<AbortController | null>(null), preferencesController = useRef<AbortController | null>(null), libraryController = useRef<AbortController | null>(null);
  const abortSearch = () => { sourceRequests.current.forEach(controller => controller.abort()); sourceRequests.current.clear(); };
  const selectedCard = useRef<HTMLButtonElement>(null);
  useEffect(() => { selectedCard.current?.scrollIntoView({ block: "nearest" }); }, [selected]);
  const activeSources = sourceOrder.filter(id => enabled.includes(id) && (source === "all" || id === source) && (kind === "all" || (allSources.find(entry => entry.id === id)!.kind === kind || kind === "plugin" && isUiExtension(allSources.find(entry => entry.id === id)!.kind) || isUiExtension(kind) && allSources.find(entry => entry.id === id)!.kind === "plugin")));
  useEffect(() => { onNavigationLockChange(busy); return () => onNavigationLockChange(false); }, [busy, onNavigationLockChange]);
  const unsupportedReason = (reason: string) => t(reason.includes("Skill metadata")
    ? "此 Skill 的 SKILL.md 缺少或不符合所需的 YAML 元数据（name、description），暂不能安装；仍可查看包内容。"
    : reason.includes("ClawHub") ? "此 ClawHub 包无法直接安装，请查看源目录。" : "此条目需要当前市场未支持的传输、参数或鉴权方式。");
  const failure = (message: string) => {
    if (message.includes("timed out")) return say("Request timed out. Retry or check network access.", "读取超时，请重试或检查网络连接。");
    if (message === "configuration changed") return t("配置已变化，已重新读取。请核对后重试。");
    if (message === "market capability name conflict") return t("能力名称已存在，请先处理目录中的同名定义。");
    if (message.includes("market version changed")) return t("目录版本已变化，请重新查看详情。");
    if (message.includes("environment references")) return t("请填写有效的环境变量引用。");
    if (message.includes("unsupported")) return unsupportedReason(message);
    const status = message.match(/^Market source HTTP (\d+)$/)?.[1];
    return status ? t("目录暂时不可用（HTTP {status}），请重试。", { status }) : errorText(message);
  };
  const reload = async () => {
    libraryController.current?.abort();
    const controller = new AbortController(); libraryController.current = controller;
    const [config, installed] = await Promise.all([readMarket<{ config: Config; revision: string }>("/config", controller.signal), readMarket<InstalledMarketItem[]>("/market/installed", controller.signal)]);
    setSnapshot(config); setInstallations(installed);
  };
  const loadLibrary = async () => {
    setLibraryLoading(true); setLibraryError("");
    try { await reload(); }
    catch (e) { if ((e as Error).name !== "AbortError") setLibraryError(failure((e as Error).message)); }
    finally { setLibraryLoading(false); }
  };
  useEffect(() => { void loadLibrary(); return () => { request.current++; detailRequest.current++; abortSearch(); detailController.current?.abort(); preferencesController.current?.abort(); libraryController.current?.abort(); }; }, []);
  const closeDetail = () => { detailRequest.current++; detailController.current?.abort(); setDetail(null); setSelected(null); setDetailLoading(false); setError(""); };
  const loadSources = async () => {
    preferencesController.current?.abort();
    const controller = new AbortController(); preferencesController.current = controller;
    setSourcesLoading(true); setSourcesError("");
    try {
      const value = await readMarket<MarketSourceSnapshot>("/market/sources", controller.signal);
      if (!controller.signal.aborted) { setSourceSnapshot(value); setEnabled(value.enabled ?? [...builtinOrder]); }
    } catch (e) { if (!controller.signal.aborted) setSourcesError(failure((e as Error).message)); }
    finally { if (!controller.signal.aborted) setSourcesLoading(false); }
  };
  useEffect(() => { void loadSources(); }, []);
  const search = async (more = false, retrySource?: string) => {
    if (!retrySource) { request.current++; abortSearch(); }
    const token = request.current;
    const sources = retrySource ? [retrySource] : activeSources.filter(id => !more || cursors[id]);
    setPendingSources(previous => retrySource ? [...new Set([...previous, retrySource])] : sources);
    setSourceErrors(previous => retrySource ? previous.filter(entry => entry.id !== retrySource) : []);
    if (!more && !retrySource) { setItems([]); setCursors({}); }
    await Promise.all(sources.map(async id => {
      sourceRequests.current.get(id)?.abort();
      const controller = new AbortController(); sourceRequests.current.set(id, controller);
      try {
        const result = await readMarket<SearchResult>(`/market/search?${new URLSearchParams({
          kind: allSources.find(entry => entry.id === id)!.kind, query: submittedQuery, source: id, sort, ...(more ? { cursor: cursors[id]! } : {}),
        })}`, controller.signal);
        if (request.current !== token || controller.signal.aborted) return;
        setItems(previous => {
          const retained = retrySource ? previous.filter(item => !matchesMarketSource(item, id)) : previous;
          return [...retained, ...result.items.filter(item => !retained.some(old => old.catalogId === item.catalogId))];
        });
        setCursors(previous => ({ ...previous, [id]: result.nextCursor ?? "" }));
        if (result.warnings?.length) setSourceErrors(previous => [...previous, { id, message: result.warnings!.join(" ") }]);
      } catch (e) {
        if (request.current === token && !controller.signal.aborted) setSourceErrors(previous => [...previous, { id, message: failure((e as Error).message) }]);
      } finally {
        if (request.current === token && sourceRequests.current.get(id) === controller) {
          sourceRequests.current.delete(id); setPendingSources(previous => previous.filter(value => value !== id));
        }
      }
    }));
  };
  useEffect(() => {
    request.current++; abortSearch(); closeDetail(); setNotice(""); setSourceErrors([]); setPendingSources([]); setCursors({});
    if (tab === "browse" && sourceSnapshot) void search();
    const params = new URLSearchParams({ tab }); if (kind !== "all") params.set("kind", kind); if (source !== "all") params.set("source", source); if (sort !== "default") params.set("sort", sort);
    history.replaceState(null, "", "/market?" + params);
    return abortSearch;
  }, [tab, kind, source, enabled, submittedQuery, sort, sourceSnapshot]);
  const select = async (item: MarketItem) => {
    detailController.current?.abort();
    const controller = new AbortController(); detailController.current = controller;
    const token = ++detailRequest.current; setSelected(item); setDetail(null); setTargets([]); setEnvironment({}); setTargetQuery(""); setTargetKind("agent");
    setError(""); setNotice(""); setMode("overview");
    if (tab === "installed") { setDetail(item); setDetailLoading(false); return; }
    setDetailLoading(true);
    try { const result = await readMarket<MarketDetail>("/market/detail?catalogId=" + encodeURIComponent(item.catalogId), controller.signal); if (detailRequest.current === token) setDetail(result); }
    catch (e) { if (detailRequest.current === token && !controller.signal.aborted) setError(failure((e as Error).message)); }
    finally { if (detailRequest.current === token) setDetailLoading(false); }
  };
  const selectedInstallation = installations.find(item => item.catalogId === detail?.catalogId);
  const mutate = async (operation: () => Promise<unknown>, success: string, clear = false) => {
    setBusy(true); setError(""); setNotice("");
    try { await operation(); await reload(); await onConfigSaved(); setNotice(success); setTargets([]); setMode("overview"); if (clear) closeDetail(); }
    catch (e) { const message = (e as Error).message; if (message === "configuration changed") await reload().catch(() => {}); setError(failure(message)); }
    finally { setBusy(false); }
  };
  const install = async () => {
    if (!snapshot || !detail) return;
    if (!targets.length) { setError(t("请选择至少一个使用范围。")); return; }
    const refs = Object.fromEntries(Object.entries(environment).filter(([, ref]) => ref.trim()).map(([name, ref]) => [name, ref.trim()]));
    if (Object.values(refs).some(ref => !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(ref)) || !selectedInstallation && detail.environment?.some(entry => entry.required && !refs[entry.name])) {
      setError(t("请填写有效的环境变量引用。")); return;
    }
    await mutate(() => api("/market/install", "POST", { catalogId: detail.catalogId, version: detail.version, revision: snapshot.revision, targets, environment: refs }), t(selectedInstallation ? "已添加关联" : "已安装并关联"));
  };
  const allTargets = snapshot ? [...snapshot.config.agents.map(owner => ({ kind: "agent" as const, id: owner.id, name: owner.name, cli: owner.defaultCli })),
    ...snapshot.config.projects.map(owner => ({ kind: "project" as const, id: owner.id, name: owner.name, cli: "Project" }))] : [];
  const shownTargets = allTargets.filter(target => target.kind === targetKind && target.name.toLowerCase().includes(targetQuery.toLowerCase()));
  const matchesKind = (item: MarketItem) => kind === "all" || item.kind === kind || kind === "plugin" && isUiExtension(item.kind) || isUiExtension(kind) && item.kinds?.includes(kind);
  const list: MarketItem[] = tab === "installed" ? installations.filter(item => (source === "all" || matchesMarketSource(item, source)) && matchesKind(item) && (item.name + " " + item.description).toLowerCase().includes(query.toLowerCase())) : sortMarketItems(items.filter(item => activeSources.some(id => matchesMarketSource(item, id)) && matchesKind(item)), sort);
  const popularity = (item: MarketItem, expanded = false) => {
    const metrics = [
      { key: "stars", label: "星标", icon: "star" }, { key: "downloads", label: "下载量", icon: "arrowDown" },
      { key: "installs", label: "安装量", icon: "check" }, { key: "comments", label: "评论", icon: "message" },
    ] as const;
    const available = metrics.filter(metric => (expanded || metric.key !== "comments") && item.stats?.[metric.key] !== undefined);
    return available.length ? <span className="market-popularity" title={t("来源统计")}>{available.map(metric => {
      const value = item.stats![metric.key]!, label = `${t(metric.label)} ${value.toLocaleString(language)}`;
      return <span key={metric.key} title={label} aria-label={label}><Icon name={metric.icon} size={13} />{t(metric.label)} <span>{new Intl.NumberFormat(language, { notation: "compact", maximumFractionDigits: 1 }).format(value)}</span></span>;
    })}</span> : expanded && tab === "browse" ? <span className="market-popularity market-metrics-missing">{t("来源未提供热度数据。")}</span> : null;
  };
  const updatedDate = (value: number) => new Date(value).toLocaleDateString(language, { year: "numeric", month: "2-digit", day: "2-digit" });
  const submitSearch = () => { closeDetail(); if (tab === "installed") return; if (submittedQuery === query.trim()) void search(); else setSubmittedQuery(query.trim()); };
  return <div className="app-shell market-page">
    <AppSidebar navigation={navigation} open={mobileNav} onClose={() => onMobileNav(false)} />
    <main data-page-width="standard" className={`market-main${selected ? " drawer-open" : ""}`}>

      <WorkspacePage width="standard" className="market-workspace"><PageHeader onMobileNav={()=>onMobileNav(true)} title={t("市场")} icon="market" actions={<><nav className="market-tabs" aria-label={t("市场分类")}>{(["browse", "installed"] as const).map(value => <Button type="button" key={value} disabled={busy} aria-label={t(value === "browse" ? "浏览" : "已安装")} aria-current={tab === value ? "page" : undefined} onClick={() => { setTab(value); onMobileNav(false); }}>{t(value === "browse" ? "浏览" : "已安装")}{value === "installed" && !!installations.length && <small>{installations.length}</small>}</Button>)}</nav><Button className="market-manage-sources" disabled={busy || !sourceSnapshot} onClick={() => { setSourceDraft({ sources: allSources.filter(entry => !!entry.adapter), enabled: [...(sourceSnapshot!.enabled ?? builtinOrder)], revision: sourceSnapshot!.revision }); setAddingSource(false); setSourceFormError(""); }}><Icon name="settings" size={16} />{t("管理来源")}</Button></>}>
       <div className="market-toolbar"><form className="market-search" onSubmit={event => { event.preventDefault(); submitSearch(); }}>
        <Icon name="search" size={18} /><Input type="search" aria-label={t("搜索市场")} placeholder={t("搜索能力、名称或用途")} value={query} disabled={busy} onChange={event => setQuery(event.target.value)} />
        {tab === "browse" && <Button type="submit" disabled={busy}>{t("搜索")}</Button>}
      </form><Select ariaLabel={t("市场来源")} value={source} onChange={value=>setSource(value as MarketSourceId|"all")} disabled={busy} options={[{value:"all",label:t("全部市场")},...sourceOrder.filter(id=>enabled.includes(id)||tab==="installed").map(id=>({value:id,label:sourceName(id)}))]}/>        <Select ariaLabel={t("能力类型")} value={kind} onChange={value=>setKind(value as MarketKind | "all")} options={[{value:"all",label:(t("全部类型"))},{value:"skill",label:"Skills"},{value:"mcp",label:"MCP"},{value:"plugin",label:localize("插件", "Plugins")},{value:"theme",label:t("主题")},{value:"language",label:t("语言包")},{value:"pet",label:localize("桌宠", "Pets")}]} disabled={busy}/>
        {tab === "browse" && <Select ariaLabel={t("市场排序")} value={sort} onChange={value=>setSort(value as MarketSort)} options={[{value:"default",label:say("Default","默认排序")},{value:"downloads",label:(t("下载最多"))},{value:"stars",label:(t("星标最多"))},{value:"updated",label:(t("最近更新"))}]} disabled={busy}/>}</div>
      </PageHeader><div className="market-content">
      {tab === "browse" && sort !== "default" && <p className="market-ranking-hint">{t(activeSources.length === 1 && activeSources[0] === "clawhub" && !submittedQuery ? "按 ClawHub 源站排行；加载更多继续浏览。" : "仅对已加载结果排序；未提供统计的数据排在后面。")}</p>}
      {!!sourceErrors.length && <div role="alert" className="market-source-errors">{sourceErrors.map(entry => <div className="market-source-error" key={entry.id}><Icon name="info" size={17} /><p>{sourceName(entry.id)} · {entry.message}</p><Button disabled={pendingSources.includes(entry.id) || busy} aria-label={`${t("重试")} ${sourceName(entry.id)}`} onClick={() => void search(false, entry.id)}>{t("重试")}</Button></div>)}</div>}
      {sourcesError && <div role="alert" className="market-source-error"><Icon name="info" size={17} /><p>{sourcesError}</p><Button onClick={() => void loadSources()}>{say("Retry sources", "重试来源")}</Button></div>}
      {extensions.error && <div role="alert" className="market-source-error"><p>{failure(extensions.error)}</p><Button onClick={() => void extensions.refresh()}>{t("重试")}</Button></div>}
      {libraryError && <div role="alert" className="market-source-error"><Icon name="info" size={17} /><p>{libraryError}</p><Button disabled={libraryLoading} onClick={() => void loadLibrary()}>{say("Retry installed capabilities", "重试已安装能力")}</Button></div>}
      {!selected && error && <div role="alert" className="error">{error}</div>}
      {!selected && notice && <p role="status" className="market-notice">{notice} · {t("已保存，实际生效状态请在对话的能力面板检查。")}</p>}
      <section className="market-results" aria-label={t(tab === "installed" ? "已安装" : "浏览市场")} aria-busy={tab === "installed" ? libraryLoading : loading || sourcesLoading}>
        {(tab === "installed" ? libraryLoading : loading || sourcesLoading) && !list.length ? <LoadingState label={t("正在读取市场…")} /> : (tab === "installed" || !!sourceSnapshot) && !list.length && !sourceErrors.length && !error && !(tab === "installed" && libraryError) && <EmptyState className="market-empty" icon={tab === "installed" ? "grid" : "search"}><strong>{t(tab === "installed" ? "尚未安装市场能力。" : !enabled.length ? "尚未启用市场来源。" : "没有匹配的结果。")}</strong><p>{t(tab === "installed" ? "从市场添加能力后，可在这里查看关联位置与管理安装。" : !enabled.length ? "在管理来源中选择想浏览的市场。" : "试试其他关键词、来源或能力类型。")}</p></EmptyState>}
        {list.length > 0 && <p className="market-result-summary" aria-live="polite">{say(`${list.length} capabilities shown`, `已显示 ${list.length} 项能力`)}{loading && <span>{say(`Loading ${pendingSources.map(sourceName).join(", ")}…`, `正在读取 ${pendingSources.map(sourceName).join("、")}…`)}</span>}</p>}
        <div className="market-grid">{list.map(item => {
          const installed = installations.find(entry => entry.catalogId === item.catalogId);
          return <Button type="button" key={item.catalogId} ref={selected?.catalogId === item.catalogId ? selectedCard : undefined} className={`market-card${selected?.catalogId === item.catalogId ? " selected" : ""}`} aria-label={`${t("查看详情")} ${item.name}`} disabled={busy} onClick={() => void select(item)}>
            <span className={`market-capability-icon ${item.kind}`}><Icon name={capabilityIcon(item)} size={20}/></span>
            <span className="market-card-content"><span className="market-item-heading"><strong>{item.name}</strong><small>{kindName(item.kind)}{item.kinds?.length ? ` · ${item.kinds.map(kindName).join(" / ")}` : ""}</small></span><span className="market-description">{item.description||t("查看包内容以了解用途。")}</span><span className="market-item-meta"><span className="market-card-source">{sourceName(marketSourceOf(item.catalogId))}{item.publisher&&item.publisher!=="Anthropic"&&<small>{item.publisher}</small>}</span>{popularity(item)}{item.updatedAt!==undefined&&<span className="market-updated"><Icon name="clock" size={12}/>{updatedDate(item.updatedAt)}</span>}{tab==="installed"&&installed&&!isUiExtension(item.kind)&&item.kind!=="plugin"&&<span className="market-card-links">{t("关联 {count} 个位置",{count:installed.targets.length})}{installed.missing&&` · ${t("能力定义缺失")}`}</span>}</span></span>
            <span className="market-card-action">{t(installed?"已安装":"查看详情")}<Icon name={installed?"check":"chevronRight"} size={14}/></span>
          </Button>;
        })}</div>
        {Object.values(cursors).some(Boolean) && tab === "browse" && <Button className="market-load-more" disabled={loading || busy} onClick={() => void search(true)}>{t(loading ? "正在读取市场…" : "加载更多")}</Button>}
      </section>
      <p className="market-source-hint">{localize("从市场发现技能、连接，以及主题、语言和桌宠插件。", "Discover skills, connections, and theme, language and pet plugins.")}</p></div></WorkspacePage>
    </main>
    {selected && (isUiExtension(selected.kind) || selected.kind === "plugin") ? <MarketExtensionDialog item={selected} detail={detail} loading={detailLoading} error={error} onRetry={() => void select(selected)} onClose={closeDetail} onBusy={setBusy}/> : selected && <Dialog label={t("能力详情")} className={`market-drawer ${mode}`} locked={busy} onClose={closeDetail}>
      <header className="market-drawer-header"><div><h2>{mode === "install" ? t("安装 {name}", { name: selected.name }) : selected.name}</h2><p>{sourceName(marketSourceOf(selected.catalogId))} · {selected.kind === "skill" ? "Skill" : "MCP"}</p></div><Button className="market-close" aria-label={t("关闭详情")} disabled={busy} onClick={closeDetail}><Icon name="close" size={20} /></Button></header>
      <div className="market-drawer-body">
        {error && <p role="alert" className="error">{error}</p>}
        {notice && <p role="status" className="market-notice">{notice} · {t("已保存，实际生效状态请在对话的能力面板检查。")}</p>}
        {detailLoading ? <p>{t("正在读取详情…")}</p> : !detail ? <Button onClick={() => void select(selected)}>{t("重试")}</Button> : <>
          <div className="market-drawer-summary"><span className={`market-capability-icon ${detail.kind}`}><Icon name={capabilityIcon(detail)} size={24} /></span><div>{mode==="install"&&<h3>{detail.name}</h3>}<p>{detail.description}</p></div></div>
          {popularity(detail, true)}
          <MetadataList items={[{label:t("版本"),value:<code title={detail.version}>{/^[a-f0-9]{40}$/.test(detail.version)?detail.version.slice(0,8):detail.version}</code>},...(detail.updatedAt!==undefined?[{label:t("更新时间"),value:<time title={new Date(detail.updatedAt).toISOString()}>{updatedDate(detail.updatedAt)}</time>}]:[]),{label:t("运行兼容性"),value:<span className="market-compatibility"><Icon name="info" size={14}/>{t(detail.unsupported?"暂不兼容":"待验证")}</span>}]}/>
          {detail.unsupported && <p className="error">{unsupportedReason(detail.unsupported)}</p>}
          {selectedInstallation?.missing && <p className="error">{t("能力定义已被移除，需重新安装。")}</p>}
          {mode !== "install" && detail.readme && <nav className="market-detail-tabs"><Button aria-pressed={mode === "overview"} onClick={() => setMode("overview")}>{t("概览")}</Button><Button aria-pressed={mode === "contents"} onClick={() => setMode("contents")}>{t("包内容")}</Button></nav>}
          {mode === "contents" && detail.readme ? <div className="market-readme"><MarkdownMessage text={detail.readme} /></div> : <>
            {mode === "install" && <fieldset disabled={busy || !!detail.unsupported || !snapshot || !!selectedInstallation?.missing} className="market-targets"><legend>{t("安装到哪里")}</legend>
              <div className="market-target-kind">{(["agent", "project"] as const).map(value => <Button type="button" key={value} aria-pressed={targetKind === value} onClick={() => setTargetKind(value)}>{value === "agent" ? t("智能体") : "Project"}</Button>)}</div>
              <Input type="search" aria-label={t("搜索使用范围")} placeholder={targetKind === "agent" ? t("搜索 Agent") : t("搜索 Project")} value={targetQuery} onChange={event => setTargetQuery(event.target.value)} />
              <div className="market-target-list">{shownTargets.map(target => {
                const linked = selectedInstallation?.targets.some(item => item.kind === target.kind && item.id === target.id);
                return <label key={target.kind + target.id}><Input type="checkbox" aria-label={`${target.kind === "agent" ? t("智能体") : "Project"} · ${target.name}`} disabled={linked} checked={!!linked || targets.some(item => item.kind === target.kind && item.id === target.id)} onChange={event => setTargets(previous => event.target.checked ? [...previous, { kind: target.kind, id: target.id }] : previous.filter(item => item.kind !== target.kind || item.id !== target.id))} /><span>{target.name}<small>{linked ? t("已关联") : target.cli}</small></span></label>;
              })}{!shownTargets.length && <p className="field-hint">{t(allTargets.length ? "没有匹配的结果。" : "请先创建 Agent 或 Project。")}</p>}</div>
              <p className="market-target-count">{t("已选择 {count} 个位置", { count: targets.length })}</p>
              <p className="market-install-hint"><Icon name="info" size={16} />{t("仅影响所选 Agent 或 Project 的后续能力加载。")}</p>
              {!selectedInstallation && detail.environment?.map(entry => <label className="market-env" key={entry.name}>{entry.name}{entry.required ? " *" : ""}<Input type="text" aria-label={entry.name} autoComplete="off" spellCheck={false} placeholder="${VARIABLE_NAME}" value={environment[entry.name] ?? ""} onChange={event => setEnvironment(previous => ({ ...previous, [entry.name]: event.target.value }))} /><small>{entry.description} · {t("使用 ${VARIABLE_NAME}，不填写密钥正文。")}</small></label>)}
            </fieldset>}
            {selectedInstallation && mode === "overview" && <section className="market-installed-actions"><h3>{t("引用位置")}</h3>{selectedInstallation.targets.map(target => <div key={target.kind + target.id}><span><Icon name={target.kind === "agent" ? "agent" : "project"} size={16} />{target.name}<small>{target.kind === "agent" ? t("智能体") : "Project"}</small></span><Button disabled={busy || !snapshot} aria-label={`${t("解除关联")} ${target.name}`} onClick={() => void mutate(() => api(`/market/installed/${selectedInstallation.id}/unlink`, "POST", { revision: snapshot!.revision, target: { kind: target.kind, id: target.id } }), t("已解除关联"))}>{t("解除关联")}</Button></div>)}{!selectedInstallation.targets.length && <p className="field-hint">{t("尚未关联使用位置。")}</p>}<p className="field-hint">{t("先解除全部关联，才能卸载。历史对话已加载的上下文不会被撤回。")}</p><Button disabled={busy || !!selectedInstallation.targets.length || !snapshot} onClick={() => void mutate(() => api(`/market/installed/${selectedInstallation.id}/uninstall`, "POST", { revision: snapshot!.revision }), t("已卸载"), true)}><Icon name="trash" size={15} />{t("卸载")}</Button></section>}
            {detail.fileCount !== undefined && <p className="field-hint">{t("配套文件：{count} 个", { count: detail.fileCount })} · {t("保留完整目录，固定到所示版本。")}</p>}
            {(detail.requirements || detail.environment?.length) && <section className="market-requirements"><h3>{t("依赖项")}</h3><p>{[...(detail.requirements?.binaries ?? []), ...(detail.requirements?.environment ?? []), ...(detail.requirements?.platforms ?? []), ...(detail.environment?.map(entry => entry.name) ?? [])].join(" · ") || t("未声明额外依赖")}</p></section>}
            {detail.connection && <Disclosure className="market-recipe" title={<> {t("安装配置")} </>}><pre>{JSON.stringify(detail.connection, null, 2)}</pre><p className="field-hint">{t(detail.connection.transport === "stdio" ? "npm MCP 由原生 CLI 首次连接时下载；安装只保存下列启动配置。" : "HTTP MCP 由原生 CLI 连接；服务鉴权与实际兼容性需在对话中验证。")}</p></Disclosure>}
            <a className="market-source-link" href={detail.sourceUrl} target="_blank" rel="noopener noreferrer">{t("查看源目录")}<Icon name="external-link" size={14} /></a>
          </>}
        </>}
      </div>
      {detail && <footer className="market-drawer-footer">{mode === "install" ? <><Button className="market-back" disabled={busy} onClick={() => setMode("overview")}><Icon name="arrowLeft" size={16} />{t("返回详情")}</Button><Button className="primary" disabled={busy || !targets.length || !!detail.unsupported || !snapshot || !!selectedInstallation?.missing} onClick={() => void install()}>{t(busy ? "正在安装…" : selectedInstallation ? "添加关联" : "安装并关联")}</Button></> : <Button className="primary" disabled={busy || !!detail.unsupported || !snapshot || !!selectedInstallation?.missing} onClick={() => setMode("install")}>{t(selectedInstallation ? "添加关联" : "安装")}</Button>}</footer>}
    </Dialog>}
    {sourceDraft && <Dialog label={t("管理来源")} className="market-source-dialog" locked={busy} onClose={() => setSourceDraft(null)}>
      <header><h2>{t("管理来源")}</h2><Button disabled={busy} aria-label={t("关闭")} onClick={() => setSourceDraft(null)}><Icon name="close" size={18} /></Button></header>
      <p>{t("选择想浏览的市场。已安装的能力不受影响。")}</p>
      <div className="market-source-list">{[...builtinOrder.map(id => allSources.find(entry => entry.id === id)!), ...sourceDraft.sources].map(entry => <div className="market-source-row" key={entry.id}>
        <label><Input type="checkbox" aria-label={entry.name} disabled={busy} checked={sourceDraft.enabled.includes(entry.id)} onChange={event => setSourceDraft(previous => previous && ({ ...previous, enabled: event.target.checked ? [...previous.enabled, entry.id] : previous.enabled.filter(id => id !== entry.id) }))} /><span><strong>{entry.name}</strong><small>{entry.adapter === "github-skills" ? say("GitHub Skills repository", "GitHub Skills 仓库") : kindName(entry.kind)}</small>{entry.adapter && <small>{entry.url}</small>}</span></label>
        <a href={entry.url} aria-label={t("访问 {name}", { name: entry.name })} target="_blank" rel="noopener noreferrer"><Icon name="external-link" size={16} /></a>
        {entry.adapter && <Button disabled={busy} aria-label={say(`Remove ${entry.name}`, `移除 ${entry.name}`)} onClick={() => setSourceDraft(previous => previous && ({ ...previous, sources: previous.sources.filter(item => item.id !== entry.id), enabled: previous.enabled.filter(id => id !== entry.id) }))}><Icon name="trash" size={16} /></Button>}
      </div>)}</div>
      {!addingSource ? <Button className="market-add-source" disabled={busy || sourceDraft.sources.length >= 10} onClick={() => { setAddingSource(true); setSourceLabel(""); setSourceUrl(""); setSourceFormError(""); }}><Icon name="plus" size={16} />{say("Add source", "添加来源")}</Button> : <form className="market-add-source-form" onSubmit={event => {
        event.preventDefault();
        try {
          const added = (sourceType === "plugin" ? githubPluginSource : githubSkillSource)(sourceLabel, sourceUrl.trim());
          if ([...marketSources, ...sourceDraft.sources].some(entry => entry.url.toLowerCase() === added.url)) throw new Error("duplicate");
          setSourceDraft(previous => previous && ({ ...previous, sources: [...previous.sources, added], enabled: [...previous.enabled, added.id] })); setAddingSource(false); setSourceFormError("");
        } catch { setSourceFormError(say("Enter a name and an unused canonical GitHub repository URL (https://github.com/owner/repo).", "请填写名称及未重复的 GitHub 仓库标准地址（https://github.com/owner/repo）。")); }
      }}>
        <h3>{say("Add GitHub repository", "添加 GitHub 仓库")}</h3>
        <Select ariaLabel={localize("来源类型", "Source type")} value={sourceType} onChange={value => setSourceType(value as "skill" | "plugin")} options={[{ value: "skill", label: "Skills" }, { value: "plugin", label: localize("数据型插件", "Data plugins") }]} />
        <p className="field-hint">{sourceType === "plugin" ? localize("读取 main 分支的 catalog.json，安装时验证固定提交与校验和。仅支持公开可读取的数据型插件目录。", "Reads catalog.json on main; installs verify pinned commits and checksums. Only publicly readable data plugin catalogs are supported.") : say("Public GitHub repositories using skills/<name>/SKILL.md. Browsing follows the default branch; installation pins its revision.", "仅支持包含 skills/<name>/SKILL.md 的 GitHub 公开仓库。浏览默认分支，安装固定到所示修订。")}</p>
        <label>{say("Source name", "来源名称")}<Input required maxLength={80} value={sourceLabel} onChange={event => setSourceLabel(event.target.value)} /></label>
        <label>{say("Repository URL", "仓库地址")}<Input required type="url" autoComplete="off" spellCheck={false} placeholder="https://github.com/owner/repo" value={sourceUrl} onChange={event => setSourceUrl(event.target.value)} /></label>
        <div><Button type="button" onClick={() => { setAddingSource(false); setSourceFormError(""); }}>{say("Cancel addition", "取消添加")}</Button><Button type="submit">{say("Add to draft", "加入草稿")}</Button></div>
      </form>}
      {sourceFormError && <p role="alert" className="error">{sourceFormError}</p>}
      <footer><Button disabled={busy} onClick={() => setSourceDraft(null)}>{t("取消")}</Button><Button className="primary" disabled={busy || addingSource} onClick={async () => {
        setBusy(true); setSourceFormError("");
        try {
          const saved = await api<MarketSourceSnapshot>("/market/sources", "PUT", sourceDraft);
          setSourceSnapshot(saved); setEnabled(saved.enabled ?? [...builtinOrder]);
          if (source !== "all" && !saved.enabled?.includes(source)) setSource("all");
          setSourceDraft(null);
        } catch (e) { if ((e as Error).message === "market sources changed") { const current = await readMarket<MarketSourceSnapshot>("/market/sources").catch(() => null); if (current) { const selection=current.enabled ?? [...builtinOrder]; setSourceSnapshot(current); setEnabled(selection); if(source!=="all"&&!selection.includes(source))setSource("all"); } } setSourceFormError((e as Error).message === "market sources changed" ? say("Sources changed elsewhere. Close and reopen Manage sources, then retry.", "来源已在其他位置变化，请关闭并重新打开来源管理后重试。") : failure((e as Error).message)); }
        finally { setBusy(false); }
      }}>{t(busy ? "保存中…" : "保存")}</Button></footer>
    </Dialog>}

  </div>;
}
