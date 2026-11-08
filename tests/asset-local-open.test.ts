import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openLocalAsset } from '../server/asset-local-open';
import { execFile } from 'node:child_process';
vi.mock('node:child_process',()=>({execFile:vi.fn((_command,args,_options,callback)=>callback(null,'',''))}));
const homes:string[]=[];
afterEach(async()=>{vi.clearAllMocks();await Promise.all(homes.splice(0).map(home=>rm(home,{recursive:true,force:true})));});
it('opens a named copy of pinned bytes and edits cannot change the blob',async()=>{
 const home=await mkdtemp(join(tmpdir(),'asset-open-'));homes.push(home);const blobPath=join(home,'blob');await writeFile(blobPath,'original');
 await openLocalAsset(home,{blobPath,name:'reports/budget.xlsx',size:8,mediaType:'application/octet-stream',etag:'hash'},'open');
 const call=vi.mocked(execFile).mock.calls[0],path=(call[1] as string[]).at(-1)!;
 expect(path.endsWith('/budget.xlsx')).toBe(true);expect(await readFile(path,'utf8')).toBe('original');
 await writeFile(path,'edited');expect(await readFile(blobPath,'utf8')).toBe('original');
});
it('rejects symlink blobs and invalid actions before launching the OS',async()=>{
 const home=await mkdtemp(join(tmpdir(),'asset-open-'));homes.push(home);const source=join(home,'source');await writeFile(source,'content');const blobPath=join(home,'blob');await symlink(source,blobPath);
 const file={blobPath,name:'note.txt',size:7,mediaType:'text/plain',etag:'hash'};
 await expect(openLocalAsset(home,file,'open')).rejects.toBeDefined();expect(execFile).not.toHaveBeenCalled();
 await expect(openLocalAsset(home,{...file,blobPath:source},'invalid' as 'open')).rejects.toBeDefined();expect(execFile).not.toHaveBeenCalled();
});
it('reveals the named file and reports OS failures',async()=>{
 const home=await mkdtemp(join(tmpdir(),'asset-open-'));homes.push(home);const blobPath=join(home,'blob');await writeFile(blobPath,'original');
 const file={blobPath,name:'budget.xlsx',size:8,mediaType:'application/octet-stream',etag:'hash'};
 await openLocalAsset(home,file,'reveal');
 if(process.platform==='darwin')expect(vi.mocked(execFile).mock.calls[0][1]).toContain('-R');
 vi.mocked(execFile).mockImplementationOnce(((_command:unknown,_args:unknown,_options:unknown,callback:Function)=>callback(new Error('No application'))) as typeof execFile);
 await expect(openLocalAsset(home,file,'open')).rejects.toMatchObject({code:'local_open_failed'});
});
