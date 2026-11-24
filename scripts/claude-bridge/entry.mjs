import {isAbsolute} from 'node:path';
import {resolveSettings} from '@anthropic-ai/claude-agent-sdk';
import {serveAcp} from '@agentclientprotocol/claude-agent-acp';
import {applyManagedPolicyEnv} from './node_modules/@agentclientprotocol/claude-agent-acp/dist/managed-policy.js';
const version = __MANDALA_CLAUDE_ADAPTER_VERSION__;

if (process.argv.includes('--version')) {
  process.stdout.write(version + '\n');
} else {
  const executable = process.env.CLAUDE_CODE_EXECUTABLE;
  if (!executable || !isAbsolute(executable)) throw new Error('Claude Code was not bound by Mandala.');
  if (process.env.MANDALA_CLAUDE_RESTRICTED === '1') {
    // The CLI can run managed hooks despite programmatic disableAllHooks.
    // Inspect the managed tier before the bridge creates any native session.
    const policy = await resolveSettings({settingSources: []});
    const unverified = policy.machinePolicy?.didNotLoad !== false;
    const managedHooks = policy.sources.some(({source, settings}) => source === 'managed' &&
      (settings.policyHelper || Object.keys(settings.hooks ?? {}).length > 0));
    if (unverified || managedHooks) {
      throw new Error('Restricted Claude execution cannot verify that managed hooks are disabled.');
    }
    await applyManagedPolicyEnv(async () => policy);
  } else {
    await applyManagedPolicyEnv();
  }
  if (process.env.CLAUDE_CODE_EXECUTABLE !== executable) {
    throw new Error('Managed settings changed the selected Claude Code executable.');
  }
  // Stdout is reserved for ACP. The bridge does not enable upstream file logging.
  console.log = console.info = console.warn = console.debug = console.error;
  const server = serveAcp(undefined, {protocols: 'v1'});
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    try { await server.dispose(); }
    finally { process.exit(0); }
  }
  void server.closed.then(close);
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  process.stdin.resume();
}
