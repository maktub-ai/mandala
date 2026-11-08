import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { Dialog as DialogRoot, DialogContent, DialogTitle } from './components/ui/dialog';
import { composingKey } from './shortcuts';
import { useEscapeScope } from './ui/escape-scope';
import './ui/controls.css';

/** Compatibility wrapper: callers retain their title, actions and controlled lifetime. */
export default function Dialog({ label, className = '', locked = false, initialFocus, returnFocusRef, onEscapeKeyDown, onClose, children }: {
  label: string; className?: string; locked?: boolean; initialFocus?: RefObject<HTMLElement | null>; returnFocusRef?:RefObject<HTMLElement|null>; onEscapeKeyDown?: (event: KeyboardEvent) => void; onClose: () => void; children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const escapeScope = useEscapeScope<HTMLDivElement>(event => {
    if (locked || composing.current || composingKey(event)) return;
    onEscapeKeyDown?.(event);
    if (!event.defaultPrevented) onClose();
  }, panel);
  useEffect(() => { if (locked) panel.current?.focus(); }, [locked]);
  return <DialogRoot open onOpenChange={open => { if (!open && !locked) onClose(); }}>
    <DialogContent ref={escapeScope.ref} className={`settings-panel ui-dialog ${className}`} showCloseButton={false}
      aria-label={label} aria-describedby={undefined} tabIndex={-1}
      onOpenAutoFocus={event => {
        const previous = document.activeElement as HTMLElement | null;
        const returnId = previous?.closest<HTMLElement>('[data-focus-return]')?.dataset.focusReturn;
        returnFocus.current = returnId ? document.getElementById(returnId) : previous;
        const target = locked ? panel.current : initialFocus?.current;
        if (target) { event.preventDefault(); target.focus(); }
      }}
      onCloseAutoFocus={event => {
        event.preventDefault();
        const preferred=returnFocusRef?.current;
        const target=preferred?.isConnected&&preferred.getClientRects().length&&getComputedStyle(preferred).visibility!=='hidden'?preferred:returnFocus.current;
        if(target?.isConnected)target.focus();
      }}
      onInteractOutside={event => event.preventDefault()}
      onEscapeKeyDown={escapeScope.onEscapeKeyDown}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}>
      <DialogTitle className="sr-only">{label}</DialogTitle>
      {children}
    </DialogContent>
  </DialogRoot>;
}
