import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDesktopAppearance, writeDesktopAppearance } from '../desktop/appearance';
import { defaultPreferences } from '../src/themes';
import { readInitialAppearance } from '../src/ThemeProvider';
const homes: string[] = [];
afterEach(() => homes.splice(0).forEach(home => rmSync(home, { recursive: true, force: true })));
test('persists exact appearance independently of the runtime origin and rejects invalid replacements', () => {
  const home = mkdtempSync(join(tmpdir(), 'mandala-appearance-')); homes.push(home);
  expect(readDesktopAppearance(home)).toBeNull();
  const value = JSON.stringify({ ...defaultPreferences(), light: 'catppuccin-latte', dark: 'nord-dark' });
  writeDesktopAppearance(home, value); expect(readDesktopAppearance(home)).toBe(value);
  expect(readFileSync(join(home, 'desktop-appearance.json'), 'utf8')).toBe(value);
  if (process.platform !== 'win32') expect(statSync(join(home, 'desktop-appearance.json')).mode & 0o777).toBe(0o600);
  for (const invalid of [null, 'not JSON', '{"version":2}', 'x'.repeat(4*1024*1024+1)]) {
    expect(() => writeDesktopAppearance(home, invalid)).toThrow();
    expect(readDesktopAppearance(home)).toBe(value);
  }
  expect(() => writeDesktopAppearance(join(home, 'missing'), value)).toThrow();
});


test('startup retains the readable palette when native migration or reads fail', () => {
 const value = { ...defaultPreferences(), light: 'catppuccin-latte', dark: 'nord-dark' };
 const storage = { getItem: (key: string) => key === 'mandala-appearance-v1' ? JSON.stringify(value) : null };
 expect(readInitialAppearance(storage,{read:()=>null,write:()=>{throw Error('ENOSPC');}})).toEqual(value);
 let writes=0;
 expect(readInitialAppearance(storage,{read:()=>{throw Error('EACCES');},write:()=>{writes++;}})).toEqual(value);
 expect(writes).toBe(0);
 expect(readInitialAppearance({getItem:()=>{throw Error('SecurityError');}},{read:()=>JSON.stringify(value),write:()=>{writes++;}})).toEqual(value);
 expect(writes).toBe(0);
});


test('desktop appearance is available even when the browser localStorage getter is blocked', () => {
 const value = { ...defaultPreferences(), light: 'catppuccin-latte', dark: 'nord-dark' };
 const browser = Object.defineProperty({} as {localStorage:Storage},'localStorage',{get(){throw new DOMException('blocked','SecurityError');}});
 const storage = {getItem:(key:string)=>browser.localStorage.getItem(key)};
 expect(readInitialAppearance(storage,{read:()=>JSON.stringify(value),write:()=>{throw Error('must not write');}})).toEqual(value);
 expect(readInitialAppearance(storage)).toEqual(defaultPreferences());
});
