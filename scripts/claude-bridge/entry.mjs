import { agent, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { NativeSession, QUEUED_CANCELLED } from './native-session.mjs';

const version = '1.0.0';
if (process.argv.includes('--version')) {
  process.stdout.write(version + '\n');
  process.exit(0);
}
const executable = process.env.CLAUDE_CODE_EXECUTABLE;
if (!executable || !isAbsolute(executable)) throw new Error('Claude Code was not bound by Mandala.');

let current;
let active;
let closing;
const requestError = message => new RequestError(-32000, message);
const notify = (client, sessionId, update) => client.notify('session/update', { sessionId, update });

function nativeMcp(servers) {
  return Object.fromEntries(servers.map(server => {
    if (server.type === 'http') {
      return [server.name, { type: 'http', url: server.url,
        headers: Object.fromEntries(server.headers.map(header => [header.name, header.value])) }];
    }
    return [server.name, { type: 'stdio', command: server.command, args: server.args,
      env: Object.fromEntries(server.env.map(variable => [variable.name, variable.value])) }];
  }));
}

function configOptions(session) {
  return session.models.length ? [{
    id: 'model', name: 'Model', category: 'model', type: 'select',
    currentValue: session.model, options: session.models,
  }] : [];
}

async function open(params, resume = false) {
  if (process.env.MANDALA_CLAUDE_RESTRICTED === '1' || params._meta?.claudeCode?.options?.tools?.length === 0) {
    throw requestError('Restricted Claude cannot verify the original gateway and native policy.');
  }
  if (current || closing || !isAbsolute(params.cwd)) throw requestError('Claude Code cannot open this session.');
  const sessionId = resume ? params.sessionId : randomUUID();
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(sessionId)) throw requestError('Invalid native Claude session ID.');
  const session = new NativeSession(executable, params.cwd, sessionId, resume);
  current = session;
  try {
    const state = await session.initialize(nativeMcp(params.mcpServers));
    session.models = (Array.isArray(state.models) ? state.models : []).flatMap(model =>
      typeof model.value === 'string' && typeof model.displayName === 'string'
        ? [{ name: model.displayName, value: model.value }] : []);
    session.model = session.models[0]?.value;
    void session.exit.then(() => {
      if (current === session && !active && !closing) process.exit(1);
    });
    return { sessionId, configOptions: configOptions(session) };
  } catch (error) {
    current = undefined;
    await session.close();
    throw error;
  }
}

async function setConfigOption({ sessionId, configId, value }) {
  if (current?.id !== sessionId || active || configId !== 'model' || !current.models.some(model => model.value === value)) {
    throw requestError('Claude Code does not offer that model in this session.');
  }
  const session = current;
  const result = await session.control({ subtype: 'set_model', model: value === 'default' ? null : value });
  if (typeof result.model !== 'string' || !result.model) throw requestError('Claude Code did not confirm the selected model.');
  session.model = value;
  return { configOptions: configOptions(session) };
}

const toolKinds = { Read: 'read', Edit: 'edit', Write: 'edit', MultiEdit: 'edit', Bash: 'execute', Grep: 'search', Glob: 'search', WebFetch: 'fetch', WebSearch: 'search' };
function toolCall(id, name, input, task) {
  const file = input?.file_path;
  const kind = Object.hasOwn(toolKinds, name) ? toolKinds[name] : 'other';
  return { toolCallId: id, title: name, kind, rawInput: input, status: 'pending',
    _meta: { claudeCode: { toolName: name, ...(task ? { agentId: task.id, parentToolUseId: task.toolUseId } : {}) } },
    ...(['read', 'edit'].includes(kind) && typeof file === 'string' && isAbsolute(file)
      ? { locations: [{ path: file }] } : {}) };
}

async function displayTool(client, owner, turn, tool) {
  if (turn.tools.has(tool.toolCallId)) return;
  turn.tools.add(tool.toolCallId);
  if (['Agent', 'Task'].includes(tool.title)) turn.delegations.set(tool.toolCallId, owner);
  await notify(client, owner, { sessionUpdate: 'tool_call', ...tool });
}

async function approve(client, session, frame, turn) {
  const request = frame.request;
  if (request?.subtype !== 'can_use_tool' || typeof request.tool_use_id !== 'string' || typeof request.tool_name !== 'string') {
    session.rejectRequest(frame);
    return;
  }
  const childRequested = request.agent_id != null && request.agent_id !== session.id || frame.parent_tool_use_id != null;
  const task = turn.tasks.get(request.agent_id) ?? turn.calls.get(frame.parent_tool_use_id);
  if (childRequested && (!task || task.finished ||
      (request.agent_id != null && request.agent_id !== task.id) ||
      (frame.parent_tool_use_id != null && frame.parent_tool_use_id !== task.toolUseId))) {
    session.respond(frame, false);
    return;
  }
  const tool = toolCall(request.tool_use_id, request.tool_name, request.input, task);
  await displayTool(client, task?.id ?? session.id, turn, tool);
  let allowed = false;
  try {
    const { outcome } = await client.request('session/request_permission', { sessionId: session.id, toolCall: tool,
      options: [
        { optionId: 'allow', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
      ],
    });
    allowed = outcome.outcome === 'selected' && outcome.optionId === 'allow';
  } catch { /* A disconnected approval channel must deny the tool. */ }
  if (active === turn && !turn.stop) session.respond(frame, allowed);
}

async function updateTask(client, session, turn, frame) {
  if (frame.session_id !== session.id || typeof frame.task_id !== 'string' || !frame.task_id) return;
  if (frame.subtype === 'task_started') {
    const parent = turn.delegations.get(frame.tool_use_id);
    if (!parent || turn.tasks.has(frame.task_id) || frame.task_id === session.id) return;
    const task = { id: frame.task_id, parent, toolUseId: frame.tool_use_id, finished: false };
    turn.tasks.set(task.id, task);
    turn.calls.set(task.toolUseId, task);
    await notify(client, parent, {
      sessionUpdate: 'subagent_update', sessionId: task.id,
      title: typeof frame.subagent_type === 'string' ? frame.subagent_type : undefined,
      description: typeof frame.description === 'string' ? frame.description : undefined,
      state: { state: 'running' }, _meta: { claudeCode: { parentToolUseId: task.toolUseId } },
    });
  } else if (frame.subtype === 'task_notification') {
    const task = turn.tasks.get(frame.task_id);
    const reasons = { completed: 'end_turn', failed: 'error', stopped: 'cancelled' };
    if (!task || !Object.hasOwn(reasons, frame.status)) return;
    task.finished = true;
    await notify(client, task.parent, {
      sessionUpdate: 'subagent_update', sessionId: task.id,
      state: { state: 'idle', stopReason: reasons[frame.status] },
    });
  }
}

function nativePrompt(parts) {
  return parts.map(part => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image' && /^image\/(png|jpeg|gif|webp)$/.test(part.mimeType)) {
      return { type: 'image', source: { type: 'base64', media_type: part.mimeType, data: part.data } };
    }
    throw requestError('Claude Code does not support this prompt attachment.');
  });
}

async function sendChunk(client, id, kind, text) {
  if (typeof text === 'string' && text) await notify(client, id, {
    sessionUpdate: kind === 'text' ? 'agent_message_chunk' : 'agent_thought_chunk',
    content: { type: 'text', text },
  });
}

async function prompt(params, client) {
  const session = current;
  if (!session || params.sessionId !== session.id || active) throw requestError('Claude Code session is unavailable or busy.');
  const content = nativePrompt(params.prompt);
  const turn = {
    tools: new Set(), streamed: new Map(), delegations: new Map(), tasks: new Map(), calls: new Map(),
    stop: undefined, cancelTimer: undefined,
  };
  active = turn;
  try {
    turn.uuid = session.start(content);
    for (;;) {
      const frame = await session.next();
      if (frame === QUEUED_CANCELLED) {
        await turn.stop;
        return { stopReason: 'cancelled' };
      }
      if (frame?.type === 'result') {
        if (frame.session_id !== session.id) throw requestError('Claude Code reported a different session.');
        const origin = Array.isArray(frame.user_message_uuids) ? frame.user_message_uuids : [];
        if (typeof frame.user_message_uuid === 'string') origin.push(frame.user_message_uuid);
        if (origin.length && !origin.includes(turn.uuid)) continue;
        if (!origin.length && typeof frame.origin?.kind === 'string' && frame.origin.kind !== 'human') continue;
        if (turn.stop) {
          await turn.stop;
          return { stopReason: 'cancelled' };
        }
        if (frame.is_error || frame.subtype !== 'success') throw requestError('Claude Code did not complete the turn.');
        const reason = frame.stop_reason;
        return { stopReason: ['max_tokens', 'refusal'].includes(reason) ? reason : 'end_turn' };
      }
      if (turn.stop) continue;
      if (frame?.type === 'control_request') {
        void approve(client, session, frame, turn).catch(() => { void session.close(); });
        continue;
      }
      if (frame?.type === 'system') {
        await updateTask(client, session, turn, frame);
        continue;
      }
      const task = turn.calls.get(frame?.parent_tool_use_id);
      if (frame?.parent_tool_use_id && !task) continue;
      const owner = task?.id ?? session.id;
      const streamed = turn.streamed.get(owner) ?? new Set();
      turn.streamed.set(owner, streamed);
      if (frame?.type === 'stream_event') {
        const event = frame.event;
        if (event?.type === 'message_start') streamed.clear();
        const delta = event?.delta;
        if (delta?.type === 'text_delta' || delta?.type === 'thinking_delta') {
          const kind = delta.type === 'text_delta' ? 'text' : 'thinking';
          streamed.add(kind);
          await sendChunk(client, owner, kind, delta.text ?? delta.thinking);
        }
        continue;
      }
      for (const block of Array.isArray(frame?.message?.content) ? frame.message.content : []) {
        if (frame.type === 'assistant') {
          if (block.type === 'tool_use') await displayTool(client, owner, turn, toolCall(block.id, block.name, block.input, task));
          else if (['text', 'thinking'].includes(block.type) && !streamed.has(block.type)) {
            await sendChunk(client, owner, block.type, block.text ?? block.thinking);
          }
        } else if (frame.type === 'user' && block.type === 'tool_result' && turn.tools.has(block.tool_use_id)) {
          await notify(client, owner, { sessionUpdate: 'tool_call_update', toolCallId: block.tool_use_id,
            status: block.is_error ? 'failed' : 'completed', rawOutput: block.content });
        }
      }
    }
  } finally {
    clearTimeout(turn.cancelTimer);
    session.turn = undefined;
    active = undefined;
  }
}

function cancel({ sessionId }) {
  const session = current;
  const turn = active;
  if (session?.id !== sessionId || !turn || turn.stop) return;
  turn.cancelTimer = setTimeout(() => { void session.close(); }, 7000);
  turn.stop = session.control({ subtype: 'interrupt', cancel_queued: true }, 5000).then(receipt => {
    if (!Array.isArray(receipt.still_queued) || receipt.still_queued.length) {
      throw requestError('Claude Code did not confirm interruption.');
    }
    if (Array.isArray(receipt.cancelled) && receipt.cancelled.includes(turn.uuid)) session.confirmQueuedCancellation(turn.uuid);
  });
  void turn.stop.catch(() => { void session.close(); });
}

const connection = agent({ name: 'mandala-claude' })
  .onRequest('initialize', () => ({ protocolVersion: PROTOCOL_VERSION,
    agentInfo: { name: 'mandala-claude', version }, agentCapabilities: {
      loadSession: true, mcpCapabilities: { http: true }, promptCapabilities: { image: true }, sessionCapabilities: { resume: {} },
    }, authMethods: [],
  }))
  .onRequest('session/new', ({ params }) => open(params))
  .onRequest('session/load', ({ params }) => open(params, true))
  .onRequest('session/resume', ({ params }) => open(params, true))
  .onRequest('session/set_config_option', ({ params }) => setConfigOption(params))
  .onRequest('session/prompt', ({ params, client }) => prompt(params, client))
  .onNotification('session/cancel', ({ params }) => cancel(params))
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));

function close() {
  closing ??= Promise.resolve(current?.close());
  return closing;
}
void connection.closed.then(close);
process.once('SIGTERM', () => { void close().finally(() => process.exit(0)); });
process.once('SIGINT', () => { void close().finally(() => process.exit(0)); });
