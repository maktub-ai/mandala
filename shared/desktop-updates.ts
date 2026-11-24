// What the desktop app reports about installer updates (see desktop/updates.cjs).
export type DesktopUpdate = { version: string } & ({ local: true; publicMac?: false; publicWindows?: false } | { local?: false; publicMac: true; publicWindows?: false; notes: string; size: number } | { local?: false; publicMac?: false; publicWindows: true; notes: string; size: number } | { local?: false; publicMac?: false; publicWindows?: false; url: string; notes: string; size: number });
export type DesktopUpdateState = {
  supported: boolean;
  channel: 'unsupported' | 'installer' | 'local' | 'signed-mac' | 'signed-windows';
  current: string; status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing' | 'handoff' | 'current' | 'error';
  update: DesktopUpdate | null; checkedAt: number | null; autoCheck: boolean; error: string | null;
};
export type DesktopUpdates = {
  state: () => Promise<DesktopUpdateState>; check: () => Promise<DesktopUpdateState>; download: () => Promise<DesktopUpdateState>;
  install: () => Promise<DesktopUpdateState>;
  setAutoCheck: (value: boolean) => Promise<DesktopUpdateState>; onChange: (listener: (state: DesktopUpdateState) => void) => () => void;
};
