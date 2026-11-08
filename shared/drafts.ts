import type { ComposerReferenceItem, ComposerReferenceSelection } from './composer-references';
export type DraftScope = { kind: 'chat' | 'task'; conversationId: string; taskId?: string; projectId?: string; agentId?: string };
export type DraftAttachment = { name: string; size: number; type: string; lastModified: number };
export type ComposerDraft = { text: string; references?: (ComposerReferenceSelection | ComposerReferenceItem)[]; attachments?: DraftAttachment[] };
export type PendingSubmission = {
 conversationId: string; commandKey: string; draftFingerprint?: string; action: 'queue' | 'continue' | 'interrupt';
 body: { text: string; attachments: string[]; references: string[] };
 recovery: { attempted: boolean; stopAttempted: boolean; stopConfirmed: boolean; expectedExecutionId?: string; rejectionMessage?: string };
};
export type DraftRecord = { revision: number; updatedAt?: string; draft: ComposerDraft | null };
export type PendingSubmissionRecord = { revision: number; updatedAt?: string; pending: PendingSubmission | null };
