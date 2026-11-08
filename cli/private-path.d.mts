import type { Stats } from 'node:fs';
export function ownedPrivatePath(path: string, stat: Stats, maxBytes?: number, mailboxSid?: string): boolean;
export function codexMailboxSid(capabilitiesFile: string | undefined, mailboxPath: string): Promise<string | undefined>;
export function protectInvocationDirectory(path: string): void;
