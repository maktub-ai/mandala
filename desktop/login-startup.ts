import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const backgroundLaunchArgument = '--mandala-background';

const pauseFile = (home: string) => join(home, '.login-startup-paused');
export function loginStartupPaused(home: string): boolean {
  return existsSync(pauseFile(home));
}

export function setLoginStartupPaused(home: string, paused: boolean): void {
  if (paused) writeFileSync(pauseFile(home), '', { mode: 0o600 });
  else rmSync(pauseFile(home), { force: true });
}

export function registerMacLoginStartup(executable: string, userHome = homedir()): void {
  const directory = join(userHome, 'Library', 'LaunchAgents');
  const label = 'com.maktubcn.mandala.background';
  const file = join(directory, label + '.plist');
  const path = executable.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${path}</string><string>${backgroundLaunchArgument}</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
`;
  if (existsSync(file) && readFileSync(file, 'utf8') === contents) return;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = file + '.' + process.pid + '.tmp';
  try {
    writeFileSync(temporary, contents, { mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}
