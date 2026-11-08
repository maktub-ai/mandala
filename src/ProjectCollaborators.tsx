import type { Agent, Project } from '../shared/types';
import { runtimeLabel } from '../shared/runtimes';
import { useLanguage } from './i18n';
import { DetailSection } from './ui/WorkspacePage';
import Button from './ui/Button';
import IdentityAvatar from './IdentityAvatar';
import Icon from './ui/Icon';

export default function ProjectCollaborators({ project, agents, onStartChat, onViewAgent, onEditProject, disabled = false }: {
 project: Project; agents: Agent[]; onStartChat: (id: string) => void; onViewAgent: (id: string) => void; onEditProject: () => void; disabled?: boolean;
}) {
 const {text: localize,  t } = useLanguage(), collaborators = agents.filter(agent => !agent.systemRole && project.agentIds.includes(agent.id));
 return <DetailSection title={t('项目协作者')} icon="users" actions={<Button disabled={disabled} onClick={onEditProject}><Icon name="settings" size={14}/>{localize('管理关联', 'Manage associations')}</Button>}>
  <div className="project-agent-rows">{collaborators.map(agent => <article className="project-agent-row" key={agent.id}>
   <IdentityAvatar identity={agent} kind="agent" size={28}/><div className="project-agent-copy"><Button className="project-agent-name" disabled={disabled} onClick={() => onViewAgent(agent.id)}>{agent.name}</Button><p>{agent.instructions.split('\n').find(line => line.trim())?.replace(/^#+\s*/, '') || t('暂无职责说明')}</p></div>
   <small>{runtimeLabel(agent.defaultCli)}</small><Button disabled={disabled} onClick={() => onStartChat(agent.id)}><Icon name="message" size={15}/>{t('开始对话')}</Button>
  </article>)}</div>
  {!collaborators.length && <p className="field-hint">{t('尚未关联 Agent')}</p>}
 </DetailSection>;
}
