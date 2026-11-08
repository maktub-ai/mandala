import Button from './ui/Button';
import { useEffect, useRef, useState } from 'react';
import { CodePreview } from './CodePreview';
import { useLanguage } from './i18n';
import { fileReference, selectedLineRange } from './chat-references';
import Icon from './ui/Icon';
import './workspace-references.css';

export default function WorkspaceCodePreview({ path, text, language, onReference }: {
  path: string; text: string; language?: string; onReference: (value: string) => void;
}) {
  const {text: localize,  language: locale } = useLanguage(), english = locale !== 'zh-CN';
  const root = useRef<HTMLDivElement>(null), [range, setRange] = useState<{ start: number; end: number } | null>(null);
  useEffect(() => {
    setRange(null);
    const update = () => {
      const selection = window.getSelection(), code = root.current?.querySelector('code');
      if (!selection?.rangeCount || selection.isCollapsed || !code) { setRange(null); return; }
      const selected = selection.getRangeAt(0);
      if (!code.contains(selected.startContainer) || !code.contains(selected.endContainer)) { setRange(null); return; }
      const prefix = document.createRange(); prefix.selectNodeContents(code); prefix.setEnd(selected.startContainer, selected.startOffset);
      const start = prefix.toString().length; prefix.setEnd(selected.endContainer, selected.endOffset);
      setRange(selectedLineRange(text, start, prefix.toString().length));
    };
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, [path, text]);
  return <div className="workspace-code-preview" ref={root}>
    <div className="workspace-reference-toolbar">
      <span>{range ? (localize('第 ', 'Lines ')) + range.start + (range.end === range.start ? '' : '–' + range.end) + (localize(' 行', '')) : localize('选中代码可引用对应行', 'Select code to reference its lines')}</span>
      <Button type="button" disabled={!range} onPointerDown={event => event.preventDefault()} onClick={() => { if (range) onReference(fileReference(path, text, range, english)); }}><Icon name="quote" size={14}/>{localize('引用选区', 'Reference selection')}</Button>
    </div>
    <CodePreview text={text} language={language}/>
  </div>;
}
