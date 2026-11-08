import { useEffect, useRef } from 'react';

export const shortcuts = {
 palette: { label: ['命令面板', 'Command palette'], code: 'KeyP', key: 'P', shift: true },
 find: { label: ['对话内查找', 'Find in conversation'], code: 'KeyF', key: 'F', shift: false },
 'new-chat': { label: ['开始新对话', 'Start new chat'], code: 'KeyN', key: 'N', shift: false },
 composer: { label: ['聚焦消息输入框', 'Focus message input'], code: 'KeyL', key: 'L', shift: true },
 terminal: { label: ['切换终端', 'Toggle terminal'], code: 'Backquote', key: '`', shift: false },
} as const;
export type ShortcutId = keyof typeof shortcuts;
export const isMac = (platform = navigator.platform) => /Mac|iPhone|iPad/.test(platform);
export function shortcutLabel(id: ShortcutId, platform?: string): string {
 const binding = shortcuts[id];
 return [id === 'terminal' || !isMac(platform) ? 'Ctrl' : '⌘', ...(binding.shift ? ['Shift'] : []), binding.key].join(' + ');
}
export function shortcutAria(id: ShortcutId): string {
 const binding = shortcuts[id];
 return [id === 'terminal' || !isMac() ? 'Control' : 'Meta', ...(binding.shift ? ['Shift'] : []), binding.key].join('+');
}
export function composingKey(event: { isComposing?: boolean; keyCode?: number }): boolean {
 return !!event.isComposing || event.keyCode === 229;
}
export function shortcutIntent(event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'isComposing' | 'keyCode' | 'repeat' | 'defaultPrevented'>, platform = navigator.platform): ShortcutId | null {
 if (event.defaultPrevented || event.repeat || composingKey(event) || event.altKey) return null;
 for (const id of Object.keys(shortcuts) as ShortcutId[]) {
  const binding = shortcuts[id], control = id === 'terminal' || !isMac(platform);
  if (event.code === binding.code && event.shiftKey === binding.shift && event.ctrlKey === control && event.metaKey === !control) return id;
 }
 return null;
}
export function shortcutScopeBlocked(event: KeyboardEvent, id: ShortcutId): boolean {
 const target = event.target instanceof Element ? event.target : null;
 const modal = document.querySelector('[aria-modal="true"]:not(.workspace-inspector)');
 const inspector = document.querySelector('.workspace-inspector[aria-modal="true"]');
 return !!modal || !!inspector && id !== 'terminal' || !!target?.closest('.terminal-surface') && id !== 'terminal';
}
export function useShortcuts(handler: (id: ShortcutId, event: KeyboardEvent) => void): void {
 const action = useRef(handler); action.current = handler;
 useEffect(() => {
  let compositionTarget: EventTarget | null = null;
  const begin = (event: CompositionEvent) => { compositionTarget = event.target; };
  const end = () => { compositionTarget = null; };
  const key = (event: KeyboardEvent) => {
   const id = shortcutIntent(event);
   if (id && event.target !== compositionTarget && !shortcutScopeBlocked(event, id)) action.current(id, event);
  };
  window.addEventListener('keydown', key);
  window.addEventListener('compositionstart', begin, true); window.addEventListener('compositionend', end, true); window.addEventListener('blur', end);
  return () => { window.removeEventListener('keydown', key); window.removeEventListener('compositionstart', begin, true); window.removeEventListener('compositionend', end, true); window.removeEventListener('blur', end); };
 }, []);
}
