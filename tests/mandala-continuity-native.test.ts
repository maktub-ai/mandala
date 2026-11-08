import {expect,it} from 'vitest';
import {chmod,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {connectCodex} from '../server/codex';
import {startOmp} from '../server/omp';
import type {RpcClient} from '../server/rpc';

it('Codex accepts compaction asynchronously and requires exact idle and background-terminal evidence',async()=>{
 let active=false,background=false;
 const requests:{method:string;params:unknown}[]=[];
 const rpc={async request(method:string,params:any){requests.push({method,params});
  if(method==='initialize')return {userAgent:'Codex/0.160.0'};
  if(method==='thread/read')return {thread:{id:params.threadId,status:{type:active?'active':'idle'},turns:[{id:'old',status:'completed',items:[{type:'contextCompaction'}]}]}};
  if(method==='thread/backgroundTerminals/list')return {data:background?[{id:'job'}]:[],nextCursor:null};
  return {};
 },notify(){},close(){}} as unknown as RpcClient;
 const client=await connectCodex(rpc);
 expect(await client.inspectContext!('native')).toEqual({settled:true,completedCompactions:['old']});
 active=true;expect((await client.inspectContext!('native')).settled).toBe(false);active=false;
 background=true;expect((await client.inspectContext!('native')).settled).toBe(false);background=false;
 expect(await client.compactThread!('native')).toBe('started');
 expect(requests.at(-1)).toEqual({method:'thread/compact/start',params:{threadId:'native'}});
});

it.each(['success','small','async'] as const)('OMP real JSON-line transport distinguishes %s from native completed state',async mode=>{
 const dir=await mkdtemp(join(tmpdir(),'mandala-compact-omp-'));
 await writeFile(join(dir,'omp'),`#!/usr/bin/env node
const {createInterface}=require('node:readline');
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
send({type:'ready'});
createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);
 if(r.type==='get_state')return send({type:'response',id:r.id,success:true,data:{sessionFile:'native',isSettled:${mode!=='async'},isStreaming:false,isCompacting:false,hasPendingAsyncWork:${mode==='async'},queuedMessageCount:0}});
 if(r.type==='compact')return setTimeout(()=>send({type:'response',id:r.id,success:${mode!=='small'},${mode==='small'?"error:'Nothing to compact (session too small)'":"data:{summary:'PRIVATE_NATIVE_SUMMARY',firstKeptEntryId:'item',tokensBefore:1000}"}}),25);
});
`);await chmod(join(dir,'omp'),0o700);
 const events:unknown[]=[];let client;
 try{
  client=await startOmp({cwd:dir,env:{PATH:dir+':'+process.env.PATH},onEvent:e=>events.push(e),onApproval(){},onExit(){}});
  expect((await client.inspectContext!('native')).settled).toBe(mode!=='async');
  let completed=false;const compact=client.compactThread!('native').then(value=>{completed=true;return value;});
  await new Promise(r=>setTimeout(r,5));expect(completed).toBe(false);
  expect(await compact).toBe(mode==='small'?'noop':'completed');expect(JSON.stringify(events)).not.toContain('PRIVATE_NATIVE_SUMMARY');
 }finally{await client?.close();await rm(dir,{recursive:true,force:true});}
});
