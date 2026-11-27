import Button from './ui/Button';
import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLanguage } from './i18n';
import Icon from './ui/Icon';

/**
 * The run-config pill of an agent chat: one button (provider mark · model · effort)
 * that opens one popover holding the model, reasoning-effort and approval controls.
 */
export default function ComposerSettings({ summary, model, effort, provider, disabled = false, children }: {
  summary: string; model: string; effort?: string; provider?: string; disabled?: boolean; children: ReactNode;
}) {
  const {text: localize } = useLanguage(), id = useId();
  const anchor = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false), [position, setPosition] = useState<{ right: number; bottom: number } | null>(null);
  const label = localize('输入区设置', 'Composer settings');
  const close = (restore = false) => { setPosition(null); if (restore) button.current?.focus(); };
  useEffect(() => {
    const parent = anchor.current?.parentElement; if (!parent) return;
    const resize = () => { setCompact(parent.clientWidth <= 420); setPosition(null); };
    resize(); const observer = new ResizeObserver(resize); observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!position) return;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node) && !(event.target as Element).closest('.ui-select-popup')) close(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !(event.target as Element | null)?.closest?.('.ui-select-popup')) { event.preventDefault(); close(true); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); };
  }, [position]);
  const open = () => {
    const rect = button.current!.getBoundingClientRect();
    setPosition({ right: Math.max(12, innerWidth - rect.right), bottom: Math.max(12, innerHeight - rect.top + 8) });
  };
  const mark = provider?.trim().charAt(0).toLocaleLowerCase();
  return <div ref={anchor} className={compact ? 'composer-settings is-compact' : 'composer-settings'}>
    <Button ref={button} type="button" variant="ghost" aria-label={label} title={summary} aria-expanded={!!position} aria-controls={position ? id : undefined} disabled={disabled}
      className="composer-settings-trigger" data-open={position ? 'true' : undefined} onClick={() => { if (position) close(); else open(); }}>
      {mark && <span className="composer-provider-mark" aria-hidden="true">{mark}</span>}
      <span className="composer-settings-model">{model}</span>
      {effort && !compact && <span className="composer-settings-effort">{effort}</span>}
      <Icon name="chevronDown" size={12} className="composer-settings-chevron" />
    </Button>
    {position && createPortal(<div id={id} ref={panel} className="composer-settings-popup" role="group" aria-label={label} style={position}>
      {React.Children.map(children, child => React.isValidElement<{ ariaLabel?: string }>(child) ? <label><span>{child.props.ariaLabel}</span>{child}</label> : child)}
    </div>, document.body)}
  </div>;
}
