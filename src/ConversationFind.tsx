import Input from './ui/Input';
import Button from './ui/Button';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useLanguage } from './i18n';
import Icon from './ui/Icon';
import { composingKey, useShortcuts } from './shortcuts';

export function conversationMatchOffsets(text: string, query: string): { start: number; end: number }[] {
  if (!query) return [];
  const literal = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...text.matchAll(new RegExp(literal, 'giu'))].map(match => ({ start: match.index, end: match.index + match[0].length }));
}

function textRanges(root: HTMLElement, query: string): Range[] {
  if (!query) return [];
  const ranges: Range[] = [];
  const blocks = [...root.querySelectorAll<HTMLElement>('.message-text, .markdown-text')]
    .filter(element => !element.parentElement?.closest('.message-text, .markdown-text'));
  for (const block of blocks) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, { acceptNode: node =>
      node.parentElement?.closest('button:not([role="link"]), .code-toolbar, [hidden]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    const nodes: { node: Node; start: number; end: number }[] = [];
    let text = '', node: Node | null;
    while ((node = walker.nextNode())) { const start = text.length; text += node.textContent; nodes.push({ node, start, end: text.length }); }
    for (const match of conversationMatchOffsets(text, query)) {
      const start = nodes.find(item => item.end > match.start), end = nodes.find(item => item.end >= match.end);
      if (start && end) { const range = document.createRange(); range.setStart(start.node, match.start - start.start); range.setEnd(end.node, match.end - end.start); ranges.push(range); }
    }
  }
  return ranges;
}

type Highlights = { set(name: string, value: unknown): void; delete(name: string): void };
export default function ConversationFind({ root, conversationId, version, hasEarlier, historyState, onLoadEarlier, onInspect }: { root: RefObject<HTMLDivElement | null>; conversationId: string; version: unknown; hasEarlier: boolean; historyState: 'idle' | 'loading' | 'error'; onLoadEarlier: () => void; onInspect: () => void }) {
  const {text: localize } = useLanguage(), say = (zh: string, en: string) => localize(zh, en);
  const [openedConversation, setOpenedConversation] = useState(''), [query, setQuery] = useState(''), [index, setIndex] = useState(0), [count, setCount] = useState(0);
  const input = useRef<HTMLInputElement>(null), matches = useRef<Range[]>([]), restoreFocus = useRef<HTMLElement | null>(null);
  const open=!!conversationId&&openedConversation===conversationId;
  const loadHistory=useRef(onLoadEarlier);loadHistory.current=onLoadEarlier;
  useEffect(()=>{if(open&&hasEarlier&&historyState==='idle')loadHistory.current();},[open,hasEarlier,historyState,version]);
  const composing = useRef(false);
  const inspect = useRef(onInspect); inspect.current = onInspect;
  const close = () => { setOpenedConversation(''); restoreFocus.current?.focus({ preventScroll: true }); };
  useEffect(() => { setOpenedConversation(''); setQuery(''); }, [conversationId]);
  useShortcuts((id, event) => {
      if (id !== 'find' || !conversationId) return;
      event.preventDefault();
      if (!input.current?.parentElement?.contains(document.activeElement))
        restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setOpenedConversation(conversationId); requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
  });
  useEffect(() => {
    matches.current = open && root.current ? textRanges(root.current, query) : [];
    setCount(matches.current.length); setIndex(0);
    const highlights = (CSS as unknown as { highlights?: Highlights }).highlights;
    const HighlightType = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    if (highlights && HighlightType && matches.current.length) highlights.set('conversation-matches', new HighlightType(...matches.current));
    else highlights?.delete('conversation-matches');
    return () => { highlights?.delete('conversation-matches'); highlights?.delete('conversation-current'); };
  }, [open, query, version, root]);
  useEffect(() => {
    const range = matches.current[index]; if (!open || !range) return;
    const highlights = (CSS as unknown as { highlights?: Highlights }).highlights;
    const HighlightType = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    if (highlights && HighlightType) highlights.set('conversation-current', new HighlightType(range));
    inspect.current();
    const scroller = root.current?.closest('.conversation');
    if (scroller) { const rect = range.getBoundingClientRect(), parent = scroller.getBoundingClientRect(); scroller.scrollBy({ top: rect.top - parent.top - parent.height / 2 }); }
  }, [open, index, count, query, version, root]);
  const move = (delta: number) => { if (count) setIndex(current => (current + delta + count) % count); };
  if (!open) return null;
  return <div className="conversation-find" role="search" aria-label={say('对话内查找', 'Find in conversation')}
    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) composing.current = false; }}
    onKeyDown={event => { if (event.key === 'Escape' && !composing.current && !composingKey(event.nativeEvent)) { event.stopPropagation(); close(); } }}>
    <Icon name="search" size={16} />
    <Input ref={input} type="search" aria-label={say('对话内查找', 'Find in conversation')} value={query} onChange={event => setQuery(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter' && !composing.current && !composingKey(event.nativeEvent)) { event.preventDefault(); move(event.shiftKey ? -1 : 1); } }} />
    {hasEarlier && (historyState==='error'?<Button type="button" onClick={onLoadEarlier}>{say('重试读取历史', 'Retry loading history')}</Button>:<small>{say('正在读取历史…', 'Loading history…')}</small>)}
    <output data-testid="conversation-find-count" aria-live="polite">{count ? index + 1 : 0} / {count}</output>
    <Button type="button" disabled={!count} aria-label={say('上一个匹配', 'Previous match')} onClick={() => move(-1)}><Icon name="arrowUp" size={16} /></Button>
    <Button type="button" disabled={!count} aria-label={say('下一个匹配', 'Next match')} onClick={() => move(1)}><Icon name="arrowDown" size={16} /></Button>
    <Button type="button" aria-label={say('关闭查找', 'Close find')} onClick={close}><Icon name="close" size={16} /></Button>
  </div>;
}
