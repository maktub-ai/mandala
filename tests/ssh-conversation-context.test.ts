import { expect, test } from 'vitest';
import type { Config, Conversation } from '../shared/types';
import { conversationContext, hostContextInstructions } from '../server/conversation-context';

function fixture() {
  const config: Config = { version: 2, agents: [], executionMachines: [{ id: 'dev', name: 'Dev', host: 'dev-server' }], projects: [{ id: 'project', name: 'Project', cwd: '/srv/project', agentIds: [], mcp: [], skills: [], resources: [], workspaces: [{ id: 'work', name: 'Server', cwd: '/srv/project', machineId: 'dev', resources: [] }] }] };
  const chat: Conversation = { id: 'chat', projectId: 'project', agentId: '', cli: 'codex', model: null, title: null, nativeId: null, turnId: null, status: 'idle', createdAt: '', workspaceId: 'work', cwd: '/srv/project', executionLocation: { machineId: 'dev', machineName: 'Dev', host: 'dev-server', cwd: '/srv/project' } };
  return { config, chat };
}

test('an existing remote conversation keeps its machine and directory after workspace and host edits', () => {
  const { config, chat } = fixture();
  config.executionMachines![0].host = 'other-server';
  config.projects[0].workspaces![0].cwd = '/srv/other';
  config.projects[0].workspaces![0].resources = [{ id: 'extra', label: 'Other host', kind: 'local', location: '/srv/other' }];
  const context = conversationContext(config, chat, '/local/fallback');
  expect(context.executionLocation).toEqual(chat.executionLocation);
  expect(context.project.cwd).toBe('/srv/project');
  expect(context.project.resources).toEqual([]);
});

test('a legacy local conversation stays local if its workspace later becomes remote', () => {
  const { config, chat } = fixture();
  delete chat.executionLocation;
  chat.cwd = '/local/original';
  config.projects[0].workspaces![0].resources = [{ id: 'extra', label: 'Remote resource', kind: 'local', location: '/srv/extra' }];
  const context = conversationContext(config, chat, '/local/fallback');
  expect(context.executionLocation).toBeUndefined();
  expect(context.project.cwd).toBe('/local/original');
  expect(context.project.resources).toEqual([]);
});

test('new workspace selection resolves the remote machine and host instructions disclose it', () => {
  const { config } = fixture();
  const context = conversationContext(config, { projectId: 'project', workspaceId: 'work' }, '/local/fallback');
  expect(context.executionLocation).toMatchObject({ host: 'dev-server', cwd: '/srv/project' });
  expect(hostContextInstructions(context, 'new-chat', 'codex')).toContain('dev-server');
  expect(hostContextInstructions(context, 'new-chat', 'codex')).toContain('"kind":"ssh"');
});

test('a pinned remote location remains readable when the directory group is removed', () => {
  const { config, chat } = fixture();
  config.projects[0].workspaces = [];
  config.executionMachines = [];
  const context = conversationContext(config, chat, '/local/fallback');
  expect(context.project.cwd).toBe('/srv/project');
  expect(context.executionLocation?.host).toBe('dev-server');
});
