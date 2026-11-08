import { expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { createTerminals } from '../server/terminals';

vi.mock('node-pty', () => ({ spawn: vi.fn(() => ({ pid: 999999999, onData() {}, onExit() {}, kill() {} })) }));

it('resolves the default Windows terminal without searching a trailing PATH entry', async () => {
  const { spawn } = await import('node-pty');
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const terminals = createTerminals();
  vi.stubEnv('SystemRoot', 'C:\\Windows'); vi.stubEnv('SHELL', undefined);
  vi.stubEnv('PATH', 'C:\\project;C:\\Windows\\System32');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    terminals.start('one', tmpdir(), { cols: 80, rows: 24 });
    expect(spawn).toHaveBeenCalledWith('C:\\Windows\\System32\\cmd.exe', [], expect.objectContaining({ cols: 80, rows: 24 }));
  } finally { Object.defineProperty(process, 'platform', original); terminals.close(); vi.unstubAllEnvs(); }
});
