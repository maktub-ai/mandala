import { expect, test } from 'vitest';
import { planMemoryRecall } from '../server/memory-retrieval-policy';

test.each(['谢谢！', '收到。', '好的', '你好', 'OK.', 'Thank you!', 'Got it'])('does not retrieve history for a pure acknowledgment: %s', request => {
 expect(planMemoryRecall({request,recentRequests:['上次部署到哪里？']})).toEqual({query:null,reason:'acknowledgment'});
});

test('a substantive request is still searched even when it starts with thanks', () => {
 expect(planMemoryRecall({request:'谢谢，请查一下上次部署的参数。',recentRequests:[]})).toMatchObject({query:'谢谢，请查一下上次部署的参数。'});
});

test('continuations recover the latest two informative user requests and skip acknowledgment noise', () => {
 const plan=planMemoryRecall({request:'继续，按那个方案处理',recentRequests:['旧的旅行安排','检查 GPU 费用变化','收到。','确认 OXC-0050 的订单价格','继续']});
 expect(plan.reason).toBe('continuation');
 expect(plan.query).toContain('检查 GPU 费用变化');
 expect(plan.query).toContain('确认 OXC-0050 的订单价格');
 expect(plan.query).toContain('继续，按那个方案处理');
 expect(plan.query).not.toContain('旧的旅行安排');
 expect(plan.query).not.toContain('收到');
});

test('explicit historical questions recover recent subject context without contaminating a new subject', () => {
 expect(planMemoryRecall({request:'上次是怎么决定的？',recentRequests:['确认 Azure 的导出流程']})).toEqual({query:'上次是怎么决定的？\n确认 Azure 的导出流程',reason:'history'});
 expect(planMemoryRecall({request:'调整 GCP 预算',recentRequests:['确认 Azure 的导出流程']})).toEqual({query:'调整 GCP 预算',reason:'request'});
});

test('task context supplements a current discovery rather than replacing it', () => {
 const plan=planMemoryRecall({request:'发现 us-west2 映射缺失，查这个区域',recentRequests:[],taskRequest:'检查 GPU 供应商映射'});
 expect(plan.query).toBe('发现 us-west2 映射缺失，查这个区域\n检查 GPU 供应商映射');
});

test('queries stay within the tool limit with valid Unicode and preserve the current request first', () => {
 const request='Investigate new-region '+ '🚀'.repeat(1500),plan=planMemoryRecall({request,recentRequests:[],taskRequest:'Existing task context'});
 expect(plan.query!.startsWith('Investigate new-region ')).toBe(true);
 expect(plan.query!.length).toBeLessThanOrEqual(2000);
 expect(plan.query).not.toMatch(/[\uD800-\uDBFF]$/u);
 expect(plan.query).toContain('Existing task context');
});
