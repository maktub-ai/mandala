export const codexMailboxErrors = {
  codex_mailbox_path_invalid: "Mandala could not open the private mailbox directory for Codex.",
  codex_mailbox_setup_failed: "Codex could not prepare its Windows sandbox for the private Mandala mailbox.",
  codex_mailbox_capability_unverified: "Mandala could not verify the Codex capability for this private mailbox.",
  codex_mailbox_permissions_unverified: "Mandala could not verify the private Codex mailbox permissions.",
} as const;
export type CodexMailboxErrorCode = keyof typeof codexMailboxErrors;

export function isCodexMailboxErrorCode(code: unknown): code is CodexMailboxErrorCode {
  return typeof code === 'string' && Object.hasOwn(codexMailboxErrors, code);
}

export function unsubmittedCodexMailboxCode(data: unknown): CodexMailboxErrorCode | undefined {
  if (!data || typeof data !== 'object') return;
  const {code, nativeTurnSubmitted} = data as {code?: unknown; nativeTurnSubmitted?: unknown};
  return nativeTurnSubmitted === false && isCodexMailboxErrorCode(code) ? code : undefined;
}
