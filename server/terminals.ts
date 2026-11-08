import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { spawn, type IPty } from 'node-pty';
import { windowsSystemBinary } from '../cli/windows-system.mjs';
import { DomainError } from '../shared/workspace-contracts';
import type { TerminalEvent, TerminalSize, TerminalSnapshot } from '../shared/terminal';

const OUTPUT_LIMIT = 512 * 1024;
export type TerminalLaunch = { command:string; args:string[]; localCwd:string; displayCwd?:string };
export function terminalSize(value: unknown): TerminalSize {
  const size = value as TerminalSize;
  if (!size || !Number.isInteger(size.cols) || !Number.isInteger(size.rows) || size.cols < 2 || size.cols > 500 || size.rows < 1 || size.rows > 200)
    throw new DomainError('terminal_size', 400, 'Invalid terminal dimensions');
  return { cols: size.cols, rows: size.rows };
}

function stopProcessTree(pty: IPty) {
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(pty.pid), '/T', '/F'], { stdio: 'ignore', timeout: 3000 }); } catch { /* May already be exited. */ }
  } else {
    // Interactive shells put background jobs in separate process groups.
    const children: number[] = [];
    try {
      const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 3000 }).trim().split('\n')
        .map(row => row.trim().split(/\s+/).map(Number));
      const parents = new Set([pty.pid]);
      for (let changed = true; changed;) {
        changed = false;
        for (const [pid, parent] of rows) if (parents.has(parent) && !parents.has(pid)) { parents.add(pid); children.push(pid); changed = true; }
      }
    } catch { /* The PTY hangup still terminates its foreground process group. */ }
    for (const pid of children.reverse()) try { process.kill(pid, 'SIGTERM'); } catch { /* Child already exited. */ }
  }
  try { pty.kill(); } catch { /* Shell already exited. */ }
}

export function createTerminals(options: { shell?: string; args?: string[] } = {}) {
  const sessions = new Map<string, { pty: IPty; snapshot: TerminalSnapshot; launchKey:string; listeners: Set<(event: TerminalEvent) => void> }>();
  let closed = false;
  const copy = (session: NonNullable<ReturnType<typeof sessions.get>>) => ({ ...session.snapshot });
  function requireSession(conversationId: string, sessionId: unknown) {
    const session = sessions.get(conversationId);
    if (!session) throw new DomainError('terminal_missing', 404, 'Terminal not found');
    if (typeof sessionId !== 'string' || session.snapshot.id !== sessionId)
      throw new DomainError('terminal_changed', 409, 'Terminal changed; reconnect before sending input');
    return session;
  }
  function running(conversationId: string, sessionId: unknown) {
    const session = requireSession(conversationId, sessionId);
    if (session.snapshot.state !== 'running') throw new DomainError('terminal_exited', 409, 'Terminal is not running');
    return session;
  }
  return {
    get(conversationId: string) { const session = sessions.get(conversationId); return session ? copy(session) : null; },
    running(prefix: string) { return [...sessions].filter(([key, session]) => key.startsWith(prefix) && session.snapshot.state === 'running').map(([key, session]) => ({ key, session: copy(session) })); },
    start(conversationId: string, cwd: string, value: TerminalSize, launch?:TerminalLaunch) {
      const size = terminalSize(value);
      if (closed) throw new DomainError('terminal_closed', 503, 'Terminal service is stopping');
      let directory: string;
      try { directory = realpathSync(launch?.localCwd ?? cwd); if (!statSync(directory).isDirectory()) throw new Error(); }
      catch { throw new DomainError('terminal_directory', 404, 'Working directory is unavailable'); }
      const displayCwd=launch?.displayCwd ?? (launch ? cwd : directory);
      const shell = launch?.command ?? options.shell ?? process.env.SHELL ?? (process.platform === 'win32' ? windowsSystemBinary('cmd.exe') : '/bin/sh');
      const args=launch?.args ?? options.args ?? (process.platform === 'win32' ? [] : ['-l']);
      const launchKey=JSON.stringify([shell,args,directory,displayCwd]);
      const previous = sessions.get(conversationId);
      if (previous?.snapshot.state === 'running') {
        if (previous.launchKey !== launchKey) throw new DomainError('terminal_directory_changed', 409, 'Working directory changed; end the previous terminal first');
        return copy(previous);
      }
      if ([...sessions.values()].filter(session => session.snapshot.state === 'running').length >= 32)
        throw new DomainError('terminal_limit', 409, 'Too many running terminals; end an unused terminal first');
      const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !['NODE_OPTIONS', 'NODE_CHANNEL_FD'].includes(key))) as Record<string, string>;
      const pty = spawn(shell, args, { name: 'xterm-256color', cwd: directory, ...size, env: { ...env, TERM: 'xterm-256color' } });
      const session = { pty, launchKey, snapshot: { ...size, id: randomUUID(), cwd: displayCwd, shell: basename(shell), pid: pty.pid,
        state: 'running' as TerminalSnapshot['state'], exitCode: null as number | null, output: '', truncated: false }, listeners: new Set<(event: TerminalEvent) => void>() };
      sessions.set(conversationId, session);
      const emit = (event: TerminalEvent) => { for (const listener of session.listeners) listener(event); };
      pty.onData(data => {
        session.snapshot.output += data;
        if (session.snapshot.output.length > OUTPUT_LIMIT) { session.snapshot.output = session.snapshot.output.slice(-OUTPUT_LIMIT); session.snapshot.truncated = true; }
        emit({ type: 'data', data });
      });
      pty.onExit(({ exitCode }) => { session.snapshot.state = 'exited'; session.snapshot.exitCode = exitCode; emit({ type: 'state', session: copy(session) }); });
      return copy(session);
    },
    write(conversationId: string, sessionId: unknown, data: unknown) {
      if (typeof data !== 'string' || !data || Buffer.byteLength(data) > 65536) throw new DomainError('terminal_input', 400, 'Invalid terminal input');
      running(conversationId, sessionId).pty.write(data);
    },
    resize(conversationId: string, sessionId: unknown, value: TerminalSize) {
      const size = terminalSize(value), session = running(conversationId, sessionId);
      session.pty.resize(size.cols, size.rows); Object.assign(session.snapshot, size);
    },
    stop(conversationId: string, sessionId: unknown) {
      const session = requireSession(conversationId, sessionId);
      if (session.snapshot.state === 'running') stopProcessTree(session.pty);
    },
    subscribe(conversationId: string, sessionId: unknown, listener: (event: TerminalEvent) => void) {
      const session = requireSession(conversationId, sessionId); session.listeners.add(listener);
      return () => { session.listeners.delete(listener); };
    },
    close() {
      closed = true;
      for (const session of sessions.values()) { session.listeners.clear(); if (session.snapshot.state === 'running') stopProcessTree(session.pty); }
    },
  };
}
export type Terminals = ReturnType<typeof createTerminals>;
