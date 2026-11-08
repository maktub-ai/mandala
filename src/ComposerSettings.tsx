import Button from './ui/Button';
import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLanguage } from './i18n';
import Icon from './ui/Icon';

export default function ComposerSettings({ summary, children }: { summary: string; children: ReactNode }) {
  const {text: localize } = useLanguage(), id = useId();
  const anchor = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false), [position, setPosition] = useState<{ left: number; bottom: number } | null>(null);
  const label = localize('输入区设置', 'Composer settings');
  const close = (restore = false) => { setPosition(null); if (restore) button.current?.focus(); };
  useEffect(() => {
    const parent = anchor.current?.parentElement; if (!parent) return;
    const resize = () => { setCompact(parent.clientWidth <= 720); setPosition(null); };
    resize(); const observer = new ResizeObserver(resize); observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!position) return;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node) && !(event.target as Element).closest('.ui-select-popup')) close(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(true); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); };
  }, [position]);
  return <div ref={anchor} className={compact ? 'composer-settings is-compact' : 'composer-settings'}>
    {!compact ? children : <>
      <Button ref={button} type="button" aria-label={label} title={summary} aria-expanded={!!position} aria-controls={position ? id : undefined}
        className="composer-settings-trigger" onClick={() => { if (position) close(); else { const rect = button.current!.getBoundingClientRect(); setPosition({ left: Math.max(12, Math.min(rect.left, innerWidth - Math.min(340, innerWidth - 24) - 12)), bottom: Math.max(12, innerHeight - rect.top + 8) }); } }}>
        <Icon name="settings" size={16} /><span>{summary}</span><Icon name="chevronDown" size={14} />
      </Button>
      {position && createPortal(<div id={id} ref={panel} className="composer-settings-popup" role="group" aria-label={label} style={position}>
        {React.Children.map(children, child => React.isValidElement<{ ariaLabel?: string }>(child) ? <label><span>{child.props.ariaLabel}</span>{child}</label> : child)}
      </div>, document.body)}
    </>}
  </div>;
}
