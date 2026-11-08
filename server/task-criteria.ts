import type {Criterion} from '../shared/tasks';
import {DomainError} from '../shared/workspace-contracts';

// Bound CLI inputs may use text shorthand; persisted domain criteria stay explicit.
export function boundTaskCriteria(value:unknown):Criterion[]{
 const invalid=():never=>{throw new DomainError('invalid_tool_arguments',422,'criteria must be text, a list of non-empty texts, or objects {id, text, checkRef:null}; IDs must be unique');};
 const items=typeof value==='string'?[value]:value;
 if(!Array.isArray(items))return invalid();
 const criteria=items.map((item,index):Criterion=>{
  if(typeof item==='string')return item.trim()?{id:'criterion-'+(index+1),text:item.trim(),checkRef:null}:invalid();
  if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(key=>!['id','text','checkRef'].includes(key))||typeof item.id!=='string'||!item.id.trim()||typeof item.text!=='string'||!item.text.trim()||item.checkRef!==undefined&&item.checkRef!==null&&(typeof item.checkRef!=='string'||!item.checkRef.trim()))return invalid();
  return {id:item.id,text:item.text,checkRef:item.checkRef??null};
 });
 if(new Set(criteria.map(item=>item.id)).size!==criteria.length)return invalid();
 return criteria;
}
