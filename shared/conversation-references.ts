import type { TaskState } from './tasks';
import type { VersionRef } from './workspace-contracts';

export type ReferenceDocument = VersionRef & {
 title:string;ordinal:number;attachmentId?:string;
 files?:{name:string;fileId:string}[];runId?:string;
 relations:('input'|'context'|'output')[];
};
export type ConversationReferenceSummary = {
 tasks:{id:string;goal:string;state:TaskState}[];
 documents:ReferenceDocument[];
 memories:{recordId:string;revision:number;text:string;relation:'provided'|'generated'|'available';suppliedRevision?:number}[];
 truncated:boolean;
};
