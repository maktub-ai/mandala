// What the desktop app reports about installer updates (see desktop/updates.cjs).
export type DesktopUpdate = { version: string } & ({ local: true } | { local?: false; url: string; notes: string; size: number });
export type DesktopUpdateState = {
  supported: boolean; current: string; status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'current' | 'error';
  update: DesktopUpdate | null; checkedAt: number | null; autoCheck: boolean; error: string | null;
};
export type DesktopUpdates = {
  state: () => Promise<DesktopUpdateState>; check: () => Promise<DesktopUpdateState>; download: () => Promise<DesktopUpdateState>;
  setAutoCheck: (value: boolean) => Promise<DesktopUpdateState>; onChange: (listener: (state: DesktopUpdateState) => void) => () => void;
};
