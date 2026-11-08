import { build } from '../desktop/node_modules/esbuild/lib/main.js';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { copyReleaseLicenses, copyElectronLicenses } from './copy-release-licenses.mjs';
import { prepareVoiceRuntime } from './prepare-voice-runtime.mjs';
import { pruneDesktopRuntime } from './prune-desktop-runtime.mjs';
import { downloadArtifact } from '../desktop/node_modules/@electron/get/dist/index.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(root, 'desktop'), runtime = join(desktop, '.runtime'), app = join(desktop, '.app');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const [major, minor, patch] = process.versions.node.split('.').map(Number);
if (major !== 22 || minor < 23 || minor === 23 && patch < 2) throw new Error('Build with Node 22.23.2 or newer 22.x; the exact binary and native ABI are shipped.');
const version = process.env.MANDALA_VERSION ?? manifest.version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('MANDALA_VERSION must be a semantic version without the tag prefix.');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function run(command, args, cwd = root) {
  // npm.cmd is a trusted fixed build command; user content never reaches this shell.
  execFileSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && command === npm });
}
run(process.execPath, ['scripts/check-release-source.mjs']);
run(npm, ['run', 'build']);
await rm(runtime, { recursive: true, force: true }); await rm(app, { recursive: true, force: true });
await mkdir(join(runtime, 'bin'), { recursive: true }); await mkdir(join(runtime, 'scripts'), { recursive: true }); await mkdir(app, { recursive: true });
await cp(process.execPath, join(runtime, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'));
const nodeLicense = [join(dirname(process.execPath), 'LICENSE'), join(dirname(process.execPath), '..', 'LICENSE')].find(existsSync);
if (nodeLicense) await cp(nodeLicense, join(runtime, 'LICENSE-node.txt'));
else {
  const response = await fetch(`https://nodejs.org/dist/${process.version}/LICENSE`, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('Cannot include the bundled Node license');
  await writeFile(join(runtime, 'LICENSE-node.txt'), await response.text());
}

await cp(join(root, 'dist'), join(runtime, 'dist'), { recursive: true });
await cp(join(root, 'cli'), join(runtime, 'cli'), { recursive: true });
await cp(join(root, 'package.json'), join(runtime, 'package.json'));
await cp(join(root, 'package-lock.json'), join(runtime, 'package-lock.json'));
await copyReleaseLicenses(root, runtime);
const electron = JSON.parse(await readFile(join(desktop, 'node_modules/electron/package.json'), 'utf8'));
const electronArchive = await downloadArtifact({version:electron.version,artifactName:'electron',platform:process.platform,arch:process.arch,checksums:JSON.parse(await readFile(join(desktop,'node_modules/electron/checksums.json'),'utf8'))});
await copyElectronLicenses(electronArchive, runtime);
await cp(join(root, 'scripts', 'prepare-terminal.mjs'), join(runtime, 'scripts', 'prepare-terminal.mjs'));
run(npm, ['ci', '--omit=dev', '--no-audit', '--no-fund'], runtime);
await cp(join(root, 'third-party-notices'), join(runtime, 'third-party-notices'), { recursive: true });
const serverBuild = await build({ entryPoints: { 'server/main': join(root, 'server/main.ts'), 'server/account-desktop-main': join(root, 'server/account-desktop-main.ts'), 'scripts/desktop-cli': join(desktop, 'cli-entry.ts'), 'scripts/account-admin': join(root, 'scripts/account-admin.ts'), 'scripts/workspace-backup': join(root, 'scripts/workspace-backup.ts'), 'scripts/migrate-home': join(root, 'scripts/migrate-home.ts') }, outdir: runtime, outExtension: { '.js': '.mjs' }, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22', logLevel: 'info', metafile: true });
await cp(join(root, 'server/voice-worker.mjs'), join(runtime, 'server/voice-worker.mjs'));
await cp(join(root, 'server/pi-permission-extension.mjs'), join(runtime, 'server/pi-permission-extension.mjs'));
await cp(join(root, 'release/ssh-runner'), join(runtime, 'server/ssh-runner'), {recursive:true});
await pruneDesktopRuntime(runtime, serverBuild.metafile);
await prepareVoiceRuntime(runtime);
await build({ entryPoints: [join(desktop, 'runtime.ts')], outfile: join(app, 'runtime.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22' });
for (const file of ['main.cjs', 'updates.cjs', 'preload.cjs', 'tray.png', 'tray-color.png', 'icon-light.png', 'icon-dark.png']) await cp(join(desktop, file), join(app, file));
await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'mandala-desktop', productName: 'Mandala', version, description: 'Mandala personal desktop application', author: 'MaktubCN', main: 'main.cjs' }, null, 2));
let commit = 'uncommitted';
try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch {}
await writeFile(join(runtime, 'build.json'), JSON.stringify({ version, commit, node: process.version, platform: process.platform, arch: process.arch, signingRequested: process.env.MANDALA_SIGNED === '1', sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()), builtAt: new Date().toISOString() }, null, 2));
const builderArgs = ['node_modules/electron-builder/cli.js', '--config', 'electron-builder.cjs', '--publish', 'never'];
if (process.argv.includes('--dir')) builderArgs.push('--dir');
run(process.execPath, builderArgs, desktop);
console.log(`Mandala ${version}: ${join(root, 'release', 'desktop')}`);
