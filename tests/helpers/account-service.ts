import type { Server } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Optional cross-repository integration. Desktop unit tests need no private checkout.
const source=process.env.MANDALA_ACCOUNT_SERVICE_SOURCE;
export const accountServiceAvailable=Boolean(source);
type Options={home:string;publicOrigin?:string;dist?:string;auth?:{
 google?:{clientId:string;clientSecret:string};github?:{clientId:string;clientSecret:string};
 sendCode?:(email:string,code:string)=>Promise<void>;fetch?:typeof fetch;
}};
const service=source?await import(pathToFileURL(resolve(source,'server/control-server.ts')).href):undefined;
export function createControlServer(options:Options):Server {
 if(!service)throw Error('Set MANDALA_ACCOUNT_SERVICE_SOURCE to a mandala-service/account-service checkout for this integration test');
 return service.createControlServer({...options,...(options.dist?{dist:resolve(source!,'dist')}:{})});
}
