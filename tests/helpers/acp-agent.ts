import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

const bridge = `
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const [socketPath, directory, shutdownDelay] = process.argv.slice(1);
fs.writeFileSync(path.join(directory, process.pid + '.pid'), '');
const socket = net.connect(socketPath);
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  socket.destroy();
  process.stdin.pause();
  setTimeout(() => process.exit(0), Number(shutdownDelay));
}
process.stdin.pipe(socket, { end: false });
socket.pipe(process.stdout, { end: false });
process.stdin.once('end', stop);
process.once('SIGTERM', stop);
socket.once('close', stop);
socket.once('error', error => { console.error(error.message); process.exit(1); });
`;

export async function createAcpAgentFixture(
  factory: ConstructorParameters<typeof AgentSideConnection>[0],
  options: { shutdownDelayMs?: number; nativeLauncher?: 'gemini' } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'ma-acp-'));
  const socketPath = process.platform === 'win32' ? String.raw`\\.\pipe\mandala-acp-${randomUUID()}` : join(directory, 's');
  const arguments_ = [socketPath, directory, String(options.shutdownDelayMs ?? 0)];
  let command = [process.execPath, '-e', bridge, ...arguments_];
  const sockets = new Set<Socket>();
  const agents: AgentSideConnection[] = [];
  const connections = new WeakMap<AgentSideConnection, Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const agent = new AgentSideConnection(factory, ndJsonStream(
      Writable.toWeb(socket), Readable.toWeb(socket) as ReadableStream<Uint8Array>,
    ));
    agents.push(agent); connections.set(agent, socket);
  });
  try {
    if (options.nativeLauncher) {
      const launcher = join(directory, options.nativeLauncher);
      await writeFile(launcher, `#!${process.execPath}
if (process.argv.includes('--version')) {
  require('node:fs').writeFileSync(require('node:path').join(${JSON.stringify(directory)}, process.pid + '.probe'), '');
  console.log('0.36.0'); process.exit(0);
}
process.argv = [process.execPath, ...${JSON.stringify(arguments_)}];
${bridge}`, { mode: 0o700 });
      command = [launcher, '--acp'];
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => { server.off('error', reject); resolve(); });
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const pids = async () => (await readdir(directory)).filter(name => name.endsWith('.pid')).map(name => Number(name.slice(0, -4)));
  const isRunning = (pid: number) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  let closing: Promise<void> | undefined;
  return {
    command,
    async probeCount() { return (await readdir(directory)).filter(name => name.endsWith('.probe')).length; },
    agents, pids, isRunning,
    async disconnect(agent: AgentSideConnection) {
      connections.get(agent)?.destroy();
      await agent.closed;
    },
    close() {
      return closing ??= (async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        const children = await pids();
        const deadline = Date.now() + 2_000;
        while (children.some(isRunning) && Date.now() < deadline) await delay(10);
        if (children.some(isRunning)) throw new Error('ACP fixture child did not exit');
        await rm(directory, { recursive: true, force: true });
      })();
    },
  };
}
