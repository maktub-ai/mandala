import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { startService, stopService, desktopEnvironment, assertHomeAvailable, prepareDesktopHome } = require('../desktop/.app/runtime.cjs');
let packagedRuntime;
if (!process.argv[2]) {
  const folders = await readdir('release/desktop');
  const folder = process.platform === 'win32' ? 'win-unpacked' : folders.find(name => /^mac(?:-|$)/.test(name));
  packagedRuntime = process.platform === 'win32' ? join('release/desktop', folder, 'resources/runtime') : join('release/desktop', folder, 'Mandala.app/Contents/Resources/runtime');
}
const runtime = resolve(process.argv[2] ?? packagedRuntime);
if (process.platform === 'darwin') {
  const signature = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', resolve(runtime, '../../..')], { encoding: 'utf8' });
  assert.equal(signature.status, 0, signature.stderr);
}
for (const dependency of ['@tencentdb-agent-memory/tcvdb-text', 'node-pty', 'cross-spawn']) {
  const metadata = JSON.parse(await readFile(join(runtime, 'node_modules', dependency, 'package.json'), 'utf8'));
  assert.equal(metadata.name, dependency, `Bundled dependency missing: ${dependency}`);
}
const home = join(await mkdtemp(join(tmpdir(), 'mandala-packaged-smoke-')), 'data');
prepareDesktopHome(home);
const node = join(runtime, 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
const env = desktopEnvironment({ env: { ...process.env, PATH: process.platform === 'win32' ? process.env.SystemRoot + '\\System32' : '/usr/bin:/bin' }, home, runtime });
let service;
const start = () => startService({ node, entry: join(runtime, 'server/main.mjs'), cwd: runtime, env });
try {
  service = await start();
  assert.equal((await fetch(service.origin + '/api/config')).status, 401);
  const launchCookie = 'mandala_setup=' + service.setupToken;
  const setup = await fetch(service.origin + '/auth/session', { headers: { Cookie: launchCookie } }).then(r => r.json());
  assert.equal(setup.setup.available, true);
  const owner = await fetch(service.origin + '/auth/setup', { method: 'POST', headers: { Origin: service.origin, Cookie: launchCookie, 'X-Setup-Token': setup.setup.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'smoke', password: 'synthetic-packaged-password' }) });
  assert.equal(owner.status, 201);
  const cookie = owner.headers.getSetCookie().find(c => /local_session=/.test(c)).split(';')[0];
  const status = await fetch(service.origin + '/api/status', { headers: { Cookie: cookie } }).then(r => r.json());
  assert.equal(status.runtime.nodeSupported, true); assert.equal(status.runtime.nodeVersion, process.versions.node);
  assert.equal(status.desktop.closeBehavior, 'hide');
  const ptyProbe = spawnSync(node, ['--input-type=module', '-e', `import {spawn} from 'node-pty';import {windowsSystemBinary} from './cli/windows-system.mjs';const win=process.platform==='win32';const p=spawn(win?windowsSystemBinary('cmd.exe'):'/bin/sh',win?['/c','echo mandala-pty-ready']:['-c','printf mandala-pty-ready'],{cols:80,rows:24,cwd:process.cwd(),env:process.env});let text='';p.onData(d=>text+=d);p.onExit(()=>{console.log(text);process.exit(text.includes('mandala-pty-ready')?0:1)});`], { cwd: runtime, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(ptyProbe.status, 0, ptyProbe.stderr); assert.match(ptyProbe.stdout, /mandala-pty-ready/);

  assert.throws(() => assertHomeAvailable(home), /Another service/);
  const cli = spawnSync(node, [join(runtime, 'cli', 'mandala.mjs'), 'config', 'get', '--base-url', service.origin], { env, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).ok, true);
  const config = await fetch(service.origin + '/api/config', { headers: { Cookie: cookie } }).then(r => r.json());
  const retained = 'Packaged restart evidence';
  config.config.ui = { ...config.config.ui, theme: 'dark' };
  const save = await fetch(service.origin + '/api/config', { method: 'PUT', headers: { Cookie: cookie, Origin: service.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ config: config.config, revision: config.revision }) });
  assert.equal(save.status, 200);
  await writeFile(join(home, 'packaged-evidence.txt'), retained);
  const origin = service.origin;
  await stopService(service.child); assert.equal(service.child.exitCode, 0); service = undefined;
  assert.equal(await fetch(origin + '/auth/session').catch(() => null), null);
  service = await start();
  assert.equal(await readFile(join(home, 'packaged-evidence.txt'), 'utf8'), retained);
  const restored = await fetch(service.origin + '/auth/session', { headers: { Cookie: cookie } }).then(r => r.json());
  assert.equal(restored.user.username, 'smoke'); assert.equal(restored.setup.available, false);
  const next = await fetch(service.origin + '/api/config', { headers: { Cookie: cookie } }).then(r => r.json());
  assert.equal(next.config.ui.theme, 'dark');
  await stopService(service.child); service = undefined;
  const backup = home + '-snapshot';
  const result = spawnSync(node, [join(runtime, 'scripts/workspace-backup.mjs'), 'backup', '--home', home, '--output', backup], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const evidence = { runtime, home, backup, bundledNode: status.runtime.nodeVersion, macCodeSignatureVerified: process.platform === 'darwin', authenticatedOwner: true, cliResource: true, nativePty: true, restartPreservedConfigAndSession: true, gracefulShutdown: true, offlineBackup: true, modelInvoked: false };
  await mkdir('release/verification', { recursive: true }); await writeFile('release/verification/desktop-runtime.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally { if (service) await stopService(service.child); }
