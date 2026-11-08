import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { watch } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const executable = resolve('cli/openmana.mjs');
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(handler: (req: IncomingMessage, res: ServerResponse, body: any) => void) {
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    handler(req, res, req.headers['content-type'] === 'application/json' ? JSON.parse(text || '{}') : Buffer.concat(chunks));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  cleanups.push(() => new Promise<void>(done => server.close(() => done())));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { baseUrl };
}
function run(args: string[], env: Record<string, string> = {}, timeout = 0) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(done => {
    execFile(process.execPath, [executable, ...args], { env: { ...process.env, OPEN_MANA_CONTEXT: '', ...env }, timeout }, (error, stdout, stderr) => {
      done({ code: typeof error?.code === 'number' ? error.code : error ? 1 : 0, stdout, stderr });
    });
  });
}
const reply = (res: ServerResponse, body: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
it('documents complete coordinator criteria and executor arguments in action help',async()=>{
 for(const action of ['create','takeover','delegate']){
  const help=JSON.parse((await run(['mandala',action,'--help'])).stdout).data.commands[0];
  expect(help.agentDataExample.criteria).toEqual([{id:'evidence',text:'Return verifiable evidence',checkRef:null}]);
  expect(help.agentDataExample).toHaveProperty(action==='create'?'projectId':'taskId');
 }
 const help=JSON.parse((await run(['tasks','create','--help'])).stdout).data.commands[0];
 expect(help.criteriaShape).toEqual({id:'unique string',text:'non-empty string',checkRef:'null or check reference'});
 expect(help.acceptanceValues).toEqual(['delivery','checks','human']);
});
async function temporary() { const directory = await mkdtemp(join(tmpdir(), 'openmana-cli-')); cleanups.push(() => rm(directory, { recursive: true, force: true })); return directory; }

describe('business CLI', () => {
  it('documents and routes on-demand work planning only through the invocation identity',async()=>{
    const requests:any[]=[],{baseUrl}=await fixture((req,res,body)=>{requests.push({path:req.url,body});reply(res,{accepted:true});});
    const context=join(await temporary(),'context.json');await writeFile(context,JSON.stringify({baseUrl,token:'bound'}),{mode:0o600});
    for(const [action,fields,args] of [['discover-work',['runtimes','includePaths','excludePaths','limit'],{runtimes:['omp'],includePaths:['/work'],excludePaths:['/old'],limit:20}],['planning-guide',[],{}],['discover-capabilities',['runtimes','directories','query','limit'],{runtimes:['omp'],directories:['/work'],query:'data',limit:10}]] as const){
      const help=await run(['mandala',action,'--help']);expect(help.code).toBe(0);
      expect(JSON.parse(help.stdout).data.commands[0]).toMatchObject({command:'mandala '+action,agent:true,invocationOnly:true,boundFields:fields,agentDataExample:action==='planning-guide'?{}:action==='discover-capabilities'?{directories:[],query:'',limit:150}:{includePaths:[],excludePaths:[],limit:50}});
      expect((await run(['mandala',action,'--data',JSON.stringify(args),'--key','work-plan'],{OPEN_MANA_CONTEXT:context})).code).toBe(0);
      expect(requests.at(-1)).toEqual({path:'/api/cli/invoke',body:{command:'mandala '+action,args,commandKey:'work-plan'}});
      expect((await run(['mandala',action,'--base-url',baseUrl])).code).toBe(1);
      expect((await run(['mandala',action,'--data','{"codexHome":"/forged"}'],{OPEN_MANA_CONTEXT:context})).code).toBe(1);
    }
    expect(requests).toHaveLength(3);
  });
  it('documents root, group and action help and rejects unknown commands', async () => {
    for (const args of [['--help'], ['assets', '--help'], ['tasks', 'start', '--help']]) {
      const result = await run(args); expect(result.code).toBe(0); expect(result.stdout).toContain('mandala');
    }
    const result = await run(['api', 'request']); expect(result.code).toBe(1); expect(JSON.parse(result.stderr).error.code).toBe('unknown_command');
  });
  it('encodes positional IDs, query values and stable write keys', async () => {
    const requests: any[] = [];
    const { baseUrl } = await fixture((req, res, body) => { requests.push({ path: req.url, key: req.headers['idempotency-key'], body }); reply(res, { accepted: true }); });
    const result = await run(['tasks', 'start', 'task/a', '--data', '{"expectedRevision":2}', '--key', 'stable-1', '--base-url', baseUrl]);
    expect(result.code).toBe(0); expect(requests).toEqual([{ path: '/api/v2/tasks/task%2Fa/start', key: 'stable-1', body: { expectedRevision: 2 } }]);
    await run(['market', 'search', '--query', '{"kind":"skill","query":"a & b"}', '--base-url', baseUrl]);
    expect(requests[1].path).toBe('/api/market/search?kind=skill&query=a+%26+b');
  });
  it('generates stable retry keys and rejects non-loopback destinations before HTTP', async () => {
    let requestKey;
    const { baseUrl } = await fixture((req, res) => { requestKey = req.headers['idempotency-key']; expect(req.headers['x-openmana-cli']).toBe('1'); reply(res, { id: 't1' }); });
    const generated = await run(['tasks', 'create', '--data', '{}', '--base-url', baseUrl]);
    expect(generated.code).toBe(0); expect(JSON.parse(generated.stdout).commandKey).toBe(requestKey); expect(requestKey).toMatch(/^[a-z0-9-]+$/);
    for (const baseUrl of ['https://example.com', 'http://127.0.0.1.example.com', 'http://user:pass@localhost', 'http://localhost/api', 'http://127.1']) {
      const result = await run(['config', 'get', '--base-url', baseUrl]); expect(result.code).toBe(1); expect(JSON.parse(result.stderr).error.code).toBe('invalid_base_url');
    }
  });
  it('reads JSON files and returns structured HTTP errors without retrying writes', async () => {
    let calls = 0;
    const { baseUrl } = await fixture((_req, res, body) => { calls++; expect(body).toEqual({ expectedRevision: 4 }); reply(res, { code: 'stale_revision', error: 'Changed' }, 409); });
    const file = join(await temporary(), 'input.json'); await writeFile(file, '{"expectedRevision":4}');
    const result = await run(['tasks', 'stop', 't1', '--data', '@' + file, '--base-url', baseUrl]);
    expect(result.code).toBe(1); expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, command: 'tasks stop', error: { code: 'stale_revision', status: 409, message: 'Changed' } }); expect(calls).toBe(1);
  });
  it('submits semantic config edits with supplied revision without assembling a changing snapshot', async () => {
    const config = { agents: [{ id: 'a1', name: 'old' }], projects: [{ id: 'p1' }], chatDefaults: { model: 'test' } };
    const writes: any[] = [];
    const { baseUrl } = await fixture((req, res, body) => { if (req.method === 'GET') reply(res, { revision: 'current', config }); else { expect(req.url).toBe('/api/cli/config/agents/upsert'); expect(req.method).toBe('POST'); writes.push(body); reply(res, { revision: 'next' }); } });
    const missing = await run(['agents', 'upsert', '--data', '{"agent":{"id":"a1"}}', '--base-url', baseUrl]); expect(missing.code).toBe(1); expect(writes).toHaveLength(0);
    const result = await run(['agents', 'upsert', '--data', '{"revision":"supplied","agent":{"id":"a1","name":"new"}}', '--base-url', baseUrl]);
    expect(result.code).toBe(0); expect(writes).toEqual([{ revision: 'supplied', agent: { id: 'a1', name: 'new' } }]);
  });
  it('sends Agent commands through invocation token and rejects all unbound routes', async () => {
    const requests: any[] = [];
    const { baseUrl } = await fixture((req, res, body) => { requests.push({ path: req.url, authorization: req.headers.authorization, body }); reply(res, { text: 'authorized' }); });
    const context = join(await temporary(), 'context.json'); await writeFile(context, JSON.stringify({ baseUrl, token: 'private-token' }), { mode: 0o600 });
    const result = await run(['assets', 'read', 'asset1', 'version1', '0'], { OPEN_MANA_CONTEXT: context });
    expect(result.code).toBe(0); expect(requests[0]).toMatchObject({ path: '/api/cli/invoke', authorization: 'Bearer private-token', body: { command: 'assets read', args: { assetId: 'asset1', versionId: 'version1', fileId: '0' } } });
    for (const args of [['config', 'get'], ['terminal', 'open', 'chat1'], ['agents', 'list'], ['project', 'agents', 'p1']]) {
      const denied = await run(args, { OPEN_MANA_CONTEXT: context }); expect(denied.code).toBe(1);
    }
    const override = await run(['memory', 'search', '--data', '{"query":"term"}', '--base-url', baseUrl], { OPEN_MANA_CONTEXT: context }); expect(override.code).toBe(1);
    expect(requests).toHaveLength(1); expect(result.stdout + result.stderr).not.toContain('private-token');
  });
  it('requires private regular context files and never prints their token', async () => {
    const context = join(await temporary(), 'context.json'); await writeFile(context, '{"baseUrl":"http://127.0.0.1:4332","token":"secret-123"}', { mode: 0o644 });
    const result = await run(['project', 'agents'], { OPEN_MANA_CONTEXT: context }); expect(result.code).toBe(1); expect(JSON.parse(result.stderr).error.code).toBe('invalid_context'); expect(result.stderr).not.toContain('secret-123');
    const privateFile = join(await temporary(), 'private.json'), link = privateFile + '.link';
    await writeFile(privateFile, '{"baseUrl":"http://127.0.0.1:4332","token":"secret-123"}', { mode: 0o600 }); await symlink(privateFile, link);
    const linked = await run(['project', 'agents'], { OPEN_MANA_CONTEXT: link }); expect(JSON.parse(linked.stderr).error.code).toBe('invalid_context');
  });
  it('never follows redirects and excludes POST reads from mutation receipts', async () => {
    const requests: any[] = [];
    const { baseUrl } = await fixture((req, res, body) => { requests.push({ path: req.url, journal: req.headers['x-openmana-cli'], key: req.headers['idempotency-key'], body });
      if (req.url === '/api/config') { res.writeHead(302, { Location: '/api/memory' }); res.end(); } else reply(res, { items: [] }); });
    const redirected = await run(['config', 'get', '--base-url', baseUrl]); expect(redirected.code).toBe(1); expect(JSON.parse(redirected.stderr).error.status).toBe(302); expect(requests).toHaveLength(1);
    const searched = await run(['memory', 'search', '--data', '{"query":"term"}', '--base-url', baseUrl]); expect(searched.code).toBe(0); expect(requests[1].journal).toBeUndefined(); expect(requests[1].key).toBeUndefined();
  });
  it('validates arguments before sending requests and keeps same key on error', async () => {
    const requests: any[] = [];
    const { baseUrl } = await fixture((req, res, body) => { requests.push({ path: req.url, body }); reply(res, { error: 'bad_request' }, 422); });
    for (const args of [['tasks', 'get'], ['tasks', 'list', '--query', '{"bad":[]}'], ['tasks', 'start', 't1', 'extra'], ['tasks', 'start', 't1', '--data', '[]'], ['tasks', 'get', 't1', '--data', '{"other":1}'], ['tasks', 'get', 't1', '--wat', 'test']]) {
      const result = await run([...args, '--base-url', baseUrl]); expect(result.code).toBe(1);
    }
    expect(requests).toHaveLength(0);
    const rejected = await run(['conversations', 'enqueue', 'c1', '--data', '{"text":"hello"}', '--command-key', 'stable', '--json', '--base-url', baseUrl]);
    expect(rejected.code).toBe(1); expect(JSON.parse(rejected.stderr)).toMatchObject({ commandKey: 'stable', error: { code: 'bad_request', status: 422 } }); expect(requests[0].body).toEqual({ text: 'hello', commandKey: 'stable' });
  });
  it('supports config entity list/get/remove and rejects a missing entity', async () => {
    const config = { agents: [{ id: 'a1', name: 'A' }, { id: 'a2', name: 'B' }], projects: [{ id: 'p1', agentIds: ['a1'] }] };
    let write;
    const { baseUrl } = await fixture((req, res, body) => { if (req.method === 'GET') reply(res, { revision: 'v1', config }); else { write = body; reply(res, { revision: 'v2' }); } });
    const listed = await run(['agents', 'list', '--base-url', baseUrl]); expect(JSON.parse(listed.stdout).data).toEqual({ revision: 'v1', agents: config.agents });
    const got = await run(['projects', 'get', 'p1', '--base-url', baseUrl]); expect(JSON.parse(got.stdout).data.project).toEqual(config.projects[0]);
    const available = await run(['project', 'agents', 'p1', '--base-url', baseUrl]); expect(JSON.parse(available.stdout).data.agents).toEqual([{ id: 'a1', name: 'A' }]);
    const missing = await run(['agents', 'get', 'unknown', '--base-url', baseUrl]); expect(JSON.parse(missing.stderr).error.status).toBe(404);
    const removed = await run(['agents', 'remove', 'a1', '--data', '{"revision":"v1"}', '--key', 'remove-1', '--base-url', baseUrl]); expect(removed.code).toBe(0); expect(write).toEqual({ id: 'a1', revision: 'v1' });
  });
  it('maps bound Agent commands and rejects forged identity fields', async () => {
    const requests: any[] = [];
    const { baseUrl } = await fixture((req, res, body) => { requests.push({ path: req.url, body }); reply(res, { id: 'result' }); });
    const context = join(await temporary(), 'context.json'); await writeFile(context, JSON.stringify({ baseUrl, token: 'private' }), { mode: 0o600 });
    const cases: Array<[string[], string, any]> = [
      [['project', 'agents'], 'project agents', {}],
      [['tasks', 'delegate', '--data', '{"targetAgentId":"a2","request":"help"}'], 'tasks delegate', { targetAgentId: 'a2', request: 'help' }],
      [['assets', 'publish', '--data', '{"title":"Report","files":[{"path":"report.txt"}]}'], 'assets publish', { title: 'Report', files: [{ path: 'report.txt' }] }],
      [['assets', 'update', '--data', '{"assetId":"a","expectedHeadVersionId":"v","path":"roadmap.md"}'], 'assets update', {assetId:'a',expectedHeadVersionId:'v',path:'roadmap.md'}],
      [['assets', 'read', 'a', 'v', '0'], 'assets read', { assetId: 'a', versionId: 'v', fileId: '0' }],
      [['memory', 'search', '--data', '{"query":"term"}'], 'memory search', { query: 'term' }],
      [['memory', 'read', 'r1'], 'memory read', { recordId: 'r1' }],
      [['tasks', 'context'], 'tasks context', {}],
      [['tasks', 'list', '--data', '{"query":"Report","conversationId":"c1"}'], 'tasks list', {query:'Report',conversationId:'c1'}],
      [['tasks', 'get', 't1'], 'tasks get', {taskId:'t1'}],
      [['tasks', 'create', '--data', '{"goal":"Report","projectId":null}'], 'tasks create', {goal:'Report',projectId:null}],
      [['tasks', 'update', 't1', '--data', '{"expectedRevision":2,"participantAgentIds":["a","b"],"state":"review"}'], 'tasks update', {taskId:'t1',expectedRevision:2,participantAgentIds:['a','b'],state:'review'}],
      [['tasks', 'execution-add', 't1', '--data', '{"expectedRevision":2,"conversationId":"c1"}'], 'tasks execution-add', {taskId:'t1',conversationId:'c1',expectedRevision:2}],
      [['tasks', 'execution-remove', 't1', 'e1', '--data', '{"expectedRevision":3}'], 'tasks execution-remove', {taskId:'t1',executionId:'e1',expectedRevision:3}],
      [['conversations', 'list', '--data', '{"query":"Report","projectId":"p"}'], 'conversations list', {query:'Report',projectId:'p'}],
      [['conversations', 'get', 'c1'], 'conversations get', {conversationId:'c1'}],
      [['conversations', 'history', 'c1', '--data', '{"after":7}'], 'conversations history', {conversationId:'c1',after:7}],
    ];
    for (const [args, command, expected] of cases) {
      const result = await run([...args, '--key', 'bound-1'], { OPEN_MANA_CONTEXT: context }); expect(result.code).toBe(0); expect(requests.at(-1)).toEqual({ path: '/api/cli/invoke', body: { command, args: expected, commandKey: 'bound-1' } });
    }
    const forbidden = await run(['tasks', 'delegate', '--data', '{"targetAgentId":"a2","request":"help","sourceConversationId":"forged"}'], { OPEN_MANA_CONTEXT: context }); expect(forbidden.code).toBe(1); expect(requests).toHaveLength(17);
  });

  it('keeps user queries distinct from bound Agent task actions and rejects identity overrides',async()=>{
    const requests:any[]=[],{baseUrl}=await fixture((req,res,body)=>{requests.push({method:req.method,path:req.url,body});reply(res,{ok:true});});
    const context=join(await temporary(),'context.json');await writeFile(context,JSON.stringify({baseUrl,token:'bound'}),{mode:0o600});
    await run(['tasks','context','--query','{"conversationId":"c1"}','--base-url',baseUrl]);
    expect(requests[0]).toMatchObject({method:'GET',path:'/api/v2/tasks/context?conversationId=c1'});
    await run(['tasks','list','--query','{"query":"Report","conversationId":"c1"}','--base-url',baseUrl]);
    expect(requests[1].path).toBe('/api/v2/tasks?query=Report&conversationId=c1');
    const prior=requests.length;
    expect((await run(['tasks','list','--data','{"query":"Report"}','--base-url',baseUrl])).code).toBe(1);
    expect((await run(['tasks','list','--query','{"query":"Report"}'],{OPEN_MANA_CONTEXT:context})).code).toBe(1);
    for(const action of ['review','complete','mark-completed','accept','reopen']){expect((await run(['tasks',action,'t1','--data','{"expectedRevision":1}'],{OPEN_MANA_CONTEXT:context})).code).toBe(0);expect(requests.at(-1).body).toMatchObject({command:'tasks '+action,args:{taskId:'t1',expectedRevision:1}});}
    for(const data of [{taskId:'t1',ownerUserId:'admin'},{taskId:'t1',agentId:'other'},{taskId:'t1',completion:{completedBy:'user'}},{taskId:'different',expectedRevision:1}])expect((await run(['tasks','update','t1','--data',JSON.stringify(data)],{OPEN_MANA_CONTEXT:context})).code).toBe(1);
    expect(requests).toHaveLength(prior+5);
    expect((await run(['tasks','create','--data','{"goal":"Goal","projectId":null,"acceptance":"checks"}'],{OPEN_MANA_CONTEXT:context})).code).toBe(0);
    expect(requests.at(-1).body).toMatchObject({command:'tasks create',args:{acceptance:'checks'}});
  });
  it('documents independent Task creation, explicit links and authorized Agent completion',async()=>{
    const entry=async(action:string)=>JSON.parse((await run(['tasks',action,'--help'])).stdout).data.commands[0];
    expect((await entry('create')).agentDataExample).toMatchObject({goal:'Write a report',projectId:null});
    expect((await entry('update')).dataExample).toMatchObject({expectedRevision:1,goal:'Updated report goal'});
    expect((await entry('context')).queryExample).toEqual({conversationId:'chat-id'});
    expect((await entry('execution-add')).boundFields).toEqual(['taskId','expectedRevision','conversationId']);
    expect((await entry('get')).resultShape).toEqual({user:'Task detail with runs and receipts',agent:'Task; verified system Agent receives a readOnly task summary without private execution context'});
    expect((await entry('accept')).agent).toBe(true);expect((await entry('mark-completed')).note).toContain('Explicitly mark completed');
  });
  it('uploads raw bytes and downloads binary files to explicit output only', async () => {
    const bytes = Buffer.from([0, 1, 255, 13]); const directory = await temporary(), input = join(directory, 'input.bin'), output = join(directory, 'output.bin'); await writeFile(input, bytes);
    let upload: Buffer | undefined;
    const { baseUrl } = await fixture((req, res, body) => { if (req.method === 'POST') { upload = body; expect(req.headers['x-openmana-cli']).toBeUndefined(); reply(res, { submissionId: 'stage' }); } else { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(bytes); } });
    const result = await run(['assets', 'read', 'a', 'v', '0', '--output', output, '--base-url', baseUrl]); expect(result.code).toBe(0); expect(await readFile(output)).toEqual(bytes);
    const missing = await run(['assets', 'read', 'a', 'v', '0', '--base-url', baseUrl]); expect(missing.code).toBe(1);
    const uploaded = await run(['assets', 'upload', '--input', input, '--query', '{"name":"input.bin"}', '--base-url', baseUrl]); expect(uploaded.code).toBe(0); expect(upload).toEqual(bytes);
  });
  it('streams SSE as JSON envelopes instead of buffering forever', async () => {
    const { baseUrl } = await fixture((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('id: 7\nevent: data\ndata: {"text":"hello"}\n\n'); });
    const result = await run(['conversations', 'events', 'c1', '--base-url', baseUrl]); expect(result.code).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, data: { id: '7', event: 'data', data: { text: 'hello' } } });
  });
  it('has a named entry for each audited HTTP operation', async () => {
    const registry = await import(/* @vite-ignore */ resolve('cli/commands.mjs'));
    const names = registry.COMMANDS.map((entry: any) => entry.name);
    const required = {
      service: 'status', config: 'get put', agents: 'list get upsert remove', projects: 'list get upsert remove', project: 'agents',
      directories: 'list', capabilities: 'list effective', models: 'list', cli: 'status', knowledge: 'list create update remove',
      conversations: 'list create get rename workspace workspace-file local-file upload attachment model queue enqueue cancel-input approval-mode history events completion archive title memory fork branch edit send continue stop answer approve',
      tasks: 'context list get update execution-add execution-remove review control create adopt-plan source start stop cancel complete accept reopen request-changes assign delegate legacy-list',
      assets: 'list create get upload import versions publish version read inspect access lifecycle bindings bind unbind',
      memory: 'list search organize jobs result source read correct retract', market: 'search detail installed install unlink uninstall',
      automations: 'list create update remove run stop', terminal: 'get open close input resize events', 'system-tasks': 'status run stop',
    };
    for (const [group, actions] of Object.entries(required)) for (const action of actions.split(' ')) expect(names).toContain(`${group} ${action}`);
    expect(names.length).toBe(new Set(names).size);
    expect(names).not.toContain('tools invoke');
  });
  it('maps overloaded and renamed actions to their precise HTTP methods and paths', async () => {
    const registry = await import(/* @vite-ignore */ resolve('cli/commands.mjs'));
    const cases: Array<[string, string[], string, string]> = [
      ['service status', [], 'GET', '/api/status'],
      ['tasks context', [], 'GET', '/api/v2/tasks/context'],
      ['tasks update', ['t1'], 'PATCH', '/api/v2/tasks/t1'],
      ['tasks execution-add', ['t1'], 'POST', '/api/v2/tasks/t1/executions'],
      ['tasks execution-remove', ['t1','e1'], 'POST', '/api/v2/tasks/t1/executions/e1/remove'],
      ['tasks review', ['t1'], 'POST', '/api/v2/tasks/t1/complete'],
      ['tasks delegate', [], 'POST', '/api/tasks'], ['tasks legacy-list', [], 'GET', '/api/tasks'],
      ['tasks request-changes', ['t1'], 'POST', '/api/v2/tasks/t1/request_changes'],
      ['conversations rename', ['c1'], 'PATCH', '/api/conversations/c1'],
      ['conversations send', ['c1'], 'POST', '/api/conversations/c1/messages'],
      ['conversations history', ['c1'], 'GET', '/api/conversations/c1/history'],
      ['conversations cancel-input', ['c1', 'q1'], 'DELETE', '/api/conversations/c1/queue/q1'],
      ['conversations answer', ['c1', 'q1'], 'POST', '/api/conversations/c1/questions/q1'],
      ['assets publish', ['a1'], 'POST', '/api/v2/assets/a1/versions'],
      ['assets read', ['a1', 'v1', '0'], 'GET', '/api/v2/assets/a1/versions/v1/files/0'],
      ['assets inspect', ['a1', 'v1', '0'], 'HEAD', '/api/v2/assets/a1/versions/v1/files/0'],
      ['memory read', ['r1'], 'GET', '/api/v2/memory/records/r1'],
      ['memory result', ['j1'], 'GET', '/api/v2/memory/jobs/j1/result'],
      ['market unlink', ['market-id'], 'POST', '/api/market/installed/market-id/unlink'],
      ['automations remove', ['auto1'], 'DELETE', '/api/automations/auto1'],
      ['terminal close', ['c1'], 'DELETE', '/api/conversations/c1/terminal'],
      ['system-tasks run', ['c1', 'title'], 'POST', '/api/system-tasks/c1/title/run'],
    ];
    for (const [name, ids, method, path] of cases) expect(registry.resolveRequest(registry.findCommand(name), { ids, key: 'test' })).toMatchObject({ method, path });
  });
  it('action help explains revision payloads and user versus Agent publication', async () => {
    const stop = JSON.parse((await run(['tasks', 'stop', '--help'])).stdout).data.commands[0]; expect(stop.dataExample).toEqual({ expectedRevision: 1 });
    const edit = JSON.parse((await run(['agents', 'upsert', '--help'])).stdout).data.commands[0]; expect(edit.dataExample).toMatchObject({ revision: '<config revision>', agent: { id: 'agent-id' } });
    const publish = JSON.parse((await run(['assets', 'publish', '--help'])).stdout).data.commands[0]; expect(publish.dataExample.submissionId).toBeDefined(); expect(publish.agentDataExample.files).toEqual([{ path: 'report.txt' }]);
  });
  it('uses the invocation mailbox for constrained Agents with unchanged bound args and keys', async () => {
    const directory = await temporary(), mailboxPath = join(directory, 'mailbox'), context = join(directory, 'context.json');
    await mkdir(mailboxPath, { mode: 0o700 }); await writeFile(context, JSON.stringify({ baseUrl: 'http://127.0.0.1:1', token: 'private-token', mailboxPath }), { mode: 0o600 });
    const requests: any[] = [], seen = new Set<string>();
    const watcher = watch(mailboxPath, async (_event, file) => {
      if (!file?.endsWith('.request') || seen.has(file)) return; seen.add(file);
      const request = JSON.parse(await readFile(join(mailboxPath, file), 'utf8')); requests.push(request);
      await writeFile(join(mailboxPath, file.replace('.request', '.response')), JSON.stringify({ ok: true, data: { id: 'task1' } }), { mode: 0o600, flag: 'wx' });
    });
    cleanups.push(async () => watcher.close());
    const result = await run(['tasks', 'delegate', '--data', '{"targetAgentId":"a1","request":"Review"}', '--key', 'retry-1'], { OPEN_MANA_CONTEXT: context });
    expect(result.code).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, commandKey: 'retry-1', data: { id: 'task1' } });
    expect(requests).toEqual([{ command: 'tasks delegate', args: { targetAgentId: 'a1', request: 'Review' }, commandKey: 'retry-1' }]); expect(await readdir(mailboxPath)).toEqual([]);
  });
  it('rejects an arbitrary or symlink mailbox path before issuing commands', async () => {
    const directory = await temporary(), context = join(directory, 'context.json'), other = join(directory, 'other'); await mkdir(other, { mode: 0o700 });
    await writeFile(context, JSON.stringify({ baseUrl: 'http://127.0.0.1:1', token: 'secret', mailboxPath: other }), { mode: 0o600 });
    const outside = await run(['project', 'agents'], { OPEN_MANA_CONTEXT: context }); expect(JSON.parse(outside.stderr).error.code).toBe('invalid_context');
    const mailboxPath = join(directory, 'mailbox'); await symlink(other, mailboxPath);
    await writeFile(context, JSON.stringify({ baseUrl: 'http://127.0.0.1:1', token: 'secret', mailboxPath }), { mode: 0o600 });
    const linked = await run(['project', 'agents'], { OPEN_MANA_CONTEXT: context }); expect(JSON.parse(linked.stderr).error.code).toBe('invalid_context'); expect(await readdir(other)).toEqual([]);
  });
  it('cleans mailbox files after domain errors, disposal and timeout without retrying', async () => {
    const cli = await import(/* @vite-ignore */ resolve('cli/openmana.mjs'));
    const directory = await temporary(), mailboxPath = join(directory, 'mailbox'); await mkdir(mailboxPath, { mode: 0o700 });
    const command = { command: 'tasks delegate', args: { targetAgentId: 'a1', request: 'Review' }, commandKey: 'stable' };
    const seen = new Set<string>(); let requests = 0;
    const watcher = watch(mailboxPath, async (_event, file) => {
      if (!file?.endsWith('.request') || seen.has(file)) return; seen.add(file); requests++;
      await writeFile(join(mailboxPath, file.replace('.request', '.response')), JSON.stringify({ ok: false, error: { code: 'forbidden', message: 'Expired invocation', status: 403 } }), { mode: 0o600, flag: 'wx' });
    });
    await expect(cli.invokeMailbox(mailboxPath, command, 1000)).rejects.toMatchObject({ code: 'forbidden', status: 403 }); watcher.close();
    expect(requests).toBe(1); expect(await readdir(mailboxPath)).toEqual([]);
    await expect(cli.invokeMailbox(mailboxPath, command, 80)).rejects.toMatchObject({ code: 'command_unconfirmed' }); expect(await readdir(mailboxPath)).toEqual([]);
    const pending = cli.invokeMailbox(mailboxPath, command, 1000); await new Promise(done => setTimeout(done, 30)); await rm(mailboxPath, { recursive: true });
    await expect(pending).rejects.toMatchObject({ code: 'invalid_context' });
  });
  it('rejects symlink mailbox responses and preserves outside file content', async () => {
    const cli = await import(/* @vite-ignore */ resolve('cli/openmana.mjs'));
    const directory = await temporary(), mailboxPath = join(directory, 'mailbox'), outside = join(directory, 'outside'); await mkdir(mailboxPath, { mode: 0o700 }); await writeFile(outside, '{"ok":true,"data":"secret"}', { mode: 0o600 });
    const seen = new Set<string>();
    const watcher = watch(mailboxPath, async (_event, file) => {
      if (!file?.endsWith('.request') || seen.has(file)) return; seen.add(file); await symlink(outside, join(mailboxPath, file.replace('.request', '.response')));
    }); cleanups.push(async () => watcher.close());
    await expect(cli.invokeMailbox(mailboxPath, { command: 'project agents', args: {}, commandKey: 'read-1' }, 1000)).rejects.toMatchObject({ code: 'invalid_response' });
    expect(await readFile(outside, 'utf8')).toBe('{"ok":true,"data":"secret"}'); expect(await readdir(mailboxPath)).toEqual([]);
  });
  it('rejects FIFO context and response files without blocking native file reads', async () => {
    const directory = await temporary(), context = join(directory, 'context.json'), mailboxPath = join(directory, 'mailbox'), sample = join(directory, 'sample.txt'); await mkdir(mailboxPath, { mode: 0o700 }); await writeFile(sample, 'file pool works');
    const fifo = (path: string) => new Promise<void>((done, reject) => execFile('mkfifo', ['-m', '600', path], error => error ? reject(error) : done()));
    await fifo(context);
    const blockedContext = await run(['project', 'agents'], { OPEN_MANA_CONTEXT: context }, 3000);
    expect(blockedContext.code).toBe(1); expect(JSON.parse(blockedContext.stderr).error.code).toBe('invalid_context');
    const seen = new Set<string>();
    const watcher = watch(mailboxPath, async (_event, file) => {
      if (!file?.endsWith('.request') || seen.has(file)) return; seen.add(file); await fifo(join(mailboxPath, file.replace('.request', '.response')));
    }); cleanups.push(async () => watcher.close());
    const script = `
      import { invokeMailbox } from ${JSON.stringify(new URL('../cli/openmana.mjs', import.meta.url).href)};
      import { readFile } from 'node:fs/promises';
      const calls = Array.from({length:4}, () => invokeMailbox(${JSON.stringify(mailboxPath)}, {command:'project agents',args:{},commandKey:'fifo-test'}, 2000).catch(error => error.code));
      const results = await Promise.all(calls);
      const sample = await readFile(${JSON.stringify(sample)}, 'utf8');
      console.log(JSON.stringify({results,sample}));
    `;
    const result = await new Promise<{ error: Error | null; stdout: string }>(done => execFile(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000 }, (error, stdout) => done({ error, stdout })));
    expect(result.error).toBeNull(); expect(JSON.parse(result.stdout)).toEqual({ results: Array(4).fill('invalid_response'), sample: 'file pool works' });
    expect(await readdir(mailboxPath)).toEqual([]);
  });
});

it('progress report is invocation-only and carries stable public report keys without identity overrides',async()=>{
 const requests:any[]=[];const {baseUrl}=await fixture((req,res,body)=>{requests.push(body);reply(res,{accepted:true});});
 const directory=await temporary(),contextFile=join(directory,'context.json');await writeFile(contextFile,JSON.stringify({baseUrl,token:'bound-token'}),{mode:0o600});
 const env={OPEN_MANA_CONTEXT:contextFile,MANDALA_CONTEXT:contextFile};
 const result=await run(['progress','report','--data','{"text":"Checking inputs"}','--key','stable-report'],env);
 expect(result.code).toBe(0);expect(requests).toEqual([{command:'progress report',args:{text:'Checking inputs'},commandKey:'stable-report'}]);
 const forged=await run(['progress','report','--data','{"text":"Checking","agentId":"forged"}'],env);expect(forged.code).toBe(1);expect(requests).toHaveLength(1);
 const unbound=await run(['progress','report','--data','{"text":"Checking"}'],{MANDALA_CONTEXT:'',OPEN_MANA_CONTEXT:''});expect(unbound.code).toBe(1);expect(requests).toHaveLength(1);
});
