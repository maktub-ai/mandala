import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createBusinessCliRuntime } from '../server/business-cli-runtime';
const run = promisify(execFile), homes: string[] = [], servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } for (const home of homes.splice(0)) await rm(home, {recursive:true,force:true}); });
async function home() { const value = await mkdtemp(join(tmpdir(),'mandala-compat-')); homes.push(value); return value; }
it('Mandala environment overrides legacy destination and owner home without copying credentials', async () => {
 const directory=await home(),key='a'.repeat(64);await writeFile(join(directory,'local-access.key'),key,{mode:0o600});
 const server=createServer((req,res)=>{res.writeHead(req.headers['x-mandala-local-key']===key?200:401,{'Content-Type':'application/json'});res.end(JSON.stringify({retained:true}));});servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening');
 const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const {stdout}=await run(process.execPath,[resolve('cli/openmana.mjs'),'service','status'],{env:{...process.env,MANDALA_CONTEXT:'',OPEN_MANA_CONTEXT:'',MANDALA_HOME:directory,OPEN_MANA_HOME:join(directory,'missing'),MANDALA_BASE_URL:url,OPEN_MANA_BASE_URL:'https://invalid.example'}});
 expect(JSON.parse(stdout)).toMatchObject({ok:true,data:{retained:true}});
});
it('new and legacy executable entries work with a scoped mailbox and expire together', async () => {
 const directory=await home(),runtime=await createBusinessCliRuntime(directory,'invocation',{baseUrl:'http://127.0.0.1:1',token:'private-token'},async()=>({tasks:[]}));
 try {
  expect(basename(runtime.launcher)).toBe('mandala');
  for(const entry of ['mandala','openmana']) {
   const {stdout}=await run(join(directory,'runtime','cli','invocation',entry),['tasks','list']);
   expect(JSON.parse(stdout)).toMatchObject({ok:true,data:{tasks:[]}});
  }
  const {stdout}=await run(process.execPath,[resolve('cli/mandala.mjs'),'--help']);expect(JSON.parse(stdout).ok).toBe(true);
 } finally {runtime.dispose();}
 await expect(run(runtime.launcher,['tasks','list'])).rejects.toMatchObject({code:'ENOENT'});
});
it('defaults reuse existing legacy homes and release manifests without moving files', async () => {
 const root=await home();
 const {productHome}=await import(/* @vite-ignore */ resolve('cli/product-env.mjs'));
 expect(productHome('workspace',{},root)).toBe(join(root,'.mandala'));
 expect(productHome('control',{},root)).toBe(join(root,'.mandala-account-service'));
 expect(productHome('releases',{},root)).toBe(join(root,'.mandala-releases'));
 for(const [kind,path] of [['workspace','.open-mana'],['control','.open-mana-account-service'],['releases','.open-mana-releases']]) {
  await mkdir(join(root,path));expect(productHome(kind,{},root)).toBe(join(root,path));
 }
 expect(productHome('workspace',{MANDALA_HOME:'/new',OPEN_MANA_HOME:'/old'},root)).toBe('/new');
 expect(productHome('workspace',{OPEN_MANA_HOME:'/old'},root)).toBe('/old');
 expect(productHome('control',{MANDALA_CONTROL_HOME:'/new',OPEN_MANA_CONTROL_HOME:'/old'},root)).toBe('/new');
});

it.each(['workspace','control','releases'] as const)('discovers canonical %s storage through a migrated legacy alias and refuses independent homes', async kind => {
 const root=await home(),suffix=kind==='workspace'?'':kind==='control'?'-account-service':'-releases';
 const legacy=join(root,'.open-mana'+suffix),current=join(root,'.mandala'+suffix);
 const {productHome}=await import(/* @vite-ignore */ resolve('cli/product-env.mjs'));
 await mkdir(current);await symlink(current,legacy,'junction');
 expect(productHome(kind,{},root)).toBe(current);
 await rm(legacy);await mkdir(legacy);
 expect(()=>productHome(kind,{},root)).toThrow('conflicting_product_homes');
 if(kind!=='releases')expect(productHome(kind,kind==='control'?{MANDALA_CONTROL_HOME:legacy}:{MANDALA_HOME:legacy},root)).toBe(legacy);
});

it('blocks explicit nested homes while their parent data directory is migrating',async()=>{
 const root=await home();await mkdir(join(root,'.mandala.migrating'));
 const {productHome}=await import(/* @vite-ignore */ resolve('cli/product-env.mjs'));
 for(const name of ['.open-mana','.mandala'])expect(()=>productHome('workspace',{MANDALA_HOME:join(root,name,'cases','nested')},root)).toThrow('product_home_migration_in_progress');
});
