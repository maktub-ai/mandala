const { execFile, execFileSync } = require('node:child_process');
const { lstatSync, readFileSync } = require('node:fs');
const { mkdir, mkdtemp, rename, rm } = require('node:fs/promises');
const { basename, dirname, join } = require('node:path');
const { promisify } = require('node:util');

const run = promisify(execFile);
const localVersion = /^\d+\.\d+\.\d+-local\.main\.[a-f0-9]{7}$/;
function ownDirectory(path, isPrivate = false) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return stat?.isDirectory() && stat.uid === process.getuid() && (!isPrivate || (stat.mode & 0o077) === 0);
}
function readBuild(bundle, arch) {
  if (!ownDirectory(bundle)) return null;
  const build = JSON.parse(readFileSync(join(bundle, 'Contents/Resources/runtime/build.json'), 'utf8'));
  if (!localVersion.test(build.version) || !/^[a-f0-9]{40}$/.test(build.commit) || !build.version.endsWith('.' + build.commit.slice(0, 7)) ||
      build.platform !== 'darwin' || build.arch !== arch || build.sourceDirty !== false || build.signingRequested !== false ||
      !Number.isFinite(Date.parse(build.builtAt))) return null;
  return build;
}
const verify = bundle => run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R=identifier "com.maktubcn.mandala"', bundle]);

function createLocalUpdate({ installed, feed, swap, version, arch }) {
  if (!localVersion.test(version)) return null;
  const current = readBuild(installed, arch);
  if (current?.version !== version) return null;
  const cache = join(dirname(installed), '.' + basename(installed) + '-update');
  const staged = join(cache, 'Mandala.app');
  const offered = join(feed, 'Mandala.app');
  function newer(parent, bundle) {
    if (!ownDirectory(parent, true)) return null;
    const next = readBuild(bundle, arch);
    return next && next.commit !== current.commit && Date.parse(next.builtAt) > Date.parse(current.builtAt) ? next : null;
  }
  const check = () => newer(feed, offered);
  const ready = () => {
    try { return newer(cache, staged); }
    catch { return null; }
  };
  return {
    check, ready,
    async download(candidate) {
      const next = check();
      if (next?.version !== candidate.version) throw Error('The local build changed. Check for updates again.');
      await mkdir(cache, { recursive: true, mode: 0o700 });
      if (!ownDirectory(cache, true)) throw Error('The local update directory is not private.');
      const temporary = await mkdtemp(join(cache, 'download-'));
      try {
        const copied = join(temporary, 'Mandala.app');
        await run('/usr/bin/ditto', [offered, copied]);
        await verify(copied);
        if (newer(temporary, copied)?.commit !== next.commit) throw Error('The downloaded build changed. Check for updates again.');
        if (lstatSync(staged, { throwIfNoEntry: false })) execFileSync(swap, [copied, staged]);
        else await rename(copied, staged);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    },
    async install(stopIfIdle) {
      const next = ready();
      if (!next || readBuild(installed, arch)?.commit !== current.commit) return 'none';
      try { await verify(staged); }
      catch (error) {
        await rm(staged, { recursive: true, force: true });
        throw error;
      }
      if (!await stopIfIdle()) return 'busy';
      if (readBuild(installed, arch)?.commit !== current.commit || ready()?.commit !== next.commit) throw Error('The local update changed. Check for updates again.');
      // The staged bundle becomes the previous app after the exchange.
      execFileSync(swap, [installed, staged]);
      return 'installed';
    },
  };
}
module.exports = { createLocalUpdate };
