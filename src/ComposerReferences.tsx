import Button from './ui/Button';
import type { ComposerReferenceItem } from '../shared/composer-references';
import { useEffect, useRef } from 'react';
import Icon from './ui/Icon';
import Select from './ui/Select';
import { useLanguage } from './i18n';
import './composer-references.css';

export function mentionReferenceQuery(text: string, caret: number) {
  const match = text.slice(0, caret).match(/(?:^|\s)@([^\s/@]*)$/);
  return match ? { start: caret - match[1].length - 1, end: caret, query: match[1] } : null;
}

export function slashReferenceQuery(text: string, caret: number) {
  const match = text.slice(0, caret).match(/(?:^|\s)\/([^\s/]*)$/);
  return match ? { start: caret - match[1].length - 1, end: caret, query: match[1] } : null;
}
export function matchesReferenceQuery(item: Pick<ComposerReferenceItem, "name" | "kind">, query: string) {
  return item.name.toLocaleLowerCase().startsWith(query.toLocaleLowerCase());
}
export function selectableReference(item: ComposerReferenceItem) {
  return !['shadowed', 'unavailable', 'disabled'].includes(item.status);
}
export default function ComposerReferences({ selected, items, conversationItems, onChangeConversation, open, loading, error, onRetry, activeIndex, onChoose, onRemove }: {
  selected: ComposerReferenceItem[]; items: ComposerReferenceItem[]; open: boolean; loading: boolean; error: string;
  conversationItems: ComposerReferenceItem[]; onChangeConversation:(previousId:string,nextId:string)=>void;
  onRetry: () => void;
  activeIndex: number; onChoose: (item: ComposerReferenceItem) => void; onRemove: (id: string) => void;
}) {
  const {text: localize,  t, language } = useLanguage();
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => { menu.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [activeIndex, open]);
  const statuses: Record<string, [string, string]> = { available: ['可用', 'Available'], shadowed: ['被更高优先级覆盖', 'Overridden by higher priority'],
    unavailable: ['不可用', 'Unavailable'], disabled: ['未启用', 'Disabled'], unverified: ['连接待验证', 'Connection unverified'], effective: ['已连接', 'Connected'],
    todo: ['待办', 'To do'], running: ['执行中', 'Running'], waiting: ['等待处理', 'Waiting'], review: ['等待验收', 'Review'], completed: ['已完成', 'Completed'], cancelled: ['已取消', 'Cancelled'] };
  const statusLabel = (status: string) => statuses[status]?.[language === 'zh-CN' ? 0 : 1] ?? status;
  const kindLabel = (item: ComposerReferenceItem) => item.kind === 'project' ? 'Project' : item.kind === 'chat' ? (localize('对话', 'Chat')) : item.kind === 'message' ? (localize('消息', 'Message')) : item.kind === 'agent' ? 'Agent' : item.kind === 'command' ? (localize('任务上下文', 'Task context')) : item.kind === 'skill' ? 'Skill' : item.kind === 'mcp' ? 'MCP' : t('任务');
  const kindIcon = (item: ComposerReferenceItem) => item.kind === 'project' ? 'project' : item.kind === 'chat'||item.kind==='message' ? 'message' : item.kind === 'agent' ? 'agent' : item.kind === 'command' ? 'plus' : item.kind === 'skill' ? 'book' : item.kind === 'mcp' ? 'plug' : 'plan';
  return <>
    {!!selected.length && <div className="composer-references" aria-label={t('已选引用')}>
      {selected.map(item => item.kind==='chat'?<div className="composer-conversation-reference" key={item.objectId??item.id} role="group" aria-label={localize('对话引用 · ','Conversation reference · ')+item.name}>
        <Icon name="message" size={15}/><div className="composer-conversation-body"><strong title={item.name}>{item.name}</strong>
          <small className="composer-conversation-owner" title={item.detail}>{item.detail}</small>
          <small>{item.intent==='inquiry'?localize('发送后向此对话提问，回复回到这里','Ask after sending; receive the reply here'):localize('按需读取可访问的历史','Read accessible history when needed')}</small></div>
        <Select ariaLabel={localize('对话引用方式','Conversation reference mode')} value={item.id} searchable={false}
          options={conversationItems.filter(candidate=>candidate.objectId===item.objectId&&selectableReference(candidate)).map(candidate=>({value:candidate.id,label:candidate.intent==='inquiry'?localize('向此对话提问','Ask this conversation'):localize('引用内容','Reference content')}))}
          onChange={id=>onChangeConversation(item.id,id)}/>
        <Button type="button" aria-label={t('移除引用 {name}',{name:item.name})} onClick={()=>onRemove(item.id)}><Icon name="close" size={14}/></Button>
      </div>:<span className="composer-reference-tag" key={item.id} title={`${item.source} · ${item.detail}`}>
        <Icon name={kindIcon(item)} size={15} />
        <span>{item.name}</span>{item.kind==='message'&&<q className="composer-message-excerpt">{item.detail}</q>}
        <span className="composer-reference-source">{item.source}</span>
        <Button type="button" aria-label={t('移除引用 {name}', { name: item.name })} onClick={() => onRemove(item.id)}><Icon name="close" size={14} /></Button>
      </span>)}
    </div>}
    {open && <div ref={menu} className="composer-reference-menu" id="composer-reference-menu" role="listbox" aria-label={localize('上下文与引用', 'Context and references')}>
      {loading && <p role="status">{t('正在读取引用…')}</p>}{error && <p role="status">{error} <Button type="button" onClick={onRetry}>{localize('重试', 'Retry')}</Button></p>}{!loading && !error && !items.length ? <p role="status">{t('没有匹配的引用')}</p> : items.map((item, index) => <Button
        type="button" role="option" id={`composer-reference-${index}`} key={item.id} aria-selected={activeIndex === index}
        aria-label={`${item.name} · ${kindLabel(item)} · ${statusLabel(item.status)}`} disabled={!selectableReference(item)} onMouseDown={event => event.preventDefault()} onClick={() => onChoose(item)}>
        <span className="composer-reference-kind" title={kindLabel(item)}><Icon name={kindIcon(item)} size={18} /></span>
        <span className="composer-reference-body"><span className="composer-reference-name">{item.name}</span>
          <span className="composer-reference-detail" title={`${item.source} · ${item.detail}`}>{item.source} · {item.detail}</span></span>
        <span className={`reference-status ${item.status}`} role="img" aria-label={statusLabel(item.status)} title={statusLabel(item.status)} />
      </Button>)}
    </div>}
  </>;
}
