#!/usr/bin/env node
import { constants } from 'node:fs';
import { lstat, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { productEnv, productHome } from './product-env.mjs';
import { codexMailboxSid, ownedPrivatePath } from './private-path.mjs';
import { COMMANDS, boundArguments, findCommand, resolveRequest } from './commands.mjs';

const fail = (code, message, status, details) => { throw Object.assign(new Error(message), { code, status, details }); };
function options(argv) {
  const values = {}, words = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') { values.help = true; continue; }
    if (argument === '--json') continue;
    if (!argument.startsWith('--')) { words.push(argument); continue; }
    const equals = argument.indexOf('='), flag = argument.slice(2, equals < 0 ? undefined : equals);
    const name = flag === 'command-key' ? 'key' : flag;
    if (!['data', 'query', 'key', 'base-url', 'input', 'output', 'range', 'if-range'].includes(name)) fail('invalid_arguments', `Unknown option --${flag}`);
    if (values[name] !== undefined) fail('invalid_arguments', `Repeated option --${flag}`);
    const value = equals < 0 ? argv[++index] : argument.slice(equals + 1);
    if (!value || value.startsWith('--')) fail('invalid_arguments', `Missing value for --${flag}`);
    values[name] = value;
  }
  return { values, words };
}
async function jsonInput(value, label) {
  if (value === undefined) return {};
  let text;
  try { text = value.startsWith('@') ? await readFile(value.slice(1), 'utf8') : value; }
  catch { fail('invalid_arguments', `Cannot read ${label} file`); }
  if (Buffer.byteLength(text) > 262144) fail('invalid_arguments', `${label} exceeds 256 KiB`);
  let data; try { data = JSON.parse(text); } catch { fail('invalid_arguments', `${label} must be valid JSON`); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('invalid_arguments', `${label} must be a JSON object`);
  return data;
}
export function loopbackBase(value) {
  // Check the supplied spelling before URL canonicalization (127.1 and hex hosts normalize).
  if (typeof value !== 'string' || !/^https?:\/\/(?:localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])(?::\d+)?\/?$/.test(value)) fail('invalid_base_url', 'Base URL must be a loopback HTTP URL without credentials, path, query or fragment');
  let url; try { url = new URL(value); } catch { fail('invalid_base_url', 'Invalid loopback URL'); }
  if (url.hostname.startsWith('127.') && url.hostname.split('.').some(part => Number(part) > 255)) fail('invalid_base_url', 'Invalid loopback address');
  return url.origin;
}
async function invocationContext(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || !ownedPrivatePath(path, stat, 16384)) throw new Error();
    const context = JSON.parse(await readBounded(handle, 16384));
    if (!context || typeof context !== 'object' || Object.keys(context).some(key => !['baseUrl', 'token', 'mailboxPath', 'codexCapabilitiesFile'].includes(key)) || typeof context.token !== 'string' || !context.token || /[\r\n]/.test(context.token)) throw new Error();
    const { mailboxPath, codexCapabilitiesFile } = context;
    if (codexCapabilitiesFile !== undefined && (process.platform !== 'win32' || !mailboxPath || typeof codexCapabilitiesFile !== 'string' || !isAbsolute(codexCapabilitiesFile))) throw new Error();
    let mailboxSid;
    if (mailboxPath !== undefined) {
      if (typeof mailboxPath !== 'string' || !isAbsolute(mailboxPath) || mailboxPath !== join(dirname(resolve(path)), 'mailbox')) throw new Error();
      mailboxSid = await codexMailboxSid(codexCapabilitiesFile, mailboxPath);
      await mailboxDirectory(mailboxPath, mailboxSid);
    }
    return { baseUrl: loopbackBase(context.baseUrl), token: context.token, mailboxPath, mailboxSid };
  } catch { fail('invalid_context', 'MANDALA_CONTEXT (or OPEN_MANA_CONTEXT) must be a private, owned regular JSON file containing baseUrl and token'); }
  finally { await handle?.close(); }
}
async function mailboxDirectory(path, mailboxSid) {
  let stat; try { stat = await lstat(path); } catch { fail('invalid_context', 'Invocation mailbox expired or unavailable'); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !ownedPrivatePath(path, stat, Infinity, mailboxSid)) fail('invalid_context', 'Invocation mailbox must be an owned private directory');
}
async function readBounded(handle, limit) {
  const bytes = Buffer.alloc(limit + 1); let size = 0;
  while (size < bytes.length) {
    const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
    if (!bytesRead) break; size += bytesRead;
  }
  if (size > limit) fail('invalid_response', 'Invocation response exceeds its size limit');
  return bytes.subarray(0, size).toString('utf8');
}
export async function invokeMailbox(mailboxPath, command, timeoutMs = 120000, mailboxSid) {
  await mailboxDirectory(mailboxPath, mailboxSid);
  const id = randomUUID(), temporary = join(mailboxPath, `${id}.tmp`), requestPath = join(mailboxPath, `${id}.request`), responsePath = join(mailboxPath, `${id}.response`);
  const bytes = JSON.stringify(command);
  if (Buffer.byteLength(bytes) > 262144) fail('invalid_arguments', 'Invocation request exceeds 256 KiB');
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
    await rename(temporary, requestPath);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await mailboxDirectory(mailboxPath, mailboxSid);
      let handle;
      try { handle = await open(responsePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) { if (error.code !== 'ENOENT') fail('invalid_response', 'Invocation response is not a readable regular file'); }
      if (handle) {
        let response;
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || !ownedPrivatePath(responsePath, stat, 8 * 1024 * 1024, mailboxSid)) fail('invalid_response', 'Invocation response must be a private regular file under 8 MiB');
          try { response = JSON.parse(await readBounded(handle, 8 * 1024 * 1024)); } catch { fail('invalid_response', 'Invocation returned invalid or oversized JSON'); }
        } finally { await handle.close(); }
        if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean') fail('invalid_response', 'Invocation returned an invalid envelope');
        if (!response.ok) {
          if (!response.error || typeof response.error.code !== 'string' || typeof response.error.message !== 'string') fail('invalid_response', 'Invocation returned an invalid error');
          fail(response.error.code, response.error.message, response.error.status);
        }
        return response.data;
      }
      if (Date.now() >= deadline) fail('command_unconfirmed', 'Invocation response timed out; query the result before manually retrying with the same key');
      await new Promise(done => setTimeout(done, Math.min(50, deadline - Date.now())));
    }
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) fail('invalid_context', 'Invocation mailbox expired or unavailable');
    throw error;
  } finally {
    // unlink never follows a response symlink; the host may already have removed requests.
    await Promise.all([temporary, requestPath, responsePath].map(path => unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; })));
  }
}
function help(words) {
  const name = words.slice(0, 2).join(' '), entry = findCommand(name);
  const entries = entry ? [entry] : COMMANDS.filter(item => !words.length || item.name.split(' ')[0] === words[0]);
  if (!entries.length || words.length > 1 && !entry) fail('unknown_command', 'Unknown command');
  return {
    usage: 'mandala <group> <action> [ids] [--data JSON|@file] [--query JSON|@file] [--key KEY] [--base-url URL]',
    options: { '--data': 'JSON request body; @file reads UTF-8 JSON', '--query': 'JSON query parameters', '--key': 'Stable mutation key; generated if omitted (--command-key alias)', '--base-url': 'Local service URL (default http://127.0.0.1:4332); forbidden in Agent mode', '--input': 'File bytes for upload', '--output': 'Required destination for binary downloads', '--range': 'HTTP byte range for assets read/inspect', '--if-range': 'ETag for conditional byte ranges', '--help': 'Root, group or action help' },
    commands: entries.map(item => ({ command: item.name, ids: item.idParams, method: item.method, path: item.path, agent: Boolean(item.boundTool), ...(item.boundTool ? { boundFields: item.boundFields } : {}), ...(item.invocationOnly ? { invocationOnly: true } : {}), ...(item.transport ? { transport: item.transport } : {}), ...inputHelp(item) })),
  };
}
function inputHelp(entry) {
  const examples = {
    'progress report': {text:'Checking source inputs',steps:[{text:'Read inputs',status:'running'}]},
    'skills find': { query: 'query review' },
    'skills register': { name: 'query-review', content: '---\nname: query-review\ndescription: Review queries\n---\nCheck predicates.' },
    'config put': { revision: '<config revision>', config: '<complete configuration>' },
    'agents upsert': { revision: '<config revision>', agent: { id: 'agent-id', name: 'Agent', instructions: '', defaultCli: 'codex', models: {}, mcp: [], skills: [] } },
    'projects upsert': { revision: '<config revision>', project: { id: 'project-id', name: 'Project', cwd: '/absolute/workspace', agentIds: ['agent-id'], resources: [], mcp: [], skills: [] } },
    'agents remove': { revision: '<config revision>' }, 'projects remove': { revision: '<config revision>' },
    'conversations create': { projectId: 'project-id', agentId: 'agent-id', cli: 'codex' },
    'conversations rename': { title: 'New title' }, 'conversations send': { text: 'Request', attachments: [] },
    'conversations enqueue': { text: 'Independent follow-up', attachments: [] }, 'conversations continue': { text: 'Continue', attachments: [] },
    'conversations model': { model: '<native model id>' }, 'conversations approval-mode': { approvalMode: 'auto' },
    'conversations completion': { completed: true }, 'conversations archive': { archived: true },
    'conversations fork': { eventId: 1 }, 'conversations branch': { eventId: 1, text: 'Replacement request' }, 'conversations edit': { eventId: 1, text: 'Edited request' },
    'conversations approve': { decision: 'approve' }, 'conversations answer': { answers: {} },
    'conversations workspace-file': { path: 'README.md' }, 'conversations local-file': { href: 'file:///absolute/output.txt' },
    'tasks create': { goal: 'Write a report', criteria: [{id:'evidence',text:'Return verifiable evidence',checkRef:null}], acceptance:'human', projectId: null, assigneeAgentId: null, participantAgentIds: [], originConversationId: null },
    'tasks update': { expectedRevision: 1, goal: 'Updated report goal', projectId: null, participantAgentIds: ['agent-id'], originConversationId: null },
    'tasks execution-add': { conversationId:'chat-id', expectedRevision: 1 }, 'tasks execution-remove': { expectedRevision: 1 },
    'messages ask': {sourceConversationId:'chat-id',targetAgentId:'agent-id',text:'Confirm the parameter',policy:'resume'},
    'tasks delegate': { sourceConversationId: 'chat-id', targetAgentId: 'agent-id', request: 'Review', policy: 'resume' },
    'tasks adopt-plan': { plan: { assetId: 'asset-id', versionId: 'version-id' }, steps: [{ key: 'step-1', goal: 'First step' }] },
    'assets create': { kind: 'document', title: 'Report' }, 'assets import': { kind: 'document', title: 'Report', submissionId: '<upload result>' },
    'assets publish': { expectedHeadVersionId: null, submissionId: '<upload result>', provenance: { sourceVersions: [] } },
    'assets access': { expectedRevision: 1, policy: { mode: 'private', agentIds: [], projectIds: [] } },
    'assets lifecycle': { expectedRevision: 1, lifecycle: 'archived' },
    'assets bind': { ownerType: 'project', ownerId: 'project-id', versionPolicy: 'latest' },
    'assets unbind': { ownerType: 'project', ownerId: 'project-id' },
    'memory search': { query: 'Historical decision', projectId: 'project-id' }, 'memory organize': { conversationId: 'chat-id' },
    'memory correct': { expectedRevision: 1, text: 'Corrected fact' }, 'memory retract': { expectedRevision: 1 },
    'market install': { revision: '<config revision>', catalogId: '<market detail catalogId>', version: '<catalog version>', targets: [] },
    'market unlink': { revision: '<config revision>', target: '<installed target>' }, 'market uninstall': { revision: '<config revision>' },
    'automations create': { name: 'Daily review', instructions: 'Review the draft', projectId: 'project-id', agentId: 'agent-id', cli: 'codex', enabled: false, schedule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Singapore' } },
    'automations update': { expectedRevision: 1, enabled: false }, 'automations remove': { expectedRevision: 1 },
    'terminal open': { cols: 100, rows: 30 }, 'terminal close': { sessionId: 'session-id' },
    'terminal input': { sessionId: 'session-id', data: 'pwd\n' }, 'terminal resize': { sessionId: 'session-id', cols: 100, rows: 30 },
  };
  const queryExamples = {
    'directories list': { path: '/absolute/directory' }, 'capabilities list': { cli: 'codex', kind: 'skills', projectId: 'project-id', agentId: 'agent-id' },
    'capabilities effective': { cli: 'codex', kind: 'skills', projectId: 'project-id', agentId: 'agent-id' },
    'models list': { cli: 'codex', scope: 'project', projectId: 'project-id' }, 'cli status': { cli: 'codex' },
    'conversations list': { query: 'Report', projectId: 'project-id', agentId: 'agent-id' }, 'conversations history': { after: 0 }, 'conversations events': { after: 0 }, 'conversations workspace': { scope: 'all' },
    'conversations attachment': { download: 1 }, 'conversations upload': { name: 'input.txt' }, 'assets upload': { name: 'input.txt' },
    'assets bindings': { ownerType: 'project', ownerId: 'project-id' }, 'tasks context': { conversationId: 'chat-id' }, 'tasks list': { query: 'Report', projectId: 'project-id', conversationId: 'chat-id' },
    'tasks source': { assetId: 'asset-id', versionId: 'version-id' }, 'tasks legacy-list': { projectId: 'project-id', view: 'control' },
    'memory list': { projectId: 'project-id', status: 'active' }, 'market search': { kind: 'skill', query: 'review' },
    'market detail': { catalogId: '<search result catalogId>' }, 'terminal events': { sessionId: 'session-id' },
  };
  let dataExample = examples[entry.name];
  if (entry.name.startsWith('tasks ') && ['start', 'stop', 'cancel', 'review', 'complete', 'mark-completed', 'accept', 'reopen', 'request-changes', 'assign'].includes(entry.name.split(' ')[1])) {
    dataExample = { expectedRevision: 1, ...(['reopen', 'request-changes'].some(action => entry.name.endsWith(action)) ? { reason: 'Needs changes' } : {}), ...(entry.name.endsWith('assign') ? { agentId: 'agent-id' } : {}) };
  }
  const agentExamples = { message_ask:{targetAgentId:'agent-id',text:'Confirm the parameter',policy:'resume'},message_read:{messageId:'message-id'}, delegate: { targetAgentId: 'agent-id', request: 'Review', policy: 'resume' }, artifact_publish: { title: 'Report', files: [{ path: 'report.txt' }] }, artifact_read: { assetId: 'asset-id', versionId: 'version-id', fileId: '0' }, memory_search: { query: 'Historical decision' }, memory_read: { recordId: 'record-id' }, project_agents: {},
    mandala_discover_capabilities:{directories:[],query:'',limit:150},mandala_discover_work:{includePaths:[],excludePaths:[],limit:50},mandala_planning_guide:{},
    mandala_create:{goal:'Investigate the question',criteria:[{id:'evidence',text:'Return verifiable evidence',checkRef:null}],projectId:null},
    mandala_takeover:{taskId:'task-id',expectedRevision:1,criteria:[{id:'evidence',text:'Return verifiable evidence',checkRef:null}]},
    mandala_delegate:{taskId:'task-id',targetAgentId:'agent-id',projectId:null,request:'Investigate and return evidence',criteria:[{id:'evidence',text:'Return verifiable evidence',checkRef:null}]},
    ...Object.fromEntries(['review','mark_completed','accept','cancel','stop'].map(action=>['task_'+action,{taskId:'task-id',expectedRevision:1}])),
    task_start:{taskId:'task-id',expectedRevision:1,conversationId:null},task_reopen:{taskId:'task-id',expectedRevision:1},task_request_changes:{taskId:'task-id',expectedRevision:1,reason:'Needs changes'},task_assign:{taskId:'task-id',expectedRevision:1,agentId:'agent-id'},
    task_context: {}, task_list: { query: 'Report', conversationId: 'chat-id' }, task_read: { taskId: 'task-id' },
    task_create: examples['tasks create'], task_update: { taskId: 'task-id', expectedRevision: 1, goal: 'Updated report goal', projectId: null },
    task_execution_add: { taskId: 'task-id', expectedRevision: 1, conversationId: 'chat-id' }, task_execution_remove: { taskId: 'task-id', expectedRevision: 1, executionId: 'execution-id' },
    conversation_list: { query: 'Report' }, conversation_read: { conversationId: 'chat-id' }, conversation_history: { conversationId: 'chat-id', after: 0 },
  };
  return { ...(['task_create','task_update','mandala_create','mandala_takeover','mandala_delegate'].includes(entry.boundTool)?{criteriaShape:{id:'unique string',text:'non-empty string',checkRef:'null or check reference'},criteriaShorthand:'Bound Agent commands also accept one text or an array of texts; the host assigns stable criterion IDs.'}:{}), ...(entry.boundTool==='task_create'?{acceptanceValues:['delivery','checks','human']}:{}), ...(dataExample ? { dataExample } : {}), ...(queryExamples[entry.name] ? { queryExample: queryExamples[entry.name] } : {}), ...(entry.boundTool ? { agentDataExample: agentExamples[entry.boundTool] } : {}), ...(entry.name === 'tasks get' ? { resultShape: { user: 'Task detail with runs and receipts', agent: 'Task; verified system Agent receives a readOnly task summary without private execution context' } } : {}), ...(['tasks list','tasks runs'].includes(entry.name) ? { note:'Verified system Agent reads return readOnly summaries. Run summaries omit native IDs, context snapshots, file references and raw events; delivery text is redacted when source/output access is unavailable. Observation never grants mutation or takeover authority.' } : {}), ...(entry.name === 'tasks create' ? { note: 'Project is optional; Agents must explicitly supply projectId (null allowed). Add execution Chats with tasks execution-add. Saving never starts execution. Users and authorized Agents may explicitly mark a Task completed. A successful Run alone does not complete the goal.' } : {}), ...(entry.name === 'tasks mark-completed' ? {note:'Explicitly mark completed. Other active or uncertain Runs block this action. For the current executor Run, completionRequested:true records intent applied only after successful settled delivery. Records the accepting user or Agent and disables old continuations.'} : {}), ...(entry.name === 'tasks accept' ? {note:'Accept a reviewed Task. Available to users and authorized Agents.'} : {}), ...(entry.name === 'tasks review' || entry.name === 'tasks complete' ? { note: 'Request review; this does not accept or complete the Task.' } : {}), ...(entry.name.startsWith('system-tasks ') ? { kindValues: ['title', 'memory'] } : {}) };
}
async function request(baseUrl, method, path, { data, key, journal, token, upload, range, ifRange, localKey } = {}) {
  const headers = { Accept: 'application/json' };
  if (localKey) { headers['X-Mandala-Local-Key'] = localKey; headers['X-OpenMana-Local-Key'] = localKey; }
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers['Idempotency-Key'] = key;
  if (journal) { headers['X-Mandala-CLI'] = '1'; headers['X-OpenMana-CLI'] = '1'; }
  if (range) headers.Range = range;
  if (ifRange) headers['If-Range'] = ifRange;
  let body;
  if (upload !== undefined) { headers['Content-Type'] = 'application/octet-stream'; body = upload; }
  else if (!['GET', 'HEAD'].includes(method)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(data ?? {}); }
  let response;
  try { response = await fetch(baseUrl + path, { method, headers, body, redirect: 'manual' }); }
  catch { fail('connection_failed', 'Cannot reach Mandala local service'); }
  if (!response.ok) {
    let details; try { details = await response.json(); } catch { details = undefined; }
    fail(details?.code || (typeof details?.error === 'string' && /^[a-z][a-z0-9_]*$/.test(details.error) ? details.error : 'http_error'), details?.message || details?.error || `HTTP ${response.status}`, response.status, details);
  }
  return response;
}
async function responseJson(response) {
  try { return await response.json(); } catch { fail('invalid_response', 'Service returned invalid JSON'); }
}
async function configCommand(entry, resolved, baseUrl, key, localKey) {
  const data = resolved.data;
  if (['upsert', 'remove'].includes(entry.configAction)) {
    if (typeof data.revision !== 'string' || !data.revision) fail('revision_required', 'Supply the configuration revision in --data');
    const allowed = entry.configAction === 'upsert' ? ['revision', entry.configEntity === 'agents' ? 'agent' : 'project'] : ['revision'];
    if (Object.keys(data).some(name => !allowed.includes(name))) fail('invalid_arguments', 'Unknown configuration edit field');
    const singular = entry.configEntity === 'agents' ? 'agent' : 'project', entity = data[singular];
    if (entry.configAction === 'upsert' && (!entity || typeof entity !== 'object' || Array.isArray(entity) || typeof entity.id !== 'string' || !entity.id)) fail('invalid_arguments', `Supply complete ${singular} with id`);
    return responseJson(await request(baseUrl, 'POST', entry.path, { data: { ...data, ...(entry.configAction === 'remove' ? { id: resolved.parameters.id } : {}) }, key, journal: true, localKey }));
  } else if (Object.keys(data).length) fail('invalid_arguments', 'This configuration read accepts only positional IDs');
  const snapshot = await responseJson(await request(baseUrl, 'GET', '/api/config', { localKey }));
  if (entry.configEntity === 'projectAgents') {
    const project = snapshot.config.projects.find(item => item.id === resolved.parameters.projectId);
    if (!project) fail('not_found', 'Project not found', 404);
    return { revision: snapshot.revision, agents: snapshot.config.agents.filter(item => project.agentIds.includes(item.id)).map(({ id, name }) => ({ id, name })) };
  }
  const list = snapshot.config[entry.configEntity], singular = entry.configEntity === 'agents' ? 'agent' : 'project';
  if (entry.configAction === 'list') return { revision: snapshot.revision, [entry.configEntity]: list };
  if (entry.configAction === 'get') {
    const entity = list.find(item => item.id === resolved.parameters.id);
    if (!entity) fail('not_found', `${singular} not found`, 404);
    return { revision: snapshot.revision, [singular]: entity };
  }
}
async function events(response, emit) {
  let pending = ''; const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    pending = pending.replace(/\r\n/g, '\n');
    let separator;
    while ((separator = pending.indexOf('\n\n')) !== -1) {
      const block = pending.slice(0, separator); pending = pending.slice(separator + 2);
      const message = { event: 'message', data: '' };
      for (const line of block.split('\n')) {
        if (line.startsWith('id:')) message.id = line.slice(3).trimStart();
        else if (line.startsWith('event:')) message.event = line.slice(6).trimStart();
        else if (line.startsWith('data:')) message.data += (message.data ? '\n' : '') + line.slice(5).trimStart();
      }
      if (message.data === '') continue;
      try { message.data = JSON.parse(message.data); } catch { /* SSE text remains text. */ }
      emit(message);
    }
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let name = '', key, token;
  const output = (value, error = false) => {
    const line = JSON.stringify(value, (_name, item) => token && typeof item === 'string' ? item.replaceAll(token, '[redacted]') : item);
    (error ? process.stderr : process.stdout).write(line + '\n');
  };
  const success = data => output({ ok: true, command: name, ...(key ? { commandKey: key } : {}), data });
  try {
    const { values, words } = options(argv);
    if (words[0] === 'help') { words.shift(); values.help = true; }
    if (values.help || words.length === 0) { name = words.join(' '); success(help(words)); return 0; }
    name = words.slice(0, 2).join(' ');
    const entry = findCommand(name); if (!entry) fail('unknown_command', 'Unknown command; use mandala --help');
    const ids = words.slice(2), data = await jsonInput(values.data, '--data'), query = await jsonInput(values.query, '--query');
    let context;
    if (productEnv('CONTEXT', env)) {
      context = await invocationContext(productEnv('CONTEXT', env)); token = context.token;
      if (!entry.boundTool) fail('forbidden_command', 'Command is unavailable to Agents');
      if (['base-url', 'input', 'output', 'range', 'if-range', 'query'].some(option => values[option] !== undefined)) fail('invalid_arguments', 'Agent context determines destination and permitted arguments');
    }
    if (entry.invocationOnly && !context) fail('forbidden_command', 'This command requires an active Agent invocation');
    const mutation = !['GET', 'HEAD'].includes(entry.method) && !entry.readOnly && entry.transport !== 'upload';
    key = values.key ?? (mutation || context ? randomUUID() : undefined);
    if (key !== undefined && (typeof key !== 'string' || !key.trim() || key.length > 200)) fail('invalid_arguments', 'Key must contain 1–200 characters');
    const baseUrl = context?.baseUrl ?? loopbackBase(values['base-url'] ?? productEnv('BASE_URL', env) ?? 'http://127.0.0.1:4332');
    if (context) {
      const args = boundArguments(entry, ids, data);
      const invocation = { command: name, args, commandKey: key };
      success(context.mailboxPath ? await invokeMailbox(context.mailboxPath, invocation, undefined, context.mailboxSid) : await responseJson(await request(baseUrl, 'POST', '/api/cli/invoke', { token, data: invocation }))); return 0;
    }
    let localKey;
    const localKeyPath = join(productHome('workspace', env), 'local-access.key');
    try {
      const handle = await open(localKeyPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || !ownedPrivatePath(localKeyPath, stat, 128)) fail('invalid_local_identity', 'Local credential must be a private owned regular file');
        localKey = (await readBounded(handle, 128)).trim();
        if (!/^[a-f0-9]{64}$/.test(localKey)) fail('invalid_local_identity', 'Invalid local credential');
      } finally { await handle.close(); }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const resolved = resolveRequest(entry, { ids, data, query, key });
    if (entry.configEntity) { if (Object.keys(query).length) fail('invalid_arguments', 'Configuration entity commands do not accept query'); success(await configCommand(entry, resolved, baseUrl, key, localKey)); return 0; }
    if (['GET', 'HEAD'].includes(entry.method) && Object.keys(resolved.data).length) fail('invalid_arguments', 'Read commands use --query, not a request body');
    if (values.output && entry.transport !== 'binary') fail('invalid_arguments', '--output is only valid for binary downloads');
    if (values.input && entry.transport !== 'upload') fail('invalid_arguments', '--input is only valid for uploads');
    if ((values.range || values['if-range']) && !['assets read', 'assets inspect'].includes(name)) fail('invalid_arguments', 'Byte ranges are only valid for Asset files');
    if (entry.transport === 'binary' && !values.output) fail('output_required', 'Binary downloads require --output FILE');
    let upload;
    if (entry.transport === 'upload') {
      if (!values.input || Object.keys(data).length) fail('invalid_arguments', 'Uploads require --input FILE and use --query for metadata');
      try { upload = await readFile(values.input); } catch { fail('invalid_arguments', 'Cannot read upload file'); }
    }
    const response = await request(baseUrl, resolved.method, resolved.path, { data: resolved.data, key, journal: mutation, upload, range: values.range, ifRange: values['if-range'], localKey });
    if (entry.transport === 'binary') {
      const bytes = Buffer.from(await response.arrayBuffer()), path = resolve(values.output);
      await writeFile(path, bytes, { mode: 0o600 }); success({ output: path, bytes: bytes.length, contentType: response.headers.get('content-type') });
    } else if (entry.transport === 'headers') success({ status: response.status, headers: Object.fromEntries(response.headers) });
    else if (entry.transport === 'events') await events(response, success);
    else success(await responseJson(response));
    return 0;
  } catch (error) {
    output({ ok: false, command: name, ...(key ? { commandKey: key } : {}), error: { code: error.code ?? 'cli_error', message: error.message, ...(error.status ? { status: error.status } : {}), ...(error.details ? { details: error.details } : {}) } }, true);
    return 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
