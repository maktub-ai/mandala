import { expect, test } from 'vitest';
import { shortcutIntent, shortcutLabel } from '../src/shortcuts';

const key = (code: string, modifiers: Partial<KeyboardEvent> = {}) => ({ code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 0, repeat: false, defaultPrevented: false, ...modifiers });
test('bindings use the platform modifier and reject AltGr, extra modifiers, repeats and IME confirmation', () => {
 for (const platform of ['MacIntel', 'Win32', 'Linux x86_64']) {
  const modifier = platform === 'MacIntel' ? { metaKey: true } : { ctrlKey: true };
  expect(shortcutIntent(key('KeyN', modifier), platform)).toBe('new-chat');
  expect(shortcutIntent(key('KeyL', { ...modifier, shiftKey: true }), platform)).toBe('composer');
  expect(shortcutIntent(key('KeyP', { ...modifier, shiftKey: true }), platform)).toBe('palette');
  for (const guard of [{ altKey: true }, { ctrlKey: true, metaKey: true }, { isComposing: true }, { keyCode: 229 }, { repeat: true }, { defaultPrevented: true }])
   expect(shortcutIntent(key('KeyN', { ...modifier, ...guard }), platform)).toBeNull();
  expect(shortcutIntent(key('Backquote', { ctrlKey: true }), platform)).toBe('terminal');
  expect(shortcutIntent(key('Backquote', { ctrlKey: true, altKey: true }), platform)).toBeNull();
  expect(shortcutIntent(key('Space', modifier), platform)).toBeNull();
 }
 expect(shortcutIntent(key('KeyF', { ctrlKey: true }), 'MacIntel')).toBeNull();
 expect(shortcutIntent(key('KeyF', { metaKey: true }), 'Win32')).toBeNull();
 expect(shortcutIntent(key('KeyF', { ctrlKey: true, shiftKey: true }), 'Win32')).toBeNull();
 expect(shortcutLabel('palette', 'MacIntel')).toBe('⌘ + Shift + P');
 expect(shortcutLabel('palette', 'Linux')).toBe('Ctrl + Shift + P');
});
