export const LOCAL_USER_ID = 'local';
export type CommandKey = string;
export type VersionRef = { assetId: string; versionId: string };
export type Principal = { userId: string; agentId?: string; runId?: string };
export type EventEnvelope = {
  sequence: number; id: string; type: string; aggregateId: string;
  aggregateRevision: number; causationId: string; schemaVersion: 1;
  createdAt: string; payload: unknown;
};
export class DomainError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) {
    super(message);
    this.name = "DomainError";
  }
}
