import {createHash} from 'node:crypto';
import {DomainError} from '../shared/workspace-contracts';
import type {MemoryGeneratorInput} from './memory-pipeline';

type ObjectValue=Record<string,unknown>;
type Namespace='s'|'r';
const object=(value:unknown):value is ObjectValue=>!!value&&typeof value==='object'&&!Array.isArray(value);
const invalid=(reason='reference_decode'):never=>{throw new DomainError('invalid_memory_generation',422,`invalid_memory_generation:${reason}`);};
const binding=({signal:_,revalidate:__,...input}:MemoryGeneratorInput)=>createHash('sha256').update(JSON.stringify(input)).digest('hex');

// Only these rendered structural paths carry identities. Never walk arbitrary
// origin/taskSnapshot objects, event IDs, prose, quotes, indexes or navigation.
function mapReferences(value:unknown,identity:(value:unknown,namespace:Namespace,item:ObjectValue,revisionKey:string|null)=>unknown,source:boolean):unknown {
 const field=(item:unknown,key:string,namespace:Namespace,revisionKey:string|null):unknown=>object(item)&&Object.hasOwn(item,key)?{...item,[key]:identity(item[key],namespace,item,revisionKey)}:item;
 const list=(items:unknown,visit:(item:unknown)=>unknown)=>Array.isArray(items)?items.map(visit):items;
 const sourceRef=(item:unknown)=>field(item,'sourceId','s','sourceRevision');
 const supportRef=(item:unknown)=>field(item,'sourceId','s',null);
 const recordRef=(item:unknown)=>field(item,'recordId','r','revision');
 const proposal=(item:unknown):unknown=>{
  if(!object(item))return item;
  const result={...item};
  if(Object.hasOwn(item,'evidence'))result.evidence=list(item.evidence,sourceRef);
  if(Object.hasOwn(item,'support'))result.support=list(item.support,supportRef);
  for(const key of ['replaces','dependencies'])if(Object.hasOwn(item,key))result[key]=list(item[key],recordRef);
  return recordRef(result);
 };
 if(!source){
  if(Array.isArray(value))return value.map(proposal);
  if(!object(value))return value;
  const result={...value};
  if(Object.hasOwn(value,'proposals'))result.proposals=list(value.proposals,proposal);
  if(Object.hasOwn(value,'decisions'))result.decisions=list(value.decisions,decision=>object(decision)&&Object.hasOwn(decision,'proposal')?{...decision,proposal:proposal(decision.proposal)}:decision);
  return result;
 }
 if(!object(value))return value;
 const result={...value};
 for(const key of ['records','atoms','drafts','repairDrafts','reusableFacts','summaries'])if(Object.hasOwn(value,key))result[key]=list(value[key],proposal);
 for(const key of ['retainedDependencies','verifiedDependencies'])if(Object.hasOwn(value,key))result[key]=list(value[key],recordRef);
 if(Object.hasOwn(value,'reusableSourceRefs'))result.reusableSourceRefs=list(value.reusableSourceRefs,sourceRef);
 if(Object.hasOwn(value,'sources'))result.sources=list(value.sources,item=>field(item,'id','s','revision'));
 if(Object.hasOwn(value,'recordEvidence'))result.recordEvidence=list(value.recordEvidence,item=>object(item)?{...(field(item,'recordId','r',null) as ObjectValue),...Object.hasOwn(item,'support')?{support:list(item.support,supportRef)}:{}}:item);
 if(object(value.context)){
  result.context={...value.context};
  for(const key of ['requestRefs','assistantReplyRefs'])if(Object.hasOwn(value.context,key))(result.context as ObjectValue)[key]=list(value.context[key],supportRef);
 }
 if(object(value.sceneContext)&&Object.hasOwn(value.sceneContext,'newFactRefs'))result.sceneContext={...value.sceneContext,newFactRefs:list(value.sceneContext.newFactRefs,recordRef)};
 if(Object.hasOwn(value,'batchItems'))result.batchItems=list(value.batchItems,item=>{
  if(!object(item))return item;
  const batch={...item};
  for(const key of ['atom','draft'])if(Object.hasOwn(item,key))batch[key]=proposal(item[key]);
  if(Object.hasOwn(item,'recordRefs'))batch.recordRefs=list(item.recordRefs,recordRef);
  return batch;
 });
 return result;
}

export function memoryReferenceCodec(input:MemoryGeneratorInput,source:unknown){
 const dictionaries:Record<Namespace,string[]>={s:[],r:[]},revisions:Record<Namespace,Set<string>>={s:new Set(),r:new Set()},heldBinding=binding(input);
 const encoded=mapReferences(source,(value,namespace,item,revisionKey)=>{
  if(typeof value!=='string')return value;
  if(revisionKey&&Object.hasOwn(item,revisionKey))revisions[namespace].add(JSON.stringify([value,item[revisionKey]]));
  let index=dictionaries[namespace].indexOf(value);
  if(index<0){index=dictionaries[namespace].length;dictionaries[namespace].push(value);}
  return {[namespace]:index};
 },true) as ObjectValue;
 const receipt=createHash('sha256').update(JSON.stringify([heldBinding,source,dictionaries])).digest('hex');
 const dictionary={s:[...dictionaries.s],r:[...dictionaries.r],receipt};
 const expandIdentity=(authorized:boolean)=>(value:unknown,namespace:Namespace,item:ObjectValue,revisionKey:string|null)=>{
  if(typeof value==='string')return value;
  if(!authorized)return invalid('reference_receipt_required');
  if(!object(value)||Object.keys(value).length!==1||!Object.hasOwn(value,namespace))return invalid('reference_alias_shape');
  const index=value[namespace];
  if(typeof index!=='number'||!Number.isInteger(index)||index<0||index>=dictionaries[namespace].length)return invalid('reference_alias_range');
  const canonical=dictionaries[namespace][index];
  if(revisionKey&&!revisions[namespace].has(JSON.stringify([canonical,item[revisionKey]])))return invalid('reference_revision_not_provided');
  return canonical;
 };
 const validateEnvelope=(current:MemoryGeneratorInput,result:unknown,enabled=true)=>{
  if(object(result)&&(Object.hasOwn(result,'referenceReceipt')||Object.hasOwn(result,'result')&&!Object.hasOwn(result,'proposals')&&!Object.hasOwn(result,'decisions'))){
   if(!enabled)return invalid('reference_encoding_disabled');
   if(Object.keys(result).length!==2||!Object.hasOwn(result,'result'))return invalid('reference_envelope_shape');
   if(result.referenceReceipt!==receipt)return invalid('reference_receipt_mismatch');
   if(binding(current)!==heldBinding)return invalid('reference_binding_changed');
   return {value:result.result,expandProposal:(proposal:unknown)=>(mapReferences([proposal],expandIdentity(true),false) as unknown[])[0]};
  }
  return {value:result,expandProposal:(proposal:unknown)=>(mapReferences([proposal],expandIdentity(false),false) as unknown[])[0]};
 };
 return {
  data:{...encoded,referenceDictionary:dictionary},
  instructions:'Reference encoding: only in source identity fields, {s:i} means referenceDictionary.s[i]; only in record identity fields, {r:i} means referenceDictionary.r[i]. Preserve revision/eventId/quote and all body text unchanged. Full canonical IDs remain allowed. When using encoded references, wrap the final JSON in {"referenceReceipt":"'+receipt+'","result":the originally required JSON}; return the receipt unchanged and make result obey all rules above. Do not borrow references across types or candidates.',
  restoreSource(value:unknown):unknown {
   if(!object(value)||JSON.stringify(value.referenceDictionary)!==JSON.stringify(dictionary))return invalid();
   const {referenceDictionary:_,...data}=value;
   return mapReferences(data,expandIdentity(true),true);
  },
  validateEnvelope,
  expand(current:MemoryGeneratorInput,result:unknown,enabled=true):unknown {
   const envelope=validateEnvelope(current,result,enabled);
   const value=envelope.value;
   if(Array.isArray(value))return value.map(envelope.expandProposal);
   if(!object(value))return value;
   return {...value,...Object.hasOwn(value,'proposals')?{proposals:Array.isArray(value.proposals)?value.proposals.map(envelope.expandProposal):value.proposals}:{},...Object.hasOwn(value,'decisions')?{decisions:Array.isArray(value.decisions)?value.decisions.map(decision=>object(decision)&&Object.hasOwn(decision,'proposal')?{...decision,proposal:envelope.expandProposal(decision.proposal)}:decision):value.decisions}:{}};
  },
 };
}
