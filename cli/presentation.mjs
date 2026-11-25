// Presentation is deliberately separate from the transport's JSON envelope.
export function humanOutput(argv, env, tty) {
  const context = env.MANDALA_CONTEXT ?? env.OPEN_MANA_CONTEXT;
  return !context && !argv.includes('--json') && (argv.includes('--human') || Boolean(tty));
}
const groups = {
  blueprint: 'Project blueprint and progress', mandala: 'Mandala coordination', progress: 'Agent progress updates',
  service: 'Local service status', workbench: 'Workspace overview', workspace: 'Search workspace content', usage: 'Observed model usage',
  config: 'Workspace configuration', agents: 'Agent identities', projects: 'Project configuration', project: 'Project membership',
  directories: 'Browse local directories', capabilities: 'Available and effective capabilities', models: 'Native model catalog', cli: 'Native CLI status',
  conversations: 'Chats, queues, history and approvals', messages: 'Independent Agent inquiries', tasks: 'Goals, runs and explicit progress',
  assets: 'Files, versions and access', memory: 'Scoped memory and evidence', skills: 'Managed Skills (Agent invocation)', wiki: 'Knowledge bases (Agent invocation)',
  'code-graph': 'Code navigation (Agent invocation)', knowledge: 'Knowledge entries', market: 'Capability catalog', automations: 'Scheduled work',
  terminal: 'Conversation terminals', 'system-tasks': 'Title and memory jobs',
};
function example(command, agent) {
  const ids = agent ? command.ids.filter(id => command.boundFields?.includes(id)) : command.ids;
  const data = agent ? command.agentDataExample : command.dataExample;
  const positional = ids.map(id => id === 'kind' ? command.kindValues[0] : id.replace(/Id$/, '-id')).join(' ');
  return `mandala ${command.command}${positional ? ' ' + positional : ''}` +
    (command.transport === 'upload' && !agent ? ' --input /absolute/input.txt' : data && Object.keys(data).length ? ` --data '${JSON.stringify(Object.fromEntries(Object.entries(data).filter(([key]) => !ids.includes(key))))}'` : '') +
    (command.queryExample && !agent ? ` --query '${JSON.stringify(command.queryExample)}'` : '') +
    (command.transport === 'binary' && !agent ? ' --output /absolute/download.bin' : '') +
    (!['GET', 'HEAD'].includes(command.method) && !command.readOnly && command.transport !== 'upload' ? ' --key my-operation-1' : '');
}
export function renderHelp(help, words) {
  const lines = ['Mandala CLI', '', `Usage: ${words.length ? 'mandala ' + words.join(' ') : 'mandala <group> <action>'}${words.length === 1 ? ' <action>' : ''}${words.length === 2 ? help.commands[0].ids.map(id => ` <${id}>`).join('') : ''} [options]`, ''];
  if (!words.length) {
    lines.push('Groups:', ...[...new Set(help.commands.map(item => item.command.split(' ')[0]))].map(group => `  ${group.padEnd(16)}${groups[group] ?? group}`));
    lines.push('', 'Explore: mandala tasks --help', '         mandala tasks start --help');
  } else if (words.length === 1) {
    lines.push('Actions:', ...help.commands.map(item => `  ${item.command.split(' ')[1]}${item.ids.map(id => ` <${id}>`).join('')}${item.invocationOnly ? '  (Agent invocation only)' : ''}`));
    lines.push('', `Explore: mandala ${words[0]} <action> --help`);
  } else {
    const command = help.commands[0];
    lines.push(`Access: ${command.invocationOnly ? 'Active Agent invocation only' : command.agent ? 'Local user or authorized Agent invocation' : 'Local user only'}`);
    if (command.boundFields) lines.push(`Agent data fields: ${command.boundFields.join(', ') || '(none)'}`);
    if (command.note) lines.push(command.note);
    if (command.kindValues) lines.push(`Allowed kind: ${command.kindValues.join(' | ')}`);
    lines.push('', 'Example:', `  ${example(command, command.invocationOnly)}`);
    if (command.agent && !command.invocationOnly) lines.push('Agent example (invocation supplies scope and permissions):', `  ${example(command, true)}`);
    lines.push('', 'Input: JSON object or @UTF-8-file; API validates command fields. IDs may be positional or in --data.',
      'Replace example IDs, revisions and paths with values read from your workspace.', 'Revisions and permissions are enforced by the service; help does not grant access.');
    if (command.transport === 'events') lines.push('Streams one result per event until disconnected; use conversations history for a finite read.');
  }
  lines.push('', 'Options:', ...Object.entries(help.options).map(([flag, description]) => `  ${flag.padEnd(14)}${description}`));
  lines.push('', 'TTY defaults to readable text; pipes and redirects default to JSON.', 'Agent context always uses JSON, including with --human. --json always selects JSON.', 'Writes are never retried automatically. Keep the command key and query actual state after an unknown result.');
  return lines.join('\n');
}
// Escape terminal control characters without truncating values or translating content.
const safe = text => String(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
function readable(value, indent = '') {
  if (Array.isArray(value)) return value.length ? value.map((item, index) => `${indent}[${index + 1}]\n${readable(item, indent + '  ')}`).join('\n') : indent + 'No results.';
  if (value && typeof value === 'object') return Object.keys(value).length ? Object.entries(value).map(([key, item]) => item && typeof item === 'object' ? `${indent}${safe(key)}:\n${readable(item, indent + '  ')}` : `${indent}${safe(key)}: ${safe(item === null ? 'null' : item)}`).join('\n') : indent + '(empty object)';
  return indent + safe(value === null ? 'null' : value);
}
export function renderResult(envelope) {
  const lines = [`mandala ${safe(envelope.command)}`];
  if (envelope.ok) lines.push(readable(envelope.data));
  else {
    lines.push(`Error [${safe(envelope.error.code)}]${envelope.error.status ? ` (HTTP ${envelope.error.status})` : ''}: ${safe(envelope.error.message)}`);
    if (envelope.error.details) lines.push(readable(envelope.error.details));
    const code = envelope.error.code;
    lines.push(code === 'connection_failed' || code === 'service_unavailable' || code === 'service_starting' ? 'Next: check that the selected workspace service is running, or supply --base-url for your local service.' : code === 'invalid_service_identity' || code === 'invalid_discovery' ? 'Next: inspect the selected HOME and its runtime discovery record; no business request was sent.' : code === 'stale_revision' || code === 'revision_required' ? 'Next: read the current object/revision and reconcile your change before submitting it.' : 'Next: inspect the result and command help before deciding whether to submit again.');
  }
  if (envelope.commandKey) lines.push(`Command key: ${safe(envelope.commandKey)}`, 'Query the resulting object before a manual retry with this same key and exact input. Acceptance does not prove completion.');
  return lines.join('\n');
}
