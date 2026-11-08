import Button from './ui/Button';
import Input from './ui/Input';
import { runtimeLabel } from "../shared/runtimes";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Agent, Conversation, Project } from "../shared/types";
import { buildConversationGroups, conversationEnvironment } from "./libraryGroups";
import IdentityAvatar from "./IdentityAvatar";
import Icon from "./ui/Icon";
import Select from "./ui/Select";
import { conversationDragType } from '../shared/composer-references';
import { useLanguage, type Message } from "./i18n";
import "./library.css";

type Props = {
  chats: Conversation[]; projects: Project[]; agents: Agent[];
  selectedId: string; projectId: string; search: string;
  onSearch: (search: string) => void; onOpen: (id: string) => void;
  onArchive?: (id: string, archived: boolean) => void;
  onReference?: (id: string) => void;
  canReference?: (id: string) => boolean;
  draft?: { projectName: string; agentName: string; projectId?: string; agentId?: string };
  onOpenDraft?: () => void; draftCurrent?: boolean;
  view: string; onView: (view: string) => void;
  sort: string; onSort: (sort: string) => void;
};
const views: { value: string; label: Message }[] = [
  { value: "recent", label: "最近对话" }, { value: "projects", label: "按项目" },
  { value: "agents", label: "按 Agent" },
  { value: "archived", label: "已归档" },
];
const statuses: Record<Conversation["status"], Message> = {
  idle: "就绪", running: "执行中", approval: "等待审批", interrupted: "已中断", error: "失败",
};

export default function ConversationLibrary({ chats, projects, agents, selectedId, projectId, search,
  onSearch, onOpen, onArchive, onReference, canReference, draft, onOpenDraft, draftCurrent, view, onView, sort, onSort }: Props) {
  const { t, text:localize, language } = useLanguage();
  const [menu, setMenu] = useState<{ chat: Conversation; top: number; right: number; anchorTop:number; anchorRight:number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const closeMenu = (restoreFocus = false) => { setMenu(null); if (restoreFocus) menuTrigger.current?.focus(); };
  useEffect(() => {
    if (!menu) return;
    (menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? menuRef.current)?.focus();
    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !menuTrigger.current?.contains(event.target as Node)) closeMenu();
    };
    // A delayed focus-scroll event may arrive after opening without moving the anchor.
    const reposition = (event:Event) => {
      const rect=menuTrigger.current?.getBoundingClientRect();
      if(event.type==='resize'||!rect||rect.top!==menu.anchorTop||rect.right!==menu.anchorRight)closeMenu();
    };
    document.addEventListener("pointerdown", outside);
    addEventListener("resize", reposition);
    addEventListener("scroll", reposition, true);
    return () => { document.removeEventListener("pointerdown", outside); removeEventListener("resize", reposition); removeEventListener("scroll", reposition, true); };
  }, [menu]);
  useEffect(() => { closeMenu(); }, [view, search]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const groups = buildConversationGroups(chats, projects, agents, { view, sort, search });
  const count = groups.reduce((total, group) => total + group.chats.length, 0);
  const menuChat = menu ? chats.find((chat) => chat.id === menu.chat.id) : undefined;
  const grouped = view === "projects" || view === "agents";
  const showDraft = draft && !selectedId && !["archived", "completed"].includes(view) && (!search.trim() ||
    [draft.projectName, draft.agentName, t("新对话")].some((value) => value.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())));
  const dateText = (value: string) => {
    const date = new Date(value), now = new Date();
    if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" });
    return date.toLocaleDateString(language, { month: "short", day: "numeric", ...(date.getFullYear() !== now.getFullYear() ? { year: "2-digit" } : {}) });
  };
  const draftAgent = draft?.agentId ? agents.find((agent) => agent.id === draft.agentId) : undefined;
  const referenceable=(id:string)=>!!onReference&&id!==selectedId&&(!canReference||canReference(id));
  const openMenu=(chat:Conversation,anchor:HTMLButtonElement,point?:{x:number;y:number})=>{
    menuTrigger.current=anchor;const rect=anchor.getBoundingClientRect();
    setMenu({chat,anchorTop:rect.top,anchorRight:rect.right,right:Math.max(8,innerWidth-(point?.x??rect.right)),top:Math.min(point?.y??rect.bottom+4,innerHeight-108)});
  };

  function renderChat(chat: Conversation) {
    const title = chat.title || t("新对话");
    const projectIdentity = projects.find((item) => item.id === chat.projectId);
    const agentIdentity = agents.find((item) => item.id === chat.agentId);
    const project = projectIdentity?.name ?? t("未归属项目");
    const agent = agentIdentity?.name ?? (runtimeLabel(chat.cli));
    const environment = conversationEnvironment(chat, projectIdentity);
    const groupName = environment.name && !["Default", "默认目录组"].includes(environment.name) ? environment.name : undefined;
    const location = chat.executionLocation;
    const context = [agent, projectIdentity?.name, location?.machineName,
      groupName ?? (chat.workspaceId === null || !projectIdentity ? environment.cwd?.split(/[\\/]/).filter(Boolean).at(-1) ?? t("无工作目录") : undefined)]
      .filter(Boolean).join(" · ");
    const time = sort === "created" ? chat.createdAt : chat.updatedAt || chat.createdAt;
    const state = t(statuses[chat.status]);
    const notable = ["running", "approval", "error"].includes(chat.status);
    return <li key={chat.id} className={"library-item " + (selectedId === chat.id ? "active " : "") + ""}>
      <Button className={"chat-link library-open " + (selectedId === chat.id ? "active" : "")} onClick={() => onOpen(chat.id)}
        draggable={referenceable(chat.id)} onDragStart={event=>{if(!referenceable(chat.id))return;event.stopPropagation();event.dataTransfer.setData(conversationDragType,chat.id);event.dataTransfer.effectAllowed='copy';}}
        onContextMenu={event=>{event.preventDefault();openMenu(chat,event.currentTarget,{x:event.clientX,y:event.clientY});}}
        aria-label={title} aria-describedby={"library-context-" + chat.id + " library-status-" + chat.id} aria-current={selectedId === chat.id ? "page" : undefined}
        title={[title, agent, project, groupName, location?.machineName, location?.host, location?.cwd ?? environment.cwd, runtimeLabel(chat.cli), state].filter(Boolean).join(" · ")}>
        <span className="library-avatar-slot" title={agent} aria-hidden="true">{agentIdentity ? <IdentityAvatar identity={agentIdentity} kind="agent" size={28} /> : <span className="library-avatar-placeholder"><Icon name="terminal" size={16} /></span>}</span>
        <span className="library-row-content"><span className="library-item-heading"><strong>{title}</strong>
          {notable && <span className={"library-status-icon " + chat.status} title={state}>{chat.status === "running" ? <span className="status-dot running" /> : <Icon name={chat.status === "approval" ? "approval" : "error"} size={13} />}</span>}
          <time dateTime={time} title={new Date(time).toLocaleString(language)}>{dateText(time)}</time></span>
          <span className="library-context" id={"library-context-" + chat.id}>
            <span className="library-context-text">{context}</span>
          </span>
          <span className="library-accessible-context" id={"library-status-" + chat.id}>{runtimeLabel(chat.cli)} · {state}</span>
        </span>
      </Button>
      <Button className="library-more" aria-label={t("更多操作") + " · " + title}
        title={t("更多操作")} aria-haspopup="menu" aria-expanded={menu?.chat.id === chat.id}
        onClick={(event) => {
          if (menu?.chat.id === chat.id) { closeMenu(); return; }
          openMenu(chat,event.currentTarget);
        }}><Icon name="more" size={16} /></Button>
    </li>;
  }

  return <section className="conversation-library" aria-label={t("会话列表")}>
    <div className="library-search-field"><Icon name="search" size={15} /><Input className="library-search" type="search"
      aria-label={t("搜索对话")} placeholder={t("搜索标题、项目或 Agent")}
      value={search} onChange={(event) => onSearch(event.target.value)} /></div>
    <div className="library-toolbar">
      <Select ariaLabel={t("会话视图")} value={view === "todo" ? "recent" : view} onChange={onView} searchable={false} className="library-views"
        options={views.map((item) => ({ value: item.value, label: t(item.label) }))} />
      <Select ariaLabel={t("排序方式")} value={sort} onChange={onSort} searchable={false} className="library-sort"
        options={[{ value: "activity", label: t("最近活动"), icon: <Icon name="clock" size={14} /> },
          { value: "created", label: t("创建时间"), icon: <Icon name="clock" size={14} /> },
          { value: "name", label: t("名称"), icon: <Icon name="arrow-down-wide-narrow" size={14} /> }]} />
    </div>
    <nav className="library-list" aria-label={t("会话列表")}>
      {showDraft && <Button type="button" className="library-draft" aria-label={t("新对话")} onClick={onOpenDraft} aria-current={draftCurrent ? "page" : undefined}>
        <span className="library-avatar-slot" aria-hidden="true">{draftAgent ? <IdentityAvatar identity={draftAgent} kind="agent" size={24} /> : <span className="library-avatar-placeholder"><Icon name="terminal" size={16} /></span>}</span>
        <div className="library-row-content"><strong>{t("新对话")}</strong>
          <span className="library-context">
            <span className="library-context-text">{draft.agentName} · {draft.projectName}</span></span><small>{t("尚未发送")}</small>
        </div></Button>}
      {groups.map((group) => {
        const key = view + ":" + group.key;
        const hidden = grouped && !!collapsed[key] && !search.trim();
        const name = group.name || t(group.key ? view === "agents" ? "未归属 Agent" : "未归属项目" : view === "agents" ? "不使用 Agent" : "不关联项目");
        const identity = view === "agents" ? agents.find((agent) => agent.id === group.key) : projects.find((project) => project.id === group.key);
        return <div className="library-group" key={key} role={grouped ? "region" : undefined} aria-label={grouped ? name : undefined}>
          {grouped && <Button className={"library-group-heading " + (view === "projects" && group.key === projectId ? "current" : "")}
            aria-expanded={!hidden} disabled={!!search.trim()} onClick={() => setCollapsed({ ...collapsed, [key]: !hidden })}>
            <Icon name={hidden ? "chevronRight" : "chevronDown"} size={14} />
            {identity && <IdentityAvatar identity={identity} kind={view === "agents" ? "agent" : "project"} size={18} />}
            <strong title={name}>{name}</strong><span>{group.chats.length}</span>
          </Button>}
          {!hidden && <ul>{group.chats.map(renderChat)}</ul>}
        </div>;
      })}
      {!count && !showDraft && <p className="library-empty">{t(search.trim() ? "没有匹配的对话。" : view === "completed" ? "暂无已完成对话" : view === "archived" ? "暂无归档对话" : "开始一项工作")}</p>}
    </nav>
    {menu && menuChat && createPortal(<div ref={menuRef} className="library-action-menu" role="menu" tabIndex={-1}
      aria-label={t("对话操作") + " · " + (menuChat.title || t("新对话"))} style={{ top: Math.max(8, menu.top), right: menu.right }}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(true); return; }
        if (event.key === "Tab") { event.preventDefault(); closeMenu(true); return; }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 :
          (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }}>
      {onReference&&<Button role="menuitem" disabled={!referenceable(menuChat.id)} title={!referenceable(menuChat.id)?localize('此对话不在当前可引用或交互的范围内。','This chat is outside the current reference or inquiry scope.'):undefined}
        onClick={()=>{onReference(menuChat.id);closeMenu();}}><Icon name="plus" size={15}/>{localize('加入当前输入','Add to current input')}</Button>}
      {onArchive && <Button role="menuitem" disabled={["running", "approval"].includes(menuChat.status)}
        aria-label={t(menuChat.archivedAt ? "取消归档" : "归档对话") + " · " + (menuChat.title || t("新对话"))}
        title={["running", "approval"].includes(menuChat.status) ? t("运行结束后可归档") : undefined} onClick={() => { onArchive(menuChat.id, !menuChat.archivedAt); closeMenu(true); }}>
        <Icon name={menuChat.archivedAt ? "rotate" : "folder"} size={15} />{t(menuChat.archivedAt ? "取消归档" : "归档对话")}</Button>}
    </div>, document.body)}
  </section>;
}
