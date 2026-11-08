import { useCallback, useRef, type RefObject } from 'react';

const scopes = new WeakMap<HTMLElement, (event: KeyboardEvent) => void>();
const handled = new WeakSet<KeyboardEvent>();

function nearestScope(target: EventTarget | null) {
  for (let node = target instanceof HTMLElement ? target : null; node; node = node.parentElement) {
    const handler = scopes.get(node);
    if (handler) return handler;
  }
}

/** Radix can briefly retain an outer Escape listener while a nested layer mounts.
 * Route that event synchronously; Radix still owns focus, portals and dismissal. */
export function useEscapeScope<T extends HTMLElement>(onEscape: (event: KeyboardEvent) => void, content?: RefObject<T | null>) {
  const handler = useRef(onEscape), mounted = useRef<T | null>(null);
  handler.current = onEscape;
  const ref = useCallback((node: T | null) => {
    if (mounted.current) scopes.delete(mounted.current);
    mounted.current = node;
    if (content) content.current = node;
    if (node) scopes.set(node, event => handler.current(event));
  }, [content]);
  const onEscapeKeyDown = useCallback((event: KeyboardEvent) => {
    if (handled.has(event)) { event.preventDefault(); return; }
    const owner = nearestScope(event.target) ?? nearestScope(mounted.current?.ownerDocument.activeElement ?? null);
    if (!owner) return;
    handled.add(event);
    event.stopImmediatePropagation();
    owner(event);
    event.preventDefault();
  }, []);
  return { ref, onEscapeKeyDown };
}
