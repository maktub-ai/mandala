// Shared public command inventory. The server authorizes boundTool independently.
const command = (name, method, path, extra = {}) => ({ name, method, path, idParams: [...path.matchAll(/:([A-Za-z]+)/g)].map(match => match[1]), ...extra });
const chat = '/api/conversations/:conversationId';
const asset = '/api/v2/assets/:assetId';
const task = '/api/v2/tasks/:taskId';
export const COMMANDS = [
  command('progress report', 'POST', '/api/cli/invoke', { invocationOnly:true, boundTool:'progress_report', boundFields:['text','steps'] }),
  command('service status', 'GET', '/api/status'),
  command('workbench overview', 'GET', '/api/workbench'),
  command('workspace search', 'GET', '/api/workspace-search'),
  command('usage summary', 'GET', '/api/usage'),
  command('config get', 'GET', '/api/config'), command('config put', 'PUT', '/api/config'),
  ...['agents', 'projects'].flatMap(group => ['list', 'get', 'upsert', 'remove'].map(action =>
    command(`${group} ${action}`, ['upsert', 'remove'].includes(action) ? 'POST' : 'GET', ['upsert', 'remove'].includes(action) ? `/api/cli/config/${group}/${action}` : '/api/config', {
      configEntity: group, configAction: action, idParams: ['get', 'remove'].includes(action) ? ['id'] : [],
    }))),
  command('project agents', 'GET', '/api/config', { configEntity: 'projectAgents', idParams: ['projectId'], boundTool: 'project_agents', boundFields: [] }),
  command('directories list', 'GET', '/api/directories'),
  command('capabilities list', 'GET', '/api/capabilities'), command('capabilities effective', 'GET', '/api/effective'),
  command('skills find', 'POST', '/api/cli/invoke', { readOnly: true, invocationOnly: true, boundTool: 'skill_find', boundFields: ['query'] }),
  command('skills read', 'POST', '/api/cli/invoke', { readOnly: true, invocationOnly: true, idParams: ['skillId'], boundTool: 'skill_read', boundFields: ['skillId'] }),
  command('skills register', 'POST', '/api/cli/invoke', { invocationOnly: true, boundTool: 'skill_register', boundFields: ['name', 'content'] }),
  command('skills update', 'POST', '/api/cli/invoke', { invocationOnly:true, boundTool:'skill_update', boundFields:['skillId','content','expectedVersionId'] }),
  command('skills versions', 'POST', '/api/cli/invoke', { readOnly:true, invocationOnly:true, idParams:['skillId'], boundTool:'skill_versions', boundFields:['skillId'] }),
  command('skills suggestions', 'POST', '/api/cli/invoke', { readOnly:true, invocationOnly:true, idParams:['skillId'], boundTool:'skill_suggestions', boundFields:['skillId'] }),
  command('skills accept', 'POST', '/api/cli/invoke', { invocationOnly:true, boundTool:'skill_accept', boundFields:['skillId','suggestionId'] }),
  command('skills reject', 'POST', '/api/cli/invoke', { invocationOnly:true, boundTool:'skill_reject', boundFields:['skillId','suggestionId'] }),
  ...[
    ['list','wiki_list',[],true],['create','wiki_create',['name','purpose','projectId','maintainerAgentId','automatic','reception'],false],
    ['get','wiki_get',['baseId'],true],['read','wiki_read',['baseId','pageId','versionId'],true],['search','wiki_search',['baseId','query'],true],
    ['add-source','wiki_add_source',['baseId','assetId','versionId','replace'],false],['remove-source','wiki_remove_source',['baseId','sourceId'],false],
    ['configure','wiki_configure',['baseId','expectedRevision','automatic','reception','purpose','maintainerAgentId'],false],['refresh','wiki_refresh',['baseId'],false],
    ['edit','wiki_edit',['baseId','pageId','body','expectedHeadVersionId'],false],['versions','wiki_versions',['baseId'],true],['restore','wiki_restore',['baseId','versionId','expectedHeadVersionId'],false],
  ].map(([name,boundTool,boundFields,readOnly])=>command('wiki '+name,'POST','/api/cli/invoke',{invocationOnly:true,boundTool,boundFields,readOnly})),
  ...[['status',[]],['refresh',['bindingId']],['search',['bindingId','query']],['definition',['bindingId','nodeId']],['callers',['bindingId','nodeId','depth']],['callees',['bindingId','nodeId','depth']]].map(([name,boundFields])=>command('code-graph '+name,'POST','/api/cli/invoke',{invocationOnly:true,boundTool:'code_graph_'+name,boundFields,readOnly:name!=='refresh'})),
  command('models list', 'GET', '/api/models'), command('cli status', 'GET', '/api/cli/status'),
  command('knowledge list', 'GET', '/api/knowledge'), command('knowledge create', 'POST', '/api/knowledge'),
  command('knowledge update', 'PATCH', '/api/knowledge/:knowledgeId'), command('knowledge remove', 'DELETE', '/api/knowledge/:knowledgeId'),
  command('conversations list', 'GET', '/api/conversations', { boundTool: 'conversation_list', boundFields: ['query', 'projectId', 'agentId'] }), command('conversations create', 'POST', '/api/conversations'),
  command('conversations get', 'GET', chat, { boundTool: 'conversation_read', boundFields: ['conversationId'] }), command('conversations rename', 'PATCH', chat),
  command('conversations workspace', 'GET', `${chat}/workspace`),
  command('conversations workspace-file', 'POST', `${chat}/workspace-file`, { readOnly: true }), command('conversations local-file', 'POST', `${chat}/local-file`, { readOnly: true }),
  command('conversations upload', 'POST', `${chat}/attachments`, { transport: 'upload' }),
  command('conversations attachment', 'GET', `${chat}/attachments/:attachmentId`, { transport: 'binary' }),
  command('conversations queue', 'GET', `${chat}/queue`), command('conversations enqueue', 'POST', `${chat}/queue`, { bodyKey: true }),
  command('conversations cancel-input', 'DELETE', `${chat}/queue/:inputId`),
  command('conversations history', 'GET', `${chat}/history`, { boundTool: 'conversation_history', boundFields: ['conversationId', 'after'] }), command('conversations events', 'GET', `${chat}/events`, { transport: 'events' }),
  ...['model', 'approval-mode', 'completion', 'archive', 'title', 'memory', 'fork', 'branch', 'edit', 'continue', 'stop'].map(action => command(`conversations ${action}`, 'POST', `${chat}/${action}`)),
  command('conversations send', 'POST', `${chat}/messages`), command('conversations answer', 'POST', `${chat}/questions/:questionId`),
  command('conversations approve', 'POST', `${chat}/approvals/:approvalId`),
  command('messages ask', 'POST', '/api/agent-messages', {bodyKey:true,boundTool:'message_ask',boundFields:['targetAgentId','text','targetConversationId','policy']}),
  command('messages get', 'GET', '/api/agent-messages/:messageId', {boundTool:'message_read',boundFields:['messageId']}),
  command('tasks legacy-list', 'GET', '/api/tasks'),
  ...[['directory',[]],['discover-capabilities',['runtimes','directories','query','limit']],['discover-work',['runtimes','includePaths','excludePaths','limit']],['planning-guide',[]],['goals',[]],['receipts',['taskId']],['create',['goal','criteria','projectId']],['takeover',['taskId','expectedRevision','criteria']],['delegate',['taskId','targetAgentId','projectId','request','criteria']],['request',['taskId','expectedRevision','text','blocked']],['configure',['change','mode']],['temporary',['templateAgentId','name','projectId']]].map(([name,boundFields])=>command('mandala '+name,'POST','/api/cli/invoke',{invocationOnly:true,boundTool:'mandala_'+name.replaceAll('-','_'),boundFields,readOnly:['directory','discover-capabilities','discover-work','planning-guide','goals','receipts'].includes(name)})),
  command('tasks delegate', 'POST', '/api/tasks', { bodyKey: true, boundTool: 'delegate', boundFields: ['targetAgentId', 'request', 'targetConversationId', 'policy'] }),
  command('system-tasks status', 'GET', '/api/system-tasks/:conversationId'),
  command('system-tasks run', 'POST', '/api/system-tasks/:conversationId/:kind/run'),
  command('system-tasks stop', 'POST', '/api/system-tasks/:conversationId/:kind/stop'),
  command('tasks draft', 'POST', '/api/v2/tasks/draft'),
  command('tasks context', 'GET', '/api/v2/tasks/context', { boundTool: 'task_context', boundFields: [] }),
  command('tasks list', 'GET', '/api/v2/tasks', { boundTool: 'task_list', boundFields: ['query', 'projectId', 'conversationId'] }),
  command('tasks create', 'POST', '/api/v2/tasks', { boundTool: 'task_create', boundFields: ['goal', 'criteria', 'acceptance', 'projectId', 'assigneeAgentId', 'participantAgentIds', 'originConversationId'] }),
  command('tasks update', 'PATCH', task, { boundTool: 'task_update', boundFields: ['taskId', 'expectedRevision', 'goal', 'criteria', 'projectId', 'assigneeAgentId', 'participantAgentIds', 'originConversationId', 'state'] }),
  command('tasks execution-add', 'POST', `${task}/executions`, {boundTool:'task_execution_add',boundFields:['taskId','expectedRevision','conversationId']}),
  command('tasks execution-remove', 'POST', `${task}/executions/:executionId/remove`, {boundTool:'task_execution_remove',boundFields:['taskId','expectedRevision','executionId']}),
  command('tasks review', 'POST', `${task}/complete`, {boundTool:'task_review',boundFields:['taskId','expectedRevision']}),
  command('tasks mark-completed', 'POST', `${task}/mark-completed`, {boundTool:'task_mark_completed',boundFields:['taskId','expectedRevision']}),
  command('tasks runs', 'GET', `${task}/runs`, {boundTool:'task_runs',boundFields:['taskId']}),
  command('tasks get', 'GET', task, { boundTool: 'task_read', boundFields: ['taskId'] }), command('tasks control', 'GET', `${task}/control`),
  command('tasks adopt-plan', 'POST', '/api/v2/tasks/adopt-plan'), command('tasks source', 'GET', '/api/v2/tasks/source'),
  ...['start', 'stop', 'cancel', 'complete', 'accept', 'reopen', 'assign'].map(action => command(`tasks ${action}`, 'POST', `${task}/${action}`, {boundTool:action==='complete'?'task_review':`task_${action}`,boundFields:['taskId','expectedRevision',...(action==='start'?['conversationId']:action==='reopen'?['reason','expectedOutput']:action==='assign'?['agentId']:[])]})),
  command('tasks request-changes', 'POST', `${task}/request_changes`, {boundTool:'task_request_changes',boundFields:['taskId','expectedRevision','reason','expectedOutput']}),
  command('assets list', 'GET', '/api/v2/assets'), command('assets create', 'POST', '/api/v2/assets'),
  command('assets get', 'GET', asset), command('assets upload', 'POST', '/api/v2/assets/uploads', { transport: 'upload' }),
  command('assets import', 'POST', '/api/v2/assets/imports'), command('assets versions', 'GET', `${asset}/versions`),
  command('assets publish', 'POST', `${asset}/versions`, { boundTool: 'artifact_publish', boundFields: ['title', 'files'] }),
  command('assets update', 'POST', '/api/cli/invoke', { invocationOnly: true, boundTool: 'artifact_update', boundFields: ['assetId', 'expectedHeadVersionId', 'path'] }),
  command('assets maintenance', 'GET', `${asset}/maintenance`), command('assets maintain', 'PUT', `${asset}/maintenance`),
  command('assets version', 'GET', `${asset}/versions/:versionId`),
  command('assets read', 'GET', `${asset}/versions/:versionId/files/:fileId`, { transport: 'binary', boundTool: 'artifact_read', boundFields: ['assetId', 'versionId', 'fileId'] }),
  command('assets inspect', 'HEAD', `${asset}/versions/:versionId/files/:fileId`, { transport: 'headers' }),
  command('assets access', 'PUT', `${asset}/access`), command('assets lifecycle', 'PUT', `${asset}/lifecycle`),
  command('assets bindings', 'GET', '/api/v2/assets/bindings'), command('assets bind', 'POST', `${asset}/bindings`), command('assets unbind', 'DELETE', `${asset}/bindings`),
  command('memory list', 'GET', '/api/v2/memory/records'),
  command('memory search', 'POST', '/api/v2/memory/search', { readOnly: true, boundTool: 'memory_search', boundFields: ['query'] }),
  command('memory organize', 'POST', '/api/v2/memory/organize'), command('memory jobs', 'GET', '/api/v2/memory/jobs'),
  command('memory result', 'GET', '/api/v2/memory/jobs/:jobId/result'), command('memory source', 'GET', '/api/v2/memory/sources/:sourceId'),
  command('memory read', 'GET', '/api/v2/memory/records/:recordId', { boundTool: 'memory_read', boundFields: ['recordId'] }),
  command('memory correct', 'POST', '/api/v2/memory/records/:recordId/correct'), command('memory retract', 'POST', '/api/v2/memory/records/:recordId/retract'),
  ...['search', 'detail', 'installed'].map(action => command(`market ${action}`, 'GET', `/api/market/${action}`)),
  command('market install', 'POST', '/api/market/install'),
  ...['unlink', 'uninstall'].map(action => command(`market ${action}`, 'POST', `/api/market/installed/:installationId/${action}`)),
  command('automations list', 'GET', '/api/automations', {boundTool:'automation_list',boundFields:[]}), command('automations create', 'POST', '/api/automations', {boundTool:'automation_create',dataExample:{name:'Workday review',instructions:'Review the latest state',projectId:'project-id',agentId:'agent-id',cli:'codex',enabled:false,executionMode:'independent',schedule:{kind:'weekly',weekdays:[1,2,3,4,5],time:'09:00',timeZone:'Asia/Singapore'}},note:'Saves paused. taskId defaults continuous; standalone defaults independent. goalId selects the task/report source. New policies default latest/coalesce; each defaults queue. Each occurrence opens a new execution conversation on the target Task.',boundFields:['executionMode','goalId','missedPolicy','overlapPolicy','taskId','conversationId','name','instructions','projectId','agentId','cli','workspaceId','enabled','schedule']}),
  command('automations update', 'PATCH', '/api/automations/:automationId', {boundTool:'automation_update',boundFields:['executionMode','missedPolicy','overlapPolicy','automationId','expectedRevision','conversationId','name','instructions','projectId','agentId','cli','workspaceId','enabled','schedule']}), command('automations remove', 'DELETE', '/api/automations/:automationId', {boundTool:'automation_remove',boundFields:['automationId','expectedRevision']}),
  ...['run', 'stop'].map(action => command(`automations ${action}`, 'POST', `/api/automations/:automationId/${action}`, {boundTool:`automation_${action}`,boundFields:['automationId']})),
  command('terminal get', 'GET', `${chat}/terminal`), command('terminal open', 'POST', `${chat}/terminal`),
  command('terminal close', 'DELETE', `${chat}/terminal`),
  ...['input', 'resize'].map(action => command(`terminal ${action}`, 'POST', `${chat}/terminal/${action}`)),
  command('terminal events', 'GET', `${chat}/terminal/events`, { transport: 'events' }),
];

export function findCommand(name) { return COMMANDS.find(entry => entry.name === name); }
function fail(message) { throw Object.assign(new Error(message), { code: 'invalid_arguments' }); }
export function boundArguments(entry, ids, data = {}) {
  if (!entry.boundTool) fail('Command is unavailable to Agents');
  const fields = entry.boundFields;
  const positional = entry.idParams.filter(name => fields.includes(name));
  if (ids.length > positional.length) fail('Unexpected positional ID in Agent mode');
  const args = { ...data };
  ids.forEach((value, index) => { const name = positional[index]; if (args[name] !== undefined && args[name] !== value) fail(`Conflicting ${name}`); args[name] = value; });
  if (Object.keys(args).some(name => !fields.includes(name))) fail('Unknown Agent command argument');
  return args;
}
export function resolveRequest(entry, { ids = [], data = {}, query = {}, key } = {}) {
  if (ids.length > entry.idParams.length) fail('Too many positional IDs');
  const body = { ...data };
  const parameters = {};
  for (let index = 0; index < entry.idParams.length; index++) {
    const name = entry.idParams[index], value = ids[index] ?? data[name];
    if (typeof value !== 'string' || !value) fail(`Missing ${name}`);
    if (ids[index] !== undefined && data[name] !== undefined && ids[index] !== data[name]) fail(`Conflicting ${name}`);
    parameters[name] = value; delete body[name];
  }
  let path = entry.path.replace(/:([A-Za-z]+)/g, (_, name) => encodeURIComponent(parameters[name]));
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) fail(`Query ${name} must be scalar`);
    search.set(name, value === null ? '' : String(value));
  }
  if (search.size) path += '?' + search;
  if (entry.bodyKey) {
    if (body.commandKey !== undefined && body.commandKey !== key) fail('Use --key for commandKey');
    body.commandKey = key;
  }
  return { method: entry.method, path, data: body, parameters };
}
