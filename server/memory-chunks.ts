import type { MemorySource } from '../shared/memory';
// TencentDB L0 role/text selection, applied only to the processing view here.
// Keep original L0 and event identities for evidence checks and historical facts.
export function memoryTextSource(source:MemorySource):MemorySource {
 const events=source.events.filter(e=>!e.contextOnly&&(source.kind==='task'||e.kind==='user'||e.kind==='text')).map(event=>{
  let text=event.text.replace(/<(relevant-memories|user-persona|relevant-scenes|scene-navigation|current_task_context|history_task_context)\b[^>]*>[\s\S]*?<\/\1>/g,'\n\n').replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/gi,'');
  if(event.kind==='text')text=text.replace(/(`{3,}|~{3,})[^\n]*\n[\s\S]*?\1/g,'\n\n');
  return {...event,text:text.trim()};
 }).filter(e=>e.text&&!/^(?:NO_REPLY|\(session bootstrap\))$/.test(e.text));
 return {...source,events,eventIds:events.map(e=>e.id),text:source.kind==='task'?source.text:events.map(e=>`${e.kind==='text'?'Assistant (unverified)':'User'}: ${e.text}`).join('\n')};
}
// Model input views retain original source/event identities. Full evidence stays in L0.
export function memoryExtractionBatches(sources:MemorySource[],limit=18000):MemorySource[][] {
 const batches:MemorySource[][]=[];let batch:MemorySource[]=[],size=0,blocks=0;
 const flush=()=>{if(batch.length)batches.push(batch);batch=[];size=0;blocks=0;};
 for(const raw of sources){
  const source=memoryTextSource(raw);
  const events=source.events.filter(e=>e.text&&!e.contextOnly);
  if(!events.length){flush();batches.push([source.events.length?{...source,text:'',events:[],eventIds:[]}:source]);continue;}
  for(const event of events){
   const chars=Array.from(event.text);
   for(let offset=0;offset<chars.length;){
    if(size>=limit-32||blocks>=10)flush();
    const end=Math.min(chars.length,offset+limit-size-32),text=chars.slice(offset,end).join('');
    let view=batch.find(s=>s.id===source.id);
    if(!view){view={...source,text:'',events:[],eventIds:[]};batch.push(view);}
    const label=event.kind==='text'?'Assistant (unverified)':event.kind==='tool'?'Tool result':'User';
    view.text+=(view.text?'\n':'')+label+': '+text;view.events.push({...event,text});view.eventIds.push(event.id);
    size+=end-offset+32;blocks++;offset=end;
   }
  }
 }
 flush();return batches;
}
