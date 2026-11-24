// What the desktop app reports about installer updates (see desktop/updates.cjs).
export type DesktopUpdate = { version: string } & ({ local: true; publicMac?: false } | { local?: false; publicMac: true; notes: string; size: number } | { local?: false; publicMac?: false; url: string; notes: string; size: number });
export type DesktopUpdateState = {
  supported: boolean;
  channel: 'unsupported' | 'installer' | 'local' | 'signed-mac';
  current: string; status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing' | 'current' | 'error';
  update: DesktopUpdate | null; checkedAt: number | null; autoCheck: boolean; error: string | null;
};
export type DesktopUpdates = {
  state: () => Promise<DesktopUpdateState>; check: () => Promise<DesktopUpdateState>; download: () => Promise<DesktopUpdateState>;
  install: () => Promise<DesktopUpdateState>;
  setAutoCheck: (value: boolean) => Promise<DesktopUpdateState>; onChange: (listener: (state: DesktopUpdateState) => void) => () => void;
};
