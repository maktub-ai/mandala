import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

export const QUEUED_CANCELLED = Symbol('queued Claude turn cancelled');

// The installed Claude process owns its profile, credentials and transcripts.
export class NativeSession {
  constructor(executable, cwd, id, resume) {
    this.id = id;
    this.pending = new Map();
    this.exit = new Promise(resolve => {
      this.child = spawn(executable, [
        '--print', '--input-format', 'stream-json', '--output-format', 'stream-json',
        '--verbose', '--include-partial-messages', '--await-initialize',
        '--permission-prompts', 'host', '--permission-prompt-tool', 'stdio',
        '--system-prompt-snapshot', 'off', (resume ? '--resume=' : '--session-id=') + id,
      ], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      this.child.once('error', () => this.fail(new Error('Claude Code could not start.')));
      this.child.once('close', () => {
        this.fail(new Error('Claude Code closed its connection.'));
        resolve();
      });
    });
    this.child.stdin.on('error', () => this.fail(new Error('Claude Code closed its input.')));
    createInterface({ input: this.child.stdout }).on('line', line => this.receive(line));
  }

  receive(line) {
    if (this.error) return;
    if (!line.trim()) return;
    let packet;
    try { packet = JSON.parse(line); }
    catch {
      this.fail(new Error('Claude Code returned an invalid protocol message.'));
      void this.close();
      return;
    }
    if (packet?.type === 'control_response') {
      const response = packet.response;
      this.pending.get(response?.request_id)?.(response);
    } else if (this.turn) {
      this.enqueue(packet);
    } else if (packet?.type === 'control_request') {
      this.rejectRequest(packet);
    }
  }

  enqueue(packet) {
    const waiting = this.turn.waiting;
    if (waiting) {
      this.turn.waiting = undefined;
      waiting.resolve(packet);
    } else {
      this.turn.packets.push(packet);
    }
  }

  fail(error) {
    this.error ??= error;
    for (const complete of this.pending.values()) complete();
    this.turn?.waiting?.reject(this.error);
  }

  send(packet) {
    if (this.error) throw this.error;
    this.child.stdin.write(JSON.stringify(packet) + '\n');
  }

  control(request, timeout = 12000) {
    return new Promise((resolve, reject) => {
      if (this.error) return reject(this.error);
      const requestId = randomUUID();
      const finish = response => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        if (response?.subtype === 'success') resolve(response.response ?? {});
        else reject(this.error ?? new Error(`Claude Code did not confirm ${request.subtype}.`));
      };
      const timer = setTimeout(finish, timeout);
      this.pending.set(requestId, finish);
      try { this.send({ type: 'control_request', request_id: requestId, request }); }
      catch { finish(); }
    });
  }

  async initialize(mcpServers) {
    const state = await this.control({ subtype: 'initialize', mcpServers, promptSuggestions: false, forwardSubagentText: true });
    if (Object.keys(mcpServers).length && state.mcp_servers_applied !== true) {
      throw new Error('Claude Code did not confirm the requested MCP configuration.');
    }
    if (!['default', 'plan', 'dontAsk'].includes(state.current_permission_mode)) {
      await this.control({ subtype: 'set_permission_mode', mode: 'default' });
    }
    return state;
  }

  start(content) {
    if (this.turn) throw new Error('Claude Code already has an active turn.');
    const uuid = randomUUID();
    this.turn = { uuid, packets: [] };
    this.send({
      type: 'user', uuid, session_id: this.id, parent_tool_use_id: null,
      message: { role: 'user', content },
    });
    return uuid;
  }

  confirmQueuedCancellation(uuid) {
    if (this.turn?.uuid === uuid) this.enqueue(QUEUED_CANCELLED);
  }

  next() {
    const turn = this.turn;
    if (turn?.packets.length) return Promise.resolve(turn.packets.shift());
    if (this.error) return Promise.reject(this.error);
    if (!turn) return Promise.reject(new Error('Claude Code has no active turn.'));
    return new Promise((resolve, reject) => { turn.waiting = { resolve, reject }; });
  }

  respond(frame, allowed) {
    this.send({
      type: 'control_response',
      response: {
        subtype: 'success', request_id: frame.request_id,
        response: allowed
          ? { behavior: 'allow', updatedInput: frame.request.input, toolUseID: frame.request.tool_use_id }
          : { behavior: 'deny', message: 'Mandala permission was declined.', toolUseID: frame.request.tool_use_id },
      },
    });
  }

  rejectRequest(frame) {
    this.send({ type: 'control_response', response: {
      subtype: 'error', request_id: frame.request_id, error: 'Unsupported native permission request.',
    } });
  }

  close() {
    this.closing ??= (async () => {
      this.child.stdin.end();
      const terminate = setTimeout(() => this.child.kill('SIGTERM'), 2000);
      const kill = setTimeout(() => this.child.kill('SIGKILL'), 4000);
      try { await this.exit; }
      finally { clearTimeout(terminate); clearTimeout(kill); }
    })();
    return this.closing;
  }
}
