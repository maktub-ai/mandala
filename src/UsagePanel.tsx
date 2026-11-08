import {isCli} from '../shared/runtimes';
import Button from './ui/Button';
import { startPolling } from './polling';
import { useEffect, useState } from 'react';
import type { Cli, Config } from '../shared/types';
import type { UsageSummary, UsageTokens } from '../shared/usage';
import { api } from './api';
import { useLanguage } from './i18n';
import Icon, { type IconName } from './ui/Icon';
import LoadingState from './ui/LoadingState';
import EmptyState from './ui/EmptyState';
import Select from './ui/Select';
import Disclosure from './ui/Disclosure';
import RuntimeIcon from './ui/RuntimeIcon';
import './usage.css';

type Dimension = 'agent' | 'project' | 'model' | 'cli' | 'category';
const dimensionIcons: Record<Dimension, IconName> = { agent: 'agent', project: 'project', model: 'sparkles', cli: 'terminal', category: 'layers' };

export default function UsagePanel({ projectId, agentId, config, onOpenPath, compact = false }: {
 projectId?: string; agentId?: string; config: Config; onOpenPath?: (href: string) => void; compact?: boolean;
}) {
 const {text: localize,  language } = useLanguage();
 const say = (cn: string, en: string) => localize(cn, en);
 const [period, setPeriod] = useState<'today' | 'week'>('week');
 const [summary, setSummary] = useState<UsageSummary | null>(null), [error, setError] = useState('');
 const [dimension, setDimension] = useState<Dimension>('agent'), [tableView, setTableView] = useState(false);
 const [expanded, setExpanded] = useState(false), [retry, setRetry] = useState(0);
 const number = (value: number | null, shorten = false) => value === null ? '—' : new Intl.NumberFormat(language, { notation: shorten ? 'compact' : 'standard', maximumFractionDigits: shorten ? 1 : 0 }).format(value);
 const dimensions: Record<Dimension, string> = { agent: say('按智能体', 'By agent'), project: say('按项目', 'By project'), model: say('按模型', 'By model'), cli: say('按执行端', 'By CLI'), category: say('按调用类型', 'By call type') };
 const categories: Record<string, string> = { conversation: say('对话', 'Conversation'), task: say('任务', 'Task'), title: say('标题生成', 'Title generation'), memory: say('记忆整理', 'Memory'), taskProgress: say('任务评估', 'Task evaluation'), fileMaintenance: say('文件维护', 'File maintenance'), skillLearning: say('技能提炼', 'Skill learning'), wikiMaintenance: say('知识库维护', 'Wiki maintenance') };
 const groupName = (key: string | null) => key === null ? say('未归属', 'Unassigned') : dimension === 'agent' ? config.agents.find(item => item.id === key)?.name ?? key : dimension === 'project' ? config.projects.find(item => item.id === key)?.name ?? key : dimension === 'category' ? categories[key] ?? key : key;
 useEffect(() => {
  let active = true;
  setSummary(null); setError('');
  const query = new URLSearchParams({ period, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  if (projectId) query.set('projectId', projectId);
  if (agentId) query.set('agentId', agentId);
  const load = (signal: AbortSignal) => api<UsageSummary>('/usage?' + query, 'GET', undefined, signal).then(value => { if (active) { setSummary(value); setError(''); } }).catch(reason => { if (active) setError(reason.message); });
  const stop = startPolling(load, 10000);
  return () => { active = false; stop(); };
 }, [period, projectId, agentId, retry]);
 const date = (value: string) => new Date(value).toLocaleDateString(language, { month: 'short', day: 'numeric', timeZone: summary?.window.timeZone });
 const rows = [...(summary?.groups[dimension] ?? [])].sort((a, b) => (b.totals.totalTokens ?? -1) - (a.totals.totalTokens ?? -1));
 const maxGroup = Math.max(1, ...rows.map(row => row.totals.totalTokens ?? 0));
 const maxDay = Math.max(1, ...(summary?.daily.map(day => day.totals.totalTokens ?? 0) ?? []));
 const hasCalls = !!summary?.coverage.total;
 const hasReported = summary?.totals.totalTokens !== null;
 const coverageLabel = summary ? !hasCalls ? say('尚无调用', 'No calls yet') : !hasReported ? say('用量未上报', 'Usage unreported') : summary.coverage.partial || summary.coverage.unknown ? say('部分用量未上报', 'Some usage is unreported') : say('用量已完整记录', 'Usage fully recorded') : '';
 const detailMetric = (key: keyof UsageTokens, label: string) => <div key={key}><dt>{label}</dt><dd>{summary?.totals[key] === null ? say('未上报', 'Unreported') : number(summary!.totals[key])}</dd></div>;
 return <section className={`usage-panel${compact ? ' usage-compact' : ''}`} aria-label={say('已记录用量', 'Recorded usage')}>
  <header className="usage-heading">{compact?<h2>{say('Token 用量','Token usage')}</h2>:<span className="usage-unit-label">Token</span>}<div className="usage-period" role="group" aria-label={say('用量时段', 'Usage period')}>{(['today', 'week'] as const).map(value => <Button key={value} type="button" aria-pressed={period === value} onClick={() => setPeriod(value)}>{value === 'today' ? say('今日', 'Today') : say('近七天', 'Last 7 days')}</Button>)}</div></header>
  {error ? <div className="usage-error" role="alert"><Icon name="error" /><div><strong>{say('用量暂时无法读取', 'Usage is unavailable')}</strong><p>{error}</p></div><Button type="button" onClick={() => setRetry(value => value + 1)}>{say('重试', 'Retry')}</Button></div> : !summary ? <LoadingState label={say('正在读取用量…', 'Loading usage…')} rows={3} /> : <>
   <dl className="usage-metrics">
    {([{ key: 'totalTokens', label: say('已记录总量', 'Recorded total') }, { key: 'inputTokens', label: say('输入', 'Input') }, { key: 'outputTokens', label: say('输出', 'Output') }] as const).map(metric => <div key={metric.key}><dt>{metric.label}</dt><dd title={summary.totals[metric.key] === null ? say('未上报', 'Unreported') : number(summary.totals[metric.key])}>{number(summary.totals[metric.key], true)}</dd></div>)}
   </dl>
   <div className="usage-context"><span className="usage-recording"><Icon name={hasCalls && summary.coverage.partial + summary.coverage.unknown === 0 ? 'circleCheck' : 'info'} size={14} />{coverageLabel}</span><span className="usage-range">{date(summary.window.start)}{period === 'week' && ` – ${date(new Date(Date.parse(summary.window.end) - 1).toISOString())}`}</span></div>
   {compact && <Button type="button" className="usage-expand" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{say(expanded ? '收起明细' : '查看明细', expanded ? 'Hide details' : 'View details')}<Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={14} /></Button>}
   {(!compact || expanded) && <div className="usage-body">
    {!hasCalls || !hasReported ? <EmptyState className="usage-empty-state" icon="activity"><strong>{!hasCalls ? say('这个时段还没有调用记录', 'No calls in this period') : say('调用尚未上报 Token 用量', 'Calls have not reported token usage')}</strong><p>{!hasCalls ? say('试试其他时间范围；新调用的用量会在这里更新。', 'Try another period. New calls will appear here.') : say('未上报不代表没有消耗。收到数据后再显示趋势。', 'Unreported does not mean zero. Trends appear when data arrives.')}</p></EmptyState> : <div className="usage-analysis">
     <section className="usage-trend" aria-label={say('每日用量', 'Daily usage')}>
      <header className="usage-section-heading"><h3>{say('用量趋势', 'Usage trend')}</h3><span>{say('每日', 'Daily')} / Token</span></header>
      {summary.daily.length ? <div className="usage-plot">
       <div className="usage-chart-scale" aria-hidden="true"><span>{number(maxDay === 1 && summary.daily.every(day => !day.totals.totalTokens) ? 0 : maxDay, true)}</span><span>0</span></div>
       <div className="usage-chart-bars">{summary.daily.map(day => {
        const value = day.totals.totalTokens, state = !day.coverage.total ? 'empty' : value === null ? 'unknown' : value === 0 ? 'zero' : 'reported';
        const valueLabel = state === 'empty' ? say('无调用', 'No calls') : value === null ? say('未上报', 'Unreported') : number(value) + ' Token';
        const label = new Date(day.date + 'T12:00:00Z').toLocaleDateString(language, { month: 'numeric', day: 'numeric', timeZone: 'UTC' });
        return <div className="usage-chart-day" data-state={state} key={day.date} tabIndex={0} aria-label={`${label}: ${valueLabel}`}>
         <div className="usage-bar-track"><span className="usage-day-tooltip">{label}<strong>{valueLabel}</strong></span>{value === null ? <span className="usage-gap">—</span> : <span className="usage-bar" style={{ height: `${value / maxDay * 100}%` }} />}</div><span className="usage-day-label">{label}</span>
        </div>;
       })}</div>
      </div> : <p className="usage-empty">{say('暂无每日明细', 'No daily detail available')}</p>}
      {summary.daily.some(day => day.coverage.total > 0 && day.totals.totalTokens === null) && <p className="usage-chart-note">{say('横线表示未上报，不按零计算。', 'A dash indicates unreported usage, not zero.')}</p>}
     </section>
     <section className="usage-breakdown" aria-label={say('用量分布', 'Usage breakdown')}>
      <header className="usage-section-heading"><Select ariaLabel={say('分析维度', 'Group by')} searchable={false} value={dimension} onChange={value => setDimension(value as Dimension)} options={(Object.keys(dimensions) as Dimension[]).map(key => ({ value: key, label: dimensions[key], icon: <Icon name={dimensionIcons[key]} size={16} /> }))} /><div className="usage-view-switch" role="group" aria-label={say('展示方式', 'Display as')}><Button type="button" aria-label={say('图表', 'Chart')} title={say('图表', 'Chart')} aria-pressed={!tableView} onClick={() => setTableView(false)}><Icon name="usage" size={16} /></Button><Button type="button" aria-label={say('表格', 'Table')} title={say('表格', 'Table')} aria-pressed={tableView} onClick={() => setTableView(true)}><Icon name="grid" size={16} /></Button></div></header>
      {!rows.length ? <p className="usage-empty">{say('这个维度暂无记录', 'No records for this dimension')}</p> : tableView ? <div className="usage-table-wrap"><table aria-label={dimensions[dimension]}><thead><tr><th scope="col">{say('对象', 'Name')}</th><th scope="col">Token</th><th scope="col">{say('输入', 'Input')}</th><th scope="col">{say('输出', 'Output')}</th></tr></thead><tbody>{rows.map(row => <tr key={row.key ?? '__unassigned'}><th scope="row">{groupName(row.key)}</th><td>{number(row.totals.totalTokens)}</td><td>{number(row.totals.inputTokens)}</td><td>{number(row.totals.outputTokens)}</td></tr>)}</tbody></table></div> : <ol className="usage-rankings">{rows.map(row => <li key={row.key ?? '__unassigned'}><div className="usage-ranking-label">{dimension === 'cli' && isCli(row.key) ? <RuntimeIcon cli={row.key as Cli} /> : <Icon name={dimensionIcons[dimension]} size={16} />}<span title={groupName(row.key)}>{groupName(row.key)}</span><strong title={number(row.totals.totalTokens)}>{row.totals.totalTokens === null ? say('未上报', 'Unreported') : number(row.totals.totalTokens, true)}</strong></div><div className="usage-ranking-track" aria-hidden="true">{row.totals.totalTokens !== null && <span style={{ width: `${row.totals.totalTokens / maxGroup * 100}%` }} />}</div></li>)}</ol>}
     </section>
    </div>}
    <div className="usage-inspect">
     <Disclosure className="usage-method" title={<><Icon name="info" size={16} /><span>{say('统计口径', 'Measurement details')}</span></>}><div className="usage-method-content"><dl className="usage-metadata"><div><dt>{say('开始', 'Start')}</dt><dd><time>{new Date(summary.window.start).toLocaleString(language, {timeZone:summary.window.timeZone})}</time></dd></div><div><dt>{say('结束（不含）', 'End (exclusive)')}</dt><dd><time>{new Date(summary.window.end).toLocaleString(language, {timeZone:summary.window.timeZone})}</time></dd></div><div><dt>{say('时区', 'Time zone')}</dt><dd>{summary.window.timeZone}</dd></div></dl><dl className="usage-token-details">{detailMetric('cachedInputTokens',say('缓存输入', 'Cached input'))}{detailMetric('cacheWriteInputTokens',say('缓存写入','Cache writes'))}{detailMetric('reasoningOutputTokens',say('推理输出','Reasoning output'))}</dl><p>{say('仅统计 Mandala 发起的调用。缓存包含在输入内，推理包含在输出内，不重复累加。', 'Only Mandala calls are included. Cache is included in input and reasoning in output; neither is added twice.')}</p><dl className="usage-coverage">{(['observed','partial','unknown'] as const).map(key=><div key={key}><dt>{{observed:say('完整记录','Complete'),partial:say('部分记录','Partial'),unknown:say('未上报','Unreported')}[key]}</dt><dd>{summary.coverage[key]}</dd></div>)}</dl></div></Disclosure>
     <Disclosure className="usage-sources" title={<><Icon name="list-check" size={16}/><span>{say('调用记录','Call records')}</span><small>{say('最近','Latest')} {summary.recent.length}</small></>}><div className="usage-source-list">{!summary.recent.length ? <p className="usage-empty">{say('暂无调用记录','No call records')}</p> : summary.recent.map(item=><div className="usage-source" key={item.executionId}><RuntimeIcon cli={item.cli}/><div><strong>{item.model ?? say('模型未上报','Model unreported')}</strong><span>{{observed:say('完整记录','Complete'),partial:say('部分记录','Partial'),unknown:say('未上报','Unreported')}[item.coverage]}</span></div><span>{number(item.totals.totalTokens)} <small>Token</small></span>{(item.taskId||item.conversationId)&&<a href={item.taskId?'/tasks/'+encodeURIComponent(item.taskId):'/?conversation='+encodeURIComponent(item.conversationId!)} aria-label={say('打开来源','Open source')} title={say('打开来源','Open source')} onClick={event=>{if(onOpenPath){event.preventDefault();onOpenPath(event.currentTarget.getAttribute('href')!);}}}><Icon name="arrowRight" size={16}/></a>}</div>)}</div></Disclosure>
    </div>
    <footer className="usage-updated">{say('更新于','Updated')} {new Date(summary.generatedAt).toLocaleTimeString(language,{hour:'2-digit',minute:'2-digit'})}</footer>
   </div>}
  </>}
 </section>;
}
