import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, type SessionNotification } from '@agentclientprotocol/sdk';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const entry = fileURLToPath(new URL('../scripts/claude-bridge/entry.mjs', import.meta.url));
const marker = 'mandala-test-mcp-value';
const fixture = `
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
const sessionArg = args.find(arg => /^--(?:session-id|resume)=/.test(arg));
assert.ok(sessionArg);
assert.ok(args.includes('--permission-prompts') && args.includes('host'));
assert.ok(!args.join(' ').includes(${JSON.stringify(marker)}));
const session_id = sessionArg.split('=')[1];
const emit = frame => console.log(JSON.stringify(frame));
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request') {
    const request = frame.request;
    if (request.subtype === 'initialize') {
      assert.equal(request.mcpServers.fixture.env.FIXTURE, ${JSON.stringify(marker)});
      assert.equal(request.promptSuggestions, false);
    }
    const response = request.subtype === 'initialize'
      ? { models: [{ value: 'default', displayName: 'Default' }, {value:'sonnet',displayName:'Sonnet'}],
          mcp_servers_applied: true, current_permission_mode: 'plan' }
      : request.subtype === 'set_model' ? { model: request.model } : {};
    assert.notEqual(request.subtype, 'set_permission_mode', 'the native Plan mode must be kept');
    emit({type:'control_response',response:{subtype:'success',request_id:frame.request_id,response}});
  } else if (frame.type === 'user') {
    assert.equal(frame.session_id, session_id);
    assert.ok(frame.message.content.some(part => part.type === 'text' && part.text === 'fixture prompt'));
    emit({type:'assistant',session_id,message:{content:[{type:'text',text:'fixture reply'}]}});
    emit({type:'result',session_id,subtype:'success',is_error:false});
  }
}
`;

it.skipIf(process.platform === 'win32')('uses native stdin for MCP, preserves Plan, streams a turn and restores the exact native session', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mandala-native-bridge-test-'));
  const launcher = join(home, 'native-claude');
  await writeFile(launcher, '#!' + process.execPath + '\n' + fixture, { mode: 0o700 });
  const children: ReturnType<typeof launch>[] = [];
  const events: SessionNotification[] = [];
  function launch() {
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, CLAUDE_CODE_EXECUTABLE: launcher }, stdio: ['pipe', 'pipe', 'ignore'],
    });
    const exit = once(child, 'close');
    const client = new ClientSideConnection(() => ({
      requestPermission: () => ({ outcome: { outcome: 'cancelled' } }),
      sessionUpdate: update => { events.push(update); },
    }), ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>));
    return { client, child, exit };
  }
  const options = { cwd: home, mcpServers: [{ name: 'fixture', command: launcher, args: [], env: [{ name: 'FIXTURE', value: marker }] }] };
  const prompt = [{ type: 'text' as const, text: 'fixture prompt' }];
  try {
    const first = launch(); children.push(first);
    await first.client.initialize({ protocolVersion: PROTOCOL_VERSION });
    const { sessionId } = await first.client.newSession(options);
    expect((await first.client.setSessionConfigOption({ sessionId, configId: 'model', value: 'sonnet' }))
      .configOptions).toMatchObject([{ id: 'model', currentValue: 'sonnet' }]);
    expect(await first.client.prompt({ sessionId, prompt })).toMatchObject({ stopReason: 'end_turn' });
    first.child.stdin.end();
    await first.exit;

    const again = launch(); children.push(again);
    await again.client.initialize({ protocolVersion: PROTOCOL_VERSION });
    await again.client.loadSession({ ...options, sessionId });
    expect(await again.client.prompt({ sessionId, prompt })).toMatchObject({ stopReason: 'end_turn' });
    expect(events.filter(event => event.sessionId === sessionId && event.update.sessionUpdate === 'agent_message_chunk')).toHaveLength(2);
  } finally {
    for (const { child, exit } of children) {
      child.stdin.end();
      child.kill();
      await exit;
    }
    await rm(home, { recursive: true, force: true });
  }
}, 15_000);
