import {expect,it,vi} from 'vitest';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {handleAutomationRequest} from '../server/automation-http';
import type {Automations} from '../server/automations';

it('forwards optional HTTP idempotency keys for create and manual Run only',async()=>{
 const create=vi.fn().mockResolvedValue({id:'rule'}),runNow=vi.fn().mockResolvedValue({id:'occurrence'});
 const service={create,runNow} as unknown as Automations;
 const res={writeHead:vi.fn(),end:vi.fn()} as unknown as ServerResponse;
 const body={name:'Review'},read=vi.fn().mockResolvedValue(body);
 await handleAutomationRequest({method:'POST',headers:{'idempotency-key':'create-1'}} as unknown as IncomingMessage,res,new URL('http://localhost/api/automations'),service,read);
 expect(create).toHaveBeenCalledWith(body,'create-1');
 await handleAutomationRequest({method:'POST',headers:{'idempotency-key':'run-1'}} as unknown as IncomingMessage,res,new URL('http://localhost/api/automations/rule/run'),service,read);
 expect(runNow).toHaveBeenCalledWith('rule','run-1');expect(read).toHaveBeenCalledTimes(1);
 await handleAutomationRequest({method:'POST',headers:{}} as IncomingMessage,res,new URL('http://localhost/api/automations/rule/run'),service,read);
 expect(runNow).toHaveBeenLastCalledWith('rule',undefined);
});
it('routes explicit missed-occurrence catch-up to the same durable record',async()=>{
 const catchUp=vi.fn().mockResolvedValue({id:'occurrence',status:'queued'}),service={catchUp} as unknown as Automations;
 const res={writeHead:vi.fn(),end:vi.fn()} as unknown as ServerResponse;
 expect(await handleAutomationRequest({method:'POST',headers:{}} as IncomingMessage,res,new URL('http://localhost/api/automations/occurrence/catch-up'),service,vi.fn())).toBe(true);
 expect(catchUp).toHaveBeenCalledWith('occurrence','occurrence');expect(res.writeHead).toHaveBeenCalledWith(202,expect.anything());
});
