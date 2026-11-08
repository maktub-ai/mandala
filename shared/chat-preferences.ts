import type { ApprovalMode } from './types';

export type ApprovalPreference = { approvalMode: ApprovalMode | null };

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return value === 'default' || value === 'strict' || value === 'auto';
}
