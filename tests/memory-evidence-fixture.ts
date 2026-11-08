import type { MemoryGenerator, MemoryGeneratorInput } from '../server/memory-pipeline';
import type { MemoryProposal } from '../shared/memory';
// Deterministic test model: supported user declarations and explicit inherited summaries.
export const evidenceFixture:MemoryGenerator=async({job,sources,stage,atoms}:MemoryGeneratorInput)=>{
 const proposal=(source:typeof sources[number],text:string):MemoryProposal=>({collectionId:job.collectionId,layer:'L1',contentType:/以后|偏好|喜欢|always|prefer/i.test(text)?'preference':'fact',text,operation:'store',replaces:[],evidence:[{sourceId:source.id,sourceRevision:source.revision}],validUntil:null,certainty:'inferred'});
 if(stage==='conflict')return atoms??[];
 if(stage==='extract')return sources.flatMap(source=>source.events.filter(e=>e.kind==='user'&&!/[?？]/.test(e.text)&&(!source.memoryRefs?.length||/请记住|记住|以后|我偏好|我喜欢|必须/.test(e.text))).map(event=>({...proposal(source,event.text),evidence:[{sourceId:source.id,sourceRevision:source.revision,startEventId:event.id,endEventId:event.id}],support:[{sourceId:source.id,eventId:event.id,quote:event.text}],semanticKey:/项目使用/.test(event.text)?'project package manager':undefined}))).slice(0,8);
 if(stage==='scene')return sources.filter(source=>source.memoryRefs?.length).map(source=>({...proposal(source,'当前场景沿用已确认的语言约定'),layer:'L2' as const,dependencies:source.memoryRefs}));
 return [];
};
