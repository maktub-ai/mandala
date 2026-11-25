import {expect,it} from 'vitest';
import {conversationProjectId,taskProjectIds} from '../src/object-scope';

it('uses current task labels, including an empty override, and falls back for a legacy response',()=>{
 expect(taskProjectIds({projectId:'dispatch',projectIds:['core','service']})).toEqual(['core','service']);
 expect(taskProjectIds({projectId:'dispatch',projectIds:[]})).toEqual([]);
 expect(taskProjectIds({projectId:'legacy'})).toEqual(['legacy']);
 expect(taskProjectIds({projectId:null})).toEqual([]);
});

it('groups chats under their attributed project when it differs from the execution route',()=>{
 expect(conversationProjectId({projectId:'old',attributedProjectId:'current'})).toBe('current');
 expect(conversationProjectId({projectId:'legacy'})).toBe('legacy');
});
