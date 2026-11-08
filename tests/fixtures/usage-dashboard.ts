export const totals = (n: number | null) => ({ totalTokens: n, inputTokens: n === null ? null : n * .8, outputTokens: n === null ? null : n * .2, cachedInputTokens: n === null ? null : n * .3, cacheWriteInputTokens: null, reasoningOutputTokens: n === null ? null : n * .1 });
const coverage = { observed: 12, partial: 2, unknown: 1, total: 15 };
const group = (key: string, n: number | null) => ({ key, totals: totals(n), coverage });
export const summary = {
 window: { start: '2026-10-11T00:00:00+08:00', end: '2026-10-18T00:00:00+08:00', timeZone: 'Asia/Singapore', period: 'week' }, generatedAt: '2026-10-17T07:00:00Z',
 totals: totals(1250000), coverage,
 daily: [120000, 200000, null, 180000, 0, 300000, 450000].map((n, i) => ({ date: `2026-10-${11 + i}`, totals: totals(n), coverage })),
 groups: { agent: [group('architect', 900000), group('reader', 350000)], project: [group('one', 1250000)], model: [group('gpt-5', 1250000)], cli: [group('codex', 1250000)], category: [group('task', 1000000), group('memory', 250000)], stage: [], reviewStage: [], callKind: [] },
 recent: [{ executionId: 'usage-sample', model: 'gpt-5', cli: 'codex', coverage: 'observed', totals: totals(10000), conversationId: 'usage-conversation', taskId: null }],
};
export const config = { version: 2, system: { cli: 'codex' }, projects: [{ id: 'one', name: 'Mandala', cwd: '/tmp', agentIds: ['architect'], resources: [], mcp: [], skills: [] }], agents: ['architect', 'reader'].map(id => ({ id, name: id === 'architect' ? '产品与架构' : '研究助手', instructions: '', defaultCli: 'codex', models: {}, mcp: [], skills: [] })) };
