export const REMOTE_APPROVAL_PRESENTATION_MS=5*60*1000;
type Request={status:string;requestedAt:string};
export function partitionRemoteApprovals<T extends Request>(items:readonly T[],now:number){
 const time=(item:T)=>{const ms=Date.parse(item.requestedAt);return Number.isFinite(ms)?ms:-Infinity;};
 const pending:T[]=[],olderPending:T[]=[],history:T[]=[];
 for(const request of [...items].sort((a,b)=>time(b)-time(a))){
  const requested=time(request);
  if(request.status!=='pending')history.push(request);
  else if(requested>=now-REMOTE_APPROVAL_PRESENTATION_MS&&requested<=now+30000)pending.push(request);
  else olderPending.push(request);
 }
 return {pending,olderPending,history};
}

type ApprovalAction='approved'|'denied'|'revoked';
export function remoteApprovalActions(request:Pick<Request,'status'>):readonly ApprovalAction[]{
 if(request.status==='pending')return ['approved','denied'];
 if(request.status==='approved')return ['revoked'];
 return [];
}
