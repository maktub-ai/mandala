export type ManifestFile = {
  path: string; blobHash: string; size: number; mediaType: string; executable: boolean;
};
// Trusted service input only. HTTP clients must upload bytes, never host paths.
export type UploadSource = { allowedRoot: string; relativePath: string; manifestPath: string };
export type StagedManifest = { submissionId: string; files: ManifestFile[]; expiresAt: string };
import type { SkillSource, KnowledgeAccess } from './types';
import type { VersionRef } from './workspace-contracts';
export type AssetKind = 'document' | 'file' | 'wiki' | 'skill' | 'memory_collection' | 'external_reference';
export type AssetOwner = { userId: string; agentId?: string; projectId?: string };
export type Asset = { id: string; kind: AssetKind; title: string; owner: AssetOwner; accessPolicy: KnowledgeAccess; headVersionId: string | null; lifecycle: 'active' | 'archived' | 'retracted'; revision: number; accessRevision: number };
export type AssetVersionInput = { assetId: string; expectedHeadVersionId: string | null; submissionId: string; files: ManifestFile[]; provenance: { runId?: string; sourceVersions: VersionRef[]; wiki?: {baseId:string;sourceIds:string[]}; skill?: {source?:SkillSource;creatorAgentId?:string} } };
export type AssetVersion = { id: string; assetId: string; ordinal: number; files: ManifestFile[]; provenance: AssetVersionInput['provenance']; createdAt: string; accessRevision: number };
export type AssetBinding = { ownerType: 'agent' | 'project' | 'task'; ownerId: string; assetId: string; versionPolicy: 'latest' | 'pinned'; versionId?: string };

export type AssetFile = { fileId: string; name: string; size: number; mediaType: string; availability: 'managed_local' | 'missing' };
export type AuthorizedFile = { blobPath: string; name: string; size: number; mediaType: string; etag: string };

export type AssetSummary = Asset & { file?: Pick<AssetFile,'name'|'mediaType'>; lastViewedAt?: string | null; lastEditedAt?: string | null; recentAt?: string | null; versionOrdinal: number | null; updatedAt: string | null; source: string; availability: 'managed_local' | 'missing' | 'unpublished' | 'host_reference' | 'access_denied' };

export type FileMaintenanceStatus = {enabled:boolean;revision:number;agentId?:string;projectId?:string|null;conditions?:string;lastCheck?:{state:'pending'|'unchanged'|'updated'|'failed';error:string|null;versionId:string|null}};
