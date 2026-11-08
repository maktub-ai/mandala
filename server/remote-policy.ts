import {isCli} from '../shared/runtimes';
import type { Config } from '../shared/types';

const id = '[a-zA-Z0-9_-]{1,100}';
const conversation = new RegExp(`^/api/conversations/(${id})(?:/([^/]+)(?:/(${id}))?)?$`);
const task = new RegExp(`^/api/v2/tasks/${id}/(control|stop)$`);
const assetFile = new RegExp(`^/api/v2/assets/${id}/versions/${id}/files/${id}$`);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const only = (value: unknown, fields: string[]) => record(value) && Object.keys(value).every(key => fields.includes(key));
const identifier = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const queryOnly = (url: URL, keys: string[]) => [...url.searchParams.keys()].every(key => keys.includes(key) && url.searchParams.getAll(key).length === 1);

/** Host-enforced allowlist. Adding a local endpoint does not grant remote authority. */
export function remoteRequestAllowed(method: string, target: string, body?: unknown): boolean {
  if (!target.startsWith('/api/') || target.includes('#') || target.includes('\\')) return false;
  const pathname = target.split('?')[0];
  if (pathname.includes('%') || pathname.slice(1).split('/').some(part => part === '.' || part === '..' || !part)) return false;
  let url: URL;
  try { url = new URL(target, 'http://local.invalid'); } catch { return false; }
  const path = url.pathname;
  if (path !== pathname) return false;
  if (path === '/api/remote/config') return method === 'GET' && queryOnly(url, []);
  if (path === '/api/conversations') {
    if (method === 'GET') return queryOnly(url, ['projectId', 'agentId']);
    return method === 'POST' && queryOnly(url, []) && only(body, ['agentId', 'projectId', 'model']) &&
      Object.entries(body as Record<string, unknown>).every(([key, value]) => key === 'model' ? typeof value === 'string' && value.length <= 200 : value === '' || value === null || identifier(value));
  }
  if (path === '/api/v2/tasks') return method === 'GET' && queryOnly(url, ['projectId', 'conversationId']);
  const matchedTask = task.exec(path);
  if (matchedTask) {
    if (matchedTask[1] === 'control') return method === 'GET' && queryOnly(url, []);
    return method === 'POST' && queryOnly(url, []) && only(body, ['expectedRevision']) && Number.isSafeInteger((body as Record<string, unknown>).expectedRevision) && Number((body as Record<string, unknown>).expectedRevision) >= 1;
  }
  if (assetFile.test(path)) return ['GET', 'HEAD'].includes(method) && queryOnly(url, []);
  const match = conversation.exec(path);
  if (!match) return false;
  const [, , action, itemId] = match;
  if (method === 'GET') {
    if (!action) return queryOnly(url, []);
    if (['history', 'events'].includes(action) && !itemId) return queryOnly(url, ['after', 'limit']);
    if (action === 'queue' && !itemId) return queryOnly(url, []);
    if (action === 'attachments' && itemId) return queryOnly(url, ['download']);
    return false;
  }
  if (method !== 'POST') return false;
  if (action === 'attachments' && !itemId) return queryOnly(url, ['name']) && Boolean(url.searchParams.get('name'));
  if (!queryOnly(url, [])) return false;
  if (action === 'stop' && !itemId) return only(body, ['expectedExecutionId']) &&
    ((body as Record<string, unknown>).expectedExecutionId === null || identifier((body as Record<string, unknown>).expectedExecutionId));
  if (action === 'approvals' && itemId) return only(body, ['decision']) && ['approve', 'reject', 'reject-stop'].includes(String((body as Record<string, unknown>).decision));
  if (action === 'questions' && itemId) return only(body, ['answers']) && record((body as Record<string, unknown>).answers);
  if (['queue', 'continue'].includes(action ?? '') && !itemId) {
    if (!only(body, ['text', 'commandKey', 'attachments', 'references'])) return false;
    const input = body as Record<string, unknown>;
    return typeof input.text === 'string' && input.text.length <= 1024 * 1024 && typeof input.commandKey === 'string' && input.commandKey.length > 0 && input.commandKey.length <= 200 &&
      (input.attachments === undefined || Array.isArray(input.attachments) && input.attachments.length <= 8 && input.attachments.every(identifier)) &&
      (input.references === undefined || Array.isArray(input.references) && input.references.length <= 20 && input.references.every(value => only(value, ['id']) && typeof value.id === 'string' && value.id.length <= 2000));
  }
  return false;
}

/** Deliberate projection: future configuration fields stay private by default. */
export function remoteConfigSummary(config: Config) {
  return {
    agents: config.agents.map(agent => ({id: agent.id, name: agent.name, defaultCli: agent.defaultCli, models: Object.fromEntries(Object.entries(agent.models).filter(([cli, model]) => isCli(cli) && typeof model === 'string'))})),
    projects: config.projects.map(project => ({id: project.id, name: project.name, agentIds: [...project.agentIds]})),
    settings: {localExecution: true as const, remoteConfiguration: 'read-only' as const},
  };
}
