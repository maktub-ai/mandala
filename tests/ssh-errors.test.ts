import { expect, it } from 'vitest';
import { sshErrorText } from '../src/ssh-errors';

it('explains common SSH failures with a next step and keeps the original detail',()=>{
 const hostKey=sshErrorText('zh-CN','SSH failed (255): Host key verification failed.','build-linux')!;
 expect(hostKey).toContain('ssh build-linux');expect(hostKey.split('\n')[1]).toBe('SSH failed (255): Host key verification failed.');
 expect(sshErrorText('en','SSH failed (255): user@host: Permission denied (publickey).')).toContain('ssh-agent');
 expect(sshErrorText('en','SSH failed (255): ssh: Could not resolve hostname nope: Name or service not known')).toContain('could not be found');
 expect(sshErrorText('zh-CN','SSH failed (255): ssh: connect to host x port 22: Connection refused')).toContain('无法连接');
 expect(sshErrorText('en','Remote Node >=22.23.2 is required')).toContain('Node.js 22.23.2');
 expect(sshErrorText('en','SSH failed (127): bash: node: command not found')).toContain('nvm');
 expect(sshErrorText('zh-CN','SSH disconnected (255): ; remote execution state is unknown')).toContain('不会自动重发');
 expect(sshErrorText('en','Remote working directory is unavailable')).toContain('project settings');
});

it('leaves unrelated errors alone, including non-SSH network failures',()=>{
 expect(sshErrorText('en','Runtime disabled')).toBeUndefined();
 expect(sshErrorText('en','MCP server: Connection refused')).toBeUndefined();
 expect(sshErrorText('en','codex: command not found')).toBeUndefined();
});
