import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTerminals } from '../server/terminals';

let home: string;
let terminals: ReturnType<typeof createTerminals>;
beforeEach(() => { home = realpathSync(mkdtempSync(join(tmpdir(), 'mana-terminal-'))); terminals = createTerminals({ shell: '/bin/bash', args: ['--noprofile', '--norc', '+H'] }); });
afterEach(() => { terminals.close(); rmSync(home, { recursive: true, force: true }); });
async function output(id: string, pattern: RegExp) {
  await expect.poll(() => terminals.get(id)?.output ?? '').toMatch(pattern);
  return terminals.get(id)!;
}

it('runs a real interactive shell in its conversation directory and reuses the running shell', async () => {
  const session = terminals.start('one', home, { cols: 80, rows: 24 });
  terminals.write('one', session.id, "printf 'WORK=%s\\n' \"$PWD\"\r");
  expect((await output('one', new RegExp('WORK=' + home))).cwd).toBe(home);
  expect(terminals.start('one', home, { cols: 80, rows: 24 }).id).toBe(session.id);
  expect(terminals.get('two')).toBeNull();
  terminals.write('one', session.id, "read -p 'YOUR_NAME:' name; printf 'HELLO_%s\\n' \"$name\"\r");
  await output('one', /YOUR_NAME:/);
  terminals.write('one', session.id, 'Mana\r');
  await output('one', /HELLO_Mana/);
});

it('launches a remote command in a local directory while retaining its remote display cwd',async()=>{
 const launch={command:'/bin/bash',args:['--noprofile','--norc','+H'],localCwd:home,displayCwd:'/srv/remote-project'};
 const session=terminals.start('remote','/srv/remote-project',{cols:80,rows:24},launch);
 expect(session.cwd).toBe('/srv/remote-project');
 terminals.write('remote',session.id,"printf 'LOCAL_LAUNCH=%s\\n' \"$PWD\"\r");
 expect((await output('remote',new RegExp('LOCAL_LAUNCH='+home))).cwd).toBe('/srv/remote-project');
 expect(terminals.start('remote','/srv/remote-project',{cols:80,rows:24},launch).id).toBe(session.id);
 expect(()=>terminals.start('remote','/srv/remote-project',{cols:80,rows:24},{...launch,args:['-l']})).toThrow(/changed/);
});

it('resizes the PTY, interrupts a foreground program and keeps the shell usable', async () => {
  const session = terminals.start('one', home, { cols: 80, rows: 24 });
  terminals.resize('one', session.id, { cols: 101, rows: 31 });
  terminals.write('one', session.id, "stty size; sleep 30\r");
  await output('one', /31 101/);
  terminals.write('one', session.id, '\x03');
  terminals.write('one', session.id, "printf 'AFTER_INTERRUPT\\n'\r");
  await output('one', /(?:^|[\r\n])AFTER_INTERRUPT\r?\n/);
  expect(terminals.get('one')?.state).toBe('running');
});

it('isolates sessions, retains exited output and refuses stale writes after a restart', async () => {
  const one = terminals.start('one', home, { cols: 80, rows: 24 });
  const two = terminals.start('two', home, { cols: 80, rows: 24 });
  terminals.write('one', one.id, "printf 'ONLY_ONE\\n'; exit 7\r");
  await expect.poll(() => terminals.get('one')?.state).toBe('exited');
  expect(terminals.get('one')).toMatchObject({ exitCode: 7, output: expect.stringContaining('ONLY_ONE') });
  expect(terminals.get('two')?.output).not.toContain('ONLY_ONE');
  const restarted = terminals.start('one', home, { cols: 80, rows: 24 });
  expect(restarted.id).not.toBe(one.id);
  expect(() => terminals.write('one', one.id, 'exit\r')).toThrow(/changed/);
  expect(() => terminals.write('two', restarted.id, 'exit\r')).toThrow(/changed/);
  expect(terminals.get('two')?.id).toBe(two.id);
});

it('terminates a running foreground child when the terminal is ended', async () => {
  const session = terminals.start('one', home, { cols: 80, rows: 24 });
  terminals.write('one', session.id, "sleep 30 & child=$!; printf 'CHILD=%s\\n' \"$child\"; wait\r");
  const snapshot = await output('one', /\r\nCHILD=\d+/);
  const child = Number(snapshot.output.match(/\r\nCHILD=(\d+)/)![1]);
  terminals.stop('one', session.id);
  await expect.poll(() => terminals.get('one')?.state).toBe('exited');
  await expect.poll(() => { try { process.kill(child, 0); return true; } catch { return false; } }).toBe(false);
});

it('rejects invalid input and dimensions without affecting the running shell', () => {
  const session = terminals.start('one', home, { cols: 80, rows: 24 });
  for (const size of [{ cols: 0, rows: 24 }, { cols: 80.5, rows: 24 }, { cols: 80, rows: 2000 }])
    expect(() => terminals.resize('one', session.id, size)).toThrow(/invalid/i);
  expect(() => terminals.write('one', session.id, 'a'.repeat(65537))).toThrow(/invalid/i);
  expect(() => terminals.start('one', home + '/missing', { cols: 80, rows: 24 })).toThrow();
  expect(terminals.get('one')?.id).toBe(session.id);
});
