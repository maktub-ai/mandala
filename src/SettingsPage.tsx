import {isSystemAgent} from '../shared/chat-context';
import {ObjectHeader,ObjectGroup,ObjectIdentityFields} from './ObjectExperience';
import ProjectNavigation from './ProjectNavigation';
import DesktopCliSettings from './DesktopCliSettings';
import DesktopUpdateSettings from './DesktopUpdateSettings';
import VoiceSettings from './VoiceSettings';
import ExecutionMachinesSettings from './ExecutionMachinesSettings';
import { PageHeader, DetailSection } from './ui/WorkspacePage';
import AgentOverview from './AgentOverview';
import AgentSettings from './AgentSettings';
import WorkspaceDirectory from './WorkspaceDirectory';
import IdentityAvatar from './IdentityAvatar';
import { responseStyles, responseStyleLabels, responseStyleDescriptions, effectiveResponseStyle, type ResponseStyle } from "../shared/response-style";
import {shortcutLabel} from './shortcuts';
import SegmentedControl from './ui/SegmentedControl';
import Tabs, { TabPanel } from './ui/Tabs';
import Field from './ui/Field';
import Notice from './ui/Notice';
import EmptyState from './ui/EmptyState';
import Button from './ui/Button';
import Input from './ui/Input';
import Textarea from './ui/Textarea';
import ThemeSettings from "./ThemeSettings";
import LoadingState from './ui/LoadingState';
import Disclosure from './ui/Disclosure';
import React, { useEffect, useRef, useState } from "react";
import type { Agent, Cli, Config, ModelChoice, Project, RuntimeConfig } from "../shared/types";
import AppSidebar, { SidebarToggle, type SidebarNavigation } from "./AppSidebar";
import ProjectWorkspaces from "./ProjectWorkspaces";
import CapabilityCatalog from "./CapabilityCatalog";
import SkillLibrary from "./SkillLibrary";
import CapabilityLinks from "./CapabilityLinks";
import NativeSkillsPanel from "./NativeSkillsPanel";
import RuntimeConfiguration from "./RuntimeConfiguration";
import RuntimeIcon from "./ui/RuntimeIcon";
import RuntimeConnections from "./RuntimeConnections";
import ModelCatalogPicker from "./ModelCatalogPicker";
import { enabledRuntimes, runtimeLabel, runtimeIds, supportsSystemTasks } from "../shared/runtimes";
import { api } from "./api";
import Icon from "./ui/Icon";
import Select from "./ui/Select";
import "./settings.css";
import "./compact-settings.css";
import SettingsObjectBrowser, { DirectoryLink } from "./SettingsObjectBrowser";
import "./object-settings.css";
import { orderedSidebarItems, modulePinned, type ModulePins } from "./sidebar-modules";
import { useLanguage } from "./i18n";

export type SettingsSection = "general" | "execution-machines" | "projects" | "agents" | "runtime" | "runtimes" | "system" | "mcp" | "skills";
type Section = SettingsSection;
export const settingsUrl = (section: Section) => section === "agents" || section === "runtime" ? "/agents" : section === "projects" ? "/projects" : section === "skills" ? "/mana/skills" : `/settings/${section}`;
export const settingsSection = (path: string): Section | null => path === "/agents" || /^\/agents\/[^/]+(?:\/memory)?$/.test(path) ? "agents" : path === "/projects" || path === "/projects/manage" || /^\/projects\/[^/]+\/settings$/.test(path) ? "projects" : path === "/mana/skills" ? "skills" : path.startsWith("/settings/") ? path.split("/")[2] as Section : null;
const freshId = () => crypto.randomUUID();

export default function SettingsPage({ navigation, mobileNav, onMobileNav, section: requestedSection, draft, setDraft, projectPreparationName, onProjectPreparationNameChange, savedConfig, saving, runtimeSaving = false, loading = false, error, initialProjectId, initialAgentId, initialAgentTab = "profile", preferredProjectAgentId = "", projectSelectionVersion, modulePins, moduleOrder, onModulePin, onModuleReorder, saveError = "", onRetrySave, onReloadSettings, onNavigate, onOpenPath, onRuntimeNavigate, onSaveRuntime, onRuntimeDirtyChange, onShortcuts, onPalette, onNavigationLockChange }: {
  onNavigationLockChange: (locked: boolean) => void;
  onShortcuts: () => void;
  onPalette: () => void;
  onRuntimeDirtyChange: (dirty: boolean) => void;
  runtimeSaving?: boolean;
  onRuntimeNavigate: (path: string) => void;
  onSaveRuntime: (cli: Cli, value: RuntimeConfig, enabled: boolean, chatDefaults: Config['chatDefaults']) => Promise<void>;
  navigation?: SidebarNavigation;
  mobileNav: boolean; onMobileNav: (open: boolean) => void;
  section: Section;
  draft: Config;
  setDraft: React.Dispatch<React.SetStateAction<Config>>;
  projectPreparationName: string;
  onProjectPreparationNameChange: (name: string) => void;
  models?: ModelChoice[];
  savedConfig?: Config;
  saving: boolean;
  loading?: boolean;
  error: string;
  initialProjectId: string;
  initialAgentId: string;
  initialAgentTab?: string;
  preferredProjectAgentId?: string;
  projectSelectionVersion: number;
  modulePins: ModulePins;
  moduleOrder: string[];
  onModuleReorder: (id: string, offset: number) => void;
  onModulePin: (id: string, pinned: boolean) => void;
  saveError?: string; onRetrySave: () => void; onReloadSettings: () => void;
  onNavigate: (section: Section, objectId?: string) => void;
  onOpenPath: (path: string) => void;
}) {
  const section = requestedSection === "agents" && initialProjectId && !initialAgentId ? "projects" : requestedSection;
  const {text: localize,  t, language, setLanguage, languages, errorText } = useLanguage();
  const [desktopCliBusy,setDesktopCliBusy]=useState(false);
  useEffect(()=>{if(section!=='general')return;onNavigationLockChange(desktopCliBusy);return()=>onNavigationLockChange(false);},[desktopCliBusy,onNavigationLockChange,section]);
  const locked = loading || runtimeSaving || desktopCliBusy;
  const [projectId, setProjectId] = useState(initialProjectId);
  const [agentId, setAgentId] = useState(initialAgentId);
  const [agentTab, setAgentTab] = useState<string>(["profile", "settings", "capabilities", "execution", "knowledge"].includes(initialAgentTab) ? initialAgentTab : "profile");
  useEffect(() => { setAgentTab(["profile", "settings", "capabilities", "execution", "knowledge"].includes(initialAgentTab) ? initialAgentTab : "profile"); }, [initialAgentTab, initialAgentId]);
  const [projectTab, setProjectTab] = useState(["background", "resources", "capabilities"].includes(new URLSearchParams(location.search).get("tab") ?? "") ? new URLSearchParams(location.search).get("tab")! : "background");
  const changeObjectTab = (value: string, setTab: (value: string) => void) => {
    const query = new URLSearchParams(location.search); query.set("tab", value);
    history.replaceState(null, "", location.pathname + "?" + query); setTab(value);
  };
  const [creatingProject, setCreatingProject] = useState(false);
  const requestedProjectTab = new URLSearchParams(location.search).get('tab') ?? 'background';
  useEffect(() => { if(section === 'projects' && !creatingProject) setProjectTab(['background','resources','capabilities'].includes(requestedProjectTab)?requestedProjectTab:'background'); }, [section,requestedProjectTab,creatingProject]);
  const projectName = projectPreparationName, setProjectName = onProjectPreparationNameChange;
  const [projectNameError, setProjectNameError] = useState("");
  const projectNameInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (creatingProject && !mobileNav) projectNameInput.current?.focus(); }, [creatingProject, mobileNav]);
  const [migrationAgentId, setMigrationAgentId] = useState("");
  useEffect(() => { if (section === "runtime") setAgentTab("execution"); }, [section]);
  const [objectSearch, setObjectSearch] = useState("");
  useEffect(() => { setAgentId(initialAgentId); }, [initialAgentId]);
  useEffect(() => { setProjectId(initialProjectId); setProjectTab(["background", "resources", "capabilities"].includes(new URLSearchParams(location.search).get("tab") ?? "") ? new URLSearchParams(location.search).get("tab")! : "background"); if (initialProjectId) setCreatingProject(false); }, [initialProjectId, projectSelectionVersion]);

  const baseline = useRef(draft);
  const saved = savedConfig ?? baseline.current;
  const [agentPreparation,setAgentPreparation]=useState<{id:string;name:string;cli:Cli|''}|null>(null);
  const creatingAgent=section==='agents'&&!!agentPreparation&&initialAgentId===agentPreparation.id;
  const project = draft.projects.find((p) => p.id === projectId);
  const agent = draft.agents.find((a) => a.id === agentId);
  const patchProject = (id: string, patch: Partial<Project>) => setDraft((d) => ({
    ...d, projects: d.projects.map((p) => p.id === id ? { ...p, ...patch } : p),
  }));
  const patchAgent = (id: string, patch: Partial<Agent>) => setDraft((d) => ({
    ...d, agents: d.agents.map((a) => a.id === id ? { ...a, ...patch } : a),
  }));
  const addProject = () => {
    onNavigate("projects"); setCreatingProject(true); setProjectNameError(""); setObjectSearch("");
  };
  const createProject = () => {
    if (!projectName.trim()) { setProjectNameError("项目名称不能为空"); return; }
    const id = freshId();
    setDraft((d) => ({ ...d, projects: [...d.projects,
      { id, name: projectName.trim(), cwd: "", agentIds: [], resources: [], mcp: [], skills: [] }] }));
    setProjectId(id); setProjectTab("background"); setCreatingProject(false); setProjectName(""); setObjectSearch(""); onNavigate("projects", id); history.replaceState(null,"","/projects/manage?project="+encodeURIComponent(id)+"&tab=background");
  };
  const removeProject = () => {
    if (!project) return;
    setDraft(d => ({ ...d, projects: d.projects.filter(item => item.id !== project.id) }));
    const next = draft.projects.find(item => item.id !== project.id)?.id ?? "";
    setProjectId(next); onNavigate("projects", next);
    setProjectTab("background"); setObjectSearch("");
  };
  const addAgent = () => {
    const requested=new URLSearchParams(location.search).get('runtime'),cli=enabledRuntimes(draft).find(item=>item===requested)??'';const id=freshId();setAgentPreparation({id,name:'',cli});setAgentId(id);onNavigate('agents',id);
  };
  useEffect(()=>{if(section==='agents'&&!loading&&!agentPreparation&&new URLSearchParams(location.search).get('new')==='1')addAgent();},[section,loading,location.search]);
  const createAgent = () => {
    if(!agentPreparation?.name.trim()||!agentPreparation.cli||!enabledRuntimes(draft).includes(agentPreparation.cli))return;
    const agent:Agent={id:agentPreparation.id,name:agentPreparation.name.trim(),instructions:'',defaultCli:agentPreparation.cli,models:{},mcp:[],skills:[]};
    setDraft(d=>({...d,agents:[...d.agents,agent]}));setAgentPreparation(null);
  };
  const cancelAgentCreation = () => {
    setAgentPreparation(null);setAgentId('');onNavigate('agents','');
  };
  const removeAgent = () => {
    if (!agent) return;
    setDraft((d) => ({ ...d, agents: d.agents.filter((a) => a.id !== agent.id),
      projects: d.projects.map((p) => ({ ...p, agentIds: p.agentIds.filter((id) => id !== agent.id) })) }));
    const next = draft.agents.find(item => item.id !== agent.id)?.id ?? "";
    setAgentId(next); onNavigate("agents", next);
  };
  const relatedProjects = draft.projects.filter((p) => agent && p.agentIds.includes(agent.id));
  const runtimes = enabledRuntimes(draft);
  const [catalogRefresh, refreshCatalog] = useState(0);
  const [catalogs, setCatalogs] = useState(() => Object.fromEntries(runtimeIds.map(cli=>[cli,{choices:[],loading:false,error:""}])) as unknown as Record<Cli,{choices:ModelChoice[];loading:boolean;error:string}>);
  useEffect(() => {
    if (loading || !["agents", "runtime", "system"].includes(section)) return;
    let active = true;
    const requestedRuntimes = [...new Set([...enabledRuntimes(saved), ...((section === "agents" || section === "runtime") && agent ? [agent.defaultCli] : [])])];
    setCatalogs(Object.fromEntries(runtimeIds.map(cli => [cli, {choices: [], loading: requestedRuntimes.includes(cli), error: ""}])) as unknown as typeof catalogs);
    for (const cli of requestedRuntimes) {
      api<ModelChoice[]>((section === "agents" || section === "runtime") && saved.agents.some(item => item.id === agent?.id) ? "/models?cli=" + cli + "&agentId=" + encodeURIComponent(agent!.id) : "/models?scope=" + (section === "system" ? "system" : "runtime") + "&cli=" + cli)
        .then((choices) => { if (active) setCatalogs((c) => ({ ...c, [cli]: { choices, loading: false, error: "" } })); })
        .catch((e: Error) => { if (active) setCatalogs((c) => ({ ...c, [cli]: { choices: [], loading: false, error: e.message } })); });
    }
    return () => { active = false; };
  }, [loading, section, agent?.id, JSON.stringify([saved.runtimes, saved.runtimeDefaults, saved.agents.find(a => a.id === agent?.id)?.id, saved.agents.find(a => a.id === agent?.id)?.runtime, agent?.defaultCli]), catalogRefresh]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const objectSection = ['projects', 'agents', 'runtime'].includes(section);
  const teamSection = objectSection;
  const objectKind = section === 'projects' ? 'project' : 'agent';
  const selectedObject = objectKind === 'project' ? project : agent;
  const objectPending=saving||dirty||!!saveError;
  const [chatChoice,setChatChoice]=useState<{objectId:string;value:string}|null>(null);
  const chatProject=agent && chatChoice?.objectId===agent.id && (chatChoice.value===''||draft.projects.some(p=>p.id===chatChoice.value&&p.agentIds.includes(agent.id)))?chatChoice.value:agent&&draft.projects.some(p=>p.id===initialProjectId&&p.agentIds.includes(agent.id))?initialProjectId:relatedProjects.length===1?relatedProjects[0].id:'';
  const chatCandidate=chatChoice?.objectId===project?.id?chatChoice?.value:preferredProjectAgentId;
  const chatAgent=project&&chatCandidate&&(project.agentIds.includes(chatCandidate)||isSystemAgent(draft,draft.agents.find(a=>a.id===chatCandidate)))&&draft.agents.some(a=>a.id===chatCandidate&&!a.temporary)?chatCandidate:'';

  const [projectSearch, setProjectSearch] = useState('');
  const directoryProject = draft.projects.find(p => p.id === initialProjectId);
  const showDirectory = objectSection && !creatingAgent && !(section === 'projects' && creatingProject) && !selectedObject;
  const directoryUrl = objectKind === 'project' ? '/projects' : '/agents';
  const moduleDrag = useRef<string | null>(null);
  const main = useRef<HTMLElement>(null);
  const directoryScroll = useRef(0);
  useEffect(() => { if (main.current) { main.current.scrollTop = showDirectory ? directoryScroll.current : 0; if (showDirectory && !loading && !initialAgentId && !initialProjectId) main.current.focus({preventScroll:true}); } }, [showDirectory, section]);
  const patchSystem = (patch: Partial<NonNullable<Config["system"]>>) => setDraft((d) => ({ ...d, system: { ...d.system, ...patch } }));

  const saveStatus=<div className="settings-autosave" role="status" hidden={!loading && !saveError && !saving && !dirty}><Icon name={saveError?'error':saving||loading||dirty?'refresh':'circleCheck'} size={15}/>{loading?t('正在读取配置…'):saveError?(t(saveError==='configuration changed'?'配置已在其他地方更新，当前修改尚未保存':'自动保存失败')):saving?t('保存中…'):dirty?t('等待自动保存'):t('所有修改已保存')}</div>;
  return <div className={"settings-page app-shell"+(!objectSection?" settings-compact":"")}>
    <AppSidebar navigation={navigation} open={mobileNav} onClose={() => onMobileNav(false)} />
    <main data-page-width={showDirectory?"standard":"compact"} ref={main} tabIndex={-1} className={"settings-main module-page"+(objectSection&&selectedObject&&!creatingProject&&!creatingAgent?" object-experience":"")} onScroll={event => { if (showDirectory) directoryScroll.current = event.currentTarget.scrollTop; }}>
      {objectSection&&!showDirectory&&<header className="settings-page-header"><SidebarToggle onClick={()=>onMobileNav(true)}/>{saveStatus}</header>}
      {loading && <LoadingState label={t("正在读取配置…")}/> }
      {saveError && <div className="settings-save-error" role="alert"><div><strong>{errorText(saveError)}</strong>{saveError === 'configuration changed' && <p>{t('请先重新读取最新配置，再核对修改。当前输入仍保留，重新读取将替换未保存的输入。')}</p>}</div>{saveError === 'configuration changed' ? <Button onClick={onReloadSettings}>{t("重新读取配置")}</Button> : <Button onClick={onRetrySave}>{t("重试自动保存")}</Button>}</div>}
      <div data-page-width={showDirectory?"standard":"compact"} data-page-canvas className={teamSection ? `object-settings-layout object-directory-layout${showDirectory ? "" : " has-detail"}${objectSection ? " independent-directory" : ""}` : "settings-compact-layout"}>
      {!objectSection&&<PageHeader title={t('设置')} icon="settings" onMobileNav={()=>onMobileNav(true)} actions={saveStatus}/>}
      <div className="object-settings-sidebar">{teamSection && !objectSection && <SettingsObjectBrowser config={draft} projectId={objectSection ? directoryProject?.id ?? '' : ''} agentId={objectSection && objectKind === 'agent' ? agent?.id ?? '' : ''} projectTab={section === 'projects' && !creatingProject ? projectTab : undefined} disabled={locked} query={projectSearch} onQuery={setProjectSearch} onNavigate={onOpenPath} onCreate={addProject} onCreateAgent={addAgent} loading={loading}/>}{!teamSection && <nav className="content-navigation" aria-label={t("设置与连接")}>{([["通用设置","/settings/general"],["执行端接入","/settings/runtimes"],["远程机器","/settings/execution-machines"],["MCP 连接","/settings/mcp"],["Skills","/mana/skills"],["系统任务","/settings/system"]] as const).map(([label,path])=><a key={path} href={path} aria-current={location.pathname===path||path==='/settings/runtimes'&&location.pathname.startsWith(path+'/')?'page':undefined} aria-disabled={locked||undefined} onClick={event=>{if(event.button||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();if(!locked)onOpenPath(path);}}>{label==='远程机器'?localize('远程机器','Remote machines'):label==='Skills'?label:label==='执行端接入'&&language !== 'zh-CN'?'CLI adapters':t(label)}</a>)}</nav>}</div>
      <div className="object-settings-content">

      {!loading && ((section === 'agents' && initialAgentId && !agent && !creatingAgent) || (section === 'projects' && initialProjectId && !project)) && <Notice>{localize('此项目或智能体不可用，可能已被移除或你无权访问。', 'This item is unavailable. It may have been removed or you may not have access.')}</Notice>}
      {showDirectory && <WorkspaceDirectory status={saveStatus} onMobileNav={()=>onMobileNav(true)} kind={section === 'projects' ? 'projects' : 'agents'} config={draft} disabled={locked} loading={loading} query={objectSearch} onQuery={setObjectSearch} onNavigate={onOpenPath} onCreate={section === 'projects' ? addProject : addAgent}/>}
      {objectSection && !showDirectory && !selectedObject && <DirectoryLink className="directory-back" href={directoryUrl} disabled={locked} onNavigate={path => { setCreatingProject(false); onOpenPath(path); }}><Icon name="arrowLeft" size={16}/>{localize((objectKind === 'project' ? '返回项目' : '返回智能体'), (objectKind === 'project' ? 'Back to Projects' : 'Back to Agents'))}</DirectoryLink>}
      {objectSection && selectedObject && !creatingProject && !creatingAgent && <ObjectHeader key={selectedObject.id} kind={objectKind} object={selectedObject} config={draft} disabled={locked} pending={objectPending} onNavigate={onOpenPath} onChange={patch=>objectKind==='project'?patchProject(selectedObject.id,patch):patchAgent(selectedObject.id,patch)} onDelete={objectKind==='project'?removeProject:removeAgent}>
        <Select ariaLabel={objectKind==='project'?(localize('选择对话智能体', 'Start with Agent')):(localize('对话所属项目', 'Chat project'))} disabled={locked||objectPending} value={objectKind==='project'?chatAgent:chatProject} onChange={value=>setChatChoice({objectId:selectedObject.id,value})} options={objectKind==='project'?[{value:'',label:localize('直接对话', 'Direct chat')},...draft.agents.filter(a=>!a.temporary&&(isSystemAgent(draft,a)||!a.systemRole&&project?.agentIds.includes(a.id))).map(a=>({value:a.id,label:a.name,group:isSystemAgent(draft,a)?(localize('系统智能体', 'System Agent')):(localize('智能体', 'Agents')),icon:<IdentityAvatar identity={a} kind="agent" size={20}/>}))]:[{value:'',label:localize('不关联项目', 'No project')},...relatedProjects.map(p=>({value:p.id,label:p.name,icon:<IdentityAvatar identity={p} kind="project" size={20}/>}))]}/>
        <Button className="primary" disabled={locked||objectPending} onClick={()=>onOpenPath('/?'+new URLSearchParams({project:objectKind==='project'?selectedObject.id:chatProject,agent:objectKind==='agent'?selectedObject.id:chatAgent}))}>{t('开始对话')}</Button>
      </ObjectHeader>}
      {error && <Notice className="form-error">{errorText(error)}</Notice>}


      <fieldset className={"settings-page-body"+(section==="general"?" general-settings-body":"")} disabled={locked} style={loading || showDirectory ? {display:"none"}:undefined}>
        {section === "general" && <section className="settings-card general-settings" aria-label={t("通用设置")}>
          <h2>{t("语言")}</h2><div className="settings-form-row"><span>{localize("界面语言", "Interface language")}</span><Select ariaLabel="Language / 语言" value={language} onChange={value => { setLanguage(value); if (value === 'en' || value === 'zh-CN') patchSystem({ memory: { ...draft.system?.memory, language: value } }); }} options={languages}/></div>
        </section>}
        {section === "execution-machines" && !loading && <ExecutionMachinesSettings config={draft} disabled={locked} onChange={executionMachines=>setDraft(value=>({...value,executionMachines}))} onOpenPath={onOpenPath}/>}
        {section === "general" && <ThemeSettings/>}
        {section === "general" && <VoiceSettings/>}
        {section === "general" && <DesktopCliSettings onBusyChange={setDesktopCliBusy}/>}
        {section === "general" && <DesktopUpdateSettings/>}
        {section === "general" && <DetailSection title={localize('快捷键', 'Keyboard shortcuts')}><p className="field-hint">{localize('查看对话和导航的快捷键。', 'View shortcuts for chats and navigation.')}</p><div className="settings-keyboard-actions"><Button type="button" onClick={onPalette}>{localize('打开命令面板', 'Open command palette')}<kbd className="shortcut-key" aria-hidden="true">{shortcutLabel('palette')}</kbd></Button><Button type="button" onClick={onShortcuts}>{localize('快捷键', 'Keyboard shortcuts')}</Button></div></DetailSection>}
        {section === "general" && <DetailSection title={localize('新手指引', 'Getting started')}><p className="field-hint">{localize('重新检测本机 CLI，并按首次使用的步骤走一遍。不会改动已有对话、Agent 和项目。', 'Check the CLIs on this computer again and walk through first-use setup. Existing chats, Agents and Projects stay as they are.')}</p><div className="settings-keyboard-actions"><Button type="button" onClick={() => onOpenPath('/?welcome=1')}>{localize('打开新手指引', 'Open getting started')}</Button></div></DetailSection>}
        {section === "general" && <section className="settings-card" aria-label={t("回答风格")}>
          <div className="workspace-section-heading"><h2>{t("回答风格")}</h2></div>
          <Field className="response-style-field" label={t("默认回答风格")} hint={t("Agent 默认继承此设置；保存后从下一次执行生效，当前执行和历史回答不变。")}>
            <Select ariaLabel={t("默认回答风格")} searchable={false} value={effectiveResponseStyle(draft)}
              onChange={value => setDraft(current => ({ ...current, responseStyle: value as ResponseStyle }))}
              options={responseStyles.map(value => ({ value, label: t(responseStyleLabels[value]) }))} />
          </Field>
          <p className="field-hint">{t(responseStyleDescriptions[effectiveResponseStyle(draft)])}</p>
        </section>}
        {section === "general" && <section className="settings-card sidebar-module-settings" aria-label={t("侧边栏模块")}>
          <h2>{t("侧边栏模块")}</h2>
          <p className="field-hint">{localize('设置固定入口和顺序；未固定的入口仍可从底部用户菜单打开。', 'Choose pinned entries and their order. Other destinations remain available in the user menu.')}</p>
          <p className="field-hint">{localize('拖动手柄排序，也可聚焦手柄后按上下方向键。', 'Drag a handle to reorder, or focus it and use the up/down arrow keys.')}</p>
          {orderedSidebarItems(moduleOrder).map((item,index) => <div className="module-visibility-row" key={item.id} onDragOver={event=>{if(moduleDrag.current)event.preventDefault();}} onDrop={event=>{event.preventDefault();const from=moduleOrder.indexOf(moduleDrag.current??'');if(from>=0&&from!==index)onModuleReorder(moduleDrag.current!,index-from);moduleDrag.current=null;}}>
            <Button type="button" className="icon-button module-order-handle" draggable aria-label={localize('调整'+t(item.label)+'顺序', 'Reorder '+(({tasks:'Tasks',projects:'Projects',agents:'Agents',library:'Library',schedules:'Schedules'} as Record<string,string>)[item.id]??t(item.label)))} title={localize('拖动或按上下方向键排序', 'Drag or use arrow keys')} onDragStart={event=>{moduleDrag.current=item.id;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',item.id);}} onDragEnd={()=>{moduleDrag.current=null;}} onKeyDown={event=>{if(event.key==='ArrowUp'||event.key==='ArrowDown'){event.preventDefault();onModuleReorder(item.id,event.key==='ArrowUp'?-1:1);}}}><Icon name="grip" size={16}/></Button>
            <label><Icon name={item.icon} size={18} /><span>{localize(item.label, ({tasks:'Tasks',projects:'Projects',agents:'Agents',library:'Library',schedules:'Schedules'} as Record<string,string>)[item.id]??t(item.label))}</span>
            <Input type="checkbox" role="switch" aria-label={t("显示{module}", { module: localize(item.label, ({tasks:'Tasks',projects:'Projects',agents:'Agents',library:'Library',schedules:'Schedules'} as Record<string,string>)[item.id]??t(item.label)) })}
              checked={modulePinned(item, modulePins)} onChange={event => onModulePin(item.id, event.target.checked)} /></label>
          </div>)}
        </section>}
        {section === "runtimes" && !loading && (location.pathname.split('/')[3] ? <RuntimeConfiguration key={location.pathname} config={draft} savedConfig={saved} onDraftChange={(cli,value,chatDefaults)=>setDraft(current=>({...current,runtimeDefaults:{...current.runtimeDefaults,[cli]:value[cli]},chatDefaults:{...current.chatDefaults,[cli]:chatDefaults?.[cli]}}))} target={location.pathname.split('/')[3]} locked={saving || dirty}
          onReload={onReloadSettings} onSave={onSaveRuntime} onNavigate={onRuntimeNavigate} onDirtyChange={onRuntimeDirtyChange}/> : <RuntimeConnections enabled={runtimes} defaults={saved.runtimeDefaults}
          refreshKey={catalogRefresh} onRefresh={() => refreshCatalog(n => n + 1)} onNavigate={onRuntimeNavigate}/>)}
        {section === "system" && <div className="system-settings">
          <p className="field-hint">{t("系统任务使用独立原生 CLI 会话与已有原生认证，不进入用户对话。")}</p>
          <section className="settings-card" aria-label={localize("系统默认", "System defaults")}>
            <h2>{localize("系统默认", "System defaults")}</h2>
            {!draft.system?.cli && <p className="field-hint">{localize("尚未选择。会话相关任务沿用来源会话；无来源会话的生成需先选择执行端。", "Not selected. Chat tasks use their source runtime; generation without a source chat requires a runtime selection.")}</p>}
            <div className="settings-form-row"><span>{t("系统任务执行端")}</span><SegmentedControl label={t("系统任务执行端")} value={draft.system?.cli ?? ''} onChange={value => patchSystem({ cli: value as Cli, model: undefined })} options={runtimes.map(value => ({value,disabled:!supportsSystemTasks(value),label:<><RuntimeIcon cli={value}/>{runtimeLabel(value)}</>}))}/></div>
            <div className="system-model-field"><span>{t("系统任务模型")}</span><ModelCatalogPicker ariaLabel={t("系统任务模型")} catalog={draft.system?.cli ? catalogs[draft.system.cli] : {choices:[],loading:false,error:""}} value={draft.system?.model ?? ""}
              disabled={!draft.system?.cli || !runtimes.includes(draft.system.cli)} onChange={value => patchSystem({ model: value || undefined })} onRefresh={() => refreshCatalog(n => n + 1)} /></div>
          </section>
          {(["title", "memory", "taskProgress"] as const).map(kind => {
            const profile = draft.system?.tasks?.[kind];
            const selectedCli = profile?.cli ?? "";
            const effectiveCli = profile?.cli ?? draft.system?.cli;
            const patchProfile = (changes: { cli?: Cli; model?: string }) => {
              const cli = changes.cli ?? effectiveCli;
              if (cli) patchSystem({tasks:{...draft.system?.tasks,[kind]:{...profile,...changes,cli}}});
            };
            return <section key={kind} className="settings-card system-task-profile" aria-label={t(kind === "title" ? "自动标题" : kind === "memory" ? "记忆提炼" : "任务进度评估")}>
              <h2>{t(kind === "title" ? "自动标题" : kind === "memory" ? "记忆提炼" : "任务进度评估")}</h2>
              <p className="field-hint">{kind === "memory" ? (localize("请求结束后提炼事实，整合场景知识与长期上下文。生成与读取可独立控制。", "Extract facts after requests, then consolidate scenes and stable context. Generation and reading have separate controls.")) : t(kind === "title" ? "对话完成后自动命名；适合轻量模型。" : "每轮结束后评估已关联任务；达成目标进入待验收，完成由你确认。")}</p>
              {kind === "title" ? <label className="system-feature-toggle"><span>{t("自动运行")}</span><Input type="checkbox" role="switch" aria-label={t("自动生成对话标题")}
                checked={draft.system?.automaticTitles ?? false} onChange={e => patchSystem({ automaticTitles: e.target.checked })} /></label> : kind === "taskProgress" ? <label className="system-feature-toggle"><span>{t("自动运行")}</span><Input type="checkbox" role="switch" aria-label={t("任务进度评估")} checked={draft.system?.automaticTaskProgress ?? true} onChange={e => patchSystem({automaticTaskProgress:e.target.checked})}/></label> : kind === "memory" && <>
                {(["generate", "read"] as const).map(control => {
                  const label = control === "generate" ? "请求记忆生成" : "请求记忆读取";
                  return <label key={control} className="system-feature-toggle"><span>{t(label)}</span><Input type="checkbox" role="switch" aria-label={t(label)}
                    checked={draft.system?.memory?.request?.[control] ?? (control === "generate" ? draft.system?.memoryCapture ?? true : true)} onChange={e => patchSystem({ memory: {
                      ...draft.system?.memory, request: { generate: draft.system?.memoryCapture ?? true, read: true, ...draft.system?.memory?.request, [control]: e.target.checked },
                    } })} /></label>;
                })}
                {!(draft.system?.memory?.request?.generate??draft.system?.memoryCapture??true)&&<Notice>{localize('生成关闭期间的新内容不会自动补记；重新开启仅处理后续内容。', 'New content is excluded while memory generation is off. Re-enabling applies to future content.')}</Notice>}
              </>}
              <div className="system-profile-fields">
                <label>{t("执行端")}<Select icon="terminal" ariaLabel={t("执行端")} value={selectedCli} searchable={false} onChange={value => {
                  if (!value) { const tasks = { ...draft.system?.tasks }; delete tasks[kind]; patchSystem({ tasks }); }
                  else patchProfile({ cli: value as Cli, model: undefined });
                }} options={[{ value: "", label: draft.system?.cli ? `${t("沿用系统默认")} · ${runtimeLabel(draft.system.cli)}` : localize("沿用来源会话执行端", "Use the source chat runtime") }, ...runtimes.map(cli => ({ value: cli, disabled:!supportsSystemTasks(cli), label: runtimeLabel(cli), icon: <RuntimeIcon cli={cli}/> })), ...(profile && !runtimes.includes(profile.cli) ? [{ value: profile.cli, label: `${runtimeLabel(profile.cli)} · ${t("已停用")}`, disabled: true }] : [])]} /></label>
                <div className="system-model-field"><span>{t("模型")}</span><ModelCatalogPicker catalog={effectiveCli ? catalogs[effectiveCli] : {choices:[],loading:false,error:""}} value={profile?.model ?? ""} onChange={value => {if(!value&&!profile){const tasks={...draft.system?.tasks};delete tasks[kind];patchSystem({tasks});}else patchProfile({ model: value || undefined });}}
                  defaultLabel={profile ? t("留空，沿用原生默认模型") : `${t("沿用系统默认")} · ${draft.system?.model || t("留空，沿用原生默认模型")}`} disabled={!effectiveCli || !runtimes.includes(effectiveCli)} onRefresh={() => refreshCatalog(n => n + 1)} /></div>
              </div>
              {effectiveCli && !runtimes.includes(effectiveCli) && <p className="field-hint">{t("所选执行端已停用；请在执行端接入中启用，或选择其他执行端。")}</p>}
              {kind === "memory" && <Disclosure title={localize('记忆行为说明', 'Memory behavior')}><p className="field-hint">{localize('关闭生成期间的新内容不会在重新开启后自动补记。重新开启默认只处理后续内容；已有深层记忆任务暂停后继续。', 'When generation is off, new content is excluded from automatic memory. Re-enabling applies to future content. Existing deep-memory work pauses and resumes.')}</p><p className="field-hint">{t("记忆保留工作来源，按当前权限与项目范围加载；可在记忆页纠正或撤回。")}</p></Disclosure>}
            </section>;
          })}
          <Disclosure className="settings-help settings-card" title={<> <Icon name="settings" size={16} />{t("系统默认与运行说明")} </>}>
            <p>{t("标题默认关闭，记忆生成与读取默认开启。生成任务使用所选 CLI 和模型，产生模型用量。")}</p>
            <p>{t("系统任务不加载 Project 与 Agent 能力；CLI 的全局扩展仍可能启动。")}</p>
            <p>{t("认证继续由原生 CLI 管理；此处不保存凭据或另设 API 密钥。")}</p>
          </Disclosure>
        </div>}
        {section === "projects" && !showDirectory && <div className="settings-columns">
          <div className="settings-detail">{creatingProject ? <section className="settings-card project-create-card" aria-label={t("新建项目")}>
            <h2>{t("新建项目")}</h2>
            <p className="field-hint">{t("先为项目命名，再配置背景、工作目录和参与 Agent。")}</p>
            <form onSubmit={event => { event.preventDefault(); createProject(); }}>
              <Field label={t("项目名称")} error={projectNameError ? errorText(projectNameError) : undefined}><Input ref={projectNameInput} aria-label={t("项目名称")} value={projectName} onChange={event => { setProjectName(event.target.value); setProjectNameError(""); }} /></Field>
              <div className="project-form-actions"><Button type="button" onClick={() => { setCreatingProject(false); setProjectName(""); }}>{t("取消新增项目")}</Button><Button type="submit" className="primary">{t("创建项目")}</Button></div>
            </form>
          </section> : project ? <>
            <ProjectNavigation project={project} active="settings" disabled={locked||objectPending} onNavigate={onOpenPath}/>
            <ObjectGroup title={localize('名称与外观', 'Name and appearance')}><div className="object-settings-editor object-identity-fields"><ObjectIdentityFields kind="project" object={project} nameLabel={t('项目名称')} onChange={patch=>patchProject(project.id,patch)}/></div></ObjectGroup>
            <ObjectGroup id="resources" title={t('工作资源')}><div className="object-settings-editor"><ProjectWorkspaces key={project.id} project={project} machines={draft.executionMachines} onChange={patch=>patchProject(project.id,patch)}/><NativeSkillsPanel key={project.id} config={draft} savedConfig={saved} projectId={project.id} directoryOnly/></div></ObjectGroup>
            <ObjectGroup id="capabilities" title={t('项目专用能力')}><div className="object-settings-editor"><p className="field-hint">{t('项目资源仅用于此项目的对话；同名能力优先于 Agent 与原生配置。')}</p><CapabilityLinks config={draft} owner={project} onChange={patch=>patchProject(project.id,patch)} onManage={onNavigate}/></div></ObjectGroup>
            {project.legacyRuntime && <Disclosure className="settings-card" title={<> {t("待迁移的旧运行参数")} </>}>
              <p className="field-hint">{t("这些旧参数已停用。迁移会替换所选 Agent 的运行参数，并影响使用该 Agent 的所有项目。")}</p>
              <pre className="legacy-config">{JSON.stringify(project.legacyRuntime, null, 2)}</pre>
              <Select icon="settings" ariaLabel={t("迁移到 Agent")} value={migrationAgentId} onChange={setMigrationAgentId} options={[
                { value: "", label: t("选择 Agent") }, ...draft.agents.filter(a => !a.systemRole && !a.temporary && project.agentIds.includes(a.id)).map(a => ({ value: a.id, label: a.name }))]} />
              <Button type="button" disabled={!project.agentIds.includes(migrationAgentId)} onClick={() => {
                patchAgent(migrationAgentId, { runtime: project.legacyRuntime }); patchProject(project.id, { legacyRuntime: undefined });
              }}>{t("替换 Agent 参数并移除旧配置")}</Button>
            </Disclosure>}
          </> : <EmptyState as="p" className="field-hint">{t("添加项目以开始配置。")}</EmptyState>}</div>
        </div>}
        {(section === "agents" || section === "runtime") && !showDirectory && <div className="settings-columns">
          <div className="settings-detail agent-settings-detail">{creatingAgent&&agentPreparation ? <section className="settings-card project-create-card" aria-label={t("创建智能体")}>
            <h2>{t("创建智能体")}</h2><p className="field-hint">{t("创建后可配置职责、模型和能力。")}</p>
            <form onSubmit={event=>{event.preventDefault();createAgent();}}>
              <label>{t("Agent 名称")}<Input autoFocus aria-label={t("Agent 名称")} value={agentPreparation.name} onChange={event=>setAgentPreparation({...agentPreparation,name:event.target.value})}/></label>
              <label>{t("执行端")}<Select ariaLabel={t("执行端")} value={agentPreparation.cli} options={[{value:'',label:localize('选择执行端', 'Choose a CLI')},...enabledRuntimes(draft).map(cli=>({value:cli,label:runtimeLabel(cli),icon:<RuntimeIcon cli={cli}/>}))]} onChange={cli=>setAgentPreparation({...agentPreparation,cli:cli as Cli})}/></label>{!enabledRuntimes(draft).length&&<p className="field-hint"><a href="/settings/runtimes" onClick={event=>{event.preventDefault();onOpenPath('/settings/runtimes');}}>{localize('先启用 CLI 接入，再创建智能体。', 'Enable a CLI adapter before creating an Agent.')}</a></p>}<div className="project-form-actions"><Button type="button" onClick={cancelAgentCreation}>{t("取消新增 Agent")}</Button><Button type="submit" className="primary" disabled={!agentPreparation.name.trim()||!agentPreparation.cli}>{t("创建智能体")}</Button></div>
            </form>
          </section> : agent ? <>
            <Tabs id="settings-agent" disabled={objectPending} className="object-tabs" label={t('Agent 内容')} value={agentTab==='profile'?'profile':'settings'} onChange={value=>changeObjectTab(value,setAgentTab)} options={[{value:'profile',label:t('概览')},{value:'settings',label:t('设置')}]}/>
            <TabPanel id="settings-agent" value={agentTab==='profile'?'profile':'settings'} className="settings-tab-panel">
            {agentTab==='profile'&&<AgentOverview key={agent.id} agent={agent} config={draft} disabled={locked} pending={objectPending} onNavigate={onOpenPath} onChange={setDraft}/>}
            {agentTab!=='profile'&&<AgentSettings key={agent.id} agent={agent} config={draft} savedConfig={saved} catalog={catalogs[agent.defaultCli]} disabled={locked} pending={objectPending} initialTab={agentTab} onChange={setDraft} onRefresh={()=>refreshCatalog(n=>n+1)} onNavigate={onOpenPath}/>}
          </TabPanel></> : <EmptyState as="p" className="field-hint">{t("添加 Agent 以开始配置。")}</EmptyState>}</div>
        </div>}
        {section === "mcp" && <CapabilityCatalog config={draft} savedConfig={saved} mode="mcp" onChange={patch => setDraft(d => ({ ...d, ...patch }))} />}
        {section === "skills" && <SkillLibrary config={draft} onChange={setDraft} onReload={onReloadSettings} busy={saving||JSON.stringify(draft)!==JSON.stringify(saved)} />}
      </fieldset>
      {!showDirectory && section !== "general" && section !== "system" && section !== "agents" && section !== "runtime" && <Disclosure className="settings-help settings-page-footer" title={<> <Icon name="info" size={16} />{t("配置说明")} </>}>
        <p>{t("默认执行端和模型用于新对话；职责与能力变更在下次执行前尝试加载，实际结果请查看生效状态。主工作目录变更请开启新对话。")}</p>
        <p>{t("保存配置会保存所有分类和对象的草稿修改。")}</p>
      </Disclosure>}
      </div></div>
    </main>
  </div>;
}
