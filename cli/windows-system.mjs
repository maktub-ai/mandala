import { win32 } from 'node:path';
// Resolve fixed OS utilities without searching a project cwd or PATH.
export function windowsSystemBinary(name) {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.windir;
  if (typeof root !== 'string' || !/^[A-Za-z]:[\\/]/.test(root) || win32.normalize(root) !== win32.resolve(root)) throw new Error('A trusted absolute Windows SystemRoot is required');
  if (name === 'powershell.exe') return win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', name);
  if (name === 'taskkill.exe' || name === 'cmd.exe' || name === 'whoami.exe') return win32.join(root, 'System32', name);
  throw new Error('Unsupported system utility');
}
