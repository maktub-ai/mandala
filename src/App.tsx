import VoiceInput from './VoiceInput';
import {appendVoiceText} from '../shared/voice';
import { useUiExtensions } from './UiExtensions';
import ExecutionResults,{useExecutionResults} from './ExecutionResults';
import PageErrorBoundary from './PageErrorBoundary';
import MandalaPanels,{referenceDragType} from "./MandalaPanels";
import { useDesktopPetBridge } from "./MandalaPet";
import MandalaCoordinationCards from './MandalaCoordinationCards';
import AgentMessageCards from './AgentMessageCards';
import OperationResults from './OperationResults';
import {useOperationTasks} from './TaskOperationCards';
import MandalaSettings from "./MandalaSettings";
import {canonicalObjectPath} from './object-routes';
import ComposerRecovery from './ComposerRecovery';
import { useComposerDraft, ComposerDraftIdentity, composerDraftFingerprint, clearAcceptedComposerDraft } from './composer-drafts';
import ComposerDraftNotice from './ComposerDraftNotice';
import { restoreSubmission, pendingSubmission, submitComposerInput, uploadComposerFiles, submissionError, type ComposerSubmission } from './composer-submit';
import { devicePreferences } from './devicePreferences';
import Button from './ui/Button';
import Input from './ui/Input';
import Textarea from './ui/Textarea';
import { useTheme } from "./ThemeProvider";
import { copyText } from "./clipboard";
import { createPortal, flushSync } from 'react-dom';
import { appendChatReference } from './chat-references';
import ComposerReferences, { slashReferenceQuery, mentionReferenceQuery, matchesReferenceQuery, selectableReference } from './ComposerReferences';
import type { ComposerReferenceItem } from '../shared/composer-references';
import { conversationDragType } from '../shared/composer-references';
import LoadingState from './ui/LoadingState';
import Disclosure from './ui/Disclosure';
import { modelOptions, effortOptions, effortLabels, efforts, type ReasoningEffort, type Attachment } from "../shared/chat-input";
import { type SubmissionRecovery } from "./chat-send";
import ApprovalRequest from "./ApprovalRequest";
import QueuedMessages from "./QueuedMessages";
import "./composer-queue.css";
import TaskWorkspace, { TaskDialog } from "./TaskWorkspace";
import { navigateAssetPage } from "./AssetLibrary";
import SchedulesPage from "./SchedulesPage";
import type { QueuedInput } from "../shared/tasks";
import AssetLibrary from "./AssetLibrary";
import MarketPage from "./MarketPage";
import { type ApprovalDecision } from "../shared/approvals";
import { projectWorkspaces } from "../shared/workspaces";
import FolderPicker from "./FolderPicker";
import { enabledRuntimes, runtimeLabel, isCli, runtimeCatalog, runtimeIds, effectiveRuntime } from "../shared/runtimes";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, requestJson } from "./api";
import { useLanguage } from "./i18n";
import Dialog from "./Dialog";
import AttachmentItem from "./AttachmentItem";
import { directoryReferenceType, resolveComposerFiles } from "./composer-files";
import MarkdownMessage, { LinkedMessageText } from "./MarkdownMessage";
import { useCopyFeedback } from './useCopyFeedback';
import { ContentPreviewContext, type ContentTarget } from "./ContentPreviewContext";
import { conversationFiles } from "./conversationFiles";
import { VerifiedFilesContext, useVerifiedConversationFiles,usePublishedConversationFiles } from "./VerifiedFilesContext";
import { isSystemAgent, projectAgentChoice } from "../shared/chat-context";
import SelectionQuote, { QuoteButton, quoteDragType } from "./SelectionQuote";
import ConversationFind from "./ConversationFind";
import ComposerActions from "./ComposerActions";
import ComposerSettings from "./ComposerSettings";
import ConversationWorkspace, { type ConversationWorkspaceTab } from "./ConversationWorkspace";
import TurnProcess, { TurnFooter } from "./TurnProcess";
import { presentRun } from "./runView";
import type {
  Agent,
  Approval,
  ApprovalMode,
  Config,
  CliStatus,
  Conversation,
  DisplayEvent,
  ModelChoice,
  Cli,
  Task,
} from "../shared/types";
import EffectivePanel from "./EffectivePanel";
import WorkspaceInspector from "./WorkspaceInspector";
import ConversationContextPopover from "./ConversationContextPopover";
import IdentityAvatar from "./IdentityAvatar";
import Icon from "./ui/Icon";
import BrandMark from "./ui/BrandMark";
import { modulePinsKey, readModulePins, moduleOrderKey, readModuleOrder, moveSidebarItem } from "./sidebar-modules";
import RuntimeIcon from "./ui/RuntimeIcon";
import AppNavigation, { type SidebarAccount } from "./AppNavigation";
import AppSidebar, { SidebarToggle } from "./AppSidebar";
import Select from "./ui/Select";
import "./redesign.css";
import ConversationLibrary from "./ConversationLibrary";
import ManaWorkspace from "./ManaWorkspace";
import { linkedCapabilities } from "../shared/catalog";
import SettingsPage, { settingsSection, settingsUrl, type SettingsSection } from "./SettingsPage";
import ProjectWorkbench from "./ProjectWorkbench";
import GettingStarted from "./GettingStarted";
import MandalaWelcome from "./MandalaWelcome";
import { adoptRuntime, loginCommand, welcomeRequested } from "./onboarding";
import TaskNotifications from "./TaskNotifications";
import UsagePanel from "./UsagePanel";
import {WorkspacePage,PageHeader} from "./ui/WorkspacePage";
import CommandPalette, { type PaletteAction } from "./CommandPalette";
import KeyboardShortcuts from './KeyboardShortcuts';
import { composingKey, useShortcuts, shortcutLabel, shortcutAria } from './shortcuts';
import { CHAT_HISTORY_PAGE_TURNS, groupChatTurns, mergeChatEvents, type ChatHistoryPage, type ChatMessage } from "./chatTurns";
import "./journeys.css";
import "./ui/design-system.css";
import "./workspace.css";
import "./chat-feedback.css";
import "./chat-bubbles.css";
const labels = {
  idle: "就绪",
  running: "执行中",
  approval: "等待审批",
  interrupted: "已中断",
  error: "出错",
} as const;
function normalizeOrganizationRoute() {
  const current=location.pathname+location.search+location.hash,canonical=canonicalObjectPath(current);
  if(canonical!==current)history.replaceState(history.state,"",canonical);
  const legacy = new URLSearchParams(location.search);
  if (location.pathname === "/mana" && legacy.get("tab") === "automation") { legacy.delete("tab"); history.replaceState(history.state, "", "/schedules" + (legacy.size ? "?" + legacy : "")); }
  if (location.pathname === "/tasks" && legacy.get("rules") === "1") { legacy.delete("rules"); history.replaceState(history.state, "", "/schedules" + (legacy.size ? "?" + legacy : "")); }
  if (location.pathname === "/mana" && new URLSearchParams(location.search).get("tab") === "organization") history.replaceState(history.state, "", "/agents");
}
function currentRoute() {
  normalizeOrganizationRoute();
  const query = new URLSearchParams(location.search);
  const settingsProject = location.pathname.match(/^\/projects\/([^/]+)\/settings$/)?.[1];
  const workbenchProject = location.pathname.match(/^\/projects\/([^/]+)\/(?:workbench|overview|tasks|library|agents)$/)?.[1];
  const explicit = location.pathname === "/mandala" || !!workbenchProject || ["project", "conversation", "agent", "workspace", "cwd"].some(key => query.has(key));
  return { usage: location.pathname === "/usage", project: workbenchProject || settingsProject ? decodeURIComponent((workbenchProject || settingsProject)!) : query.get("project") ?? "",
    workspace: query.has("workspace") ? query.get("workspace") || null : undefined, cwd: query.get("cwd") ?? "",
    agent: location.pathname.match(/^\/agents\/([^/]+)(?:\/memory)?$/)?.[1] ? decodeURIComponent(location.pathname.split("/")[2]) : query.get("agent") ?? "", conversation: query.get("conversation") ?? "", workbench: !!workbenchProject, mana: location.pathname === "/mana", assets: (location.pathname.startsWith("/assets") || location.pathname.startsWith("/library")) || location.pathname === "/mana" && query.get("tab") === "document",
    market: location.pathname === "/market", tasks: location.pathname.startsWith("/tasks") || location.pathname === "/schedules", explicit };
}
export default function App({ account, userInitial, draftIdentity = "fixture" }: { account?: SidebarAccount; userInitial?: string; draftIdentity?: string } = {}) {
  const { refresh: refreshExtensions } = useUiExtensions();
  useEffect(() => { void refreshExtensions(); }, [refreshExtensions]);
  const {text: localize,  t, errorText, language } = useLanguage();
  const [config, setConfig] = useState<Config>({
    version: 2,
    projects: [],
    agents: [],
  });
  const [configLoaded, setConfigLoaded] = useState(false);
  const [initialConfigError, setInitialConfigError] = useState("");
  const initialConfigPending = useRef(false);
  const initialRoute = useRef(currentRoute());
  const [remembered] = useState(() => {
    try {
      const value = JSON.parse(devicePreferences.getItem("mana-chat-preferences") || "null");
      if (value && [value.projectId, value.agentId, value.model].every(item => typeof item === "string") &&
          isCli(value.cli) && (value.effort === "" || efforts.includes(value.effort)))
        return value as { projectId: string; agentId: string; cli: Cli; model: string; effort: ReasoningEffort | "";onboardingCompleted?:boolean };
    } catch { /* Ignore an unreadable browser preference. */ }
  });
  const initialChat = useRef(initialRoute.current.explicit ? initialRoute.current.conversation : devicePreferences.getItem("mana-chat"));
  const [projectId, setProjectId] = useState(initialRoute.current.explicit ? initialRoute.current.project : devicePreferences.getItem("mana-project") || ""),
    [agentId, setAgentId] = useState(new URLSearchParams(location.search).has("agent") ? initialRoute.current.agent :
      remembered?.projectId === projectId ? remembered.agentId : "");
  const restoreChoices = useRef(remembered?.projectId === projectId && remembered?.agentId === agentId);
  const [workspaceId, setWorkspaceId] = useState<string | null | undefined>(initialRoute.current.workspace);
  const [directory, setDirectory] = useState(initialRoute.current.cwd);
  const [folderOpen, setFolderOpen] = useState(false);
  const [approvalOverride, setApprovalOverride] = useState<ApprovalMode | "">("");
  const [approvalPreferenceLoading, setApprovalPreferenceLoading] = useState(false);
  const [approvalPreferenceError, setApprovalPreferenceError] = useState(false);
  const [approvalPreferenceRevision, setApprovalPreferenceRevision] = useState(0);
  const approvalRequest = useRef(0);
  const messagesRoot = useRef<HTMLDivElement>(null);
  const rememberedAgents = useRef<Record<string, string>>((() => {
    try { const value = JSON.parse(devicePreferences.getItem('mana-project-agents') ?? '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([, id]) => typeof id === 'string')) as Record<string, string> : {}; }
    catch { return {}; }
  })());
  const [modeSaving, setModeSaving] = useState(false);
  const [onboardingDismissed,setOnboardingDismissed]=useState(remembered?.onboardingCompleted===true);
  const runtimeName = (value:Cli | '') => value ? runtimeLabel(value) : localize('请选择执行端', 'Choose a runtime');
  const [cli, setCli] = useState<Cli | "">(restoreChoices.current ? remembered!.cli : "");
  const fileInput = useRef<HTMLInputElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const composerComposing = useRef(false);
  const contentPanelTrigger = useRef<HTMLButtonElement>(null);
  const [effort, setEffort] = useState<ReasoningEffort | "">(restoreChoices.current ? remembered!.effort : "");
  const [model, setModel] = useState(restoreChoices.current ? remembered!.model : "");
  const modelContext = JSON.stringify([projectId, agentId, cli, workspaceId, directory, config]);
  const [modelCatalog, setModelCatalog] = useState<{ context: string; models: ModelChoice[] }>({ context: "", models: [] });
  const models = modelCatalog.context === modelContext ? modelCatalog.models : [];
  const modelsPath = "/models?projectId=" + encodeURIComponent(projectId) + "&agentId=" + encodeURIComponent(agentId) + "&cli=" + cli +
    (workspaceId !== undefined ? "&workspaceId=" + encodeURIComponent(workspaceId ?? "") : "") +
    (!projectId && directory ? "&cwd=" + encodeURIComponent(directory) : "");
  const [chats, setChats] = useState<Conversation[]>([]),
    [selected, setSelected] = useState(initialRoute.current.explicit ? initialRoute.current.conversation : "");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [queuedInputs,setQueuedInputs] = useState<QueuedInput[]>([]);
  const queueReads = useRef({ generation: 0, issued: 0, applied: 0 });
  const refreshQueuedInputs = async (id: string, isCurrent: () => boolean) => {
    const generation = queueReads.current.generation, version = ++queueReads.current.issued;
    const inputs = await api<QueuedInput[]>("/conversations/" + id + "/queue");
    if (!isCurrent() || generation !== queueReads.current.generation || version < queueReads.current.applied) return;
    queueReads.current.applied = version;
    setQueuedInputs(inputs.filter(input => input.state === "queued" || input.unrecorded));
  };
  const [executionId,setExecutionId]=useState<string|null>(null);
  const selectedChat = useRef(selected);
  selectedChat.current = selected;
  const [search, setSearch] = useState("");
  const [libraryView, setLibraryView] = useState(() => devicePreferences.getItem("mana-view") === "completed" ? "recent" : devicePreferences.getItem("mana-view") || "recent");
  const [librarySort, setLibrarySort] = useState(() => devicePreferences.getItem("mana-sort") || "activity");
  const [tasksOpen,setTasksOpen]=useState(initialRoute.current.tasks);
  const [taskDialog,setTaskDialog]=useState<string|null>(null);
  useEffect(()=>{if(!taskDialog)return;const close=()=>setTaskDialog(null);addEventListener("popstate",close);return()=>removeEventListener("popstate",close);},[taskDialog]);
  const [marketOpen, setMarketOpen] = useState(initialRoute.current.market);
  const [assetsOpen, setAssetsOpen] = useState(initialRoute.current.assets);
  const [manaOpen, setManaOpen] = useState(initialRoute.current.mana);
  const [editingTitle, setEditingTitle] = useState(false),
    [titleDraft, setTitleDraft] = useState("");
  const [chat, setChat] = useState<Conversation | null>(null),
    [events, setEvents] = useState<DisplayEvent[]>([]),
    [approvals, setApprovals] = useState<Approval[]>([]);
  const [historyReadyConversation, setHistoryReadyConversation] = useState('');
  const [earlierBefore, setEarlierBefore] = useState<number | null>(null);
  const [earlierState, setEarlierState] = useState<'idle' | 'loading' | 'error'>('idle');
  const loadEarlier = useRef<(() => void) | null>(null);
  const historyAnchor = useRef<{ element: HTMLElement; top: number } | null>(null);
  const lastScrollTop = useRef(0);
  const historyReady = !selected || historyReadyConversation === selected;
  const readerConversation = useRef("");
  const [contentRequest, setContentRequest] = useState<{ conversationId: string; target: ContentTarget } | null>(null);
  const [workspaceTab, setWorkspaceTab] = useState<ConversationWorkspaceTab>("files");
  const openContent = useCallback((target: ContentTarget) => {
    setContentRequest({ conversationId: selected, target });
    setWorkspaceTab(target.kind === "file" ? "files" : "references"); setEffectiveOpen(true);
  }, [selected]);
  const [editingMessage, setEditingMessage] = useState<{ eventId: number; text: string } | null>(null);
  const [branchPending, setBranchPending] = useState(false);
  const branchRequest = useRef(0);
  const [copiedMessage, setCopiedMessage, clearCopiedMessage, copySequence] = useCopyFeedback();
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const activeChat = chat?.id === selected ? chat : chats.find(item => item.id === selected);
  const mandalaMain=activeChat?.purpose === "mandala-main";
  const mandalaAgent=mandalaMain?config.agents.find(item=>item.id===activeChat.agentId):undefined;
  const runtimeRunning=pending||activeChat?.status==='running'||activeChat?.status==='approval';
  const statusCli=mandalaAgent&&!runtimeRunning?mandalaAgent.defaultCli:activeChat?.cli??cli;
  const runtimePending=mandalaAgent&&runtimeRunning&&(activeChat?.cli!==mandalaAgent.defaultCli||activeChat?.model!==(mandalaAgent.models[mandalaAgent.defaultCli]||null));
  const [referenceItems, setReferenceItems] = useState<ComposerReferenceItem[]>([]);
  const composerDraft = useComposerDraft({kind:'chat',conversationId:selected,...!selected?{projectId,agentId}:{}},draftIdentity,false,configLoaded);
  const composerDraftRef=useRef(composerDraft);composerDraftRef.current=composerDraft;
  const {text,files,references:selectedReferences}=composerDraft.value;
  const [voiceBusy,setVoiceBusy]=useState(false);
  const setText: React.Dispatch<React.SetStateAction<string>> = next => composerDraft.setValue(value=>({...value,text:typeof next === 'function' ? next(value.text) : next}));
  const setFiles: React.Dispatch<React.SetStateAction<File[]>> = next => composerDraft.setValue(value=>{const files=typeof next==='function'?next(value.files):next;return {...value,files,missingAttachments:value.missingAttachments.filter(item=>!files.some(file=>file.name===item.name&&file.size===item.size))};});
  const setSelectedReferences: React.Dispatch<React.SetStateAction<ComposerReferenceItem[]>> = next => composerDraft.setValue(value=>({...value,references:typeof next==='function'?next(value.references):next}));
  const [referenceQuery, setReferenceQuery] = useState<ReturnType<typeof slashReferenceQuery>>(null);
  const [referenceMode, setReferenceMode] = useState<'slash'|'mention'>('slash');
  const [referenceIndex, setReferenceIndex] = useState(0);
  const [referencesLoading, setReferencesLoading] = useState(false);
  const [referencesError, setReferencesError] = useState('');
  const [referenceReload, setReferenceReload] = useState(0);
  const [composerDragOver, setComposerDragOver] = useState(false);
  const visibleReferences = referenceItems
    .filter(item => (referenceMode === 'mention' ? item.kind === 'agent' : item.kind !== 'agent' && item.kind !== 'chat')
      && !selectedReferences.some(selected=>selected.id===item.id) && matchesReferenceQuery(item,referenceQuery?.query??''))
    .map(item => item.kind === 'command' ? {...item,name:localize('创建任务', 'Create task'),detail:localize('加入任务上下文，发送后由 Agent 处理', 'Add task creation context for the Agent')} : item);
  const updateReferenceQuery = (value: string, caret: number) => {
    const mention = mentionReferenceQuery(value,caret);
    setReferenceMode(mention?'mention':'slash'); setReferenceQuery(mention??slashReferenceQuery(value,caret)); setReferenceIndex(0);
  };
  const chooseReference = (item: ComposerReferenceItem) => {
    if (!referenceQuery || !selectableReference(item)) return;
    const next = text.slice(0, referenceQuery.start) + text.slice(referenceQuery.end), caret = referenceQuery.start;
    setText(next); setReferenceQuery(null);
    setSelectedReferences(items => items.some(value=>value.id===item.id)?items:[...items, item]);
    requestAnimationFrame(() => { composerInput.current?.focus(); composerInput.current?.setSelectionRange(caret, caret); });
  };
  const addCatalogReference=(item:ComposerReferenceItem)=>{
    if(!selectableReference(item)||!composerDraft.loaded)return;
    setSelectedReferences(items=>items.some(value=>value.id===item.id||item.kind==='chat'&&value.kind==='chat'&&value.objectId===item.objectId)?items:[...items,item]);
    if(matchMedia('(max-width: 1100px)').matches)setEffectiveOpen(false);
    requestAnimationFrame(()=>composerInput.current?.focus());
  };
  const addConversationReference=(id:string)=>{
    const items=referenceItems.filter(item=>item.kind==='chat'&&item.objectId===id&&selectableReference(item));
    const item=items.find(item=>item.intent==='inquiry')??items[0];if(item)addCatalogReference(item);
  };
  const changeConversationReference=(previousId:string,nextId:string)=>{
    const previous=selectedReferences.find(item=>item.id===previousId);
    const next=referenceItems.find(item=>item.id===nextId&&item.kind==='chat'&&item.objectId===previous?.objectId&&selectableReference(item));
    if(next)setSelectedReferences(items=>items.map(item=>item.id===previousId?next:item));
  };
  const referencePath = selected ? `/conversations/${selected}/references` : '/composer-references?' + new URLSearchParams({
    projectId, agentId, cli, ...(workspaceId !== undefined ? { workspaceId: workspaceId ?? '' } : {}), ...(!projectId && directory ? { cwd: directory } : {}),
  });
  const refreshReferenceCatalog=useCallback(()=>{
    const view=navigationVersion.current;void api<{items:ComposerReferenceItem[]}>(referencePath).then(result=>{if(view===navigationVersion.current)setReferenceItems(result.items);}).catch(reason=>{if(view===navigationVersion.current)setReferencesError(reason.message);});
  },[referencePath]);
  const chatActive = location.pathname === '/' || location.pathname === '/mandala';
  useEffect(() => {
    if (!chatActive || !configLoaded) return;
    const controller = new AbortController();
    let active = true; setReferenceItems([]); setReferencesLoading(true); setReferencesError('');
    requestJson<{ items: ComposerReferenceItem[] }>('/api' + referencePath, {signal:controller.signal}, 10000)
      .then(result => { if (active) setReferenceItems(result.items); })
      .catch(reason => { if (active) setReferencesError(reason.message?.includes('timed out') ? localize('引用读取超时，请重试。', 'Loading references timed out. Please retry.') : reason.message); }).finally(() => { if (active) setReferencesLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [referencePath, chatActive, configLoaded, config, referenceReload]);
  useEffect(() => { if (!selected && !pending) { setSelectedReferences([]); } }, [projectId, agentId, cli, workspaceId, directory]);
  useEffect(() => { if (!text) setReferenceQuery(null); }, [text]);
  const addReference = useCallback((reference: string) => {
    let next: string;
    try { next = appendChatReference(text, reference); }
    catch (reason) { setError((reason as Error).message); return; }
    flushSync(() => {
      setText(next);
      if (workspaceTab === 'terminal' && matchMedia('(max-width: 1100px)').matches) setEffectiveOpen(false);
    });
    const input = composerInput.current; input?.focus(); if (input) input.setSelectionRange(input.value.length, input.value.length);
  }, [text, workspaceTab]);
  const [settingsPath, setSettingsPath] = useState(() => settingsSection(location.pathname) ? location.pathname : ""),
    [draft, setDraft] = useState<Config>(config),
    [settingsRevision, setSettingsRevision] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const configRevision = useRef('');
  const settingsSaved = useRef<Config>(config);
  const latestDraft = useRef(draft); latestDraft.current = draft;
  const saveInFlight = useRef(false);
  const failedDraft = useRef('');

  const runtimeDraftDirty = useRef(false);
  const runtimeSaveInFlight = useRef(false);
  const [runtimeSaving, setRuntimeSaving] = useState(false);
  const confirmRuntimeLeave = () => !runtimeSaveInFlight.current &&
    (!runtimeDraftDirty.current || confirm(t("未保存的修改将丢失。确定离开吗？")));
  const [settingsAgentId, setSettingsAgentId] = useState(initialRoute.current.agent);
  const [settingsProjectId, setSettingsProjectId] = useState(initialRoute.current.project);
  const [projectPreparationName,setProjectPreparationName]=useState("");
  const [projectSelectionVersion, setProjectSelectionVersion] = useState(0);
  const [routeLocation, setRouteLocation] = useState(location.pathname + location.search);
  const [workbench, setWorkbench] = useState(initialRoute.current.workbench),
    [effectiveOpen, setEffectiveOpen] = useState(false),
    [agentDetail, setAgentDetail] = useState("");
  const [usageOpen, setUsageOpen] = useState(initialRoute.current.usage);
  const [usageProjectId, setUsageProjectId] = useState(new URLSearchParams(location.search).get("project") ?? "");
  const [usageAgentId, setUsageAgentId] = useState(new URLSearchParams(location.search).get("agent") ?? "");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [workbenchProjectId, setWorkbenchProjectId] = useState(initialRoute.current.project);
  const { variant: theme, changeMode } = useTheme();
  const [modulePins, setModulePins] = useState(readModulePins);
  const [moduleOrder, setModuleOrder] = useState(readModuleOrder);
  const reorderModule = (id: string, offset: number) => setModuleOrder(current => moveSidebarItem(current, id, offset));
  useEffect(() => { devicePreferences.setItem(moduleOrderKey, JSON.stringify(moduleOrder)); }, [moduleOrder]);
  const pinModule = (id: string, pinned: boolean) => setModulePins(current => ({ ...current, [id]: pinned }));
  useEffect(() => { devicePreferences.setItem(modulePinsKey, JSON.stringify(modulePins)); }, [modulePins]);
  const [mobileNav, setMobileNav] = useState(false);
  const [navigationLocked, setNavigationLocked] = useState(false);
  const objectSavePending = !!settingsRevision && (saving || !!saveError || JSON.stringify(draft)!==JSON.stringify(settingsSaved.current));
  const objectSaveGuard = objectSavePending && /^\/(?:settings\/)?(projects|agents|runtime)(?:\/|$)/.test(location.pathname);
  const navigationBlocked = useRef(false);navigationBlocked.current=navigationLocked || runtimeSaving || objectSaveGuard;
  const [cliStatus, setCliStatus] = useState<CliStatus | null>(null),
    [checkingCli, setCheckingCli] = useState(false),
    [cliPanel, setCliPanel] = useState(false),
    [cliCheck, setCliCheck] = useState(0);
  const navigationVersion = useRef(0);
  const retrySubmissions = useRef(new Map<string, SubmissionRecovery & { view: number; conversationId: string; text: string; files: File[]; references: ComposerReferenceItem[]; attachments: Attachment[]; commandKey: string; draftFingerprint?:string; action: "queue" | "continue" | "interrupt" }>());
  const composerReady = useRef<{id:string;resolve:(draft:ReturnType<typeof useComposerDraft>)=>void;reject:(error:Error)=>void}|null>(null);
  useEffect(()=>{const waiter=composerReady.current;if(!waiter)return;if(selected===waiter.id&&composerDraft.ready){composerReady.current=null;waiter.resolve(composerDraft);}else if(selected&&selected!==waiter.id){composerReady.current=null;waiter.reject(new Error('Chat changed before submission; the prepared draft is retained.'));}},[selected,composerDraft.loaded]);
  const settingsReturn = useRef("/");
  const settingsPathRef = useRef(settingsPath);
  settingsPathRef.current = settingsPath;
  const [connectionLost, setConnectionLost] = useState(false);
  const [submittingApproval, setSubmittingApproval] = useState("");
  const [stopping, setStopping] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  useEffect(() => {
    const pushState = history.pushState, replaceState = history.replaceState;
    let index: number = history.state?.openManaHistoryIndex ?? 0;
    replaceState.call(history, { ...history.state, openManaHistoryIndex: index }, "");
    history.pushState = (data, title, url) => {
      pushState.call(history, { ...data, openManaHistoryIndex: ++index }, title, url);
    };
    history.replaceState = (data, title, url) => {
      replaceState.call(history, { ...data, openManaHistoryIndex: index }, title, url);
    };
    const updatePath = (event: PopStateEvent) => {
      if (event.isTrusted && (navigationBlocked.current || runtimeSaveInFlight.current ||
          event.state?.openManaHistoryIndex !== index && runtimeDraftDirty.current && !confirm(t("未保存的修改将丢失。确定离开吗？")))) {
        event.stopImmediatePropagation();
        const delta = index - (event.state?.openManaHistoryIndex ?? index);
        if (delta) history.go(delta);
        return;
      }
      if (event.isTrusted) index = event.state?.openManaHistoryIndex ?? index;
      normalizeOrganizationRoute();
      setRouteLocation(location.pathname + location.search);
      navigationVersion.current++;
      setPending(false);
      setSettingsPath(settingsSection(location.pathname) ? location.pathname : "");
      const section = settingsSection(location.pathname);
      if (section) {
        const query = new URLSearchParams(location.search);
        if (section === "agents" || section === "runtime") setSettingsAgentId(location.pathname.match(/^\/agents\/([^/]+)(?:\/memory)?$/)?.[1] ? decodeURIComponent(location.pathname.split("/")[2]) : query.get("agent") ?? "");
        if (["projects", "agents", "runtime"].includes(section)) setSettingsProjectId(location.pathname.match(/^\/projects\/([^/]+)\/settings$/)?.[1] ? decodeURIComponent(location.pathname.split("/")[2]) : query.get("project") ?? "");
        return;
      }
      const route = currentRoute();
      setUsageOpen(route.usage);
      setWorkbench(route.workbench);
      setAssetsOpen(route.assets);
      setMarketOpen(route.market);
      setTasksOpen(route.tasks);
      setManaOpen(route.mana);
      setError("");
      if (route.usage) { setUsageAgentId(new URLSearchParams(location.search).get("agent") ?? ""); setUsageProjectId(new URLSearchParams(location.search).get("project") ?? ""); return; }
      if (route.workbench) { setWorkbenchProjectId(route.project); return; }
      if (route.mana || route.assets || route.tasks || route.market) return;
      setProjectId(route.explicit ? route.project : devicePreferences.getItem("mana-project") || "");
      setWorkspaceId(route.workspace);
      setDirectory(route.cwd);
      setAgentId(route.agent);
      setSelected(route.conversation);
    };
    addEventListener("popstate", updatePath, true);
    return () => {
      removeEventListener("popstate", updatePath, true);
      history.pushState = pushState; history.replaceState = replaceState;
    };
  }, []);
  useEffect(() => {
    if ((!settingsPath && !workbench) || settingsRevision || !configLoaded) return;
    settingsSaved.current = config; setDraft(structuredClone(config)); setSettingsRevision(configRevision.current);
  }, [settingsPath, workbench, settingsRevision, configLoaded]);
  const refresh = async (initial = false) => {
    const startedAt=location.pathname+location.search;
    const restoringChat=initial&&!initialRoute.current.explicit&&location.pathname==='/'&&initialChat.current;
    const chatRead=api<Conversation[]>('/conversations?origin=all').then(list=>{
      setChats(list);
      return list;
    });
    const taskRead=api<Task[]>('/tasks?view=control').then(setTasks);
    const activity=Promise.allSettled([chatRead,taskRead]);
    const c = await api<{config:Config;revision:string}>('/config');
    configRevision.current = c.revision; setConfig(c.config);
    if (!(initial && initialRoute.current.explicit && initialRoute.current.conversation)) {
      setAgentId(a => selected ? a : projectAgentChoice(c.config, projectId, a,
        initial && !new URLSearchParams(location.search).has("agent") ? rememberedAgents.current : {}));
    }
    if (initial && !restoreChoices.current && !(initialRoute.current.explicit && initialRoute.current.conversation)) {
      const initialAgentId = projectAgentChoice(c.config, projectId, agentId, new URLSearchParams(location.search).has("agent") ? {} : rememberedAgents.current);
      const initialAgent = c.config.agents.find(a => a.id === initialAgentId);
      const enabled = enabledRuntimes(c.config);
      setCli(initialAgent?.defaultCli ?? enabled[0] ?? "");
    }
    // Only restoring a remembered chat needs the chat list; unrelated sidebar reads
    // must not keep the selected conversation or another workspace behind a spinner.
    if(restoringChat){
      const list=await chatRead;
      if(location.pathname+location.search===startedAt&&list.some(chat=>chat.id===restoringChat))setSelected(restoringChat);
    }
    setConfigLoaded(true);
    for(const result of await activity)if(result.status==='rejected')throw result.reason;
  };
  const loadInitialConfig = async () => {
    if (initialConfigPending.current) return;
    initialConfigPending.current = true; setInitialConfigError("");
    try { await refresh(true); }
    catch (e) { setInitialConfigError((e as Error).message); setError((e as Error).message); }
    finally { initialConfigPending.current = false; }
  };
  useEffect(() => {
    void loadInitialConfig();
  }, []);
  useEffect(() => {
    if (settingsPath) return;
    let active = true, updating = false;
    const update = async () => {
      if (document.hidden || updating) return;
      updating = true;
      try {
        const [list, taskList, currentConfig] = await Promise.all([api<Conversation[]>("/conversations?origin=all"), api<Task[]>("/tasks?view=control"),location.pathname==='/mandala'?api<{config:Config;revision:string}>('/config'):Promise.resolve(null)]);
        if (active) { setChats(list); setTasks(taskList); setRefreshError("");if(currentConfig&&currentConfig.revision!==configRevision.current){configRevision.current=currentConfig.revision;setConfig(currentConfig.config);} }
      } catch (e) { if (active) setRefreshError((e as Error).message); }
      finally { updating = false; }
    };
    const timer = setInterval(() => { void update(); }, 3000);
    return () => { active = false; clearInterval(timer); };
  }, [settingsPath]);
  useEffect(() => {
    if (!cli || !chatActive || !configLoaded || selected && chat?.id !== selected) return;
    let active = true;
    setCliStatus(null);
    setCheckingCli(true);
    api<CliStatus>(
      "/cli/status?cli=" + statusCli + (agentId ? "&agentId=" + encodeURIComponent(agentId) : "") +
        (projectId ? "&projectId=" + encodeURIComponent(projectId) : "") +
        (workspaceId !== undefined ? "&workspaceId=" + encodeURIComponent(workspaceId ?? "") : "") +
        (!projectId && directory ? "&cwd=" + encodeURIComponent(directory) : ""),
    )
      .then((status) => {
        if (active) setCliStatus(status);
      })
      .catch(() => {
        if (active) setCliStatus({ status: "unavailable", version: null });
      })
      .finally(() => {
        if (active) setCheckingCli(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, agentId, statusCli, cliCheck, chatActive, configLoaded, selected, chat?.id, workspaceId, directory, JSON.stringify([config.runtimeDefaults, config.agents.find(a => a.id === agentId)?.runtime])]);
  useEffect(() => {
    if (!cli || !chatActive || !configLoaded || selected && chat?.id !== selected) {
      setModelCatalog({ context: modelContext, models: [] });
      return;
    }
    let active = true;
    setModelCatalog({ context: modelContext, models: [] });
    api<ModelChoice[]>(modelsPath)
      .then((list) => {
        if (active) setModelCatalog({ context: modelContext, models: list });
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [projectId, agentId, cli, chatActive, configLoaded, selected, chat?.id, config, workspaceId, directory]);
  useEffect(() => {
    setSubmittingApproval("");
    setStopping(false);
    setEditingTitle(false);
    setEditingMessage(null);
    setBranchPending(false);
    clearCopiedMessage();
  }, [selected]);
  useEffect(() => {
    if (!chatActive) return;
    followLatest.current = true;
    setAwayFromLatest(false);
    setEvents([]);
    setHistoryReadyConversation('');
    setEarlierBefore(null);
    setEarlierState('idle');
    historyAnchor.current = null;
    lastScrollTop.current = 0;
    setApprovals([]);
    setConnectionLost(false);
    setChat(null);
    setQueuedInputs([]);
    queueReads.current.generation++;
    setExecutionId(null);
    devicePreferences.setItem("mana-chat", selected);
    if (!selected) return;
    let active = true, loadVersion = 0, appliedVersion = 0, loading = 0, reload = false;
    let queueLoading = 0, queueReload = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined, eventTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingEvents: DisplayEvent[] = [], initialReplayComplete = false;
    const loadQueue = async () => {
      if (queueLoading >= 2) { queueReload = true; return; }
      queueLoading++;
      const generation = queueReads.current.generation;
      try {
        await refreshQueuedInputs(selected, () => active);
      } catch { /* A later event refreshes queue state again. */ }
      finally {
        queueLoading--;
        if (active && (queueReload || generation !== queueReads.current.generation)) { queueReload = false; void loadQueue(); }
      }
    };
    const scheduleLoad = () => {
      if (refreshTimer !== undefined) return;
      refreshTimer = setTimeout(() => { refreshTimer = undefined; if (active) void load(); }, 25);
    };
    const load = () => {
      // One delayed snapshot must not prevent a newer execution state from loading.
      if (loading >= 2) { reload = true; return; }
      loading++;
      const version = ++loadVersion;
      return api<{ conversation: Conversation; approvals: Approval[]; executionId:string|null }>(
        "/conversations/" + selected,
      )
        .then((data) => {
          // A newer request may still be pending; only an already applied response supersedes this one.
          if (!active || version < appliedVersion) return;
          appliedVersion = version;
          void loadQueue();
          setChat(data.conversation);
          setExecutionId(data.executionId);
          setApprovals(data.approvals);
          setProjectId(data.conversation.projectId);
          setAgentId(data.conversation.agentId);
          setWorkspaceId(data.conversation.workspaceId);
          setDirectory(data.conversation.workspaceId === null ? data.conversation.cwd ?? "" : "");
          setCli(data.conversation.cli);
          setChats((list) =>
            list.map((c) => (c.id === selected ? {...c,...data.conversation} : c)),
          );
        })
        .catch((e) => {
          if (active && version === loadVersion) setError(e.message);
        }).finally(() => {
          loading--;
          if (active && reload) { reload = false; scheduleLoad(); }
        });
    };
    const path = "/conversations/" + selected;
    let before: number | null = null;
    let earlierRequest: AbortController | undefined;
    loadEarlier.current = () => {
      if (!active || !initialReplayComplete || before === null || earlierRequest) return;
      const controller = new AbortController();
      earlierRequest = controller;
      setEarlierState('loading');
      void api<ChatHistoryPage>(
        path + "/history?recent=" + CHAT_HISTORY_PAGE_TURNS + "&compact=1&before=" + before, "GET", undefined, controller.signal,
      ).then(page => {
        if (!active) return;
        const viewport = messagesRoot.current?.closest('.conversation');
        if (viewport && !followLatest.current) {
          const top = viewport.getBoundingClientRect().top;
          const element = Array.from(messagesRoot.current!.querySelectorAll<HTMLElement>('.chat-turn'))
            .find(turn => turn.getBoundingClientRect().bottom > top);
          if (element) historyAnchor.current = { element, top: element.getBoundingClientRect().top };
        }
        before = page.before;
        setEarlierBefore(before);
        // Replay the newer window over the page so an edit arriving during the read
        // still removes any now-superseded events from the older response.
        setEvents(previous => mergeChatEvents(page.events, previous));
        setEarlierState('idle');
      }).catch(() => { if (active) setEarlierState('error'); })
        .finally(() => { earlierRequest = undefined; });
    };
    load();
    const stream = new EventSource("/api" + path + "/events?recent=" + CHAT_HISTORY_PAGE_TURNS + "&compact=1");
    stream.addEventListener('history-window', (message: MessageEvent<string>) => {
      if (!active || initialReplayComplete) return;
      before = (JSON.parse(message.data) as { before: number | null }).before;
      setEarlierBefore(before);
    });
    stream.onerror = () => { if (active) setConnectionLost(true); };
    stream.onopen = () => { if (active) { setConnectionLost(false); if (initialReplayComplete) scheduleLoad(); } };
    stream.addEventListener('history-ready', () => {
      if (!active || initialReplayComplete) return;
      initialReplayComplete = true;
      const batch = pendingEvents; pendingEvents = [];
      setEvents(previous => mergeChatEvents(previous, batch));
      setHistoryReadyConversation(selected);
      scheduleLoad();
    });
    stream.onmessage = (message) => {
      if (!active) return;
      const event = JSON.parse(message.data) as DisplayEvent;
      const replacedFrom = event.kind === "metadata" ? (event.data as { historyReplacedFrom?: number }).historyReplacedFrom : undefined;
      if (replacedFrom !== undefined) setEditingMessage(current => current && current.eventId >= replacedFrom ? null : current);
      pendingEvents.push(event);
      if (initialReplayComplete && eventTimer === undefined) eventTimer = setTimeout(() => {
        eventTimer = undefined;
        const batch = pendingEvents; pendingEvents = [];
        if (!active) return;
        setEvents(previous => mergeChatEvents(previous, batch));
        if (batch.some(item => item.kind === "task")) {
          api<Task[]>("/tasks?view=control").then(items => { if (active) setTasks(items); }).catch(() => {});
          api<Conversation[]>("/conversations?origin=all").then(items => { if (active) setChats(items); }).catch(() => {});
        }
      }, 16);
      if (initialReplayComplete && (
        event.kind === "status" ||
        event.kind === "approval" ||
        event.kind === "user" || event.kind === "task" || event.kind === "metadata"
      ))
        scheduleLoad();
    };
    return () => {
      active = false;
      loadEarlier.current = null;
      earlierRequest?.abort();
      clearTimeout(refreshTimer); clearTimeout(eventTimer);
      stream.close();
    };
  }, [selected, chatActive]);
  useLayoutEffect(() => {
    const viewport = bottom.current?.closest('.conversation');
    const anchor = historyAnchor.current;
    historyAnchor.current = null;
    if (!viewport) return;
    if (followLatest.current) viewport.scrollTop = viewport.scrollHeight;
    else if (anchor?.element.isConnected) viewport.scrollTop += anchor.element.getBoundingClientRect().top - anchor.top;
    lastScrollTop.current = viewport.scrollTop;
  }, [events, approvals.length, historyReady]);
  const busy =
    pending || chat?.status === "running" || chat?.status === "approval";
  const project = config.projects.find((p) => p.id === projectId),
    agent = config.agents.find((a) => a.id === agentId);
  const activeCli = chat?.cli ?? cli;
  const inheritedApprovalMode = (activeCli ? effectiveRuntime(activeCli, agent?.runtime, config.runtimeDefaults).approvalMode : undefined) ?? "default";
  useEffect(() => {
    const request = ++approvalRequest.current;
    setApprovalOverride('');
    setApprovalPreferenceError(false);
    if (!configLoaded || selected || settingsPath || !agentId || isSystemAgent(config,agent) || (!cli || !enabledRuntimes(config).includes(cli))) { setApprovalPreferenceLoading(false); return; }
    setApprovalPreferenceLoading(true);
    void api<{ approvalMode: ApprovalMode | null }>('/chat-preferences/approval?' + new URLSearchParams({ agentId, cli }))
      .then(value => { if (request === approvalRequest.current) setApprovalOverride(value.approvalMode ?? ''); })
      .catch(reason => { if (request === approvalRequest.current) { setApprovalPreferenceError(true); setError((reason as Error).message); } })
      .finally(() => { if (request === approvalRequest.current) setApprovalPreferenceLoading(false); });
    return () => { approvalRequest.current++; };
  }, [configLoaded, selected, projectId, agentId, cli, settingsPath, approvalPreferenceRevision]);
  useLayoutEffect(() => {
    const field = composerInput.current; if (!field) return;
    const resize = () => { field.style.height = '0px'; field.style.height = field.scrollHeight + 'px'; };
    resize(); window.addEventListener('resize', resize); window.visualViewport?.addEventListener('resize', resize);
    return () => { window.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('resize', resize); };
  }, [text, selected, configLoaded, settingsPath, workbench, manaOpen, usageOpen, tasksOpen, assetsOpen, marketOpen]);
  const changeApprovalMode = async (mode: string) => {
    if (busy || modeSaving) return;
    const id = selected;
    const request = ++approvalRequest.current;
    setModeSaving(true);
    try {
      if (!id) {
        if (agentId && !isSystemAgent(config,agent)) await api('/chat-preferences/approval', 'PATCH', { agentId, cli, approvalMode: mode || null });
        if (request === approvalRequest.current) { setApprovalOverride(mode as ApprovalMode | ''); setApprovalPreferenceError(false); setError(''); }
        return;
      }
      const { conversation } = await api<{ conversation: Conversation }>(`/conversations/${id}/approval-mode`, "POST", { approvalMode: mode || null });
      setChats(list => list.map(c => c.id === id ? {...c,...conversation} : c));
      if (selectedChat.current === id) setChat(current => current?.id === id ? conversation : current);
    } catch (e) { if (selectedChat.current === id) setError((e as Error).message); }
    finally { setModeSaving(false); }
  };
  const runtimes = enabledRuntimes(config);
  const availableAgents = config.agents.filter((a) => !a.temporary && !a.archivedAt && (isSystemAgent(config,a) || !a.systemRole && (!project || project.agentIds.includes(a.id))));
  const workbenchProject = (settingsRevision ? draft : config).projects.find(item => item.id === workbenchProjectId);
  const workspaces = projectWorkspaces(project);
  const workspace = workspaceId === null ? undefined : workspaces.find(w => w.id === workspaceId) ?? (workspaceId === undefined ? workspaces[0] : undefined);
  const workspaceLabel = workspace?.name === "Default" ? workspace.cwd : workspace?.name;
  useEffect(() => {
    if (!configLoaded || !chatActive || selected || !projectId || config.projects.some(p => p.id === projectId && !p.archivedAt)) return;
    setProjectId("");
    setWorkspaceId(undefined);
    setDirectory("");
    const query = new URLSearchParams(location.search);
    query.set("project", ""); query.delete("workspace"); query.delete("cwd");
    history.replaceState(history.state, "", location.pathname + "?" + query);
  }, [configLoaded, chatActive, selected, projectId, config]);
  useEffect(() => {
    if (!configLoaded || selected || !agentId || availableAgents.some((a) => a.id === agentId)) return;
    setAgentId("");
  }, [projectId, config, selected, configLoaded, agentId]);
  useEffect(() => {
    if (configLoaded && !selected && runtimes.length && !cli) {
      setCli(agent && runtimes.includes(agent.defaultCli) ? agent.defaultCli : runtimes[0]);
      setModel(""); setEffort("");
    }
  }, [selected, config, configLoaded, cli]);
  useEffect(() => { devicePreferences.setItem("mana-project", projectId); }, [projectId]);
  const openSettings = async (section: SettingsSection = "general", targetAgentId = "", targetProjectId = projectId, selectProject = false, targetTab = "", targetSearch = "", targetPath = "") => {
    if (!configLoaded || objectSaveGuard || !confirmRuntimeLeave()) return;
    const view = ++navigationVersion.current;
    try {
      // Show the destination from the loaded config while its refresh is in flight.
      if (!settingsRevision) {
        settingsSaved.current = config;
        latestDraft.current = structuredClone(config);
        setDraft(latestDraft.current); setSettingsRevision(configRevision.current);
      }
      setPending(false);
      if (section === "projects") {
        setSettingsProjectId(targetProjectId);
        if (selectProject) setProjectSelectionVersion(version => version + 1);
      }
      if (section === "agents" || section === "runtime") {
        setSettingsProjectId(targetSearch || targetAgentId ? targetProjectId : "");
        setSettingsAgentId(targetAgentId);
      }
      if (!settingsPath) settingsReturn.current = location.pathname + location.search;
      const query = section === "projects" && targetProjectId ? "?project=" + encodeURIComponent(targetProjectId) : (section === "agents" || section === "runtime") && targetAgentId ? "?agent=" + encodeURIComponent(targetAgentId) + (targetProjectId ? "&project=" + encodeURIComponent(targetProjectId) : "") : "";
      const tab = targetTab || (section === "runtime" ? "execution" : "");
      history.pushState(null, "", targetPath || settingsUrl(section) + (targetSearch || query + (tab ? (query ? "&" : "?") + "tab=" + encodeURIComponent(tab) : "")));
      setSettingsPath(location.pathname);
      setProjectSelectionVersion(version => version + 1);
      setMobileNav(false);
      if (!settingsPath) setError("");
      const snapshot = JSON.stringify(latestDraft.current), revision = configRevision.current;
      if (!saveInFlight.current && !saveError && (!settingsRevision || snapshot === JSON.stringify(settingsSaved.current))) {
        const saved = await api<{config:Config;revision:string}>('/config');
        if (navigationVersion.current !== view) return;
        if (!saveInFlight.current && configRevision.current === revision && JSON.stringify(latestDraft.current) === snapshot) {
          settingsSaved.current = saved.config; configRevision.current = saved.revision;
          setConfig(saved.config); setDraft(structuredClone(saved.config)); setSettingsRevision(saved.revision);
        }
      }
    } catch (e) {
      if (navigationVersion.current === view) setError((e as Error).message);
    }
  };
  const closeSettings = (restoreRoute = true) => {
    if (objectSaveGuard || !confirmRuntimeLeave()) return false;
    navigationVersion.current++;
    if (JSON.stringify(latestDraft.current) !== JSON.stringify(settingsSaved.current)) void saveSettings();
    if (restoreRoute) history.pushState(null, "", settingsReturn.current);
    setSettingsPath("");
    setError("");
    return true;
  };
  const saveSettings = async () => {
    if (saveInFlight.current || !settingsRevision) return;
    const snapshot = structuredClone(latestDraft.current), serialized = JSON.stringify(snapshot);
    if (serialized === failedDraft.current || saveError === 'configuration changed') return;
    const invalid = snapshot.projects.some(p => !p.name.trim()) ? '项目名称不能为空' : snapshot.agents.some(a => !a.name.trim()) ? 'Agent 名称不能为空' : '';
    if (invalid) { failedDraft.current = serialized; setSaveError(invalid); return; }
    saveInFlight.current = true; setSaving(true); setSaveError('');
    try {
      const saved = await api<{config:Config;revision:string}>('/config', 'PUT', {config:snapshot,revision:settingsRevision});
      settingsSaved.current = saved.config; configRevision.current = saved.revision;
      setConfig(saved.config);
      if (JSON.stringify(latestDraft.current) === serialized) setDraft(structuredClone(saved.config));
      setSettingsRevision(saved.revision);
      failedDraft.current = '';
    } catch (e) {
      failedDraft.current = serialized;
      setSaveError((e as Error).message);
    } finally { saveInFlight.current = false; setSaving(false); }
  };
  const saveRuntime = async (cli: Cli, runtimeDefaults: NonNullable<Config['runtimeDefaults']>, enabled: boolean, chatDefaults: Config['chatDefaults']) => {
    if (saveInFlight.current || JSON.stringify(latestDraft.current) !== JSON.stringify(settingsSaved.current)) throw new Error('configuration changed');
    saveInFlight.current = true; runtimeSaveInFlight.current = true; setRuntimeSaving(true); setSaving(true);
    try {
      const current = settingsSaved.current;
      const runtimes = enabled ? runtimeIds.filter(item => item === cli || enabledRuntimes(current).includes(item)) : enabledRuntimes(current).filter(item => item !== cli);
      const next = { ...current, runtimes, runtimeDefaults: { ...current.runtimeDefaults, [cli]: enabled ? runtimeDefaults[cli] ?? {} : current.runtimeDefaults?.[cli] }, chatDefaults: { ...current.chatDefaults, [cli]: enabled ? chatDefaults?.[cli] : current.chatDefaults?.[cli] } };
      const saved = await api<{config:Config;revision:string}>('/config', 'PUT', {config:next,revision:configRevision.current});
      settingsSaved.current = saved.config; configRevision.current = saved.revision;
      latestDraft.current = structuredClone(saved.config);
      setConfig(saved.config); setDraft(structuredClone(saved.config)); setSettingsRevision(saved.revision); setSaveError(''); failedDraft.current = '';
    } finally { saveInFlight.current = false; runtimeSaveInFlight.current = false; setRuntimeSaving(false); setSaving(false); }
  };
  useEffect(() => {
    const serialized = JSON.stringify(draft);
    if (!settingsRevision || saving || serialized === JSON.stringify(settingsSaved.current) || serialized === failedDraft.current || saveError === 'configuration changed') return;
    const timer = setTimeout(() => { void saveSettings(); }, 500);
    return () => clearTimeout(timer);
  }, [draft, settingsRevision, saving, saveError]);
  useEffect(() => {
    const protectPending = (event:BeforeUnloadEvent) => {
      if (runtimeDraftDirty.current || runtimeSaveInFlight.current || saving || settingsRevision && JSON.stringify(latestDraft.current) !== JSON.stringify(settingsSaved.current)) { event.preventDefault(); event.returnValue = ''; }
    };
    addEventListener('beforeunload', protectPending); return () => removeEventListener('beforeunload', protectPending);
  }, [saving, settingsRevision]);
  const reloadSettings = async () => {
    if (saveInFlight.current) return;
    saveInFlight.current = true; setSaving(true);
    try {
      const saved = await api<{config:Config;revision:string}>('/config');
      settingsSaved.current = saved.config; configRevision.current = saved.revision; setConfig(saved.config); setDraft(structuredClone(saved.config)); setSettingsRevision(saved.revision);
      failedDraft.current = ''; setSaveError(''); setError('');
    } catch (e) { setError((e as Error).message); }
    finally { saveInFlight.current = false; setSaving(false); }
  };
  const saveTitle = async () => {
    const id = selected;
    try {
      const { conversation } = await api<{ conversation: Conversation }>(
        "/conversations/" + id,
        "PATCH",
        { title: titleDraft },
      );
      setChats((list) =>
        list.map((c) =>
          c.id === id ? { ...c, title: conversation.title } : c,
        ),
      );
      if (selectedChat.current !== id) return;
      setChat((current) =>
        current?.id === id
          ? { ...current, title: conversation.title }
          : current,
      );
      setEditingTitle(false);
      setError("");
    } catch (e) {
      if (selectedChat.current === id) setError((e as Error).message);
    }
  };
  const [mandalaSettingsOpen,setMandalaSettingsOpen]=useState(false);
  const [mandalaLoading,setMandalaLoading]=useState(false);
  useEffect(()=>{if(mandalaMain)setEffectiveOpen(!matchMedia('(max-width: 1100px)').matches);},[mandalaMain]);
  const chatDefaults = cli ? config.chatDefaults?.[cli] : undefined;
  const inheritedModel = cli ? agent?.models[cli] || chatDefaults?.model : undefined;
  const effectiveModel = selected ? activeChat?.model ?? models.find(item => item.isDefault)?.id : model || inheritedModel || models.find(item => item.isDefault)?.id;
  const modelChoice = models.find(item => item.id === effectiveModel);
  const currentEffort = selected ? activeChat?.effort ?? modelChoice?.defaultReasoningEffort ?? "" : effort || (effectiveModel === chatDefaults?.model ? chatDefaults?.effort : undefined) || modelChoice?.defaultReasoningEffort || "";
  const allowedEfforts = effortOptions(modelChoice);
  useEffect(() => {
    if (!cli || !configLoaded || !chatActive || settingsPath || mandalaMain || selected && chat?.id !== selected || !effectiveModel) return;
    devicePreferences.setItem("mana-chat-preferences", JSON.stringify({ projectId, agentId, cli,
      model: selected ? effectiveModel : model, effort: selected ? currentEffort : effort,...(onboardingDismissed?{onboardingCompleted:true}:{}) }));
  }, [configLoaded, chatActive, settingsPath, mandalaMain, selected, chat, projectId, agentId, cli, effectiveModel, currentEffort, model, effort,onboardingDismissed]);
  const pickModel = async (value: string, nextEffort?: ReasoningEffort) => {
    if (!selected) { setModel(value); setEffort(nextEffort ?? models.find(item => item.id === value)?.defaultReasoningEffort ?? ""); return; }
    const id = selected;
    setModeSaving(true);
    try {
      nextEffort ??= models.find(item => item.id === value)?.defaultReasoningEffort;
      const result = await api<{ conversation: Conversation }>(`/conversations/${id}/model`, "POST", { model: value, effort: nextEffort });
      if (selectedChat.current === id) setChat(result.conversation);
      setChats(list => list.map(item => item.id === id ? {...item,...result.conversation} : item));
      setError("");
    } catch (e) { if (selectedChat.current === id) setError((e as Error).message); }
    finally { setModeSaving(false); }
  };
  const addFiles = (incoming: File[]) => {
    if (pending || branchPending) return;
    const attachments: File[] = [];
    try {
      const desktopFiles = (window as Window & {mandalaDesktop?:{files?:{directoryPath:(file:File)=>string|null}}}).mandalaDesktop?.files;
      for (const file of incoming) {
        const path = desktopFiles?.directoryPath(file);
        attachments.push(path ? new File([path], file.name, { type: directoryReferenceType }) : file);
      }
    } catch (reason) { setError((reason as Error).message); return; }
    incoming = attachments;
    if (files.length + incoming.length > 8 || incoming.some(file => !file.size || file.size > 20 * 1024 * 1024)) {
      setError("附件最多 8 个，每个文件须为 1 字节至 20 MB。"); return;
    }
    setFiles(current => [...current, ...incoming]);
    setError("");
  };
  const addTextAttachment = (value: string, quoted = false) => {
    const label = localize(quoted ? '引用选段' : '粘贴文本', quoted ? 'Quoted text' : 'Pasted text');
    let name = label + '.txt', index = 2;
    while (files.some(file => file.name === name)) name = `${label} (${index++}).txt`;
    addFiles([new File([value], name, { type: 'text/plain' })]);
    composerInput.current?.focus();
  };
  const quoteDisabled = !composerDraft.loaded || pending || branchPending || navigationLocked;
  const addQuote = (value: string) => {
    if (quoteDisabled || !value.trim()) return;
    addTextAttachment(value, true);
    window.getSelection()?.removeAllRanges();
  };
  const send = async (interrupt = false) => {
    if(voiceBusy)return;
    if (selected && (chat?.id !== selected || !historyReady)) return;
    if (!composerDraft.loaded || (composerDraft.value.missingAttachments.length && !composerDraft.pending) || ((!text.trim() && !files.length && !selectedReferences.length) && !composerDraft.pending) || pending || stopping || modeSaving || branchPending || approvalPreferenceLoading || approvalPreferenceError || (!selected && (!cli || !runtimes.includes(cli)))) return;
    const view = navigationVersion.current;
    let requestText = text;
    let requestFiles = files;
    let requestReferences = selectedReferences;
    let draftConversation = selected;
    let submission = retrySubmissions.current.get(selected);
    if(!composerDraft.pending&&submission&&!submission.attempted&&submission.stopConfirmed){retrySubmissions.current.delete(selected);submission=undefined;}
    if (composerDraft.pending && !submission) {
      const recovered=restoreSubmission(composerDraft.pending);
      submission={view,conversationId:recovered.conversationId,text:recovered.text,files:[],references:recovered.references.map(ref=>referenceItems.find(item=>item.id===ref.id)??{id:ref.id,kind:'task',name:ref.id,source:'',detail:'',status:''}),attachments:recovered.attachments,commandKey:recovered.commandKey,draftFingerprint:recovered.draftFingerprint,action:recovered.action,...recovered.recovery};
      retrySubmissions.current.set(selected,submission);
    }
    if(submission&&(submission.attempted||submission.stopAttempted||composerDraft.pending)){requestText=submission.text;requestFiles=submission.files;requestReferences=submission.references;}
    if (!submission || (!submission.attempted && !submission.stopAttempted && !composerDraft.pending && ((!selected && submission.view !== view) || submission.conversationId !== selected || submission.text !== requestText || submission.files !== requestFiles ||
        submission.references.length !== requestReferences.length || submission.references.some((item, index) => item.id !== requestReferences[index].id) || (submission.action === "interrupt") !== interrupt || interrupt&&submission.expectedExecutionId!==executionId))) {
      submission = { view, conversationId: selected, text: requestText, files: requestFiles, references: requestReferences, attachments: [], commandKey: crypto.randomUUID(), draftFingerprint:composerDraftFingerprint(composerDraft.value),
        action: interrupt ? "interrupt" : chat?.status === "interrupted" || chat?.status === "error" ? "continue" : "queue",
        ...(interrupt&&executionId?{expectedExecutionId:executionId}:{}) };
      retrySubmissions.current.set(selected, submission);
    }
    setPending(true);
    setError("");
    try {
      let id = submission.conversationId || selected;
      if (!id) {
        const creationModels = effectiveModel ? models : await api<ModelChoice[]>(modelsPath);
        if (navigationVersion.current !== view) return;
        const creationModel = effectiveModel || creationModels.find(item => item.isDefault)?.id;
        const creationChoice = creationModels.find(item => item.id === creationModel);
        const creationEffort = currentEffort || creationChoice?.defaultReasoningEffort;
        const c = await api<Conversation>("/conversations", "POST", {
          projectId,
          agentId,
          workspaceId: workspace?.id ?? null,
          ...(!project && directory ? { cwd: directory } : {}),
          cli,
          ...(creationModel ? { model: creationModel } : {}),
          ...(creationEffort && effortOptions(creationChoice).includes(creationEffort) ? { effort: creationEffort } : {}),
          ...(approvalOverride ? { approvalMode: approvalOverride } : {}),
        });
        id = c.id;
        submission.conversationId = id;
        retrySubmissions.current.set(id, submission);
        setChats((list) => [c, ...list]);
        draftConversation = id;
      }
      if (selected && !mandalaMain && !busy && !chat?.model && effectiveModel) {
        await api(`/conversations/${id}/model`, "POST", { model: effectiveModel,
          ...(currentEffort && allowedEfforts.includes(currentEffort) ? { effort: currentEffort } : {}) });
      }
      const action = submission.action;
      const attachments = submission.attachments;
      const input = await resolveComposerFiles(requestText, requestFiles);
      await uploadComposerFiles(fetch,id,input.files,attachments);
      const prepared:ComposerSubmission={conversationId:id,commandKey:submission.commandKey,draftFingerprint:submission.draftFingerprint,text:input.text,attachments,references:requestReferences.map(item=>({id:item.id})),action,recovery:submission};
      let submittedDraft=composerDraft;
      if(!selected){
        await composerDraft.flush();await composerDraft.copyToConversation(id,pendingSubmission(prepared));
        if(navigationVersion.current===view){submittedDraft=await new Promise<ReturnType<typeof useComposerDraft>>((resolve,reject)=>{composerReady.current={id,resolve,reject};setSelected(id);history.replaceState(null,'','/?'+new URLSearchParams({project:projectId,conversation:id}));});retrySubmissions.current.delete('');}
      }
      const background=!selected&&navigationVersion.current!==view;
      if (selectedChat.current === id) queueReads.current.generation++;
      await submitComposerInput(api,prepared,background?(pending=>composerDraft.savePending(pending,id)):submittedDraft.savePending,async()=>{if(background)await composerDraft.completeConversation(id,prepared.draftFingerprint);else{submittedDraft.setValue(current=>clearAcceptedComposerDraft(current,prepared.draftFingerprint));await submittedDraft.flush();}});
      if (selectedChat.current === id) queueReads.current.generation++;
      rememberedAgents.current[projectId] = agentId;
      try { devicePreferences.setItem('mana-project-agents', JSON.stringify(rememberedAgents.current)); } catch { /* Sending is independent of browser preference storage. */ }
      if (retrySubmissions.current.get(id) === submission) retrySubmissions.current.delete(id);
      if (retrySubmissions.current.get('') === submission) retrySubmissions.current.delete('');
      if (navigationVersion.current === view && action !== "continue") {
        await refreshQueuedInputs(id, () => navigationVersion.current === view).catch(() => {});
      }
      if (selectedChat.current === draftConversation) setReferenceQuery(null);
    } catch (e) {
      if (navigationVersion.current === view) setError(submissionError(e,language !== 'zh-CN'));
    } finally {
      if (navigationVersion.current === view) setPending(false);
    }
  };
  const editMessage = async () => {
    if (!editingMessage?.text.trim() || busy || branchPending || !selected) return;
    const source = selected, view = navigationVersion.current, request = ++branchRequest.current;
    setBranchPending(true);
    setError("");
    try {
      const result = await api<{ conversation: Conversation }>("/conversations/" + source + "/edit", "POST", { eventId: editingMessage.eventId, text: editingMessage.text });
      setChats(list => [result.conversation, ...list.filter(item => item.id !== result.conversation.id)]);
      if (selectedChat.current === source && navigationVersion.current === view) {
        setEditingMessage(null);
        setChat(result.conversation);
      }
    } catch (e) { if (selectedChat.current === source && navigationVersion.current === view) setError((e as Error).message); }
    finally { if (request === branchRequest.current) setBranchPending(false); }
  };
  const forkReply = async (eventId?: number) => {
    if (!selected || busy || branchPending) return;
    const source = selected, view = navigationVersion.current, request = ++branchRequest.current;
    setBranchPending(true); setError("");
    try {
      const result = await api<{conversation: Conversation}>("/conversations/" + source + "/fork", "POST", {eventId});
      setChats(list => [result.conversation, ...list.filter(item => item.id !== result.conversation.id)]);
      if (selectedChat.current === source && navigationVersion.current === view)
        navigate(result.conversation.projectId, result.conversation.id, result.conversation.agentId);
    } catch (e) { if (selectedChat.current === source && navigationVersion.current === view) setError((e as Error).message); }
    finally { if (request === branchRequest.current) setBranchPending(false); }
  };
  const copyMessage = async (id: number, content: string) => {
    try { await copyText(content); setCopiedMessage(id); }
    catch { clearCopiedMessage(); setError(t("复制失败，请手动选择文本。")); }
  };
  const reuseRequest = async (message: Pick<ChatMessage, 'text' | 'referenceItems'> & { attachments?: { id: string; name?: string; mimeType?: string }[] }) => {
    if (pending || branchPending || navigationLocked) return;
    const source = selected, view = navigationVersion.current;
    setBranchPending(true); setError("");
    try {
      const attachments = await Promise.all((message.attachments ?? []).map(async item => {
        const response = await fetch(`/api/conversations/${source}/attachments/${item.id}?download=1`);
        if (!response.ok) throw new Error(t("无法读取附件，请重试。"));
        const name = item.name ?? decodeURIComponent(response.headers.get('Content-Disposition')?.split("UTF-8''")[1] ?? item.id);
        return new File([await response.blob()], name, { type: item.mimeType ?? response.headers.get('Content-Type') ?? '' });
      }));
      if (selectedChat.current !== source || view !== navigationVersion.current) return;
      flushSync(() => { navigate(projectId, "", agentId); setWorkspaceId(chat?.workspaceId); setDirectory(chat?.cwd ?? ""); });
      composerDraftRef.current.replaceValue({text:message.text,files:attachments,references:message.referenceItems??[],missingAttachments:[]});
      requestAnimationFrame(() => composerInput.current?.focus());
    } catch (e) { if (selectedChat.current === source) setError((e as Error).message); }
    finally { setBranchPending(false); }
  };
  const control = async (action: string, body = {}) => {
    if (action === "stop" && stopping) return;
    const conversationId = selected;
    if (action === "stop") setStopping(true);
    try {
      const result=await api<{stopConfirmed?:boolean}>("/conversations/" + conversationId + "/" + action, "POST", body);
      if(action==='stop'&&result.stopConfirmed===false&&selectedChat.current===conversationId)setError(t('停止尚未确认，排队消息暂未发送。'));
    } catch (e) {
      if (selectedChat.current === conversationId) setError((e as Error).message);
    } finally {
      if (action === "stop" && selectedChat.current === conversationId) setStopping(false);
    }
  };
  const sendQueued=async(input:QueuedInput)=>{
    if(pending||stopping||navigationLocked||branchPending||modeSaving||!historyReady||chat?.id!==selected)return;
    const id=selected,view=navigationVersion.current;setPending(true);setError('');queueReads.current.generation++;
    try{await api('/conversations/'+id+'/queue/'+input.id,'POST',{expectedExecutionId:executionId});if(view===navigationVersion.current)queueReads.current.generation++;await refreshQueuedInputs(id,()=>view===navigationVersion.current);}
    catch(error){if(view===navigationVersion.current)setError((error as Error).message);}
    finally{if(view===navigationVersion.current)setPending(false);}
  };
  const submitApproval = async (id: string, decision: ApprovalDecision) => {
    if (submittingApproval) return;
    const conversationId = selected;
    setSubmittingApproval(id);
    setError("");
    try { await api("/conversations/" + conversationId + "/approvals/" + id, "POST", { decision }); }
    catch (e) { if (selectedChat.current === conversationId) setError((e as Error).message); }
    finally { if (selectedChat.current === conversationId) setSubmittingApproval(""); }
  };
  const submitQuestion = async (id:string,answers:Record<string,{answers:string[]}>)=>{
    if(submittingApproval)return;
    const conversationId=selected;setSubmittingApproval(id);
    try{await api('/conversations/'+conversationId+'/questions/'+id,'POST',{answers});}
    catch(error){if(selectedChat.current===conversationId)setError((error as Error).message);}
    finally{if(selectedChat.current===conversationId)setSubmittingApproval('');}
  };
  const renderApprovalRequest=(approval:Approval)=><ApprovalRequest key={approval.id} approval={approval} events={events}
    pending={submittingApproval===approval.id} onDecision={(id,decision)=>void submitApproval(id,decision)} onAnswer={(id,answers)=>void submitQuestion(id,answers)}/>;
  const turns = useMemo(() => groupChatTurns(events), [events]);
  const presentedTurns = useMemo(() => turns.map(turn => {
    const run = presentRun(turn);
    return { turn, run, replyText: run.answers.map(message => message.text).join("\n\n") };
  }), [turns]);
  const executionResults=useExecutionResults(chatActive&&agent?.systemRole==='mandala'?selected:'');
  const resultGroups=useMemo(()=>{
    const presented=new Set(turns.flatMap(turn=>turn.messages.flatMap(message=>message.source?.kind==='coordination'?message.source.receiptIds:[])));
    const groups=new Map<number|null,typeof executionResults.items>();
    const oldestLoadedAt = earlierBefore !== null ? events[0]?.createdAt : undefined;
    for(const item of executionResults.items){
      if(presented.has(item.id))continue;
      const turn=[...turns].reverse().find(turn=>(turn.events.find(event=>event.kind==='user')??turn.events[0]).createdAt<=item.createdAt);
      if (!turn && oldestLoadedAt && item.createdAt < oldestLoadedAt) continue;
      const key=turn?.key??null;
      groups.set(key,[...groups.get(key)??[],item]);
    }
    return groups;
  },[turns,executionResults.items,earlierBefore,events]);
  const focusedExecution=useRef('');
  useLayoutEffect(()=>{
    const runId=new URLSearchParams(location.search).get('run');
    if(!runId||!historyReady){focusedExecution.current='';return;}
    const key=selected+':'+runId;if(focusedExecution.current===key)return;
    const target=messagesRoot.current?.querySelector<HTMLElement>('[data-run-id="'+CSS.escape(runId)+'"]');
    if (!target) {
      if (earlierState === 'idle') loadEarlier.current?.();
      return;
    }
    focusedExecution.current=key;followLatest.current=false;setAwayFromLatest(true);
    target.focus({preventScroll:true});
    const viewport=target.closest<HTMLElement>('.conversation');
    if(viewport)viewport.scrollTop+=target.getBoundingClientRect().top-viewport.getBoundingClientRect().top;
  },[selected,historyReady,events,routeLocation,earlierState]);
  const chatMessages = useMemo(() => turns.flatMap(turn => turn.messages), [turns]);
  const verifiedFiles = useVerifiedConversationFiles(chatActive ? selected : "", chatMessages);
  const publishedFiles=usePublishedConversationFiles(chatActive?selected:'',chat?.updatedAt??'');
  const operationTasks=useOperationTasks(events,selected);
  const publishedFilesByRun=useMemo(()=>new Map([['',publishedFiles],...[...new Set(publishedFiles.flatMap(file=>file.runId?[file.runId]:[]))].map(runId=>[runId,publishedFiles.filter(file=>!file.runId||file.runId===runId)] as const)]),[publishedFiles]);
  // Read only when the context popover opens.
  const loadChatFiles = useCallback(() => conversationFiles(chatMessages, selected, verifiedFiles), [chatMessages, selected, verifiedFiles]);
  const messageStates=new Map<string,{autoResumeAllowed?:boolean;replyState?:string;direction?:string}>();
  for(const event of events){const message=(event.data as {agentMessage?:{id:string;autoResumeAllowed?:boolean;replyState?:string;direction?:string}}).agentMessage;if(event.kind==='metadata'&&message&&message.direction!=='request')messageStates.set(message.id,message);}
  const waitingForMessages=[...messageStates.values()].some(m=>m.autoResumeAllowed&&m.replyState!=='consumed'&&m.replyState!=='parked');
  const waitingForTasks=tasks.some(task=>task.sourceConversationId===selected&&task.autoResume===true&&['queued','running'].includes(task.status));

  const navigate = (nextProject: string, conversation = "", nextAgent = "", showWorkbench = false, preserveLibrary = false) => {
    if(objectSaveGuard)return;
    setUsageOpen(false);
    setAssetsOpen(false);
    setTasksOpen(false);
    setMarketOpen(false);
    const sameChat = conversation && conversation === selected && nextProject === projectId && !showWorkbench;
    if (sameChat && !usageOpen && !workbench && !manaOpen && !tasksOpen && !assetsOpen && !marketOpen) {
      setMobileNav(false);
      if (!preserveLibrary) setSearch("");
      return;
    }
    navigationVersion.current++;
    const query = new URLSearchParams({ project: nextProject });
    if (conversation) query.set("conversation", conversation);
    else query.set("agent", nextAgent);
    history.pushState(null, "", showWorkbench ? `/projects/${encodeURIComponent(nextProject)}/workbench` : "/?" + query);
    if (sameChat) {
      setWorkbench(false); setManaOpen(false); setMobileNav(false); if (!preserveLibrary) setSearch("");
      return;
    }
    if (showWorkbench) {
      setWorkbenchProjectId(nextProject); setWorkbench(true); setManaOpen(false);
      setMobileNav(false); setEffectiveOpen(false); setError("");
      return;
    }
    setProjectId(nextProject);
    setAgentId(nextAgent);
    setWorkspaceId(undefined);
    setDirectory("");
    setSelected(conversation);
    setWorkbench(showWorkbench);
    setManaOpen(false);
    if (conversation !== selected) { setChat(null); setEvents([]); }
    setError("");
    setPending(false);
    const keepChoices = !conversation && nextProject === (activeChat?.projectId ?? projectId) && nextAgent === (activeChat?.agentId ?? agentId);
    setModel(keepChoices ? effectiveModel ?? "" : "");
    setEffort(keepChoices ? currentEffort as ReasoningEffort | "" : "");
    if (keepChoices && activeChat) setCli(activeChat.cli);
    if (!conversation && !keepChoices) {
      const nextDefault = config.agents.find(a => a.id === nextAgent)?.defaultCli;
      setCli(nextDefault ?? runtimes[0] ?? "");
    }
    if (!preserveLibrary) setSearch("");
    setMobileNav(false);
    setEffectiveOpen(false);
  };
  const openConversation = async (id: string, preserveLibrary = false) => {
    if(navigationBlocked.current)return;
    const view=navigationVersion.current;
    let item = chats.find((c) => c.id === id);
    if(!item){
      try{item=(await api<{conversation:Conversation}>('/conversations/'+id)).conversation;}
      catch(e){if(view===navigationVersion.current&&!navigationBlocked.current)setError((e as Error).message);return;}
      if(view!==navigationVersion.current||navigationBlocked.current)return;
      setChats(list=>[item!,...list.filter(c=>c.id!==id)]);
    }
    const sourceView=item.archivedAt?"archived":"recent";
    if (!preserveLibrary) { setLibraryView(sourceView);devicePreferences.setItem("mana-view",sourceView); }
    navigate(item.projectId, id, item.agentId, false, preserveLibrary);
    setCli(item.cli);
    setWorkspaceId(item.workspaceId);
    setDirectory(item.workspaceId === null ? item.cwd ?? "" : "");
  };
  const archiveChat = async (id: string, archived: boolean) => {
    try {
      const { conversation } = await api<{ conversation: Conversation }>(`/conversations/${id}/archive`, "POST", { archived });
      const apply = (item: Conversation) => (item.updatedAt ?? item.createdAt) > (conversation.updatedAt ?? conversation.createdAt)
        ? item : { ...item, archivedAt: conversation.archivedAt, updatedAt: conversation.updatedAt };
      setChats(list => list.map(item => item.id === id ? apply(item) : item));
      if (selectedChat.current === id) setChat(item => item?.id === id ? apply(item) : item);
    } catch (e) { setError((e as Error).message); }
  };
  const changeArea = (area: "tasks" | "chat" | "projects" | "agents" | "mana" | "assets" | "market" | "settings") => {
    if (navigationLocked || objectSaveGuard) return;
    if (area === "settings" || area === "agents" || area === "projects") { void openSettings(area === "agents" ? "agents" : area === "projects" ? "projects" : "general"); return; }
    const fromSettings = !!settingsPath;
    if (fromSettings && !closeSettings()) return;
    navigationVersion.current++;
    const query = new URLSearchParams({ project: projectId });
    if (selected) query.set("conversation", selected);
    else { query.set("agent", agentId); if (workspaceId !== undefined) query.set("workspace", workspaceId ?? ""); if (!projectId && directory) query.set("cwd", directory); }
    const path = area === "market" ? "/market" : area === "tasks" ? "/tasks" : area === "assets" ? "/assets" : area === "mana" ? "/mana" : "/?" + query;
    if (path !== location.pathname + location.search) history[fromSettings ? "replaceState" : "pushState"](null, "", path);
    if (area === "assets" || area === "tasks" || area === "market") dispatchEvent(new PopStateEvent("popstate"));
    setAssetsOpen(area === "assets");
    setMarketOpen(area === "market");
    setTasksOpen(area === "tasks");
    setManaOpen(area === "mana");
    setUsageOpen(false);
    setWorkbench(false);
    setEffectiveOpen(false);
    setMobileNav(false);
    setError("");
  };
  const existingComposerDraft=composerDraft.loaded&&!!(text||files.length||selectedReferences.length||composerDraft.value.missingAttachments.length||composerDraft.pending);
  const welcomeForced=welcomeRequested(routeLocation);
  const firstUseGuide=configLoaded&&!selected&&(welcomeForced||!chats.some(chat=>chat.purpose!=='mandala-main')&&!config.agents.some(agent=>!agent.systemRole&&!agent.temporary)&&!isSystemAgent(config,agent)&&!onboardingDismissed&&!existingComposerDraft);
  const activeArea = settingsPath ? settingsSection(settingsPath) === "agents" || settingsSection(settingsPath) === "runtime" ? "agents" : settingsSection(settingsPath) === "projects" ? "projects" : "settings" : marketOpen ? "market" : tasksOpen ? location.pathname === "/schedules" ? "schedules" : "tasks" : assetsOpen ? "assets" : manaOpen ? "mana" : usageOpen ? "usage" : workbench ? "projects" : "chat";
  const openWorkspacePath = (path: string) => {
    if(path === "/mandala"){void openMandala();return;}
    if (runtimeSaveInFlight.current || navigationLocked || objectSaveGuard) return;
    path=canonicalObjectPath(path);
    const target = new URL(path, location.href);
    const taskRoute = !tasksOpen && target.pathname.match(/^\/tasks\/([^/]+)$/);
    if (taskRoute) { setTaskDialog(decodeURIComponent(taskRoute[1])); return; }
    const agentRoute = target.pathname.match(/^\/agents\/([^/]+)(?:\/memory)?$/);
    if (agentRoute) { void openSettings('agents', decodeURIComponent(agentRoute[1]), target.searchParams.get('project') ?? '', false, target.pathname.endsWith('/memory') ? 'memory' : target.searchParams.get('tab') ?? '', '', path); return; }
    const projectRoute = target.pathname.match(/^\/projects\/([^/]+)\/settings$/);
    if (projectRoute) { void openSettings('projects', '', decodeURIComponent(projectRoute[1]), true, '', '', path); return; }
    if (!configLoaded && initialConfigError) {
      history.pushState(null, "", path); dispatchEvent(new PopStateEvent("popstate")); setMobileNav(false); return;
    }
    if (target.pathname === "/mana" && target.searchParams.get("tab") === "organization") { void openSettings("agents", "", ""); return; }
    const section = settingsSection(target.pathname);
    if (section) { void openSettings(section, target.searchParams.get("agent") ?? "", target.searchParams.get("project") ?? "", section === "projects" && target.searchParams.has("project"), target.searchParams.get("tab") ?? "", target.search); return; }
    if (settingsPath && !closeSettings(false)) return;
    const workbenchMatch = path.match(/^\/projects\/([^/]+)\/(?:workbench|overview|tasks|library|agents)$/);
    if (workbenchMatch && path.endsWith("/workbench")) { navigate(decodeURIComponent(workbenchMatch[1]), "", "", true); return; }
    const identity=config.agents.find(a=>a.id===target.searchParams.get('agent'));
    if (target.pathname === '/' && isSystemAgent(config,identity) && !target.searchParams.has('conversation')) {
      navigate(target.searchParams.get('project')??'','',identity!.id);
      setCli(identity!.defaultCli);setModel('');setEffort('');
      if(target.searchParams.has('workspace'))setWorkspaceId(target.searchParams.get('workspace')||null);
      if(target.searchParams.has('cwd'))setDirectory(target.searchParams.get('cwd')??'');
      history.replaceState(null,'',path);
      return;
    }
    history.pushState(null, "", path);
    dispatchEvent(new PopStateEvent("popstate"));
    setMobileNav(false);
  };
  const openMandala = async () => {
    if (navigationLocked || objectSaveGuard || mandalaLoading) return;
    if (settingsPath && !closeSettings(false)) return;
    const open = (conversation:Conversation) => {
      navigate('',conversation.id,conversation.agentId);
      history.replaceState(null,'','/mandala?'+new URLSearchParams({conversation:conversation.id}));
      setRouteLocation(location.pathname+location.search);setCli(conversation.cli);
      return conversation.id;
    };
    const known=chats.find(chat=>chat.purpose==='mandala-main'&&!chat.archivedAt&&chat.agentId===config.mandala?.agentId);
    if(known)return open(known); // The selected chat still performs fresh history/approval authorization.
    setMandalaLoading(true); const view=navigationVersion.current;
    try {
      const result=await api<{config:Config;conversation:Conversation|null}>('/mandala');
      if(view!==navigationVersion.current)return;
      setConfig(result.config);
      const conversation=result.conversation;
      if(!conversation){navigate('','','');history.replaceState(null,'','/?welcome=1');setRouteLocation('/?welcome=1');return;}
      setChats(list=>[conversation,...list.filter(item=>item.id!==conversation.id)]);
      return open(conversation);
    } catch(reason){setError((reason as Error).message);} finally{setMandalaLoading(false);}
  };
  // First use ends by adopting the chosen CLI everywhere it is needed, then handing off; nothing is sent.
  const finishOnboarding = async (chosen: Cli, action: "mandala" | "chat" | "agent") => {
    const saved = await adoptRuntime(chosen, action === "mandala");
    settingsSaved.current = saved.config; configRevision.current = saved.revision; latestDraft.current = structuredClone(saved.config);
    setConfig(saved.config); setDraft(latestDraft.current); setSettingsRevision(saved.revision);
    devicePreferences.setItem("mana-chat-preferences", JSON.stringify({ projectId, agentId: "", cli: chosen, model: "", effort: "", onboardingCompleted: true }));
    setOnboardingDismissed(true);
    if (welcomeRequested(location.pathname + location.search)) { history.replaceState(null, "", "/"); setRouteLocation("/"); }
    if (action === "mandala") { await openMandala(); return; }
    if (action === "agent") { openWorkspacePath("/agents?new=1&runtime=" + chosen); return; }
    setCli(chosen); setAgentId(""); setModel(""); setEffort("");
    requestAnimationFrame(() => composerInput.current?.focus());
  };
  useEffect(()=>{
    if(!configLoaded)return;
    if(location.pathname==='/mandala'&&!new URLSearchParams(location.search).has('conversation'))void openMandala();
    else if(settingsPath&&isSystemAgent(config,config.agents.find(a=>a.id===settingsAgentId))){setSettingsAgentId('');history.replaceState(null,'','/agents');setRouteLocation('/agents');setMandalaSettingsOpen(true);}
  },[configLoaded,routeLocation,settingsPath,settingsAgentId,config.mandala?.agentId]);
  const paletteProjectId = settingsPath && settingsSection(settingsPath) === "projects" ? config.projects.find(p=>p.id===settingsProjectId)?.id ?? "" : usageOpen ? usageProjectId : activeArea === "chat" ? projectId : workbench ? workbenchProjectId : new URLSearchParams(location.search).get("project") ?? "";
  const paletteAgentId = activeArea === "chat" ? agentId : "";
  const startChat = () => {
    if(objectSaveGuard)return;
    if (!configLoaded || navigationLocked || runtimeSaving) return;
    const scoped = settingsPath && settingsSection(settingsPath) === "projects" || activeArea === "chat" || workbench || usageOpen && !!usageProjectId || new URLSearchParams(location.search).has("project");
    const nextProject = scoped ? paletteProjectId : activeChat?.projectId ?? projectId;
    if (settingsPath && !closeSettings()) return;
    navigate(nextProject, "", mandalaMain ? "" : nextProject === (activeChat?.projectId ?? projectId) ? activeChat?.agentId ?? agentId : projectAgentChoice(config, nextProject, agentId, rememberedAgents.current));
  };
  useShortcuts((id, event) => {
      if (!configLoaded) return;
      if (id === 'palette') { event.preventDefault(); setPaletteOpen(true); }
      if (id === 'new-chat' && !navigationLocked && !runtimeSaving) { event.preventDefault(); startChat(); }
      if (id === 'composer' && chatActive && !composerInput.current?.disabled) { event.preventDefault(); composerInput.current?.focus(); }
      if (id === 'terminal' && chatActive && selected) {
        event.preventDefault();
        const closing = effectiveOpen && workspaceTab === 'terminal';
        setWorkspaceTab('terminal'); setEffectiveOpen(!closing);
        if (closing) requestAnimationFrame(() => { if(document.activeElement===document.body||document.activeElement?.closest("#chat-environment-panel"))contentPanelTrigger.current?.focus(); });
      }
  });
  const paletteAction = async (action: PaletteAction) => {
    if (action.type === "theme") { changeMode(theme === "dark" ? "light" : "dark"); return; }
    if (navigationLocked || objectSaveGuard) return;
    if (action.type === "new-chat") {
      if (settingsPath && !closeSettings()) return;
      navigate(action.projectId ?? paletteProjectId, "", action.agentId ?? paletteAgentId); return;
    }
    if (action.type === "stop") {
      if (!confirm(t("确定停止此执行吗？"))) return;
      await api("/conversations/" + encodeURIComponent(action.conversationId) + "/stop", "POST", {}); await refresh(); return;
    }
    if (settingsPath && !closeSettings()) return;
    if (action.type === "model") {
      if (action.conversationId !== selected) return;
      await pickModel(action.model ?? ""); return;
    }
    if (action.type === "terminal") {
      await openConversation(action.conversationId); setWorkspaceTab("terminal"); setEffectiveOpen(true);
    }
  };
  const palette = <CommandPalette open={paletteOpen} config={config} context={{conversation: activeArea === "chat" ? activeChat : null, projectId: paletteProjectId, agentId: paletteAgentId, taskId: location.pathname.match(/^\/tasks\/([^/]+)$/)?.[1], navigationLocked}} onClose={() => setPaletteOpen(false)} onNavigate={openWorkspacePath} onAction={paletteAction} />;
  const pageQuery = new URLSearchParams(location.search);
  // Typing a task search changes the URL, not the page or its unsent drafts.
  if (tasksOpen) pageQuery.delete('q');
  // Selecting or creating a Project/Agent keeps the settings page and its unsaved creation form.
  if (settingsPath) { pageQuery.delete('agent'); pageQuery.delete('project'); }
  const withPalette = (content: React.ReactNode) => <TaskNotifications onOpen={openWorkspacePath}><ComposerDraftIdentity.Provider value={draftIdentity}><PageErrorBoundary key={marketOpen ? "/market" : location.pathname+'?'+pageQuery} onRecover={path=>{setNavigationLocked(false);if(path){history.pushState(null,'',path);dispatchEvent(new PopStateEvent('popstate'));}}}>{content}</PageErrorBoundary>{palette}{mandalaSettingsOpen&&<MandalaSettings onClose={()=>setMandalaSettingsOpen(false)} onSaved={(value,revision)=>{settingsSaved.current=value;configRevision.current=revision;latestDraft.current=structuredClone(value);setConfig(value);setDraft(latestDraft.current);setSettingsRevision(revision);}}/>} {shortcutsOpen && <KeyboardShortcuts onClose={() => setShortcutsOpen(false)}/>}{taskDialog && !tasksOpen && <TaskDialog id={taskDialog} config={config} onNavigate={setTaskDialog} onClose={() => setTaskDialog(null)} onOpenPage={() => { const id = taskDialog; setTaskDialog(null); navigateAssetPage("/tasks/" + encodeURIComponent(id)); }}/>}</ComposerDraftIdentity.Provider></TaskNotifications>;
  const conversationLibrary = <fieldset className="library-loading-boundary" disabled={!configLoaded}><ConversationLibrary chats={chats.filter(c=>c.purpose!=="mandala-main")} projects={config.projects} agents={config.agents} selectedId={activeArea === "chat" ? selected : ""}
    projectId={projectId} search={search} onSearch={setSearch} onOpen={id => { if (!navigationLocked && (!settingsPath || closeSettings())) void openConversation(id, true); }} onArchive={(id, archived) => void archiveChat(id, archived)}
    onReference={chatActive&&!settingsPath&&!navigationLocked&&composerDraft.loaded?addConversationReference:undefined}
    canReference={id=>referenceItems.some(item=>item.kind==='chat'&&item.objectId===id&&selectableReference(item))}
    draft={!selected && text.trim() ? { projectName: project?.name ?? workspaceLabel ?? (directory ? directory.split("/").filter(Boolean).at(-1) ?? directory : t("无工作目录")), agentName: agent?.name ?? (runtimeName(cli)), projectId, agentId } : undefined}
    draftCurrent={activeArea === "chat"} onOpenDraft={() => changeArea("chat")}
    view={libraryView} onView={value => { setLibraryView(value); devicePreferences.setItem("mana-view", value); }}
    sort={librarySort} onSort={value => { setLibrarySort(value); devicePreferences.setItem("mana-sort", value); }} /></fieldset>;
  useEffect(()=>{
    if(selected&&!tasksOpen&&!workbench&&!manaOpen&&!usageOpen&&!assetsOpen&&!marketOpen&&!settingsPath)
      void api('/conversation-progress/'+encodeURIComponent(selected),'POST',{action:'visit'}).catch(()=>{});
  },[selected,tasksOpen,workbench,manaOpen,usageOpen,assetsOpen,marketOpen,settingsPath]);
  // The desktop pet window asks the main window to open the item it points at.
  const petNavigate = useRef(openWorkspacePath); petNavigate.current = openWorkspacePath;
  useDesktopPetBridge(path => petNavigate.current(path));
  const globalNavigation = () => <AppNavigation mandala={{name:config.agents.find(a=>a.id===config.mandala?.agentId)?.name??"Mandala",active:mandalaMain&&activeArea==="chat"}} active={activeArea} disabled={!configLoaded && !initialConfigError || navigationLocked || runtimeSaving || objectSaveGuard} library={conversationLibrary} account={account?{...account,onOpen:()=>{setMobileNav(false);account.onOpen();}}:undefined} modulePins={modulePins} moduleOrder={moduleOrder}
    onOpenPath={openWorkspacePath}
    onStartChat={startChat} />;
  if (!configLoaded) return withPalette(<div className="product-frame"><div className="app-shell">
    <AppSidebar navigation={globalNavigation} open={mobileNav} onClose={() => setMobileNav(false)} />
    <main className="workspace-main"><SidebarToggle onClick={() => setMobileNav(true)} />{initialConfigError ? <><p role="alert">{errorText(initialConfigError)}</p><Button onClick={() => void loadInitialConfig()}>{t("重试")}</Button></> : <LoadingState label={t("正在读取配置…")} />}</main>
  </div></div>);
  if (location.pathname === '/mandala' && !selected) return withPalette(<div className="product-frame"><div className="app-shell"><AppSidebar navigation={globalNavigation} open={mobileNav} onClose={()=>setMobileNav(false)}/><main className="workspace-main"><SidebarToggle onClick={()=>setMobileNav(true)}/>{error?<div role="alert"><p>{errorText(error)}</p><Button onClick={()=>void openMandala()}>{t('重试')}</Button></div>:<LoadingState label={localize('正在打开 Mandala…', 'Opening Mandala…')}/>}</main></div></div>);
  if (settingsPath) {
    const section = settingsSection(settingsPath) ?? "general";
    return withPalette(<div className="product-frame"><SettingsPage onPalette={()=>setPaletteOpen(true)} preferredProjectAgentId={projectAgentChoice(config,settingsProjectId,agentId,rememberedAgents.current)} onNavigationLockChange={setNavigationLocked} navigation={globalNavigation} mobileNav={mobileNav} onMobileNav={setMobileNav}
      section={(["general", "projects", "agents", "runtimes", "runtime", "system", "mcp", "skills", "execution-machines"].includes(section) ? section : "general") as SettingsSection}
      draft={draft} setDraft={setDraft} savedConfig={config} saving={saving} runtimeSaving={runtimeSaving} loading={!configLoaded || !settingsRevision} error={error}
      onRuntimeDirtyChange={dirty => { runtimeDraftDirty.current = dirty; }} onSaveRuntime={saveRuntime} onRuntimeNavigate={path => { if(runtimeSaveInFlight.current) return; if(JSON.stringify(latestDraft.current)!==JSON.stringify(settingsSaved.current))void saveSettings(); const requestedCli=new URLSearchParams(location.search).get('runtime');const previousCli = location.pathname.split('/')[3]==='new'&&runtimeIds.includes(requestedCli as Cli)?requestedCli!:location.pathname.split('/')[3]; history.pushState(null, '', path); setSettingsPath(path); runtimeDraftDirty.current = false; if(path === '/settings/runtimes') requestAnimationFrame(() => (document.querySelector<HTMLButtonElement>('[data-runtime-configure="' + previousCli + '"]') ?? document.querySelector<HTMLButtonElement>('.runtime-connections .primary'))?.focus()); }}
      projectPreparationName={projectPreparationName} onProjectPreparationNameChange={setProjectPreparationName} initialProjectId={settingsProjectId} initialAgentId={isSystemAgent(config,config.agents.find(a=>a.id===settingsAgentId))?'':settingsAgentId} projectSelectionVersion={projectSelectionVersion}
      initialAgentTab={location.pathname.endsWith("/memory") ? "memory" : new URLSearchParams(location.search).get("tab") ?? "profile"}
      onShortcuts={() => setShortcutsOpen(true)} modulePins={modulePins} moduleOrder={moduleOrder} onModulePin={pinModule} onModuleReorder={reorderModule} saveError={saveError} onRetrySave={() => { failedDraft.current = ''; void saveSettings(); }} onReloadSettings={() => void reloadSettings()}
      onOpenPath={openWorkspacePath} onNavigate={(next, objectId = "") => { if(objectSaveGuard || navigationLocked || !confirmRuntimeLeave()) return; navigationVersion.current++; const query = next === "projects" && objectId ? "?project=" + encodeURIComponent(objectId) : next === "agents" && objectId ? "?agent=" + encodeURIComponent(objectId) : ""; history.pushState(null, "", settingsUrl(next) + query); setSettingsProjectId(next === "projects" ? objectId : ""); setSettingsAgentId(next === "agents" ? objectId : ""); setSettingsPath(location.pathname); setMobileNav(false); }} /></div>);
  }
  if (workbench && !workbenchProject) return withPalette(<div className="product-frame"><div className="app-shell"><AppSidebar navigation={globalNavigation} open={mobileNav} onClose={() => setMobileNav(false)}/><main className="workspace-main"><SidebarToggle onClick={() => setMobileNav(true)}/><p role="alert">{localize('此项目不可用，可能已被移除或你无权访问。', 'This project is unavailable. It may have been removed or you may not have access.')}</p><Button onClick={()=>openWorkspacePath('/projects')}>{localize('返回项目', 'Back to Projects')}</Button></main></div></div>);
  if (marketOpen) return withPalette(<div className="product-frame"><MarketPage navigation={globalNavigation} mobileNav={mobileNav} onMobileNav={setMobileNav} onConfigSaved={() => refresh()} onNavigationLockChange={setNavigationLocked} /></div>);
  if (tasksOpen && location.pathname === "/schedules") return withPalette(<div className="product-frame"><SchedulesPage navigation={globalNavigation} mobileNav={mobileNav} onMobileNav={setMobileNav} config={config} onOpenConversation={openConversation} onNavigationLockChange={setNavigationLocked}/></div>);
  if (tasksOpen) return withPalette(<div className="product-frame"><TaskWorkspace navigation={globalNavigation} mobileNav={mobileNav} onMobileNav={setMobileNav} config={config} onOpenConversation={openConversation} onNavigationLockChange={setNavigationLocked}/></div>);
  if (assetsOpen) return withPalette(<div className="product-frame"><AssetLibrary onNavigationLockChange={setNavigationLocked} navigation={globalNavigation} mobileNav={mobileNav} onMobileNav={setMobileNav} config={config} onOpenPath={openWorkspacePath} /></div>);
  if (manaOpen) return withPalette(<div className="product-frame"><ManaWorkspace navigation={globalNavigation} mobileNav={mobileNav} onMobileNav={setMobileNav}
    config={config} conversations={chats} tasks={tasks} onOpenConversation={openConversation} onNavigationLockChange={setNavigationLocked} onOpenPath={openWorkspacePath}
    onManageSkills={() => void openSettings("skills")} onConfigSaved={() => refresh()} onEdit={(kind, id) => void openSettings(kind === "agent" ? "agents" : "projects", kind === "agent" ? id : "", kind === "project" ? id : projectId)} /></div>);
  if (usageOpen) return withPalette(<div className="product-frame"><div className="app-shell"><AppSidebar navigation={globalNavigation} open={mobileNav} onClose={() => setMobileNav(false)} /><main data-page-width="standard" className="workspace-main usage-page"><WorkspacePage width="standard"><PageHeader onMobileNav={()=>setMobileNav(true)} title={localize("用量", "Usage")} icon="usage" actions={<><Select ariaLabel={localize("智能体", "Agent")} value={usageAgentId} onChange={value=>{setUsageAgentId(value);const query=new URLSearchParams(location.search);if(value)query.set("agent",value);else query.delete("agent");history.replaceState(null,"","/usage"+(query.size?"?"+query:""));}} options={[{value:"",label:localize("全部智能体", "All Agents")},...config.agents.map(a=>({value:a.id,label:a.name}))]}/><Select ariaLabel={t("当前项目")} value={usageProjectId} onChange={value => { setUsageProjectId(value); const query = new URLSearchParams(location.search); if (value) query.set("project", value); else query.delete("project"); history.replaceState(null, "", "/usage" + (query.size ? "?" + query : "")); }} options={[{value:"",label:localize("全部项目", "All projects")},...config.projects.map(p=>({value:p.id,label:p.name}))]}/></>}/><div className="usage-content"><UsagePanel config={config} agentId={usageAgentId} projectId={usageProjectId} onOpenPath={openWorkspacePath}/></div></WorkspacePage></main></div></div>);

  if (effectiveOpen && selected && !workbench) readerConversation.current = selected;
  const effectiveQuery = (() => { const query = new URLSearchParams({ projectId, agentId, cli: chat?.cli ?? cli }); query.set("workspaceId", workspace?.id ?? ""); if (!project && directory) query.set("cwd", directory); if (selected) query.set("conversationId", selected); return query.toString(); })();
  // The chat's context glance: in the desktop titlebar beside the panel button, otherwise at the end of the chat bar.
  // A remote workspace's CLI status comes from its machine, so the notice points to that machine rather than local CLI setup.
  const statusMachine = chat?.executionLocation ? { name: chat.executionLocation.machineName } : workspace?.machineId !== undefined ? { name: config.executionMachines?.find(item => item.id === workspace.machineId)?.name ?? localize("执行机器不可用", "Machine unavailable") } : undefined;
  const contextPopover = selected && !workbench && !mandalaMain ? <ConversationContextPopover conversationId={selected} executionLocation={chat?.executionLocation} activityVersion={chat?.updatedAt} running={chat?.status==='running'} capabilitiesQuery={effectiveQuery} loadFiles={loadChatFiles} hasEarlier={earlierBefore !== null} onContent={openContent} onPanel={tab=>{setWorkspaceTab(tab);setEffectiveOpen(true);}} onDocument={doc=>openContent({kind:'asset',assetId:doc.assetId,versionId:doc.versionId,fileId:doc.files?.[0]?.fileId??'',title:doc.title})}/> : null;
  const environmentPanel = cli && <>{!selected && <p className="effective-scope">{agent?.name}{project && <> / {project.name}</>}</p>}<EffectivePanel visible={effectiveOpen && (!selected || !!workbench || workspaceTab === "configuration")} view={selected ? "capabilities" : "all"} projectId={projectId} agentId={agentId} cli={chat?.cli ?? cli} conversationId={selected || undefined} workspaceId={workspace?.id ?? null} cwd={!project ? directory : undefined} references={selected ? referenceItems : undefined} onReference={selected ? addCatalogReference : undefined} /></>;
  return withPalette(
    <ContentPreviewContext.Provider value={selected && !workbench ? openContent : null}><div className="product-frame"><div className="app-shell">
      <AppSidebar navigation={globalNavigation} open={mobileNav} onClose={() => setMobileNav(false)} chat={!workbench} />
      <main className={"workspace-main " + (!manaOpen && !workbench ? "theme-chat-surface " : "") + (selected && !workbench ? "has-content-panel " : "") + (!selected && !manaOpen && !workbench ? "is-new" : "")}
        onDragOver={e => { if (e.dataTransfer.types.includes(referenceDragType)) {e.preventDefault();return;} if (!workbench && !manaOpen && !tasksOpen && !assetsOpen && !marketOpen && e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
        onDrop={e => { if(e.dataTransfer.types.includes(referenceDragType)){e.preventDefault();const item=referenceItems.find(item=>item.id===e.dataTransfer.getData(referenceDragType));if(item)addCatalogReference(item);return;} if (!workbench && !manaOpen && !tasksOpen && !assetsOpen && !marketOpen && e.dataTransfer.types.includes("Files")) { e.preventDefault(); addFiles(Array.from(e.dataTransfer.files)); } }}>
        {!workbench && <header className={"topbar"+(mandalaMain?" mandala-topbar":"")}>
          <SidebarToggle chat={!workbench} onClick={() => setMobileNav(true)} />
          <div className="context">
            {mandalaMain ? <span className="mandala-header-identity"><BrandMark/><strong>{agent?.name??'Mandala'}</strong><Button aria-label={(agent?.name??'Mandala')+(localize(' 设置', ' settings'))} onClick={()=>setMandalaSettingsOpen(true)}><Icon name="settings" size={16}/></Button></span> : manaOpen ? <span className="context-identity"><Icon name="book" size={18} />{t("MANA 工作区")}</span> : <>
            <span className="context-identity">{workbench ? workbenchProject?.name : project?.name ?? t("不关联项目")}</span>
            <span className="context-divider">/</span>
            <span className="context-identity">{selected && !manaOpen && !workbench && agent && <IdentityAvatar identity={agent} kind="agent" size={22} />}<span>{manaOpen ? "MANA" : workbench ? t("工作资源") : selected ? agent?.name ?? (runtimeName(cli)) : t("新对话")}</span></span>
            </>}
          </div>
          {!workbench && !firstUseGuide && <Button
            className="engine"
            aria-label={t("执行端状态")}
            onClick={() => setCliPanel(true)}
          >
            <span
              className={
                "status-dot " +
                (cliStatus?.status === "ready"
                  ? "idle"
                  : cliStatus?.status === "login-required"
                    ? "approval"
                    : cliStatus
                      ? "error"
                      : "")
              }
            />{" "}
            <span>{runtimeName(statusCli)}{runtimePending&&<small className="mandala-runtime-pending">{localize('下轮：', 'Next turn: ')}{activeChat?.cli!==mandalaAgent.defaultCli?runtimeName(mandalaAgent.defaultCli):localize('切换模型', 'model change')}</small>}</span>
          </Button>}
        {!document.getElementById('desktop-titlebar-right')&&contextPopover}</header>}
        {chatActive && <ConversationFind root={messagesRoot} conversationId={selected} version={events} hasEarlier={earlierBefore !== null} onInspect={() => { followLatest.current = false; }} />}
        {!workbench && selected && (()=>{const slot=document.getElementById('desktop-titlebar-right');const button=<Button ref={contentPanelTrigger} type="button" className="content-panel-trigger" hidden={!slot&&effectiveOpen} aria-label={t(effectiveOpen?'收起右侧栏':'展开右侧栏')} title={t(effectiveOpen?'收起右侧栏':'展开右侧栏')} aria-expanded={effectiveOpen} aria-controls="chat-environment-panel" onClick={()=>{setEffectiveOpen(value=>!value);}}><Icon name="panel" size={18}/></Button>;return slot?createPortal(<>{contextPopover}{button}</>,slot):button;})()}

        {workbench && workbenchProject ? <>{(error || refreshError) && <p className="form-error" role="alert">{errorText(error || refreshError)}</p>}
          {saveError&&<div role="alert" className="settings-save-error"><span>{errorText(saveError)}</span><Button onClick={()=>saveError==='configuration changed'?void reloadSettings():(failedDraft.current='',void saveSettings())}>{t(saveError==='configuration changed'?'重新读取配置':'重试自动保存')}</Button></div>}
          <ProjectWorkbench key={workbenchProject.id} onMobileNav={()=>setMobileNav(true)} config={settingsRevision?draft:config} project={workbenchProject} onChange={setDraft}
           preferredAgentId={projectAgentChoice(config,workbenchProject.id,agentId,rememberedAgents.current)} pending={objectSavePending} disabled={!settingsRevision}
           saveStatus={<span className="settings-autosave" role="status" hidden={!saveError&&!saving&&!objectSavePending}>{saveError?t('自动保存失败'):saving?t('保存中…'):objectSavePending?t('等待自动保存'):t('所有修改已保存')}</span>}
           onStartChat={id=>navigate(workbenchProject.id,"",id)} onNavigate={openWorkspacePath}
           onDelete={()=>{setDraft(current=>({...current,projects:current.projects.filter(item=>item.id!==workbenchProject.id)}));history.pushState(null,"","/projects");dispatchEvent(new PopStateEvent("popstate"));}}/>
         </> : <>
        {chat && !mandalaMain && (
          <div className="chat-title-bar">
            {editingTitle ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveTitle();
                }}
              >
                <Input
                  aria-label={t("对话标题")}
                  value={titleDraft}
                  maxLength={80}
                  autoFocus
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Escape") setEditingTitle(false); }}
                />
                <Button type="submit" disabled={!titleDraft.trim()}>
                  {t("保存标题")}
                </Button>
                <Button type="button" onClick={() => setEditingTitle(false)}>
                  {t("取消")}
                </Button>
              </form>
            ) : (
              <>
                <Button
                  className="chat-title-trigger"
                  type="button"
                  aria-label={t("重命名对话")}
                  title={chat.title || t("重命名对话")}
                  onClick={() => {
                    setTitleDraft(chat.title || "");
                    setEditingTitle(true);
                  }}
                >
                  {chat.title || t("新对话")}
                </Button>
                <Button className="chat-config-trigger" type="button" aria-label={t("Fork 对话")} title={t("保留当前上下文，创建新对话")}
                  disabled={busy || branchPending || !historyReady || chat.status !== "idle" || !events.some(event => event.kind === "status" && (event.data as {status?: string}).status === "idle")}
                  onClick={() => void forkReply()}><Icon name="workflow" size={15} /></Button>

              </>
            )}
          </div>
        )}
        {chat?.branchedFrom && <div className="branch-origin"><Icon name="workflow" size={14} /><span>{t("从原对话分支")}</span><Button onClick={() => openConversation(chat.branchedFrom!.conversationId)}>{t("查看原对话")}<Icon name="arrowRight" size={14} /></Button></div>}
        {(error || refreshError) && (
          <div className="error-banner" role="alert">
            <span>{errorText(error || refreshError)}</span>
            <Button onClick={() => { setRefreshError(''); if (approvalPreferenceError) { setError(''); setApprovalPreferenceRevision(value => value + 1); } else setError(''); }} aria-label={approvalPreferenceError ? localize('重试读取审批偏好', 'Retry approval preference') : t("关闭错误")}>
              <Icon name={approvalPreferenceError ? 'refresh' : 'close'} size={18} />
            </Button>
          </div>
        )}
        {!checkingCli && !firstUseGuide && cliStatus && cliStatus.status !== "ready" && (
          <div className="cli-notice">
            <span>
              {statusMachine ? `${runtimeName(statusCli)} · ${cliStatus.status === "login-required" ? localize(`需要在 ${statusMachine.name} 上登录`, `sign in required on ${statusMachine.name}`) : localize(`无法在 ${statusMachine.name} 上连接`, `cannot connect on ${statusMachine.name}`)}`
                : cliStatus.status === "login-required"
                ? <>{runtimeName(statusCli)} · {localize("需要登录：在终端运行 ", "sign in required: run ")}<code>{statusCli && loginCommand(statusCli)}</code></>
                : mandalaMain ? `${runtimeName(statusCli)} · ${localize("这台电脑上没有检测到，Mandala 暂时无法工作", "not found on this computer; Mandala cannot work yet")}`
                : `${runtimeName(statusCli)} · ${t("无法连接")}`}
            </span>
            {mandalaMain && !statusMachine && <Button onClick={() => setMandalaSettingsOpen(true)}>{localize("更换 CLI", "Change CLI")}</Button>}
            {statusMachine ? <Button onClick={() => void openSettings("execution-machines")}>{localize("检查远程机器", "Check remote machine")}</Button> : <Button onClick={() => setCliPanel(true)}>
              {t("查看连接指引")}
            </Button>}
          </div>
        )}
        {connectionLost && <div className="connection-notice" role="status">{t("事件连接中断，正在重连；当前状态可能尚未更新。")}</div>}
        <VerifiedFilesContext.Provider value={verifiedFiles}>
        <div className="conversation-viewport">
        <div
          className="conversation"
          aria-live="polite"
          onScroll={(e) => {
            const element = e.currentTarget;
            followLatest.current =
              element.scrollHeight - element.scrollTop - element.clientHeight <
              80;
            if (earlierBefore !== null && element.scrollTop < 100 && element.scrollTop < lastScrollTop.current && earlierState === 'idle') {
              followLatest.current = false;
              loadEarlier.current?.();
            }
            setAwayFromLatest(!followLatest.current);
            lastScrollTop.current = element.scrollTop;
          }}
        >
          {mandalaMain&&historyReady&&!events.some(event=>event.kind==='user'||event.kind==='text')&&<MandalaWelcome name={agent?.name??'Mandala'} disabled={!composerDraft.loaded||pending||navigationLocked||busy} hasDraft={existingComposerDraft} onPrepare={prompt=>{if(!composerDraft.loaded||existingComposerDraft||pending||navigationLocked||busy)return;setText(prompt);requestAnimationFrame(()=>composerInput.current?.focus());}}/>}
          {firstUseGuide && <GettingStarted config={config} onOpenPath={openWorkspacePath} onStart={finishOnboarding}/>}
          {!selected && !firstUseGuide && <section className="chat-setup" aria-label={t("新对话准备")}>
            {(chats.length > 0 || config.agents.length > 0) && <div className="chat-introduction"><BrandMark /><h1>{t("从一个想法开始")}</h1><p>{t("让每次对话，积累为下一步的上下文。")}</p></div>}
            <>
              <div className="setup-fields">
                <div className="setup-project"><Select ariaLabel={t("当前项目")} value={projectId} placeholder={t("选择项目")} disabled={pending}
                  onChange={value => navigate(value, "", projectAgentChoice(config, value, agentId, rememberedAgents.current))}
                  options={[{ value: "", label: t("不关联项目"), icon: <Icon name="message" size={18} /> }, ...config.projects.filter(p => !p.archivedAt).map(p => ({ value: p.id, label: p.name, icon: <IdentityAvatar identity={p} kind="project" size={18} />, description: p.cwd }))]} /></div>
                <div className="setup-agent">
                  <Select ariaLabel={t("当前 Agent")} compactDescriptions disabled={pending || modeSaving} value={agentId}
                    onChange={value => { setAgentId(value); const nextDefault = config.agents.find(a => a.id === value)?.defaultCli; setCli(nextDefault ?? runtimes[0] ?? ""); setModel(""); setEffort(""); const query = new URLSearchParams({ project: projectId, agent: value }); if (workspaceId !== undefined) query.set("workspace", workspaceId ?? ""); if (directory) query.set("cwd", directory); history.replaceState(null, "", "/?" + query); }}
                    options={[{ value: "", label: t("不使用 Agent"), icon: <Icon name="terminal" size={18} /> }, ...availableAgents.map(item => ({ value: item.id, label: item.name, description: isSystemAgent(config,item) ? (localize('可在任意项目中执行工作', 'Execute work in any Project')) : item.instructions.split("\n").find(line => line.trim()), group: isSystemAgent(config,item) ? (localize('系统智能体', 'System Agent')) : (localize('智能体', 'Agents')), icon: <IdentityAvatar identity={item} kind="agent" size={18} /> }))]} />
                </div>
                <div className="setup-runtime"><Select ariaLabel={t("当前 CLI")} disabled={pending || !runtimes.length} searchable={false} value={cli && runtimes.includes(cli) ? cli : ""}
                  onChange={value => { setCli(value as Cli); setModel(""); setEffort(""); }} placeholder={t("暂无已启用执行端")} options={runtimes.map(value => ({ value, label: runtimeName(value), icon: <RuntimeIcon cli={value} size={18} /> }))} /></div>
                {!runtimes.length && <a href="/settings/runtimes" onClick={e => { e.preventDefault(); void openSettings("runtimes"); }}>{t("启用执行端后开始对话")}</a>}

              </div>
              <Button className="setup-environment" type="button" aria-label={t("上下文与能力")} title={t("环境详情")} onClick={() => { setWorkspaceTab("configuration"); setEffectiveOpen(value => !value); }}><Icon name="settings" size={16} /></Button>
              <div className="setup-workspace">
                {project ? <Select ariaLabel={t("当前目录组")} value={workspace?.id ?? ""} onChange={value => { setWorkspaceId(value || null); setDirectory("");
                  const query = new URLSearchParams({ project: projectId, agent: agentId, workspace: value }); history.replaceState(null, "", "/?" + query); }}
                  options={[{ value: "", label: t("无工作目录"), icon: <Icon name="message" size={16} /> }, ...workspaces.map(w => { const machine = w.machineId === undefined ? undefined : config.executionMachines?.find(item => item.id === w.machineId);
                    const base = w.name === "Default" ? w.cwd : w.name, machineName = machine?.name ?? localize("执行机器不可用", "Machine unavailable");
                    return { value: w.id, label: w.machineId === undefined ? base : `${base} · ${machineName}`, description: w.machineId === undefined ? w.cwd : `${machineName}（${machine?.host ?? "—"}）· ${w.cwd}`, icon: <Icon name={w.machineId === undefined ? "folder" : "server"} size={16} /> }; })]} /> :
                  <Button type="button" onClick={() => setFolderOpen(true)}><Icon name="folder" size={16} />{directory ? directory.split("/").filter(Boolean).at(-1) : t("选择工作目录（可选）")}</Button>}
                {!project && directory && <Button className="icon-button" type="button" aria-label={t("清除工作目录")} onClick={() => { setDirectory(""); const query = new URLSearchParams({project: projectId, agent: agentId}); history.replaceState(null,"","/?"+query); }}><Icon name="close" size={14} /></Button>}
              </div>
            </>
          </section>}
          {selected && !historyReady && <LoadingState label={t('正在读取对话历史…')} />}
          <SelectionQuote conversationId={selected} disabled={quoteDisabled} onQuote={addQuote} />
          <div ref={messagesRoot} className={"messages"+(mandalaMain?" mandala-messages":"")} hidden={!historyReady}>
            {earlierBefore !== null && <div className="chat-earlier-history">
              <Button type="button" variant="ghost" disabled={earlierState === 'loading'} onClick={() => {
                followLatest.current = false;
                loadEarlier.current?.();
              }}>
                {earlierState === 'loading' ? localize('正在加载更早的记录…', 'Loading earlier messages…') : earlierState === 'error'
                  ? localize('加载失败，点击重试', 'Could not load history. Retry') : localize('加载更早的记录', 'Load earlier messages')}
              </Button>
            </div>}
            <ExecutionResults items={resultGroups.get(null)??[]} config={config} tasks={operationTasks.tasks} onOpen={openWorkspacePath}/>
            {presentedTurns.map(({ turn, run, replyText }) => {
              const inspect = () => { followLatest.current = false; setAwayFromLatest(true); };
              const checkpoint = [...turn.events].reverse().find(event => event.kind === "status" && (event.data as {status?: string}).status === "idle");
              const answer = run.answers.at(-1);
              const canFork = !!checkpoint && !run.incomplete && !busy && !branchPending;
              const showReply = turn.messages.some(m=>m.kind!=="agent_message") && turn.events.some(event=>event.kind!=="user");
              const operationCards = <><AgentMessageCards messages={turn.messages.filter(message=>message.agentMessage?.direction!=='reply')} config={config} onOpen={openWorkspacePath}/><MandalaCoordinationCards config={config} events={turn.events} allEvents={events} onOpen={openWorkspacePath}/><OperationResults taskState={operationTasks} events={turn.events} allEvents={events} onOpen={openWorkspacePath}/></>;
              return <section className="chat-turn" key={turn.key} tabIndex={-1} data-run-id={(turn.events.find(event=>(event.data as {runId?:string}).runId)?.data as {runId?:string}|undefined)?.runId}>
            {turn.messages.filter(message => message.kind === "user").map(m => m.source?.kind==='coordination' ? <ExecutionResults key={m.key} items={executionResults.items.filter(item=>m.source?.kind==='coordination'&&m.source.receiptIds.includes(item.id))} config={config} tasks={operationTasks.tasks} onOpen={openWorkspacePath}/> : m.source && m.source.kind!=='telegram' ? <Disclosure key={m.key} className="handoff-input" title={<><Icon name="workflow" size={14}/>{localize('自动后台输入', 'Automatic background input')}</>}><div className="message-text">{m.text}</div></Disclosure> : m.task ? <Disclosure key={m.key} className="handoff-input" title={<> <Icon name="workflow" size={14} />{t(m.task.kind === "return" ? "帮手结果 · 结合原对话整合" : "接收的 Agent 任务")} </>}>

              <div className="message-text">{m.text}</div>
            </Disclosure> : <article key={m.key} className="message user" aria-label={localize('你的消息', 'Your message')} data-message-key={m.key}>
              <div className={"message-avatar" + (userInitial ? " user-initial-avatar" : "")}>{userInitial || <Icon name="user" size={17} />}</div>
              <div className="message-content">
                {m.source?.kind==='telegram'&&<span className="telegram-source">Telegram</span>}
                {!mandalaMain && <div className="message-name">{t("你")}<span className="message-actions">
                {m.text.trim() && <QuoteButton kind="message" text={m.text} disabled={quoteDisabled} onQuote={addQuote} />}
                <Button type="button" aria-label={t("复制消息")} title={t(copiedMessage === m.key ? "已复制" : "复制消息")} data-copied={copiedMessage === m.key || undefined} onClick={() => void copyMessage(m.key, m.text)}><Icon key={"icon-" + copySequence} name={copiedMessage === m.key ? "check" : "copy"} size={14} />{copiedMessage === m.key && <span key={"feedback-" + copySequence} className="copy-feedback" role="status">{t('已复制')}</span>}</Button>
                <Button type="button" aria-label={t("在新对话中使用此请求")} title={t("在新对话中使用此请求")} disabled={pending || branchPending || navigationLocked} onClick={() => void reuseRequest(m)}><Icon name="message" size={14} /></Button>
                {!mandalaMain && <Button type="button" aria-label={t("编辑消息")} disabled={busy || branchPending} title={t(busy ? "执行结束后可编辑消息" : "编辑消息")}
                  onClick={() => setEditingMessage({ eventId: m.key, text: m.text })}><Icon name="edit" size={14} /></Button>}
              </span></div>}
                {editingMessage?.eventId === m.key ? <form className="message-editor" onSubmit={e => { e.preventDefault(); void editMessage(); }}>
                  <Textarea autoFocus aria-label={t("修改消息内容")} value={editingMessage.text} disabled={branchPending}
                    onChange={e => setEditingMessage({ ...editingMessage, text: e.target.value })} onKeyDown={e => { if (e.key === "Escape" && !branchPending) setEditingMessage(null); }} />
                  <p>{t("在当前对话重跑，替换此消息及之后的上下文；已执行的文件和工具操作不会撤销。")}</p>
                  <div><Button type="button" disabled={branchPending} onClick={() => setEditingMessage(null)}>{t("取消")}</Button>
                    <Button className="primary" type="submit" disabled={busy || branchPending || !editingMessage.text.trim()}><Icon name="send" size={15} />{t(branchPending ? "正在重新执行…" : "保存并重新执行")}</Button></div>
                </form> : <div className="message-text markdown-text"><LinkedMessageText text={m.text}/></div>}
                {!!m.referenceItems?.length && <div className="message-references" aria-label={t('已选引用')}>{m.referenceItems.map(item => <span className="composer-reference-tag" key={item.id} title={`${item.source} · ${item.detail}`}>
                  <Icon name={item.kind==='project'?'project':item.kind==='chat'||item.kind==='message'?'message':item.kind === 'agent' ? 'agent' : item.kind === 'skill' ? 'book' : item.kind === 'mcp' ? 'plug' : 'plan'} size={15} /><span>{item.name}</span>{item.kind==='message'&&<q className="composer-message-excerpt">{item.detail}</q>}<span className="composer-reference-source">{item.kind==='chat'?(item.intent==='inquiry'?localize('提问目标','Inquiry target'):localize('对话引用','Conversation reference')):item.source}</span>
                </span>)}</div>}
                {m.attachments?.length ? <div className="message-attachments">{m.attachments.map(item => <AttachmentItem key={item.id} item={item} conversationId={selected} />)}</div> : null}
              </div>
              {mandalaMain && <div className="message-name"><span className="message-actions">
                {m.text.trim() && <QuoteButton kind="message" text={m.text} disabled={quoteDisabled} onQuote={addQuote} />}
                <Button type="button" aria-label={t("复制消息")} title={t(copiedMessage === m.key ? "已复制" : "复制消息")} data-copied={copiedMessage === m.key || undefined} onClick={() => void copyMessage(m.key, m.text)}><Icon key={"icon-" + copySequence} name={copiedMessage === m.key ? "check" : "copy"} size={14} />{copiedMessage === m.key && <span key={"feedback-" + copySequence} className="copy-feedback" role="status">{t('已复制')}</span>}</Button>
                <Button type="button" aria-label={t("在新对话中使用此请求")} title={t("在新对话中使用此请求")} disabled={pending || branchPending || navigationLocked} onClick={() => void reuseRequest(m)}><Icon name="message" size={14} /></Button>
                {!mandalaMain && <Button type="button" aria-label={t("编辑消息")} disabled={busy || branchPending} title={t(busy ? "执行结束后可编辑消息" : "编辑消息")}
                  onClick={() => setEditingMessage({ eventId: m.key, text: m.text })}><Icon name="edit" size={14} /></Button>}
              </span></div>}
            </article>)}
            <AgentMessageCards messages={turn.messages.filter(message=>message.agentMessage?.direction==='reply')} config={config} onOpen={openWorkspacePath}/>
            {showReply ? <section className="agent-reply" aria-label={agent?.name ?? (runtimeName(cli))}>
              {!mandalaMain && <header className="agent-reply-header">
                <div className="message-avatar">{agent ? <IdentityAvatar identity={agent} kind="agent" size={28} /> : <Icon name="agent" size={18} />}</div>
                <div className="message-name">{agent?.name ?? (runtimeName(cli))}</div>
              </header>}
              <TurnProcess turn={turn} run={run} onInspect={inspect} approvals={approvals} renderApproval={renderApprovalRequest} />
              {run.answers.map(m => <article className={"message text"+(mandalaMain?" chat-reply-bubble":"")} key={m.key} data-message-key={m.key}>
                <div className="message-content"><MarkdownMessage text={m.text} streaming={run.status === 'running'} publishedFiles={publishedFilesByRun.get((turn.events.find(event=>event.id===m.key)?.data as {runId?:string})?.runId??'')} /></div>
              </article>)}
              {operationCards}
              <TurnFooter turn={turn} run={run} turns={turns} onInspect={inspect} actions={answer && checkpoint && !run.incomplete ? <>
                <QuoteButton kind="reply" text={replyText} disabled={quoteDisabled} onQuote={addQuote} />
                <Button type="button" aria-label={t("复制消息")} title={t(copiedMessage === answer.key ? "已复制" : "复制消息")} data-copied={copiedMessage === answer.key || undefined} onClick={() => void copyMessage(answer.key, replyText)}><Icon key={"icon-" + copySequence} name={copiedMessage === answer.key ? "check" : "copy"} size={15} />{copiedMessage === answer.key && <span key={"feedback-" + copySequence} className="copy-feedback" role="status">{t('已复制')}</span>}</Button>
                {!mandalaMain && <Button type="button" aria-label="Fork" title={t("从这轮回答继续新对话，不重新执行")} disabled={!canFork} onClick={() => void forkReply(checkpoint.id)}><Icon name="workflow" size={15} /></Button>}
              </> : undefined} />
            </section> : operationCards}
            <ExecutionResults items={resultGroups.get(turn.key)??[]} config={config} tasks={operationTasks.tasks} onOpen={openWorkspacePath}/>
            </section>; })}
            {approvals.filter(approval=>!presentedTurns.some(({turn})=>turn.messages.some(message=>message.kind!=='agent_message')&&turn.events.some(event=>event.kind==='approval'&&(event.data as Approval).id===approval.id))).map(renderApprovalRequest)}
            {executionResults.error&&<p role="alert">{localize('执行结果读取失败。', 'Could not load execution results.')} {executionResults.error} <Button onClick={executionResults.retry}>{t('重试')}</Button></p>}
            <div ref={bottom} />
          </div>
        </div>
        </div>
        </VerifiedFilesContext.Provider>
        {!firstUseGuide&&<footer className="composer-wrap">
          {awayFromLatest && (
            <Button
              className="latest-messages"
              onClick={() => {
                followLatest.current = true;
                setAwayFromLatest(false);
                bottom.current?.scrollIntoView({ block: "end" });
              }}
            >
              <Icon name="arrowDown" size={16} />{t("回到最新消息")}
            </Button>
          )}
          <QueuedMessages inputs={queuedInputs} busy={busy} disabled={pending||stopping||branchPending||navigationLocked||modeSaving||!historyReady} onSend={input=>void sendQueued(input)} onCopy={input => void copyMessage(-1, input.text)} onReuse={input => void reuseRequest({ text: input.text, attachments: input.attachments?.map(id => ({ id })), referenceItems: referenceItems.filter(item => input.references?.some(ref => ref.id === item.id)) })} onCancel={async inputId=>{
            const view=navigationVersion.current;
            queueReads.current.generation++;
            try {await api("/conversations/"+selected+"/queue/"+inputId,"DELETE");if(view===navigationVersion.current){queueReads.current.generation++;setQueuedInputs(items=>items.filter(item=>item.id!==inputId));}}
            catch(e){if(view===navigationVersion.current)setError((e as Error).message);}
          }}/>
          <div className={'composer'+(composerDragOver?' is-composer-drop-target':'')}
            onDragOver={event=>{
              const { types } = event.dataTransfer;
              if (types.includes(quoteDragType) ? quoteDisabled : !types.includes(conversationDragType) || !composerDraft.loaded) return;
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = 'copy';
              setComposerDragOver(true);
            }}
            onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setComposerDragOver(false);}}
            onDrop={event=>{
              const { dataTransfer } = event;
              const type = dataTransfer.types.includes(quoteDragType) ? quoteDragType : conversationDragType;
              if (!dataTransfer.types.includes(type)) return;
              event.preventDefault();
              event.stopPropagation();
              setComposerDragOver(false);
              if (type === quoteDragType) addQuote(dataTransfer.getData(type));
              else addConversationReference(dataTransfer.getData(type));
            }}>
            <ComposerReferences selected={selectedReferences} items={visibleReferences} open={!!referenceQuery}
              conversationItems={referenceItems.filter(item=>item.kind==='chat')} onChangeConversation={changeConversationReference}
              loading={referencesLoading} error={referencesError} onRetry={() => setReferenceReload(value => value + 1)} activeIndex={referenceIndex} onChoose={chooseReference}
              onRemove={id => { setSelectedReferences(items => items.filter(item => item.id !== id)); composerInput.current?.focus(); }} />
            <Input ref={fileInput} type="file" multiple hidden aria-label={t("上传附件")} onChange={e => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
            {files.length > 0 && <div className="composer-attachments">{files.map((file, index) => <AttachmentItem key={index} item={file} disabled={pending || branchPending}
              onChange={async updated => { setFiles(current => current.map((item, i) => i === index ? updated : item)); await composerDraft.flush(); }}
              onRemove={() => { setFiles(current => current.filter((_, i) => i !== index)); composerInput.current?.focus(); }} />)}</div>}
            <Textarea
              ref={composerInput}
              aria-keyshortcuts={shortcutAria('composer')}
              title={shortcutLabel('composer')}
              rows={2}
              aria-label={t("消息")} disabled={!composerDraft.loaded}
              placeholder={
                agent
                  ? t("给 {agent} 分派工作…", { agent: agent.name })
                  : t("描述你希望完成的任务…")
              }
              value={text}
              aria-controls={referenceQuery ? 'composer-reference-menu' : undefined}
              aria-autocomplete="list"
              aria-activedescendant={referenceQuery && visibleReferences[referenceIndex] ? `composer-reference-${referenceIndex}` : undefined}
              onPaste={e => {
                if (pending || branchPending) return;
                const incoming = Array.from(e.clipboardData.files);
                if (incoming.length) { e.preventDefault(); addFiles(incoming); return; }
                const pasted = e.clipboardData.getData('text/plain');
                if (pasted.length > 2000 || pasted.split('\n').length > 20) { e.preventDefault(); addTextAttachment(pasted); }
              }}
              onChange={(e) => { setText(e.target.value); updateReferenceQuery(e.target.value, e.target.selectionStart); }}
              onCompositionStart={() => { composerComposing.current = true; }}
              onCompositionEnd={() => { composerComposing.current = false; }}
              onBlur={() => { composerComposing.current = false; }}
              onClick={e => updateReferenceQuery(e.currentTarget.value, e.currentTarget.selectionStart)}
              onKeyUp={e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) updateReferenceQuery(e.currentTarget.value, e.currentTarget.selectionStart); }}
              onKeyDown={(e) => {
                if (composerComposing.current || composingKey(e.nativeEvent)) return;
                if (referenceQuery) {
                  if (e.key === 'Escape') { e.preventDefault(); setReferenceQuery(null); return; }
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    const direction = e.key === 'ArrowDown' ? 1 : -1, length = visibleReferences.length;
                    for (let offset = 1; offset <= length; offset++) { const index = (referenceIndex + direction * offset + length) % length;
                      if (selectableReference(visibleReferences[index])) { setReferenceIndex(index); break; } }
                    return;
                  }
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const item = visibleReferences[referenceIndex]; if (item) chooseReference(item); return; }
                }
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat
                ) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <ComposerDraftNotice draft={composerDraft} onReselect={()=>fileInput.current?.click()}/>
            {!pending && <ComposerRecovery draft={composerDraft} onResolved={()=>retrySubmissions.current.delete(selected)}/>}
            <span className="composer-status" role="status" data-testid="chat-status" hidden={!pending && (!chat || chat.status === "idle")}>
              {t(pending ? "启动中" : labels[chat?.status ?? "idle"])}
            </span>
            <div className="composer-toolbar">
              <Button type="button" className="attachment-button" aria-label={t("上传附件")} title={t("上传附件")} disabled={pending || branchPending} onClick={() => fileInput.current?.click()}><Icon name="plus" size={18} /></Button>
              {!mandalaMain&&<ComposerSettings summary={modelChoice?.label ?? t('模型')}>
              <Select className="composer-model" ariaLabel={t("模型")} disabled={busy || modeSaving || branchPending} value={selected ? effectiveModel ?? "" : model}
                onChange={value => void pickModel(value || inheritedModel || models.find(item => item.isDefault)?.id || "")}
                options={selected ? [...(chat?.model && !models.some(item => item.id === chat.model) ? [{ value: chat.model, label: chat.model }] : []), ...models.map(item => ({ value: item.id, label: item.label }))] : modelOptions(models, inheritedModel)} />
              <Select className="composer-effort" icon="sparkles" ariaLabel={t("思考强度")} disabled={busy || modeSaving || branchPending || !allowedEfforts.length} searchable={false}
                value={allowedEfforts.includes(currentEffort as ReasoningEffort) ? currentEffort : ""} placeholder={t("思考强度")}
                onChange={value => selected ? void pickModel(effectiveModel!, value as ReasoningEffort) : setEffort(value as ReasoningEffort)}
                options={allowedEfforts.map(value => ({ value, label: t(effortLabels[value]) }))} />
              <Select className="composer-approval" icon="approval" ariaLabel={t("审批模式")} searchable={false}
                disabled={busy || modeSaving || branchPending || approvalPreferenceLoading} value={selected ? chat?.approvalMode ?? "" : approvalOverride}
                onChange={mode => void changeApprovalMode(mode)} options={[
                  { value: "", label: t("继承设置：{mode}", { mode: t(inheritedApprovalMode === "auto" ? "自动批准" : inheritedApprovalMode === "strict" ? "严格审批" : "按需审批") }) },
                  { value: "default", label: t("按需审批"), description: t("日常读写减少审批；命令和额外权限按执行端规则确认。") },
                  { value: "strict", label: t("严格审批"), description: t("使用更严格的原生规则，暂停平台对话授权。") },
                  { value: "auto", label: t("自动批准"), description: t("自动批准工具操作，不扩大文件和网络访问范围。") },
                ]} />
              </ComposerSettings>}
              <VoiceInput key={JSON.stringify([draftIdentity,selected,projectId,agentId])} disabled={!composerDraft.loaded||pending||stopping||branchPending||!!composerDraft.pending} onBusyChange={setVoiceBusy} onText={value=>{setText(current=>appendVoiceText(current,value));composerInput.current?.focus();}}/>
              <ComposerActions recovering={!!composerDraft.pending} busy={busy} waiting={waitingForMessages||waitingForTasks} stopping={stopping} stopDisabled={!chat || stopping || pending}
                disabled={voiceBusy || !composerDraft.loaded || !!(composerDraft.value.missingAttachments.length && !composerDraft.pending) || !configLoaded || !!selected && (chat?.id !== selected || !historyReady) || (!text.trim() && !files.length && !selectedReferences.length && !composerDraft.pending) || pending || stopping || modeSaving || branchPending || approvalPreferenceLoading || approvalPreferenceError || (!selected && (!cli || !runtimes.includes(cli)))}
                continuing={chat?.status === 'interrupted' || chat?.status === 'error'} onStop={() => void control('stop',{expectedExecutionId:executionId,continueQueued:busy})} onSend={() => void send()} onInterrupt={() => void send(true)} />
            </div>
          </div>
        </footer>}
        </>}
      </main>
      <WorkspaceInspector returnFocusRef={selected && !workbench ? contentPanelTrigger : undefined} compact={!!selected && !workbench} id="chat-environment-panel" title={t(selected && !workbench ? "右侧栏" : "上下文与能力")} className={selected && !workbench ? "chat-workspace-inspector" : ""} preserveContent={!!selected && !workbench} resizable={!!selected && !workbench} open={effectiveOpen} onClose={()=>setEffectiveOpen(false)}>
        {mandalaMain ? <MandalaPanels conversationId={selected} config={config} onCatalogRefresh={refreshReferenceCatalog} references={referenceItems} onReference={addCatalogReference} onOpen={openWorkspacePath} visible={effectiveOpen}/> : selected && !workbench ? chat && readerConversation.current === selected && <ConversationWorkspace key={selected} conversationId={selected} projectId={projectId} activityVersion={chat?.updatedAt} config={config} theme={theme} configuration={environmentPanel} contextSources={<><p className="effective-scope">{project?.name ?? t("不关联项目")} / {agent?.name ?? runtimeName(chat?.cli ?? cli)}</p><EffectivePanel visible={effectiveOpen && workspaceTab === "configuration"} view="sources" projectId={projectId} agentId={agentId} cli={chat!.cli} conversationId={selected} workspaceId={workspace?.id ?? null} cwd={!project ? directory : undefined}/></> } onCloseTerminal={() => { setEffectiveOpen(false); requestAnimationFrame(() => { if(document.activeElement===document.body||document.activeElement?.closest("#chat-environment-panel"))contentPanelTrigger.current?.focus(); }); }} onReference={addReference} initialTab={workspaceTab} onTabChange={setWorkspaceTab} requestedContent={contentRequest?.conversationId === selected ? contentRequest.target : null} /> : environmentPanel}
      </WorkspaceInspector>
      {folderOpen && <FolderPicker initialPath={directory} purpose="conversation" onClose={() => setFolderOpen(false)} onSelect={path => { setDirectory(path); setWorkspaceId(null); setFolderOpen(false); const query = new URLSearchParams({project: projectId, agent: agentId, cwd: path}); history.replaceState(null, "", "/?" + query); }} />}
      {agentDetail && (() => {
        const item = config.agents.find((a) => a.id === agentDetail);
        return item ? <Dialog label={t("Agent 详情")} onClose={() => setAgentDetail("")}>
          <div className="settings-header"><div><p className="eyebrow">{t("智能体")}</p><h2>{item.name}</h2></div>
            <Button className="icon-button" aria-label={t("关闭 Agent 详情")} onClick={() => setAgentDetail("")}><Icon name="close" size={18} /></Button></div>
          <div className="settings-scroll">
            <dl className="agent-identity-facts"><div><dt>{t("默认执行端")}</dt><dd><RuntimeIcon cli={item.defaultCli} size={22}/>{runtimeName(item.defaultCli)}</dd></div><div><dt>{t("默认模型")}</dt><dd>{item.models[item.defaultCli] || t("原生默认模型")}</dd></div></dl>
            <p><strong>{t("已关联项目")}</strong> · {config.projects.filter((p) => p.agentIds.includes(item.id)).map((p) => p.name).join(" · ") || "—"}</p>
            <p><strong>{t("Agent 指令")}</strong></p><div className="agent-instructions"><MarkdownMessage text={item.instructions || "—"} /></div>
            <p><strong>MCP</strong> · {linkedCapabilities(config, item).mcp.map((m) => m.name).join(" · ") || "—"}</p>
            <p><strong>Skills</strong> · {linkedCapabilities(config, item).skills.map((s) => s.name).join(" · ") || "—"}</p>
            <p className="field-hint">{t("配置来源：Agent 层；Project 层可覆盖同名能力。")}</p>
          </div>
          <div className="settings-footer"><Button className="primary" disabled={!(workbench?workbenchProject:project)?.agentIds.includes(item.id)} onClick={() => { setAgentDetail(""); navigate(workbench?workbenchProjectId:projectId, "", item.id); }}>{t("开始对话")}</Button><Button onClick={() => { setAgentDetail(""); void openSettings("agents", item.id, workbench ? workbenchProjectId : projectId); }}>
            {t("编辑 Agent")}</Button></div>
        </Dialog> : null;
      })()}
      {cliPanel && statusCli && (
        <Dialog
          label={t("执行端状态")}
          className="cli-panel"
          onClose={() => setCliPanel(false)}
        >
          <div className="settings-header">
            <div>
              <p className="eyebrow">{t("执行端")}</p>
              <h2>{runtimeName(statusCli)}</h2>
            </div>
            <Button
              className="icon-button"
              aria-label={t("关闭执行端状态")}
              onClick={() => setCliPanel(false)}
            >
              <Icon name="close" size={18} />
            </Button>
          </div>
          <div className="cli-panel-content">
            <h3>
              {checkingCli
                ? t("检测中…")
                : cliStatus?.status === "ready"
                  ? t("已连接")
                  : cliStatus?.status === "login-required"
                    ? t("需要登录")
                    : t("无法连接")}
            </h3>
            {cliStatus?.version && (
              <p>{t("版本 {version}", { version: cliStatus.version })}</p>
            )}
            {cliStatus?.status === "login-required" ? (
              <>
                <p>{statusCli !== "omp" && statusCli !== "codex" ? (localize("请先在本机 CLI 登录，再重新检测。", "Sign in using the native CLI, then retry.")) : statusCli === "omp" ? t("在本机终端启动 OMP 并登录，然后重新检测。") :
                  t("在本机终端登录 Codex，然后重新检测。")}</p>
                <pre>{statusCli === "codex" ? "codex login" : statusCli === "claude" ? "claude" : runtimeCatalog[statusCli].command}</pre>
              </>
            ) : cliStatus?.status === "unavailable" ? (
              <p>
                {t(
                  statusCli !== "omp" && statusCli !== "codex" ? "请检查 CLI 是否已安装" : statusCli === "omp" ? "请检查 OMP 是否已安装，以及本机 CLI 配置。完成后重新检测。" :
                    "请检查 Codex 是否已安装，以及本机 CLI 配置。完成后重新检测。",
                )}
              </p>
            ) : (
              <p>{statusCli !== "omp" && statusCli !== "codex" ? t("连接状态表示 CLI 可启动；模型权限与余额在实际请求时验证。") : statusCli === "omp" ? t("已连接仅表示 OMP 可启动；模型授权在实际请求时验证。") :
                t("认证、工具与权限继续使用 CLI 原生设置。")}</p>
            )}
            <a
              href={runtimeCatalog[statusCli].docs}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("安装与登录指引")} <Icon name="external-link" size={14} />
            </a>
          </div>
          <div className="settings-footer">
            <span>{t("检测不会启动对话。")}</span>
            <Button
              disabled={checkingCli}
              onClick={() => setCliCheck((n) => n + 1)}
            >
              {t("重新检测")}
            </Button>
          </div>
        </Dialog>
      )}

    </div></div></ContentPreviewContext.Provider>
  );
}
