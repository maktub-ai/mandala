import Button from './ui/Button';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLanguage } from './i18n';
import Icon from './ui/Icon';

export const quoteDragType = 'application/x-mandala-quote';

const quoteLabels = {
  message: ['引用消息', 'Quote message'],
  reply: ['引用回复', 'Quote reply'],
  selection: ['引用选中文字', 'Quote selection'],
} as const;

export function QuoteButton({ kind, text, disabled, onQuote }: {
  kind: keyof typeof quoteLabels; text: string; disabled?: boolean; onQuote: (text: string) => void;
}) {
  const { text: localize } = useLanguage();
  const [chinese, english] = quoteLabels[kind];
  const label = localize(chinese, english);
  const selection = kind === 'selection';
  return <Button type="button" className="message-quote" aria-label={label}
    title={label + localize('（点击或拖入输入框）', ' (click or drag into the composer)')}
    disabled={disabled} draggable={!disabled}
    onDragStart={event => {
      event.dataTransfer.setData(quoteDragType, text);
      event.dataTransfer.effectAllowed = 'copy';
    }}
    onClick={() => onQuote(text)}>
    <Icon name="quote" size={14} />{selection && localize('引用', 'Quote')}
  </Button>;
}

export default function SelectionQuote({ conversationId, disabled, onQuote }: { conversationId: string; disabled: boolean; onQuote: (text: string) => void }) {
  const [quote, setQuote] = useState<{ text: string; x: number; y: number } | null>(null);
  useEffect(() => {
    const update = () => {
      const selection = window.getSelection();
      if (disabled || !selection?.rangeCount || selection.isCollapsed) { setQuote(null); return; }
      const range = selection.getRangeAt(0);
      const element = (node: Node) => node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
      const first = element(range.startContainer)?.closest('.message[data-message-key] .markdown-text');
      const last = element(range.endContainer)?.closest('.message[data-message-key] .markdown-text');
      if (!first || first !== last || !selection.toString().trim()) { setQuote(null); return; }
      const rect = range.getBoundingClientRect();
      setQuote({ text: selection.toString(), x: Math.max(8, Math.min(innerWidth - 240, rect.left)), y: Math.max(8, rect.top - 36) });
    };
    setQuote(null);
    document.addEventListener('selectionchange', update);
    window.addEventListener('scroll', update, true);
    return () => { document.removeEventListener('selectionchange', update); window.removeEventListener('scroll', update, true); };
  }, [conversationId, disabled]);
  return !disabled && quote && createPortal(<div className="selection-quote" style={{ left: quote.x, top: quote.y }}>
    <QuoteButton kind="selection" text={quote.text} onQuote={text => { onQuote(text); setQuote(null); }} />
  </div>, document.body);
}
