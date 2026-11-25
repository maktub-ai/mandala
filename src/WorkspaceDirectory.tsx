import WorkspaceFirstUse from './ui/WorkspaceFirstUse';
import { isSystemAgent } from '../shared/chat-context';
import BrandMark from './ui/BrandMark';
import type { ReactNode } from 'react';
import type { Agent, Config } from '../shared/types';
import { runtimeLabel } from '../shared/runtimes';
import { useLanguage } from './i18n';
import { DirectoryLink } from './SettingsObjectBrowser';
import { firstSentence } from './ObjectExperience';
import IdentityAvatar from './IdentityAvatar';
import { WorkspacePage, PageHeader } from './ui/WorkspacePage';
import Button from './ui/Button';
import { Button as ButtonLink } from './components/ui/button';
import Input from './ui/Input';
import EmptyState from './ui/EmptyState';
import LoadingState from './ui/LoadingState';
import Icon from './ui/Icon';
import RuntimeIcon from './ui/RuntimeIcon';
import './workspace-directory.css';

export default function WorkspaceDirectory({ kind, config, disabled, loading, query, onQuery, onNavigate, onCreate, onMobileNav, status }: {
  kind: 'projects' | 'agents'; config: Config; disabled: boolean; loading: boolean; query: string;
  onQuery: (value: string) => void; onNavigate: (path: string) => void; onCreate: () => void; onMobileNav?: () => void; status?: ReactNode;
}) {
  const {text: localize,  t } = useLanguage();
  const projects = kind === 'projects';
  const title = localize(projects ? '项目' : '智能体', (projects ? 'Projects' : 'Agents'));
  const agents=config.agents.filter(agent=>!agent.temporary && !agent.systemRole);
  const members=(id:string)=>agents.filter(agent=>config.projects.find(project=>project.id===id)!.agentIds.includes(agent.id));
  const memberCount=(id:string)=>members(id).length;
  const agentProjects=(id:string)=>config.projects.filter(project=>project.agentIds.includes(id));
  const summary=firstSentence;
  const system = !projects ? config.agents.find(agent=>isSystemAgent(config,agent)) : undefined;
  const capability = localize('了解全局任务，协调项目与智能体，也可独立执行工作。', 'Understand workspace tasks, coordinate Projects and Agents, and execute work independently.');
  const search = query.trim().toLocaleLowerCase();
  const systemMatches = !!system && (system.name+' '+capability+' '+(localize('系统智能体', 'System Agent'))).toLocaleLowerCase().includes(search);
  const searchField = <Input type="search" aria-label={title} placeholder={localize(`搜索${title}`, `Search ${projects ? 'projects' : 'agents'}`)} value={query} disabled={disabled} onChange={event => onQuery(event.target.value)}/>;
  const rows = projects ? config.projects.filter(item => (item.name + ' ' + item.background).toLocaleLowerCase().includes(search)) : agents.filter(item => (item.name + ' ' + item.instructions).toLocaleLowerCase().includes(search));
  const firstUse = !loading && !search && !rows.length;
  const createButton = <Button variant="primary" disabled={disabled} onClick={onCreate}><Icon name="plus" size={15}/>{t(projects ? '添加项目' : '添加智能体')}</Button>;
  return <WorkspacePage className="workspace-directory">
    <PageHeader onMobileNav={onMobileNav} title={title} icon={projects ? 'project' : 'agent'} context={loading ? undefined : String(projects ? config.projects.length : agents.length + (system ? 1 : 0))} actions={<>{status}{!firstUse && createButton}</>}>
      {(!firstUse || !!system) && searchField}
    </PageHeader>
    {!loading && system && systemMatches && <section className="system-agent-section" aria-label={localize('系统智能体', 'System Agent')}>
      <span className="system-agent-avatar" aria-hidden="true"><BrandMark/></span>
      <div className="system-agent-copy"><div className="system-agent-identity"><h2>{system.name}</h2><span>{localize('系统智能体', 'System Agent')}</span></div><p>{capability}</p></div>
      <div className="system-agent-actions"><ButtonLink asChild variant="secondary" className="ui-button"><DirectoryLink href="/mandala" disabled={disabled} onNavigate={onNavigate}>{localize('打开主对话', 'Open main chat')}</DirectoryLink></ButtonLink><ButtonLink asChild variant="secondary" className="ui-button"><DirectoryLink href={'/?'+new URLSearchParams({project:'',agent:system.id})} disabled={disabled} onNavigate={onNavigate}>{localize('新建对话', 'New chat')}</DirectoryLink></ButtonLink><ButtonLink asChild variant="secondary" className="ui-button"><DirectoryLink href={'/agents?agent='+encodeURIComponent(system.id)} disabled={disabled} onNavigate={onNavigate}>{t('设置')}</DirectoryLink></ButtonLink></div>
    </section>}
    {loading ? <LoadingState label={t('正在读取配置…')}/> : rows.length ? <div className="workspace-directory-rows">{rows.map(item => <DirectoryLink key={item.id} className="workspace-directory-row" href={projects ? `/projects/${encodeURIComponent(item.id)}/overview` : `/agents/${encodeURIComponent(item.id)}`} disabled={disabled} onNavigate={onNavigate}>
      <IdentityAvatar identity={item} kind={projects ? 'project' : 'agent'} size={32}/>
      <span className="workspace-directory-identity"><strong>{item.name || t(projects ? '未命名项目' : '未命名智能体')}</strong><small>{summary('instructions' in item ? item.instructions : item.background) || (projects ? (localize('尚未设置项目背景', 'No project background')) : t('暂无职责说明'))}</small></span>
      {projects ? <span className="workspace-directory-context"><span className="workspace-directory-members" aria-hidden="true">{members(item.id).slice(0, 4).map(agent => <IdentityAvatar key={agent.id} identity={agent} kind="agent" size={20}/>)}</span>{`${memberCount(item.id)} ${localize('智能体', (memberCount(item.id) === 1 ? 'Agent' : 'Agents'))}`}</span>
        : <span className="workspace-directory-context">{agentProjects(item.id).length ? <span className="workspace-directory-members is-projects" title={agentProjects(item.id).map(project => project.name).join('、')}>{agentProjects(item.id).slice(0, 4).map(project => <IdentityAvatar key={project.id} identity={project} kind="project" size={20}/>)}<span className="sr-only">{agentProjects(item.id).map(project => project.name).join('、')}</span></span> : <span>{localize('未加入项目', 'No project')}</span>}<span className="workspace-directory-runtime" title={runtimeLabel((item as Agent).defaultCli)}><RuntimeIcon cli={(item as Agent).defaultCli} size={18}/><span className="sr-only">{runtimeLabel((item as Agent).defaultCli)}</span></span></span>}
      <Icon name="chevronRight" size={15}/>
    </DirectoryLink>)}</div> : search ? !systemMatches && <EmptyState>{t('没有匹配选项')}</EmptyState> :
      <WorkspaceFirstUse
        title={projects ? localize('添加第一个项目', 'Add your first project') : localize('组建你的第一个智能体', 'Set up your first Agent')}
        slot={projects
          ? { fields: [localize('项目名', 'Name'), localize('本机或远程目录', 'Local or remote folder'), localize('关联的智能体', 'Agents')], createLabel: localize('添加', 'Add'), onCreate: onCreate, disabled }
          : { shape: 'card', fields: [localize('名字与身份', 'Name and identity'), localize('运行的 CLI', 'Runtime CLI'), localize('负责的项目', 'Projects it looks after')], createLabel: localize('添加', 'Add'), onCreate: onCreate, disabled }}
        action={createButton}>
        {projects ? localize('项目是一个工作目录或代码仓库。关联后，智能体知道去哪里干活，任务和对话也按项目归档。', 'A project is a working folder or repository. Once linked, Agents know where to work, and tasks and chats are filed by project.') :
          localize('智能体长期负责一块业务，记住来龙去脉；具体执行交给 Claude Code、Codex 等 CLI。', 'An Agent looks after one area of work and remembers its history; CLIs such as Claude Code and Codex do the execution.')}
      </WorkspaceFirstUse>}
  </WorkspacePage>;
}
