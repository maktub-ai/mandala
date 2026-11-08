import type {MemoryProposal} from '../shared/memory';
// Created only by the bound packet decoder. JSON fields cannot confer this identity.
export class MemoryReviewOutcome {
 readonly proposals:MemoryProposal[];
 constructor(readonly decisions:Record<string,MemoryProposal|null>,readonly summary?:string){this.proposals=Object.values(decisions).filter((p):p is MemoryProposal=>p!==null);}
}
