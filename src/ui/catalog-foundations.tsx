import { useState } from 'react';
import Button from './Button';
import Icon from './Icon';
import Tabs from './Tabs';
import SegmentedControl from './SegmentedControl';
import EmptyState from './EmptyState';
import LoadingState from './LoadingState';
import Notice from './Notice';
import Field from './Field';
import Input from './Input';
import StatusLabel from './StatusLabel';
import type { StatusShape } from './StatusMark';
import './design-system.css';
import '../conversation-progress.css';

// Live reference for DESIGN.md: every swatch and sample reads the same roles as the product.
const surfaces = [['--bg', '画布'], ['--panel', '侧栏'], ['--surface', '内容'], ['--raised', '悬停'], ['--accent-bg', '选中'], ['--border', '控件描边'], ['--border-soft', '分割线']];
const inks = [['--heading', '标题'], ['--text', '正文'], ['--muted', '次要'], ['--accent', '交互'], ['--focus', '焦点'], ['--brand-accent', '标志']];
const tones = [['--status-running', '运行中'], ['--success', '成功'], ['--warning', '待验收'], ['--danger', '失败']];
const type = [['--page-heading-size', '页面标题', 600], ['--section-heading-size', '分区标题', 600], ['--type-body', '阅读正文：对话与任务描述', 400], ['--type-ui', '界面文字：控件、导航与列表', 400], ['--type-meta', '元数据：时间、计数与说明', 400]] as const;
type Tone = 'neutral' | 'active' | 'success' | 'warning' | 'danger';
const states: [Tone, string, string, StatusShape][] = [['neutral', '待办', 'todo', 'ring'], ['neutral', '排队中', 'queued', 'clock'], ['active', '进行中', 'running', 'play'], ['danger', '需要你处理', 'attention', 'alert'], ['warning', '待验收', 'review', 'clock'], ['success', '已回复', 'replied', 'reply'], ['success', '已完成', 'completed', 'check'], ['neutral', '已取消', 'cancelled', 'minus'], ['danger', '失败', 'failed', 'cross']];

function Swatches({ items }: { items: string[][] }) {
  return <div className="catalog-swatches">{items.map(([token, label]) => <div key={token}><span style={{ background: `var(${token})` }} /><strong>{label}</strong><code>{token}</code></div>)}</div>;
}

export default function CatalogFoundations() {
  const [nav, setNav] = useState('general'), [panel, setPanel] = useState('tasks'), [view, setView] = useState('list'), [row, setRow] = useState(1), [filtered, setFiltered] = useState(true);
  return <section className="catalog-foundations product-frame" aria-label="设计基础">
    <div><h2><Icon name="palette" />颜色</h2>
      <p className="catalog-note">表面靠深浅区分层级；靛蓝只用于主操作、焦点、选中与链接；状态色只表达状态。</p>
      <Swatches items={surfaces} /><Swatches items={inks} /><Swatches items={tones} /></div>
    <div><h2><Icon name="file" />字号与字重</h2>
      <div className="catalog-type">{type.map(([token, text, weight]) => <div key={token}><code>{token}</code><span style={{ fontSize: `var(${token})`, fontWeight: weight }}>{text}</span></div>)}
        <div><code>--font-mono</code><span className="catalog-mono">resource_key 0123456789</span></div></div></div>
    <div><h2><Icon name="circleCheck" />状态标记</h2>
      <p className="catalog-note">颜色表示状态大类，镂空形状区分具体状态，不依赖颜色也能分辨。</p>
      <div className="catalog-states">{states.map(([tone, label, , shape]) => <StatusLabel key={label} icon="circleCheck" tone={tone} shape={shape} filled>{label}</StatusLabel>)}</div></div>
    <div><h2><Icon name="list-check" />选中态</h2>
      <p className="catalog-note">导航用中性灰底；面板标签用靛蓝下划线；列表里的选中项用靛蓝浅底；视图切换用分段控件。</p>
      <nav className="content-navigation" aria-label="导航选中示例">{[['general', '通用设置'], ['runtimes', '执行端接入'], ['mcp', 'MCP 连接']].map(([id, label]) => <a key={id} href={'#' + id} aria-current={nav === id ? 'page' : undefined} onClick={event => { event.preventDefault(); setNav(id); }}>{label}</a>)}</nav>
      <Tabs id="catalog-panel" label="面板标签示例" value={panel} onChange={setPanel} options={[{ value: 'tasks', label: '任务' }, { value: 'agents', label: '智能体' }, { value: 'schedules', label: '定时' }]} />
      <div className="catalog-list" role="listbox" aria-label="列表选中示例">{['运行知识库', '审计政策', '运行政策'].map((label, index) => <button type="button" role="option" key={label} aria-selected={row === index} onClick={() => setRow(index)}>{label}</button>)}</div>
      <SegmentedControl label="视图切换示例" value={view} onChange={setView} options={[{ value: 'list', label: <><Icon name="list-check" size={15} />列表</> }, { value: 'board', label: <><Icon name="grid" size={15} />看板</> }]} /></div>
    <div className="catalog-wide"><h2><Icon name="inbox" />状态形态</h2>
      <div className="catalog-state-grid">
        <figure><figcaption>页面或列表为空</figcaption><EmptyState icon="book" action={<Button><Icon name="plus" size={14} />新建文档</Button>}><strong>尚无资料</strong><p>新建文档或导入文件以开始。</p></EmptyState></figure>
        <figure><figcaption>区块为空</figcaption><p className="catalog-section-empty">尚未运行</p></figure>
        <figure><figcaption>筛选后为空</figcaption>{filtered ? <div className="progress-empty" data-filtered><h2>当前筛选下没有任务</h2><p><Button onClick={() => setFiltered(false)}>清除筛选</Button></p></div> : <Button onClick={() => setFiltered(true)}>恢复筛选示例</Button>}</figure>
        <figure><figcaption>读取中</figcaption><LoadingState label="读取示例" rows={2} /></figure>
        <figure><figcaption>字段错误</figcaption><Field label="名称" error="请填写有效的名称。"><Input aria-label="名称" defaultValue="" /></Field></figure>
        <figure><figcaption>区域错误</figcaption><Notice><span>无法读取计划。</span><Button>重试</Button></Notice></figure>
      </div></div>
  </section>;
}
