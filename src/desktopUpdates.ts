import { useEffect, useState } from 'react';
import type { DesktopUpdateState, DesktopUpdates } from '../shared/desktop-updates';

export const desktopUpdates = (): DesktopUpdates | undefined => typeof window === 'undefined' ? undefined : (window as Window & { mandalaDesktop?: { updates?: DesktopUpdates } }).mandalaDesktop?.updates;

/** The desktop app's update state, kept current by its background checks. Undefined outside the desktop app. */
export function useDesktopUpdate(): [DesktopUpdateState | undefined, (state: DesktopUpdateState) => void] {
  const bridge = desktopUpdates();
  const [state, setState] = useState<DesktopUpdateState>();
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    void bridge.state().then(value => { if (active) setState(value); }).catch(() => {});
    const off = bridge.onChange(value => { if (active) setState(value); });
    return () => { active = false; off(); };
  }, [bridge]);
  return [state, setState];
}
