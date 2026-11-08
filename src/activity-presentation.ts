import type {NativeItem} from './execution';
import type {RunOperation,RunTimelineItem} from './runView';

export type ActivityCategory='read'|'search'|'command'|'change'|'tool'|'plan'|'collaboration'|'context'|'hook';
export type OperationPresentation={category:ActivityCategory;target?:string};

/** Prefer a provided reasoning heading, matching the compact Codex title convention. */
export function reasoningTitle(text:string):string|undefined{
 const lines=text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
 let title:string|undefined;
 for(const line of lines){
  const heading=line.match(/^#{1,6}\s+(.+?)(?:\s+#+)?$/)?.[1]??line.match(/^\*\*(.+)\*\*$/)?.[1];
  if(heading)title=heading;
 }
 return title??lines.at(-1);
}

/** Explicit native kinds and known adapter contracts establish an action. */
export function describeOperation(item:NativeItem):OperationPresentation{
 const args=item.arguments&&typeof item.arguments==='object'?item.arguments as Record<string,unknown>:{};
 const string=(value:unknown)=>typeof value==='string'&&value.trim()?value:undefined;
 const path=string(item.locations?.[0]?.path)??string(args.path)??string(args.file_path);
 if(item.type==='commandExecution')return {category:'command',target:item.command};
 if(item.type==='fileChange')return {category:'change',target:item.changes?.map(change=>change.path).join(', ')};
 if(item.type==='webSearch')return {category:'search',target:item.query};
 if(item.type==='plan')return {category:'plan'};
 if(item.type==='collabAgentToolCall')return {category:'collaboration'};
 if(item.type==='contextCompaction')return {category:'context'};
 if(item.type==='hook')return {category:'hook',target:item.hook?.name};
 if(item.server==='ACP'){
  const kinds:Record<string,ActivityCategory>={read:'read',search:'search',execute:'command',edit:'change',delete:'change',move:'change'};
  const category=kinds[item.kind??''];
  if(category)return {category,target:category==='command'?string(args.command)??item.tool:path??(category==='search'?string(args.query)??item.tool:undefined)};
 }
 if(item.server==='OMP'){
  if(item.tool==='read')return {category:'read',target:path};
  if(item.tool==='bash')return {category:'command',target:string(args.command)};
  if(item.tool==='grep'||item.tool==='find')return {category:'search',target:string(args.pattern)??string(args.query)??path};
  if(item.tool==='edit'||item.tool==='write')return {category:'change',target:path};
 }
 return {category:'tool',target:item.tool??item.command};
}

export type ActivityTimelineItem=RunTimelineItem|{
 kind:'operationGroup';key:string;category:'read'|'search';operations:RunOperation[];
}|{
 kind:'reasoningGroup';key:string;text:string;operations:RunOperation[];
};
export function groupActivity(timeline:RunTimelineItem[],cli?:string):ActivityTimelineItem[]{
 const result:ActivityTimelineItem[]=[];
 for(const entry of timeline){
  if(entry.kind==='operation'&&entry.operation.status==='completed'){
   const category=entry.operation.presentation.category,previous=result.at(-1);
   if(cli==='codex'){
    if(previous?.kind==='reasoningGroup'){previous.operations.push(entry.operation);continue;}
    if(previous?.kind==='reasoning'){
     result[result.length-1]={...previous,kind:'reasoningGroup',operations:[entry.operation]};
     continue;
    }
   }
   if(category==='read'||category==='search'){
    if(previous?.kind==='operationGroup'&&previous.category===category){previous.operations.push(entry.operation);continue;}
    if(previous?.kind==='operation'&&previous.operation.status==='completed'&&previous.operation.presentation.category===category){
     result[result.length-1]={kind:'operationGroup',key:previous.key,category,operations:[previous.operation,entry.operation]};
     continue;
    }
   }
  }
  result.push(entry);
 }
 return result;
}
