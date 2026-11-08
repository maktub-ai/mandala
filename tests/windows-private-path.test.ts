import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

it.each(['\n', '\r\n'])('ACL subprocesses load only trusted Windows PowerShell modules with %j line endings', (lineEnding) => {
  const source = readFileSync(resolve('cli/private-path.mjs'), 'utf8').replace(/\r?\n/g, lineEnding).replace(/^import .*;\r?\n/gm, '').replace(/^export (?=(?:async )?function )/gm, '');
  const execute = vi.fn(() => '');
  const stat = { dev: 1, ino: 2, size: 0, isSymbolicLink: () => false };
  const api = new Function('windowsSystemBinary', 'lstatSync', 'execFileSync', 'process', 'Buffer', source + '\nreturn {ownedPrivatePath,protectInvocationDirectory};')(
    () => 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', () => stat, execute, { platform: 'win32', env: { PSModulePath: 'C:\\project\\malicious-modules' } }, Buffer,
  );
  api.protectInvocationDirectory("C:\\private\\$ path '");
  expect(api.ownedPrivatePath('C:\\private', stat)).toBe(true);
  expect(execute).toHaveBeenCalledTimes(2);
  for (const call of execute.mock.calls as unknown as [string, string[]][]) {
    const script = Buffer.from(call[1].at(-1)!, 'base64').toString('utf16le');
    expect(script).toContain("$env:PSModulePath=$PSHOME+'\\Modules';");
    expect(script.indexOf('$env:PSModulePath=')).toBeLessThan(script.indexOf('$env:MANDALA_ACL_PATH'));
    expect(script).not.toContain('malicious-modules');
  }
});
