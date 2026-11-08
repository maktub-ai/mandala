import type { MemoryProposal, MemoryRevision } from '../../../shared/memory';

type ProfileRecord = Pick<MemoryRevision, 'recordId' | 'collectionId' | 'revision' | 'layer' | 'text' | 'semanticKey' | 'evidence'>;
export function fixtureMemoryProfile(data: { collectionId: string; records: ProfileRecord[] }): MemoryProposal[] {
 const scenes=data.records.filter(r=>r.layer==='L2'&&r.collectionId===data.collectionId),prior=data.records.find(r=>r.layer==='L3'&&r.collectionId===data.collectionId&&r.semanticKey==='persona.operating-doctrine');
 return scenes.length?[{collectionId:data.collectionId,layer:'L3',contentType:'procedure',semanticKey:'persona.operating-doctrine',text:scenes.map(r=>r.text).join('\n'),operation:prior?'update':'store',replaces:prior?[{recordId:prior.recordId,revision:prior.revision}]:[],evidence:scenes.flatMap(r=>r.evidence),support:[],dependencies:scenes.map(({recordId,revision})=>({recordId,revision})),validUntil:null,certainty:'observed'}]:[];
}
