import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';
import { conversationContext } from './conversation-context';
import { readConfig } from './config';
import type { Store } from './store';
import type { SessionManager } from './sessions';
import type { Terminals } from './terminals';
import { terminalSize } from './terminals';
import { DomainError } from '../shared/workspace-contracts';
import { conversationEnvironment } from './conversation-workspace';
import { connectSshExecution } from './ssh-execution';
import { sshArgs, shellQuote } from './ssh-transport';
import { isRemoteAbsolutePath } from '../shared/execution-machines';

export const maxTerminalSlots = 6;

const json = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
function fields(value: unknown, keys: string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)))
    throw new DomainError('terminal_request', 400, 'Invalid terminal request');
  return value as Record<string, any>;
}
export function createTerminalHttp(home: string, store: Store, manager: SessionManager, terminals: Terminals) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL, body: (req: IncomingMessage) => Promise<unknown>) => {
    const match = url.pathname.match(/^\/api\/conversations\/([a-zA-Z0-9_-]+)\/terminal(?:\/(events|input|resize|sessions))?$/);
    if (!match) return false;
    const [, id, action] = match, conversation = store.getConversation(id);
    if (!conversation) throw new DomainError('conversation_missing', 404, 'Conversation not found');
    manager.authorizeConversationRead(id);
    // Slot 0 keeps the conversation id as its key; extra terminals are id:slot.
    const slotText = url.searchParams.get('slot') ?? '0', slot = Number(slotText);
    if (!/^\d$/.test(slotText) || slot >= maxTerminalSlots) throw new DomainError('terminal_request', 400, 'Invalid terminal request');
    const key = slot ? id + ':' + slot : id;
    if (action === 'sessions' && req.method === 'GET') {
      json(res, 200, { sessions: terminals.running(id).filter(item => item.key === id || item.key.startsWith(id + ':')).map(item => ({ slot: item.key === id ? 0 : Number(item.key.slice(id.length + 1)), session: item.session })) });
      return true;
    }
    if (!action && req.method === 'GET') { json(res, 200, { session: terminals.get(key) }); return true; }
    if (!action && req.method === 'POST') {
      const input = fields(await body(req), ['cols', 'rows', 'worktree']), size = terminalSize(input);
      const { config, revision } = await readConfig(home);
      const { project, workspace } = conversationContext(config, conversation, resolve(home, 'workspaces', 'conversations', id));
      if ((await readConfig(home)).revision !== revision || store.getConversation(id)?.cwd !== conversation.cwd)
        throw new DomainError('terminal_context_changed', 409, 'Working directory changed; open the terminal again');
      manager.authorizeConversationRead(id);
      let cwd = project.cwd;
      if(conversation.executionLocation){
        const location=conversation.executionLocation;
        const remote=await connectSshExecution({id:location.machineId,name:location.machineName,host:location.host},{home,conversationId:id});
        try{
          const own=await remote.request<{isDirectory:boolean;realpath:string}>('fs.stat',{path:cwd});
          if(!own.isDirectory||!isRemoteAbsolutePath(own.realpath))throw new DomainError('terminal_directory',404,'Working directory is unavailable');
          cwd=own.realpath;
          if(input.worktree!==undefined){
            const environment=await remote.request<Awaited<ReturnType<typeof conversationEnvironment>>>('workspace.environment',{cwd:project.cwd});
            if(typeof input.worktree!=='string'||input.worktree!==cwd&&!(environment.git&&environment.worktrees.some(item=>item.path===input.worktree)))
              throw new DomainError('terminal_request',400,'Invalid terminal request');
            const selected=await remote.request<{isDirectory:boolean;realpath:string}>('fs.stat',{path:input.worktree});
            if(!selected.isDirectory||!isRemoteAbsolutePath(selected.realpath))throw new DomainError('terminal_directory',404,'Working directory is unavailable');
            cwd=selected.realpath;
          }
          manager.authorizeConversationRead(id);
          if((await readConfig(home)).revision!==revision)throw new DomainError('terminal_context_changed',409,'Working directory changed; open the terminal again');
          const args=sshArgs(location.host,'cd -- '+shellQuote(cwd)+' && exec "${SHELL:-/bin/sh}" -l');args[0]='-tt';
          json(res,201,{session:terminals.start(key,cwd,size,{command:'ssh',args,localCwd:home,displayCwd:cwd})});return true;
        }finally{remote.close();}
      }
      if (input.worktree !== undefined) {
        // Only a worktree of the conversation's own repository, never an arbitrary directory.
        const environment = await conversationEnvironment(project.cwd);
        const own = await realpath(project.cwd).catch(() => project.cwd);
        if (typeof input.worktree !== 'string' || input.worktree !== own && !(environment.git && environment.worktrees.some(item => item.path === input.worktree)))
          throw new DomainError('terminal_request', 400, 'Invalid terminal request');
        cwd = input.worktree;
      } else if (!workspace && !conversation.cwd) await mkdir(project.cwd, { recursive: true });
      json(res, 201, { session: terminals.start(key, cwd, size) }); return true;
    }
    if (!action && req.method === 'DELETE') {
      const input = fields(await body(req), ['sessionId']); terminals.stop(key, input.sessionId);
      json(res, 200, { session: terminals.get(key) }); return true;
    }
    if (req.method === 'POST' && (action === 'input' || action === 'resize')) {
      const input = fields(await body(req), action === 'input' ? ['sessionId', 'data'] : ['sessionId', 'cols', 'rows']);
      if (action === 'input') terminals.write(key, input.sessionId, input.data);
      else terminals.resize(key, input.sessionId, terminalSize(input));
      json(res, 200, { accepted: true }); return true;
    }
    if (action === 'events' && req.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId');
      const send = (event: string, value: unknown) => {
        if (res.destroyed) return;
        try { manager.authorizeConversationRead(id); }
        catch { res.end(); return; }
        if (res.writableLength > 1024 * 1024) { res.end(); return; }
        res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
      };
      const unsubscribe = terminals.subscribe(key, sessionId, event => send(event.type, event.type === 'data' ? event.data : event.session));
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      send('snapshot', terminals.get(key));
      const heartbeat = setInterval(() => { try { manager.authorizeConversationRead(id); res.write(': heartbeat\n\n'); } catch { res.end(); } }, 15000);
      res.on('close', () => { unsubscribe(); clearInterval(heartbeat); });
      return true;
    }
    json(res, 405, { error: 'Method not allowed' }); return true;
  };
}
