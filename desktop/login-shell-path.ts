import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';

const marker = 'MANDALA_PATH=';

export function loginShellPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<string> {
  const fallback = env.PATH ?? '';
  if (process.platform === 'win32') return Promise.resolve(fallback);
  const shell = env.SHELL && isAbsolute(env.SHELL) ? env.SHELL : '/bin/zsh';
  return new Promise(resolve => {
    // Shell startup files can be slow, noisy or depend on cwd. Run them from
    // the user's home, never from an Agent's project or probe directory.
    try {
      const child = execFile(shell, ['-ilc', 'printf "\\nMANDALA_PATH=%s\\n" "$PATH"'], {
        cwd: home, env: { ...env, PWD: home }, encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
      }, (error, stdout) => {
        const line = !error && stdout.split(/\r?\n/).find(line => line.startsWith(marker));
        resolve(line ? line.slice(marker.length) : fallback);
      });
      child.stdin?.end();
    } catch {
      // macOS may reject the spawn before execFile can deliver its callback.
      resolve(fallback);
    }
  });
}
