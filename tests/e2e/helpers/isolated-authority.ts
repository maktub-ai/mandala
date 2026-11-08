import { test as base, expect, request as requestFactory, type APIRequestContext } from '@playwright/test';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';

// UI scenarios requiring generated memory own their store and background queue.
// Reuse the complete synthetic server so task/candidate generation stays real.
export const test = base.extend<{ isolatedAuthority: {request: APIRequestContext; baseURL: string} }>({
  isolatedAuthority: async ({}, use) => {
    const reservation=createServer();
    await new Promise<void>(resolve=>reservation.listen(0,'127.0.0.1',resolve));
    const port=(reservation.address() as {port:number}).port;
    await new Promise<void>(resolve=>reservation.close(()=>resolve()));
    const child=spawn(process.execPath,['--import','tsx','tests/e2e/server.ts'],{env:{...process.env,MANDALA_E2E_PORT:String(port)},stdio:'ignore'});
    const baseURL='http://127.0.0.1:'+port,request=await requestFactory.newContext({baseURL});
    try {
      await expect.poll(async()=>{try{return(await request.get('/api/config',{timeout:1000})).status();}catch{return 0;}},{timeout:15000}).toBe(200);
      await use({request,baseURL});
    } finally {
      await request.dispose();
      child.kill('SIGTERM');
      await new Promise<void>(resolve=>child.exitCode!==null?resolve():child.once('exit',()=>resolve()));
    }
  },
});
