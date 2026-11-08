import Button from './ui/Button';
import Input from './ui/Input';
import { runtimeLabel } from "../shared/runtimes";
import { useEffect, useRef, useState } from 'react';
import OrganizationCanvas from './OrganizationCanvas';
import { api } from './api';
import type { Conversation } from '../shared/types';
import type { Config } from '../shared/types';
import { useLanguage } from './i18n';
import IdentityAvatar from './IdentityAvatar';
import Icon from './ui/Icon';
import LoadingState from './ui/LoadingState';

export function DirectoryLink({ href, disabled, onNavigate, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string; disabled: boolean; onNavigate: (path: string) => void;
}) {
  return <a {...props} href={href} aria-disabled={disabled || undefined} onClick={event => {
    if (disabled) { event.preventDefault(); return; }
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); onNavigate(href);
  }}>{children}</a>;
}

export default function SettingsObjectBrowser({ config, projectId, agentId, projectTab, disabled, loading = false, query, onQuery, onNavigate, onCreate, onCreateAgent }: {
  config: Config; projectId: string; agentId: string; projectTab?: string; disabled: boolean; loading?: boolean; query: string; onQuery: (value: string) => void;
  onNavigate: (path: string) => void; onCreate: () => void; onCreateAgent?: () => void;
}) {
  const { t } = useLanguage();
  const list = useRef<HTMLDivElement>(null);
  const selectedProject = projectId || (agentId ? config.projects.find(p => p.agentIds.includes(agentId))?.id ?? '' : '');
  const [expanded, setExpanded] = useState<string[]>(selectedProject ? [selectedProject] : []);
  const [ungroupedOpen, setUngroupedOpen] = useState(true);
  const selectedUngrouped = !!agentId && !config.projects.some(project => project.agentIds.includes(agentId));
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => { if (selectedProject) setExpanded(ids => ids.includes(selectedProject) ? ids : [...ids, selectedProject]); }, [selectedProject, agentId]);
  useEffect(() => { if (selectedUngrouped) setUngroupedOpen(true); }, [selectedUngrouped, agentId]);
  useEffect(() => {
    const viewport = list.current, selected = viewport?.querySelector<HTMLElement>('[aria-current=page]');
    if (viewport && selected) {
      const row = selected.getBoundingClientRect(), bounds = viewport.getBoundingClientRect();
      if (row.top < bounds.top || row.bottom > bounds.bottom) viewport.scrollTop += row.top - bounds.top;
    }
  }, [projectId, agentId, query, expanded, ungroupedOpen, mobileOpen]);
  const librarySelected = ['/mana/skills', '/settings/skills'].includes(location.pathname);
  const search = query.trim().toLocaleLowerCase();
  const matchesAgent = (agent: Config['agents'][number]) => (agent.name + ' ' + agent.instructions).toLocaleLowerCase().includes(search);
  const members = (project: Config['projects'][number]) => config.agents.filter(agent => !agent.systemRole && !agent.temporary && project.agentIds.includes(agent.id));
  const visible = config.projects.filter(project => project.name.toLocaleLowerCase().includes(search) || members(project).some(matchesAgent));
  const independent = config.agents.filter(agent => !agent.systemRole && !agent.temporary && !config.projects.some(project => project.agentIds.includes(agent.id)) && (t('未分组').toLocaleLowerCase().includes(search) || matchesAgent(agent)));
  const showUngrouped = ungroupedOpen || !!search;
  const navigate = (path: string) => { setMobileOpen(false); onNavigate(path); };
  return <>
    <Button type="button" className="directory-mobile-toggle" aria-controls="content-projects" aria-expanded={mobileOpen} aria-label={t(mobileOpen ? '关闭团队目录' : '打开团队目录')} onClick={() => setMobileOpen(open => !open)}><Icon name="panelLeft" size={18}/>{t('团队目录')}<Icon name={mobileOpen ? 'chevronDown' : 'chevronRight'} size={16}/></Button>
    <fieldset id="content-projects" className={'directory-projects' + (mobileOpen ? ' is-open' : '')} disabled={disabled} aria-label={t('团队目录')}>
      <DirectoryLink href="/agents" disabled={disabled} onNavigate={navigate} aria-current={!projectId && !agentId && !librarySelected ? 'page' : undefined}><Icon name="grid" size={18}/><span>{t('团队总览')}</span></DirectoryLink>
      <Input type="search" aria-label={t('搜索项目或智能体')} placeholder={t('搜索项目或智能体')} value={query} onChange={event => onQuery(event.target.value)}/>
      <div className="directory-create-actions"><Button type="button" aria-label={t('添加项目')} onClick={() => { setMobileOpen(false); onCreate(); }}><Icon name="plus" size={14}/>{t('项目')}</Button>{onCreateAgent && <Button type="button" aria-label={t('添加智能体')} onClick={() => { setMobileOpen(false); onCreateAgent(); }}><Icon name="plus" size={14}/>{t('智能体')}</Button>}</div>
      {loading ? <LoadingState label={t('正在读取配置…')} rows={3}/> : <div className="directory-project-list" ref={list}>
        {visible.map(project => {
          const projectMembers = members(project), open = expanded.includes(project.id) || !!search;
          const children = project.name.toLocaleLowerCase().includes(search) ? projectMembers : projectMembers.filter(matchesAgent);
          return <div key={project.id}>
            <div className="directory-project-row">{projectMembers.length > 0 ? <Button type="button" aria-label={t(open ? '收起{project}' : '展开{project}', { project: project.name })} aria-expanded={open} disabled={!!search} onClick={() => setExpanded(ids => ids.includes(project.id) ? ids.filter(id => id !== project.id) : [...ids, project.id])}><Icon name={open ? 'chevronDown' : 'chevronRight'} size={14}/></Button> : <span className="directory-expander-space" aria-hidden="true"/>}
              <DirectoryLink data-project-navigation={project.id} href={'/projects/manage?project=' + encodeURIComponent(project.id) + '&tab=' + (projectTab ?? 'background')} disabled={disabled} onNavigate={path => { setExpanded(ids => ids.includes(project.id) ? ids : [...ids, project.id]); navigate(path); }} aria-current={project.id === projectId && !agentId ? 'page' : undefined} aria-label={project.name || t('未命名项目')}><IdentityAvatar identity={project} kind="project" size={24}/><span>{project.name || t('未命名项目')}</span><small>{projectMembers.length}</small></DirectoryLink>
            </div>
            {open && children.length > 0 && <div className="directory-project-children">{children.map(agent => <DirectoryLink key={agent.id} href={'/agents?agent=' + encodeURIComponent(agent.id) + '&project=' + encodeURIComponent(project.id)} disabled={disabled} onNavigate={navigate} aria-current={project.id === selectedProject && agent.id === agentId ? 'page' : undefined} aria-label={agent.name || t('未命名智能体')}><IdentityAvatar identity={agent} kind="agent" size={20}/><span>{agent.name || t('未命名智能体')}</span></DirectoryLink>)}</div>}
          </div>;
        })}
        {independent.length > 0 && <div>
          <Button type="button" className="directory-ungrouped" aria-label={t('未分组')} aria-expanded={showUngrouped} aria-controls="directory-ungrouped-agents" disabled={!!search} onClick={() => setUngroupedOpen(open => !open)}><Icon name={showUngrouped ? 'chevronDown' : 'chevronRight'} size={14}/><Icon name="project" size={24}/><span>{t('未分组')}</span><small>{independent.length}</small></Button>
          {showUngrouped && <div id="directory-ungrouped-agents" className="directory-project-children">{independent.map(agent => <DirectoryLink key={agent.id} href={'/agents?agent=' + encodeURIComponent(agent.id)} disabled={disabled} onNavigate={navigate} aria-current={agent.id === agentId ? 'page' : undefined} aria-label={agent.name || t('未命名智能体')}><IdentityAvatar identity={agent} kind="agent" size={20}/><span>{agent.name || t('未命名智能体')}</span></DirectoryLink>)}</div>}
        </div>}
        {!visible.length && !independent.length && <p className="field-hint">{t(search ? '没有匹配选项' : '尚无项目或智能体。')}</p>}
      </div>}
      <DirectoryLink className="directory-library" aria-current={librarySelected ? 'page' : undefined} href="/mana/skills" disabled={disabled} onNavigate={navigate}><Icon name="book" size={18}/><span>{t('技能库')}</span></DirectoryLink>
    </fieldset>
  </>;
}

type DirectoryProps = {
  config: Config; disabled: boolean; loading: boolean; query: string; onQuery: (value: string) => void;
  onNavigate: (path: string) => void; onCreate: () => void; onConfigSaved?: () => void;
};
export function DirectoryOverview({ config, disabled, loading, onNavigate, onCreate, onConfigSaved }: DirectoryProps) {
  const { t } = useLanguage();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  useEffect(() => { let active = true; void api<Conversation[]>('/conversations').then(value => { if(active) setConversations(value); }).catch(() => {}); return () => { active = false; }; }, []);
  if (loading) return <LoadingState label={t('正在读取配置…')}/>;
  if (!config.projects.length && !config.agents.length) return <section className="directory-overview" aria-label={t('团队总览')}><p className="directory-empty">{t('尚无项目或智能体。')}</p><Button type="button" disabled={disabled} onClick={onCreate}><Icon name="plus" size={16}/>{t('添加智能体')}</Button></section>;
  return <section className="directory-overview" aria-label={t('团队总览')}>
    <OrganizationCanvas config={config} conversations={conversations} tasks={[]} onOpenPath={onNavigate}
      onOpenConversation={id => onNavigate('/?conversation=' + encodeURIComponent(id))}
      onEdit={(kind, id) => onNavigate(kind === 'agent' ? '/agents?agent=' + encodeURIComponent(id) : '/projects/manage?project=' + encodeURIComponent(id) + '&tab=background')}
      onConfigSaved={onConfigSaved} />
  </section>;
}
export function DirectoryMembers({ config, disabled, loading, query, onQuery, onNavigate, onCreate }: DirectoryProps) {
  const { t } = useLanguage();
  const visible = config.agents.filter(a => !a.systemRole && !a.temporary && (a.name + ' ' + a.instructions).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <section id="content-agents" className="directory-members" aria-label={t('成员列表')}>
    <header className="directory-heading"><div className="directory-title"><Icon name="users" size={28}/><div><h2>{t('智能体')}</h2>{!loading && <p>{t('{count} 个智能体', { count: config.agents.filter(a=>!a.systemRole && !a.temporary).length })}</p>}</div></div>
      <div className="directory-actions"><Button type="button" disabled={disabled} onClick={onCreate}><Icon name="plus" size={16}/>{t('添加智能体')}</Button></div>
    </header>
    <div className="directory-roster-toolbar"><Input type="search" aria-label={t('搜索智能体')} placeholder={t('搜索智能体')} value={query} disabled={disabled} onChange={event => onQuery(event.target.value)}/></div>
    <div className="directory-roster">{visible.map(a => <div className="directory-member" key={a.id}>
      <DirectoryLink className="directory-member-identity" href={'/agents?agent=' + encodeURIComponent(a.id)} disabled={disabled} onNavigate={onNavigate} aria-label={a.name || t('未命名智能体')}><IdentityAvatar identity={a} kind="agent" size={36}/><span><strong>{a.name || t('未命名智能体')}</strong><small>{a.instructions.split('\n')[0] || t('暂无职责说明')}</small></span></DirectoryLink>
      <div className="directory-memberships">{config.projects.filter(p => p.agentIds.includes(a.id)).map(p => <DirectoryLink key={p.id} href={'/projects/manage?project=' + encodeURIComponent(p.id) + '&tab=background'} disabled={disabled} onNavigate={onNavigate}>{p.name || t('未命名项目')}</DirectoryLink>)}</div>
      <span className="directory-cli">{runtimeLabel(a.defaultCli)}</span>
    </div>)}</div>
    {!loading && !visible.length && <p className="directory-empty">{t(query ? '没有匹配选项' : '添加智能体以开始配置。')}</p>}
  </section>;
}
