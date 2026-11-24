export type CodexWriterRecoveryAction = 'retry-original' | 'isolate' | 'check';

export type CodexWriterRecovery = {
  conflictId: number;
  previousNativeId: string;
  state: 'held' | 'released' | 'creating' | 'unknown' | 'linked';
  operationId?: string;
  nativeId?: string;
};
