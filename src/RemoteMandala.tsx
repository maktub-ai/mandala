import Button from './ui/Button';
import Disclosure from './ui/Disclosure';
import EmptyState from './ui/EmptyState';
import Icon from './ui/Icon';
import StatusLabel from './ui/StatusLabel';
import StatusMark, { statusShape } from './ui/StatusMark';
import type { Conversation, DisplayEvent } from '../shared/types';
import type { Task } from '../shared/tasks';
import { managedValueText, type ManagementProposal, type MandalaGoal } from '../shared/mandala-coordination';

/** Primary-chat identity projected by the host's GET /api/remote/mandala. */
export type RemoteMandala = { agentId: string | null; name: string | null; conversationId: string | null };
export type Say = (zh: string, en: string) => string;
type Named = { id: string; name: string };

export const taskTone = (state: string) => state === 'running' ? 'active' : ['waiting', 'review'].includes(state) ? 'warning' : state === 'completed' ? 'success' : 'neutral';
export const chatTone = (state: string) => state === 'running' ? 'active' : state === 'approval' ? 'warning' : state === 'error' ? 'danger' : 'neutral';
const activeFirst = (state: string) => ({ waiting: 0, review: 1, running: 2, todo: 3, completed: 4, cancelled: 5 } as Record<string, number>)[state] ?? 3;

export function relativeTime(iso: string | undefined, say: Say, language: string): string {
  if (!iso) return '';
  const seconds = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return say('刚刚', 'just now');
  if (seconds < 3600) return say(`${Math.floor(seconds / 60)} 分钟前`, `${Math.floor(seconds / 60)}m ago`);
  if (seconds < 86400) return say(`${Math.floor(seconds / 3600)} 小时前`, `${Math.floor(seconds / 3600)}h ago`);
  return new Date(iso).toLocaleDateString(language, { month: 'short', day: 'numeric' });
}

/** Owned goals beside the primary chat. Each goal links only to execution Chats this browser can already read. */
export function MandalaGoals({ goals, unsupported, chats, agents, projects, say, statusLabel, waitingLabel, onOpenChat, onStop, disabled, stopDisabled }: {
  goals: MandalaGoal[] | null; unsupported: boolean; chats: Conversation[]; agents: Named[]; projects: Named[]; say: Say;
  statusLabel: (state: string) => string; waitingLabel: (reason: string) => string;
  onOpenChat: (id: string) => void; onStop: (task: Task) => void; disabled: boolean; stopDisabled: boolean;
}) {
  if (unsupported) return <EmptyState icon="info">{say('电脑端的 Mandala 版本较旧，更新后可在这里查看它负责的目标。', 'Update Mandala on your computer to see the goals it owns here.')}</EmptyState>;
  if (!goals) return <EmptyState icon="plan">{say('读取目标…', 'Loading goals…')}</EmptyState>;
  if (!goals.length) return <EmptyState icon="plan">{say('还没有负责的目标。在对话中交代想完成的事情。', 'No owned goals yet. Describe what you want to accomplish in the chat.')}</EmptyState>;
  const ordered = [...goals].sort((a, b) => activeFirst(a.task.state) - activeFirst(b.task.state) || Date.parse(b.task.activityAt ?? b.createdAt) - Date.parse(a.task.activityAt ?? a.createdAt));
  return <ul className="remote-goal-list">{ordered.map(goal => {
    const task = goal.task, title = task.goal.split('\n')[0], linked = chats.filter(chat => task.conversationIds.includes(chat.id));
    const agent = agents.find(item => item.id === task.assigneeAgentId)?.name, project = task.projectId ? projects.find(item => item.id === task.projectId)?.name : null;
    return <li key={goal.taskId} className="remote-goal" data-state={task.state}>
      <div className="remote-goal-heading"><StatusMark tone={taskTone(task.state)} shape={statusShape(task.state)} /><h3>{title}</h3></div>
      <div className="remote-goal-meta"><span>{statusLabel(task.state)}</span>{task.waitingReason && <span>{waitingLabel(task.waitingReason)}</span>}{agent && <span><Icon name="agent" size={12} />{agent}</span>}{project && <span><Icon name="project" size={12} />{project}</span>}</div>
      {goal.blockedReason && <p className="remote-goal-blocked">{goal.blockedReason}</p>}
      {task.goal.includes('\n') && <Disclosure title={say('目标说明', 'Goal details')}><p className="remote-pre">{task.goal}</p></Disclosure>}
      {(linked.length > 0 || ['running', 'waiting'].includes(task.state) && task.waitingReason !== 'interrupted') && <div className="remote-goal-actions">
        {linked.map(chat => <Button key={chat.id} size="sm" variant="ghost" disabled={disabled} onClick={() => onOpenChat(chat.id)}><Icon name="message" size={13} /><span>{chat.title || say('执行对话', 'Execution Chat')}</span><StatusMark tone={chatTone(chat.status)} shape={statusShape(chat.status === 'idle' ? 'completed' : chat.status)} /></Button>)}
        {['running', 'waiting'].includes(task.state) && task.waitingReason !== 'interrupted' && <Button size="sm" variant="ghost" disabled={stopDisabled} onClick={() => onStop(task)}><Icon name="stop" size={13} />{say('停止任务', 'Stop task')}</Button>}
      </div>}
    </li>;
  })}</ul>;
}

/** In-chat receipts that Mandala writes as metadata: decision requests and configuration proposals. */
export function MandalaTurnCards({ events, allEvents, resolved, agents, projects, say, canDecide, unsupported, busy, onDecide }: {
  events: DisplayEvent[]; allEvents: DisplayEvent[]; resolved: Record<string, ManagementProposal>; agents: Named[]; projects: Named[]; say: Say;
  canDecide: boolean; unsupported: boolean; busy: boolean; onDecide: (proposal: ManagementProposal, decision: 'approve' | 'reject') => void;
}) {
  const latest = new Map<string, ManagementProposal>(), seen = new Set<string>();
  for (const event of allEvents) { const proposal = event.kind === 'metadata' && (event.data as { mandalaProposal?: ManagementProposal }).mandalaProposal; if (proposal) latest.set(proposal.id, proposal); }
  const fields: Record<string, string> = { name: say('名称', 'Name'), instructions: say('职责说明', 'Instructions'), defaultCli: say('执行端', 'Runtime'), models: say('模型', 'Models'), maxParallel: say('并发数', 'Concurrency'), agentIds: say('成员数量', 'Members'), cwd: say('工作目录', 'Working directory'), background: say('项目介绍', 'Project introduction'), skills: 'Skills', mcp: 'MCP' };
  const verbs: Record<string, string> = { create: say('创建', 'Create'), update: say('更新', 'Update'), archive: say('归档', 'Archive'), promote: say('保留为长期智能体', 'Keep as permanent') };
  const cards = [];
  for (const event of events) {
    if (event.kind !== 'metadata') continue;
    const data = event.data as { mandalaRequest?: { taskId: string; text: string; blocked: boolean }; mandalaProposal?: ManagementProposal };
    if (data.mandalaRequest) {
      cards.push(<section key={event.id} className="remote-card" data-tone="warning"><header><Icon name="approval" size={15} /><strong>{data.mandalaRequest.blocked ? say('目标受阻', 'Goal blocked') : say('需要你的决定', 'Your decision is needed')}</strong><StatusLabel icon="clock" tone="warning">{say('等待你回复', 'Awaiting your reply')}</StatusLabel></header><p className="remote-pre">{data.mandalaRequest.text}</p><small>{say('在下方回复即可继续。', 'Reply below to continue.')}</small></section>);
      continue;
    }
    if (!data.mandalaProposal || seen.has(data.mandalaProposal.id)) continue;
    seen.add(data.mandalaProposal.id);
    const p = resolved[data.mandalaProposal.id] ?? latest.get(data.mandalaProposal.id) ?? data.mandalaProposal;
    if (p.unchanged || !['applied', 'pending', 'rejected', 'failed'].includes(p.status)) continue;
    const kind = p.change.kind === 'agent' ? say('智能体', 'Agent') : say('项目', 'Project');
    const id = String(p.change.id ?? p.change.values?.id ?? ''), name = String(p.objectName || p.change.values?.name || p.summary?.before.name || (p.change.kind === 'agent' ? agents : projects).find(item => item.id === id)?.name || kind);
    const after = p.summary?.after ?? Object.fromEntries(Object.entries(p.change.values ?? {}).filter(([key]) => key !== 'id').map(([key, value]) => [key, managedValueText(key, value)]));
    const pending = p.status === 'pending' && !p.failure;
    const state = p.failure ? say('结果待确认', 'Result unconfirmed') : ({ applied: say('已应用', 'Applied'), rejected: say('已拒绝', 'Rejected'), failed: say('未应用', 'Not applied'), pending: say('待确认', 'Approval needed') } as Record<string, string>)[p.status];
    cards.push(<section key={p.id} className="remote-card" data-tone={pending || p.failure ? 'warning' : p.status === 'applied' ? 'success' : 'neutral'} aria-label={say('配置变更 · ', 'Configuration change · ') + name}>
      <header><Icon name={p.change.kind === 'agent' ? 'agent' : 'project'} size={15} /><strong>{(verbs[p.change.action] ?? p.change.action) + ' ' + kind + ' · ' + name}</strong><StatusLabel filled icon="clock" tone={pending || p.failure ? 'warning' : p.status === 'applied' ? 'success' : 'neutral'} shape={pending ? 'clock' : p.status === 'applied' ? 'check' : 'minus'}>{state}</StatusLabel></header>
      {Object.keys(after).length > 0 && <Disclosure open={pending || undefined} title={say('查看具体变更', 'Review exact changes')}><dl className="remote-change-list">{Object.entries(after).map(([key, value]) => <div key={key}><dt>{fields[key] ?? key}</dt><dd>{p.summary?.before[key] && p.summary.before[key] !== '—' && <><s>{p.summary.before[key]}</s>{' → '}</>}{value || say('空', 'Empty')}</dd></div>)}</dl></Disclosure>}
      {pending && (unsupported ? <small>{say('更新电脑端 Mandala 后可在远程确认；也可以在电脑上处理。', 'Update Mandala on your computer to confirm remotely, or decide on the computer.')}</small> : <div className="remote-card-actions"><Button variant="primary" size="sm" disabled={busy || !canDecide} onClick={() => onDecide(p, 'approve')}>{say('确认此变更', 'Confirm this change')}</Button><Button size="sm" disabled={busy || !canDecide} onClick={() => onDecide(p, 'reject')}>{say('拒绝', 'Reject')}</Button></div>)}
    </section>);
  }
  return cards.length ? <>{cards}</> : null;
}
