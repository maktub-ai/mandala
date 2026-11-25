export type BlueprintRecord = {
  id: string;
  title: string;
  result: string;
  decisions: string[];
  lanes: string[];
  at: string;
};
export type BlueprintRecordInput = Pick<BlueprintRecord,'result'|'decisions'|'lanes'>;
export type BlueprintModule = {lane:string; status:'planned'|'active'|'done'; records:BlueprintRecord[]};
export type BlueprintSummary = {title:string; modules:BlueprintModule[]; records:BlueprintRecord[]};
export type BlueprintState = {
  enabled: boolean;
  status: 'disabled'|'ready'|'uninitialized'|'conflict'|'unavailable';
  planId: string|null;
  candidates: string[];
  summary: BlueprintSummary|null;
};
export type BlueprintDraft = {draftId:string; modules:string[]};
export const isBlueprintPlanId=(id:unknown):id is string=>typeof id==='string'&&/^[a-z0-9_][a-z0-9._-]{0,79}$/.test(id)&&!id.endsWith('-');
