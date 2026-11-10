import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { assertHomeAvailable, prepareDesktopHome, startService, stopService } from '../desktop/runtime';
import { openAccountStore } from './account-store';
import type { DesktopLease } from './desktop-accounts';

export async function startAccountWorkspace(profileHome:string,lease:DesktopLease,entry:string){
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
 const service=await startService({node:process.execPath,entry,cwd:dirname(dirname(entry)),env:{...process.env,MANDALA_HOME:profileHome,OPEN_MANA_HOME:profileHome,MANDALA_PORT:'0',OPEN_MANA_PORT:'0',MANDALA_DESKTOP:'1',MANDALA_DESKTOP_PERSIST:'0',MANDALA_ACCOUNT_LEASE_FILE:leaseFile,MANDALA_ACCOUNT_WORKER_KEY:key}});
 const exited=service.child.exitCode!==null||service.child.signalCode!==null?Promise.resolve():new Promise<void>(resolve=>service.child.once('exit',()=>resolve()));
 return {exited,origin:service.origin,cookie:`mandala_local_session=${local.token}`,csrfToken:local.csrfToken,key,async close(){if(existsSync(leaseFile))unlinkSync(leaseFile);await stopService(service.child);store.deleteSession(local.token);store.close();}};
 }catch(error){
  const leaseFile=join(profileHome,'.account-session');if(existsSync(leaseFile))unlinkSync(leaseFile);
  if(movedConnection)renameSync(previousConnection,connection);
  store.deleteSession(local.token);store.close();throw error;
 }
}
