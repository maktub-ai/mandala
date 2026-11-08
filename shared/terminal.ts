export type TerminalSize = { cols: number; rows: number };
export type TerminalSnapshot = TerminalSize & {
  id: string; cwd: string; shell: string; pid: number;
  state: 'running' | 'exited'; exitCode: number | null; output: string; truncated: boolean;
};
export type TerminalEvent = { type: 'data'; data: string } | { type: 'state'; session: TerminalSnapshot };
