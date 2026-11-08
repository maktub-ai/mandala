import type {MemoryGeneratorInput} from './memory-pipeline';
// Derived memory stages and evidence-backed conflict repairs request low reasoning.
export function memoryThinking(input:MemoryGeneratorInput):'off'|'low' {
 const stage=input.stage==='verify'?input.reviewStage:input.stage;
 if(stage==='scene'||stage==='profile'||stage==='consolidate')return 'low';
 if(stage!=='conflict'||!(input.callKind==='repair'||input.job.error))return 'off';
 const proposals=input.repairDrafts??input.drafts??input.atoms??input.batchItems?.flatMap(item=>item.draft?[item.draft]:item.atom?[item.atom]:[])??[];
 const correction=proposals.some(proposal=>(proposal.explicitChange||(['update','merge'].includes(proposal.operation)&&proposal.replaces?.length))&&proposal.support?.some(ref=>input.sources.some(source=>source.id===ref.sourceId&&source.events.some(event=>event.id===ref.eventId&&!event.contextOnly&&['user','tool'].includes(event.kind)&&event.text.includes(ref.quote)))));
 return correction?'low':'off';
}
