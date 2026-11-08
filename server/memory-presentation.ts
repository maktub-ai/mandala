import type {MemoryHit,MemorySearchSummary} from '../shared/memory';
const words=new Intl.Segmenter('zh',{granularity:'word'});

/** A source excerpt, not a generated claim; full text stays behind the authorized read. */
export function summarizeMemoryHit(hit:MemoryHit,query:string,maxChars=500):MemorySearchSummary {
 const {recordId,revision,layer,contentType,reason,observedAt,effectiveFrom,validUntil,verification}=hit;
 const letters=Array.from(hit.text),limit=Math.max(1,Math.floor(maxChars));
 let excerpt=hit.text;
 const truncated=letters.length>limit;
 if(truncated){
  const terms=[...new Set([query.trim(),...(query.match(/[\p{L}\p{N}_./\\-]+/gu)??[]),...Array.from(words.segment(query)).filter(word=>word.isWordLike).map(word=>word.segment)])].filter(term=>Array.from(term).length>1).sort((a,b)=>b.length-a.length);
  let position=0;
  for(const term of terms){const match=hit.text.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'iu'));if(match){position=Array.from(hit.text.slice(0,match.index)).length;break;}}
  const size=Math.max(0,limit-2),start=Math.min(letters.length-size,Math.max(0,position-Math.floor(size/3))),end=start+size;
  excerpt=limit<3?'…':(start>0?'…':'')+letters.slice(start,end).join('')+(end<letters.length?'…':'');
 }
 return {recordId,revision,layer,contentType,excerpt,truncated,reason,observedAt,effectiveFrom,validUntil,verification,sourceCount:new Set(hit.evidence.map(ref=>ref.sourceId)).size};
}
