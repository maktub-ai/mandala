import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';

export function systemComputerName() {
  if (process.platform === 'darwin') {
    try {
      const name = execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], {
        encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (name) return name.slice(0, 128);
    } catch {
      // The computer name is optional in macOS system preferences.
    }
  }
  return hostname().trim().slice(0, 128) || 'Mandala';
}
