import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { productHome } from '../cli/product-env.mjs';
import { claimServiceHome } from './service-home-lock';
import { claimServiceRecord, handleServiceControl, removeServiceRecord } from '../desktop/service-discovery';
import { assertHomeAvailable, prepareDesktopHome, startService, stopService } from '../desktop/runtime';
import { openAccountStore } from './account-store';
import { createDesktopGateway } from './desktop-gateway';

const root=productHome(),home=join(root,'account-gateway'),setupToken=randomBytes(32).toString('base64url');
prepareDesktopHome(home);
const lock=claimServiceHome(home), directory=dirname(fileURLToPath(import.meta.url));
const gateway=createDesktopGateway({root,setupToken,controlOrigin:process.env.MANDALA_ACCOUNT_ORIGIN??'https://account.mandala.pub',dist:join(directory,'../dist'),async startWorkspace(profileHome,lease){
 assertHomeAvailable(profileHome);prepareDesktopHome(profileHome);
 const key=randomBytes(32).toString('base64url'),store=openAccountStore(profileHome);
 // Preserve legacy owner IDs and history. The account index exclusively assigns this whole workspace.
 const owner=store.listUsers()[0];if(!owner)store.importUser(lease.user);
 const local=store.createSession(owner?.id??lease.user.id);
 const connection=join(profileHome,'computer-connection.json'),previousConnection=connection+'.before-account-login-'+randomBytes(8).toString('hex');
 let movedConnection=false;
 try{
 if(existsSync(connection)&&JSON.parse(readFileSync(connection,'utf8')).device?.ownerId!==lease.user.id){renameSync(connection,previousConnection);movedConnection=true;}
 const leaseFile=join(profileHome,'.account-session');
 writeFileSync(leaseFile,JSON.stringify({key,expiresAt:lease.expiresAt}),{mode:0o600});
 const entry=join(directory,'main.mjs');
 const service=await startService({node:process.execPath,entry,cwd:join(directory,'..'),env:{...process.env,MANDALA_HOME:profileHome,OPEN_MANA_HOME:profileHome,MANDALA_PORT:'0',OPEN_MANA_PORT:'0',MANDALA_DESKTOP:'1',MANDALA_DESKTOP_PERSIST:'0',MANDALA_ACCOUNT_LEASE_FILE:leaseFile,MANDALA_ACCOUNT_WORKER_KEY:key}});
 return {origin:service.origin,cookie:`mandala_local_session=${local.token}`,csrfToken:local.csrfToken,key,async close(){if(existsSync(leaseFile))unlinkSync(leaseFile);await stopService(service.child);store.deleteSession(local.token);store.close();}};
 }catch(error){
  const leaseFile=join(profileHome,'.account-session');if(existsSync(leaseFile))unlinkSync(leaseFile);
  if(movedConnection)renameSync(previousConnection,connection);
  store.deleteSession(local.token);store.close();throw error;
 }
}});
let record:ReturnType<typeof claimServiceRecord>|undefined,stopping=false;
const stop=async()=>{if(stopping)return;stopping=true;await gateway.close();if(record)removeServiceRecord(home,record);lock.release();if(process.connected)process.disconnect();};
const requestListeners=gateway.server.listeners('request');gateway.server.removeAllListeners('request');
gateway.server.on('request',(req,res)=>{if(record&&handleServiceControl(record,req,res,()=>{void stop();}))return;for(const listener of requestListeners)listener.call(gateway.server,req,res);});
await new Promise<void>(r=>gateway.server.listen(0,'127.0.0.1',r));
const port=(gateway.server.address() as {port:number}).port;
record=claimServiceRecord(home,`http://127.0.0.1:${port}`,setupToken);
process.on('message',message=>{if((message as any)?.type==='mandala:stop')void stop();});
process.once('SIGTERM',()=>{void stop();});process.once('SIGINT',()=>{void stop();});
process.once('exit',()=>{try{lock.release();}catch{}});
process.send?.({type:'mandala:ready',port,setupToken});
