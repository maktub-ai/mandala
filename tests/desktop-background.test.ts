import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { connectService, prepareDesktopHome, stopBackgroundService } from '../desktop/runtime';
import { readServiceRecord, runtimeRecordPath } from '../desktop/service-discovery';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
test('runtime survives its launcher exiting, reconnects to the same process, and stops explicitly', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'mandala-background-')); roots.push(parent);
  const home = join(parent, 'data'); prepareDesktopHome(home);
  const launcher = join(parent, 'launcher.mjs');
  writeFileSync(launcher, `import {startService} from ${JSON.stringify(pathToFileURL(resolve('desktop/runtime.ts')).href)};
const service=await startService({node:process.execPath,entry:${JSON.stringify(resolve('server/main.ts'))},cwd:${JSON.stringify(process.cwd())},env:{...process.env,MANDALA_HOME:${JSON.stringify(home)},OPEN_MANA_HOME:${JSON.stringify(home)},MANDALA_PORT:'0',OPEN_MANA_PORT:'0',MANDALA_DESKTOP:'1',MANDALA_DESKTOP_PERSIST:'1',NODE_OPTIONS:'--import tsx'}});
service.child.disconnect();service.child.unref();`);
  const child = spawn(process.execPath, ['--import', 'tsx', launcher], { stdio: ['ignore','pipe','pipe'] });
  let stderr = ''; child.stderr!.on('data', data => stderr += data); child.stdout!.resume();
  try {
    const [code] = await once(child, 'exit'); expect(code, stderr).toBe(0);
    const record = readServiceRecord(home)!; expect(record).toBeTruthy();
    const first = await connectService(home); expect(first!.origin).toBe(record.origin);
    await new Promise(r => setTimeout(r, 150));
    const second = await connectService(home); expect(second!.record.pid).toBe(record.pid);
    expect((await fetch(record.origin + '/auth/session')).ok).toBe(true);
    await stopBackgroundService(second!, 15000);
    expect(existsSync(runtimeRecordPath(home))).toBe(false);
    expect(await fetch(record.origin).catch(() => null)).toBeNull();
  } finally {
    const record = readServiceRecord(home);
    if (record) { try { process.kill(record.pid, 'SIGTERM'); } catch {} }
    if (child.exitCode === null) child.kill();
  }
}, 30000);
