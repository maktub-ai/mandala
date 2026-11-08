import Button from './ui/Button';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLanguage } from './i18n';
import Icon from './ui/Icon';

export default function SelectionQuote({ conversationId, disabled, onQuote }: { conversationId: string; disabled: boolean; onQuote: (text: string) => void }) {
  const {text: localize } = useLanguage();
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
  return quote && createPortal(<div className="selection-quote" style={{ left: quote.x, top: quote.y }}><Button type="button"
    aria-label={localize('引用选中文字', 'Quote selection')}
    onMouseDown={event => event.preventDefault()} onClick={() => { onQuote(quote.text); window.getSelection()?.removeAllRanges(); setQuote(null); }}>
    <Icon name="quote" size={14} />{localize('引用', 'Quote')}
  </Button></div>, document.body);
}
