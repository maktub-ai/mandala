import { expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { openLocalFile } from '../server/local-file-open';
vi.mock('node:child_process',()=>({execFile:vi.fn((_command,_args,_options,callback)=>callback(null,'',''))}));
it('passes the exact local path as a shell-free argument and reports OS failures',async()=>{
 const path='/tmp/report $(touch unexpected) one.html';
 await openLocalFile(path);
 expect(execFile).toHaveBeenCalledWith(process.platform==='darwin'?'/usr/bin/open':process.platform==='win32'?expect.stringContaining('explorer.exe'):'xdg-open',[path],expect.objectContaining({shell:false,timeout:10000}),expect.any(Function));
 vi.mocked(execFile).mockImplementationOnce(((_command:unknown,_args:unknown,_options:unknown,callback:Function)=>callback(new Error('No application'))) as typeof execFile);
 await expect(openLocalFile(path)).rejects.toMatchObject({code:'local_open_failed',status:503});
});
