import type { VersionRef } from './workspace-contracts';
export type WikiReception = {enabled:boolean;agentId?:string;projectId?:string};
export type WikiPolicy = {id:string;name:string;purpose:string;ownership?:'project';maintainerAgentId:string|null;projectId:string|null;automatic:boolean;reception:WikiReception;revision:number;receptionEpoch:number;enabledAfter:number};
export type WikiEvidence = {conversationId:string;agentId:string;projectId:string;sharedProjectId?:string;events:{id:number;fingerprint:string}[]};
export type WikiSource = {id:string;baseId:string;kind:'asset'|'dialogue';title:string;ref?:VersionRef;supportVersions?:VersionRef[];evidence?:WikiEvidence;text?:string;active:boolean;supersededBy?:string;createdAt:string};
export type WikiClaim = {key:string;text:string;sourceId:string;quote:string};
export type WikiPage = {id:string;title:string;body:string;links:string[];claims:WikiClaim[];conflicts:string[];markdown:string};
export type WikiSnapshot = {sourceIds:string[];pages:WikiPage[];inputHash:string;versionId:string};
export type WikiState = WikiPolicy & {headVersionId:string|null;sources:WikiSource[];pages:Pick<WikiPage,'id'|'title'|'links'|'conflicts'>[];lastJob?:{state:string;error?:string};stale:boolean;maintenance?:'ready'|'unconfigured'|'unavailable'};
