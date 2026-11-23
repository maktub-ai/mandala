import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, existsSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, expect, test, vi } from 'vitest';

const require=createRequire(import.meta.url);
const {createPublicMacUpdate}=require('../desktop/public-mac-update.cjs');
const homeList:string[]=[];
afterEach(()=>homeList.splice(0).forEach(home=>rmSync(home,{recursive:true,force:true})));
const zip=Buffer.from('synthetic pre-authenticated archive');
const zipName='Mandala-1.1.0-mac-arm64.zip';
const manual={version:'1.1.0',notes:'https://github.com/maktub-ai/mandala-releases/releases/tag/v1.1.0'};
const teamId='TESTTEAM01';
function fixture(toManifest:(value:any)=>any=value=>value, mode:'valid'|'bad-signature'|'bad-archive'|'redirect'|'missing'|'partial'='valid'){
  const root=mkdtempSync(join(tmpdir(),'mandala-public-update-')),installed=join(root,'Mandala.app');
  homeList.push(root);mkdirSync(installed);
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const trust={schema:1,teamId,publicKey:publicKey.export({format:'der',type:'spki'}).toString('base64')};
  const manifest=Buffer.from(JSON.stringify(toManifest({schema:1,version:'1.1.0',platform:'darwin',arch:'arm64',name:zipName,size:zip.length,
    sha256:createHash('sha256').update(zip).digest('hex'),bundleId:'com.maktubcn.mandala',teamId}))+'\n');
  const signature=sign(null,mode==='bad-signature'?Buffer.from('different'):manifest,privateKey).toString('base64')+'\n';
  const fetch=vi.fn(async (url:string)=>url.endsWith('.update.json') ? (mode==='missing'||mode==='partial'?new Response(null,{status:404}):mode==='redirect'?new Response(null,{status:302,headers:{Location:'https://unapproved.invalid/manifest'}}):new Response(new Uint8Array(manifest))) :
    url.endsWith('.update.sig') ? (mode==='missing'?new Response(null,{status:404}):new Response(signature)) : url.endsWith(zipName) ? new Response(new Uint8Array(mode==='bad-archive'?Buffer.alloc(zip.length):zip)) : new Response(null,{status:404}));
  const verifyBundle=vi.fn(async (_bundle:string,options:{version:string})=>({commit:(options.version==='1.1.0'?'b':'a').repeat(40)}));
  const extract=vi.fn(async (_zip:string,stage:string)=>{mkdirSync(join(stage,'Mandala.app'));});
  const exchange=vi.fn(async ()=>{});
  const options={installed,swap:'not-executed',version:'1.0.0',arch:'arm64',trust,fetch,verifyBundle,extract,exchange};
  const updater=createPublicMacUpdate(options);
  return {root, options,updater,fetch,verifyBundle,extract,exchange,installed};
}
test('authenticates the manifest and archive before touching extraction, stages, and survives a new updater instance',async()=>{
  const f=fixture();
  const offer=await f.updater.check(manual);
  expect(offer).toEqual({...manual,size:zip.length,publicMac:true});
  expect(f.updater.ready()).toBeNull();
  await f.updater.download(offer);
  expect(f.fetch.mock.calls.map(args=>new URL(args[0]).pathname)).toEqual([
    '/maktub-ai/mandala-releases/releases/download/v1.1.0/Mandala-1.1.0-mac-arm64.update.json',
    '/maktub-ai/mandala-releases/releases/download/v1.1.0/Mandala-1.1.0-mac-arm64.update.sig',
    '/maktub-ai/mandala-releases/releases/download/v1.1.0/Mandala-1.1.0-mac-arm64.zip',
  ]);
  expect(f.extract).toHaveBeenCalledOnce();
  const reopened=createPublicMacUpdate(f.options);
  expect(reopened.ready()).toEqual(offer);
  const busy=vi.fn(async()=>false);
  expect(await reopened.install(busy)).toBe('busy');
  expect(reopened.ready()).toEqual(offer);
  expect(f.exchange).not.toHaveBeenCalled();
  expect(await reopened.install(async()=>true,()=>null)).toBe('busy');
  expect(f.exchange).not.toHaveBeenCalled();
  const release=vi.fn();
  expect(await reopened.install(async()=>true,()=>({release}))).toBe('installed');
  expect(release).toHaveBeenCalledOnce();
  expect(f.exchange).toHaveBeenCalledWith(f.installed,expect.stringMatching(/install-[^/]+\/verified\/Mandala\.app$/));
  expect(f.extract).toHaveBeenCalledTimes(4);
  expect(existsSync(join(f.root,'.Mandala.app-public-update','previous','Mandala.app'))).toBe(true);
});
test.each([
  ['version', '1.1.1'],['arch','x64'],['bundleId','foreign.bundle'],['teamId','FOREIGN001'],
  ['name','../secret.zip'],['size',0],['size',4*1024**3],['sha256','not-a-digest'],['unrecognized',true],
])('rejects even signed wrong %s before attempting archive download',async(field,value)=>{
  const f=fixture(manifest=>({...manifest,[field]:value}));
  await expect(f.updater.check(manual)).rejects.toMatchObject({name:'PublicUpdateVerificationError'});
  expect(f.fetch.mock.calls.some(args=>args[0].endsWith('.zip'))).toBe(false);
});
test.each(['bad-signature','redirect'] as const)('fails closed on %s',async(mode)=>{
  const f=fixture(undefined,mode);
  await expect(f.updater.check(manual)).rejects.toMatchObject({name:'PublicUpdateVerificationError'});
  expect(f.fetch.mock.calls.some(args=>args[0].includes('unapproved.invalid')||args[0].endsWith('.zip'))).toBe(false);
  expect(f.extract).not.toHaveBeenCalled();
});
test('does not extract a corrupted archive or stop the runtime for an unverifiable installed app',async()=>{
  const f=fixture(undefined,'bad-archive');
  const offer=await f.updater.check(manual);
  await expect(f.updater.download(offer)).rejects.toThrow('checksum');
  expect(f.extract).not.toHaveBeenCalled();
  expect(f.updater.ready()).toBeNull();
  f.verifyBundle.mockRejectedValue(Error('ad hoc signature'));
  expect(await f.updater.check(manual)).toBeNull();
  expect(await f.updater.install(vi.fn())).toBe('none');
});
test('rejects missing trust, previews, mismatched tag, and rollback or equal versions',async()=>{
 const f=fixture();
 for(const trust of [undefined,{...f.options.trust,teamId:'bad'}, {...f.options.trust,publicKey:'not-a-key'}])
   expect(createPublicMacUpdate({...f.options,trust})).toBeNull();
 for(const version of ['0.99.0','1.0.0','1.1.0-dev','1.2.0'])
   expect(await f.updater.check({...manual,version})).toBeNull();
 expect(f.fetch).not.toHaveBeenCalled();
});
test('rechecks the exact staged bundle after drain; timeout, change, and concurrent install do not replace it',async()=>{
 const f=fixture(),offer=await f.updater.check(manual);
 await f.updater.download(offer);
 await expect(f.updater.install(async()=>{throw Error('timeout');})).rejects.toThrow('timeout');
 const releaseLease=vi.fn();
 let release!: (result:boolean)=>void;
 const stopping=new Promise<boolean>(resolve=>{release=resolve;});
 const pending=f.updater.install(async()=>stopping);
 expect(await f.updater.install(async()=>true)).toBe('busy');
 release(false);
 expect(await pending).toBe('busy');
 await expect(f.updater.install(async()=>{
   f.verifyBundle.mockRejectedValueOnce(Error('changed since verified'));
   return true;
 },()=>({release:releaseLease}))).rejects.toThrow('changed');
 expect(releaseLease).toHaveBeenCalledOnce();
 expect(f.exchange).not.toHaveBeenCalled();expect(f.updater.ready()).toEqual(offer);
});

test('fallback is limited to a manual-only release; an incomplete signed publication fails closed', async()=>{
 expect(await fixture(undefined,'missing').updater.check(manual)).toBeNull();
 await expect(fixture(undefined,'partial').updater.check(manual)).rejects.toMatchObject({name:'PublicUpdateVerificationError'});
});
test('a corrupted cached ZIP is detected before extraction or idle drain and can be downloaded again',async()=>{
 const f=fixture(),offer=await f.updater.check(manual);
 await f.updater.download(offer);
 writeFileSync(join(f.root,'.Mandala.app-public-update','ready','update.zip'),Buffer.alloc(zip.length));
 const drain=vi.fn();
 await expect(createPublicMacUpdate(f.options).install(drain)).rejects.toMatchObject({name:'PublicUpdateVerificationError'});
 expect(f.extract).toHaveBeenCalledOnce();expect(drain).not.toHaveBeenCalled();
 expect(f.updater.ready()).toBeNull();
 await f.updater.download(offer);
 expect(f.updater.ready()).toEqual(offer);
});
