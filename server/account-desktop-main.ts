import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { productHome } from '../cli/product-env.mjs';
import { claimServiceHome } from './service-home-lock';
import { claimServiceRecord, handleServiceControl, removeServiceRecord } from '../desktop/service-discovery';
import { prepareDesktopHome } from '../desktop/runtime';
import { startAccountWorkspace } from './account-desktop-workspace';
import { createDesktopGateway } from './desktop-gateway';

const root=productHome(),home=join(root,'account-gateway'),setupToken=randomBytes(32).toString('base64url');
prepareDesktopHome(home);
const lock=claimServiceHome(home), directory=dirname(fileURLToPath(import.meta.url));
const gateway=createDesktopGateway({root,setupToken,controlOrigin:process.env.MANDALA_ACCOUNT_ORIGIN??'https://account.mandala.pub',dist:join(directory,'../dist'),async startWorkspace(profileHome,lease){
 return startAccountWorkspace(profileHome,lease,join(directory,'main.mjs'));
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
