import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useState } from 'react';
import { defaultPreferences, parsePreferences, resolvePalette, themeStorageKey, themeTokens, type ThemeMode, type ThemePreferences, type Variant } from './themes';
import './themes.css';
type ThemeContextValue = { saved: ThemePreferences; systemDark: boolean; variant: Variant; save: (value: ThemePreferences) => void; changeMode: (value: ThemeMode) => void };
const ThemeContext = createContext<ThemeContextValue | null>(null);
type DesktopAppearance = { read: () => string | null; write: (value: string) => void };
const desktopAppearance = () => (window as Window & { mandalaDesktop?: { appearance?: DesktopAppearance } }).mandalaDesktop?.appearance;
export function readInitialAppearance(storage: Pick<Storage, 'getItem'>, desktop?: DesktopAppearance): ThemePreferences {
  let canMigrate = true;
  try { const persisted = desktop?.read(); if (persisted) return parsePreferences(persisted); }
  catch { canMigrate = false; }
  let value = defaultPreferences();
  try { value = parsePreferences(storage.getItem(themeStorageKey),storage.getItem('mana-theme')??undefined); } catch { /* Keep the normal first-run default when browser storage is unavailable. */ }
  // Migration failure must not replace a readable existing choice with the default.
  if (desktop && canMigrate) try { desktop.write(JSON.stringify(value)); } catch { /* Explicit saves still report native write failures. */ }
  return value;
}
export function ThemeProvider({children}: {children: React.ReactNode}) {
  const [saved,setSaved] = useState(() => readInitialAppearance({getItem:key=>localStorage.getItem(key)},desktopAppearance()));
  const [systemDark,setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const media=matchMedia('(prefers-color-scheme: dark)'), change=()=>setSystemDark(media.matches);
    media.addEventListener('change',change); return ()=>media.removeEventListener('change',change);
  },[]);
  useEffect(() => {
    const sync=(event:StorageEvent)=>{if(event.key===themeStorageKey)setSaved(parsePreferences(event.newValue));};
    window.addEventListener('storage',sync); return ()=>window.removeEventListener('storage',sync);
  },[]);
  const save=useCallback((value:ThemePreferences)=>{
    // Write first: a quota error must leave the last saved theme intact.
    const raw = JSON.stringify(value), desktop = desktopAppearance();
    desktop?.write(raw);
    // Desktop storage is authoritative across ports; browser storage remains the web authority.
    try { localStorage.setItem(themeStorageKey,raw); } catch (error) { if (!desktop) throw error; }
    setSaved(value);
  },[]);
  const preferences=saved;
  const palette=resolvePalette(preferences,systemDark);
  useLayoutEffect(()=>{
    const root=document.documentElement, tokens=themeTokens(palette,preferences.appearance), b=preferences.background;
    root.dataset.theme=palette.variant; root.dataset.palette=palette.id; root.dataset.themeDensity=preferences.appearance.density;
    root.dataset.themeBackground=b.image?b.scope:'none';
    for(const [key,value] of Object.entries(tokens))root.style.setProperty(key,value);
    root.style.setProperty('--theme-image',b.image?`url("${b.image}")`:'none');
    root.style.setProperty('--theme-image-position',b.position);
    root.style.setProperty('--theme-image-size',b.size);
    root.style.setProperty('--theme-image-zoom',String(b.zoom/100));
    root.style.setProperty('--theme-image-blur',b.blur+'px');
    root.style.setProperty('--theme-image-overlay',String(b.overlay/100));
    root.style.colorScheme=palette.variant;
    window.dispatchEvent(new Event('mandala-theme-change'));
  },[palette,preferences]);
  return <ThemeContext.Provider value={{saved,systemDark,variant:palette.variant,save,changeMode:value=>save({...saved,mode:value})}}>{children}</ThemeContext.Provider>;
}
export function useTheme() { const value=useContext(ThemeContext); if(!value)throw Error('ThemeProvider missing'); return value; }
