import { setLoginStartupPaused, loginStartupPaused, registerMacLoginStartup } from '../desktop/login-startup';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolveDesktopHome, desktopEnvironment, startService, stopService, allowedNavigation, assertHomeAvailable, prepareDesktopHome } from '../desktop/runtime';

const roots: string[] = [];
const temporary = () => { const parent = mkdtempSync(join(tmpdir(), 'mandala-desktop-')); roots.push(parent); const root = join(parent, 'data'); prepareDesktopHome(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('desktop runtime', () => {
  it('uses the canonical home after a migration while keeping the old alias accessible', () => {
    const root=temporary(),current=join(root,'.mandala');mkdirSync(current);
    symlinkSync(current,join(root,'.open-mana'),'junction');
    expect(resolveDesktopHome({},root)).toBe(current);
  });
  it('preserves an existing legacy home and respects explicit overrides', () => {
    const root = temporary();
    mkdirSync(join(root, '.open-mana'));
    expect(resolveDesktopHome({}, root)).toBe(join(root, '.open-mana'));
    expect(resolveDesktopHome({ MANDALA_HOME: join(root, 'selected'), OPEN_MANA_HOME: join(root, 'old') }, root)).toBe(join(root, 'selected'));
    expect(resolveDesktopHome({ OPEN_MANA_HOME: join(root, 'old') }, root)).toBe(join(root, 'old'));
    expect(resolveDesktopHome({}, temporary())).toMatch(/\.mandala$/);
  });
  it('prepends bundled node and CLI locations, removes injected Node flags, and uses loopback ephemeral ports', () => {
    const env = desktopEnvironment({ env: { PATH: '/usr/bin', NODE_OPTIONS: '--inspect=0.0.0.0', ELECTRON_RUN_AS_NODE: '1' }, home: '/data', runtime: '/app/runtime', userHome: '/user', platform: 'darwin', loginPath: '/custom/bin:/usr/bin' });
    expect(env.PATH!.split(':').slice(0, 2)).toEqual([join('/app/runtime', 'bin'), '/custom/bin']);
    expect(env.PATH).toContain(join('/user', '.bun', 'bin'));
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.OPEN_MANA_HOME).toBe('/data');
    expect(env.MANDALA_HOME).toBe('/data');
    expect(env.OPEN_MANA_PORT).toBe('0');
    expect(env.MANDALA_PORT).toBe('0');
  });
  it('rejects remote and deceptive navigation while allowing the exact local origin', () => {
    const origin = 'http://127.0.0.1:3456';
    expect(allowedNavigation(origin + '/chat', origin)).toBe(true);
    for (const url of ['http://127.0.0.1:3457', 'https://127.0.0.1:3456', 'file:///etc/passwd', 'javascript:alert(1)', 'http://127.0.0.1.evil.test:3456']) expect(allowedNavigation(url, origin)).toBe(false);
  });
  it('waits for a child-owned readiness message and gracefully stops before returning', async () => {
    const root = temporary();
    writeFileSync(join(root, 'server.cjs'), `const s=require('node:http').createServer((q,r)=>r.end('ready'));s.listen(0,'127.0.0.1',()=>process.send({type:'mandala:ready',port:s.address().port}));process.on('message',m=>{if(m.type==='mandala:stop')s.close(()=>{require('node:fs').writeFileSync(${JSON.stringify(join(root, 'stopped'))},'clean');process.disconnect()})});`);
    const service = await startService({ node: process.execPath, entry: join(root, 'server.cjs'), cwd: root, env: process.env });
    expect(await (await fetch(service.origin)).text()).toBe('ready');
    await stopService(service.child);
    expect(service.child.exitCode).toBe(0);
    expect(await fetch(service.origin).catch(() => null)).toBeNull();
    expect((await import('node:fs')).readFileSync(join(root, 'stopped'), 'utf8')).toBe('clean');
  });
  it('does not attach to or stop an unrelated process on a requested port', async () => {
    const root = temporary();
    const foreign = createServer((_q, r) => r.end('foreign'));
    foreign.listen(0, '127.0.0.1'); await once(foreign, 'listening');
    const port = (foreign.address() as { port: number }).port;
    writeFileSync(join(root, 'conflict.cjs'), `const s=require('node:http').createServer();s.on('error',()=>process.exit(3));s.listen(${port},'127.0.0.1',()=>process.send({type:'mandala:ready',port:${port}}));`);
    try {
      await expect(startService({ node: process.execPath, entry: join(root, 'conflict.cjs'), cwd: root, env: process.env })).rejects.toThrow(/exited/);
      expect(await (await fetch('http://127.0.0.1:' + port)).text()).toBe('foreign');
    } finally { foreign.close(); foreign.closeAllConnections(); }
  });
  it('refuses a live workspace lease without writing or stopping its owner', () => {
    const root = temporary(); mkdirSync(join(root, '.store-leases'));
    const lease = join(root, '.store-leases', `${process.pid}-active`); writeFileSync(lease, 'open');
    expect(() => assertHomeAvailable(root)).toThrow(/Another service/);
    expect(readFileSync(lease, 'utf8')).toBe('open');
  });
  it('never force-kills a slow shutdown on timeout and can wait again', async () => {
    const root = temporary();
    writeFileSync(join(root, 'slow.cjs'), `const s=require('node:http').createServer();s.listen(0,'127.0.0.1',()=>process.send({type:'mandala:ready',port:s.address().port}));let stopping=false;process.on('message',m=>{if(m.type==='mandala:stop'&&!stopping){stopping=true;setTimeout(()=>s.close(()=>process.disconnect()),150)}});`);
    const service = await startService({ node: process.execPath, entry: join(root, 'slow.cjs'), cwd: root, env: process.env });
    await expect(stopService(service.child, 20)).rejects.toThrow(/has not finished/);
    expect(service.child.exitCode).toBeNull(); expect(service.child.signalCode).toBeNull();
    await stopService(service.child, 1000); expect(service.child.exitCode).toBe(0);
  });

  it('retains a timed-out startup until the owned child has actually exited', async () => {
    const root = temporary();
    writeFileSync(join(root, 'late.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'pid'))},String(process.pid));const interval=setInterval(()=>{},1000);setTimeout(()=>process.on('message',m=>{if(m.type==='mandala:stop'){clearInterval(interval);process.disconnect()}}),120);`);
    await expect(startService({ node: process.execPath, entry: join(root, 'late.cjs'), cwd: root, env: process.env, timeoutMs: 180 })).rejects.toThrow(/timed out/);
    const pid = Number(readFileSync(join(root, 'pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });
  it('publishes its reserved ephemeral port to both environment generations before native CLI context creation', async () => {
    const root = temporary(); const wrapper = join(root, 'entry.mjs');
    writeFileSync(wrapper, `const send=process.send.bind(process);process.send=m=>send({...m,legacyPort:process.env.OPEN_MANA_PORT,preferredPort:process.env.MANDALA_PORT});await import(${JSON.stringify(pathToFileURL(resolve('server/main.ts')).href)});`);
    const child = spawn(process.execPath, ['--import', 'tsx', wrapper], { cwd: process.cwd(), env: { ...process.env, OPEN_MANA_HOME: root, OPEN_MANA_PORT: '0', MANDALA_PORT: '0', MANDALA_DESKTOP: '1' }, stdio: ['ignore','pipe','pipe','ipc'] });
    child.stdout!.resume(); child.stderr!.resume();
    try {
      const message = await new Promise<any>((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', code => reject(new Error('Startup exited ' + code))); });
      expect(message.legacyPort).toBe(String(message.port)); expect(message.preferredPort).toBe(String(message.port));
    } finally { await stopService(child); }
  });

  it('prepares the same single-instance lock home while a primary service lease is active', () => {
    const root = temporary(); mkdirSync(join(root, '.store-leases'));
    const lease = join(root, '.store-leases', `${process.pid}-active`); writeFileSync(lease, 'open');
    expect(() => prepareDesktopHome(root)).not.toThrow();
    expect(() => assertHomeAvailable(root)).toThrow(/Another service/);
    expect(readFileSync(lease,'utf8')).toBe('open');
  });

  it('does not initialize workspace data if its IPC supervisor disconnected before module loading', async () => {
    const root = temporary(), home = join(root,'data'), wrapper = join(root,'disconnected.mjs');
    writeFileSync(wrapper, `process.disconnect();await import(${JSON.stringify(pathToFileURL(resolve('server/main.ts')).href)});`);
    const child = spawn(process.execPath, ['--import','tsx',wrapper], { cwd: process.cwd(), env: { ...process.env, OPEN_MANA_HOME: home, MANDALA_HOME: home, OPEN_MANA_PORT: '0', MANDALA_PORT: '0', MANDALA_DESKTOP: '1' }, stdio: ['ignore','pipe','pipe','ipc'] });
    child.stdout!.resume(); child.stderr!.resume();
    const [code] = await once(child,'exit'); expect(code).toBe(0); expect((await import('node:fs')).existsSync(home)).toBe(false);
  });

});

describe('desktop login startup', () => {
  it('persists an explicit stop until manual startup clears it', () => {
    const home = temporary();
    expect(loginStartupPaused(home)).toBe(false);
    setLoginStartupPaused(home, true);
    expect(loginStartupPaused(home)).toBe(true);
    setLoginStartupPaused(home, false);
    expect(loginStartupPaused(home)).toBe(false);
  });

  it('registers one background launch per login using the installed executable path', () => {
    const userHome = temporary();
    registerMacLoginStartup('/Applications/Mandala & Tools.app/Contents/MacOS/Mandala', userHome);
    const plist = readFileSync(join(userHome, 'Library', 'LaunchAgents', 'com.maktubcn.mandala.background.plist'), 'utf8');
    expect(plist).toContain('<string>/Applications/Mandala &amp; Tools.app/Contents/MacOS/Mandala</string>');
    expect(plist).toContain('<string>--mandala-background</string>');
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).not.toContain('KeepAlive');
  });
});
