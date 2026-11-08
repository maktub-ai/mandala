import {describe,it,expect} from 'vitest';
import {scheduleConversation,l1Completed,l2Completed,l2Due,type MemoryScheduleState} from '../server/memory-schedule';
describe('TencentDB schedule',()=>{
 it('advances 1→2→4→5 only on successful L1 and resets idle deadline',()=>{
 let state:MemoryScheduleState={};
 expect(scheduleConversation(state,1000).flush).toBe(true);
 state=l1Completed(scheduleConversation(state,1000).state,1000);
 expect(state.warmupThreshold).toBe(2);
 state=scheduleConversation(state,2000).state;
 expect(scheduleConversation(state,3000).flush).toBe(true);
 expect(state.warmupThreshold).toBe(2);
 state=l1Completed(state,4000);expect(state.warmupThreshold).toBe(4);
 state=l1Completed(state,5000);expect(state.warmupThreshold).toBe(0);
 const one=scheduleConversation(state,6000);expect(one.flush).toBe(false);
 const two=scheduleConversation(one.state,7000);expect(two.state.l1DueAt).toBe(607000);
 expect(scheduleConversation(two.state,607000).flush).toBe(true);
 });
 it('has downward-only delay, minimum floor, maximum interval and cold periodic cutoff',()=>{
 let state=l1Completed({},1000);expect(state.l2DueAt).toBe(11000);
 state=l1Completed(state,2000);expect(state.l2DueAt).toBe(11000);
 state=l2Completed(state,11000);expect(state.l2DueAt).toBe(3611000);
 state=l1Completed(state,12000);expect(state.l2DueAt).toBe(911000);
 expect(l2Due(state,910999)).toBe(false);expect(l2Due(state,911000)).toBe(true);
 expect(l2Due({...state,l2Source:'max-interval',lastActiveAt:1000},86401000)).toBe(false);
 expect(l2Due({...state,l2Source:'delay-after-l1',lastActiveAt:1000},86401000)).toBe(true);
 });
});
