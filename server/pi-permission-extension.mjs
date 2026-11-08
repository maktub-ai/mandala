// Loaded explicitly while discovery is disabled, before any model tools execute.
export default function mandalaPermissionGate(pi) {
  // RPC get_commands lets the host verify this gate loaded before any prompt.
  pi.registerCommand('mandala-permission-gate', {
    description: 'Mandala permission gate is active',
    handler: async () => {},
  });
  pi.on('tool_call', async (event, ctx) => {
    try {
      const choice = await ctx.ui.select('Mandala tool approval: ' + JSON.stringify({
        toolName: event.toolName, toolCallId: event.toolCallId, input: event.input,
      }), ['Approve', 'Deny']);
      if (choice === 'Approve') return;
    } catch {}
    return { block: true, reason: 'Mandala did not approve this tool call' };
  });
}
