import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import type { ExtensionSnapshot } from '../shared/ui-extensions';
import { readMarket } from './market-read';
const ExtensionContext = createContext({ snapshot: null as ExtensionSnapshot | null, error: '', refresh: async () => {}, update: (_value: ExtensionSnapshot) => {} });
export function UiExtensionsProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<ExtensionSnapshot | null>(null), [error, setError] = useState('');
  const generation = useRef(0);
  const update = useCallback((value: ExtensionSnapshot) => { generation.current++; setSnapshot(value); setError(''); }, []);
  const refresh = useCallback(async () => {
    const token = ++generation.current;
    try { const value = await readMarket<ExtensionSnapshot>('/market/extensions'); if (generation.current === token) { setSnapshot(value); setError(''); } }
    catch (reason) { if (generation.current === token) setError((reason as Error).message); }
  }, []);
  return <ExtensionContext.Provider value={{ snapshot, error, refresh, update }}>{children}</ExtensionContext.Provider>;
}
export const useUiExtensions = () => useContext(ExtensionContext);
