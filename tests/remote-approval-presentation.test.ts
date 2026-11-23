import {expect,it} from 'vitest';
import {partitionRemoteApprovals,remoteApprovalActions} from '../src/remote-approval-presentation';
const now=Date.parse('2026-11-22T18:45:00Z');
const grant=(clientId:string,status:string,offset:number)=>({clientId,status,requestedAt:new Date(now+offset).toISOString()});
it('surfaces only fresh pending requests newest first without dropping history',()=>{
 const grants=[grant('older','pending',-250000),grant('stale','pending',-300001),grant('approved','approved',-900000),grant('revoked','revoked',-1000),grant('new','pending',-1000),grant('denied','denied',-2000)];
 const {pending,olderPending,history}=partitionRemoteApprovals(grants,now);
 expect(pending.map(g=>g.clientId)).toEqual(['new','older']);
 expect(olderPending.map(g=>g.clientId)).toEqual(['stale']);
 expect(history.map(g=>g.clientId)).toEqual(['revoked','denied','approved']);
 expect(grants).toHaveLength(6);
});
it('moves a decided or aged request out of active presentation without changing its grant',()=>{
 const request=grant('same','pending',-299999);
 expect(partitionRemoteApprovals([request],now).pending).toEqual([request]);
 expect(partitionRemoteApprovals([request],now+2).pending).toEqual([]);
 expect(partitionRemoteApprovals([request],now+2).olderPending).toEqual([request]);
 const result={...request,status:'approved'};
 expect(partitionRemoteApprovals([result],now).history).toEqual([result]);
});

it('still offers explicit approve and deny for an older pending request, but only revoke for approvals',()=>{
 const stale=grant('stale','pending',-300001);
 const {pending,olderPending}=partitionRemoteApprovals([stale],now);
 expect(pending).toEqual([]);
 expect(remoteApprovalActions(olderPending[0])).toEqual(['approved','denied']);
 expect(remoteApprovalActions({...stale,status:'approved'})).toEqual(['revoked']);
 expect(remoteApprovalActions({...stale,status:'denied'})).toEqual([]);
 expect(remoteApprovalActions({...stale,status:'revoked'})).toEqual([]);
});
