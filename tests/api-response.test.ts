import {afterEach,expect,it,vi} from 'vitest';
import {api} from '../src/api';
afterEach(()=>vi.unstubAllGlobals());
it.each([204,200])('rejects empty JSON responses (%s) with a protocol error',async status=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(status===204?null:'',{status})));
 await expect(api('/workbench')).rejects.toThrow('Invalid JSON response (HTTP '+status+')');
});
it('rejects malformed JSON with a protocol error',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('{"items":',{status:200})));
 await expect(api('/workbench')).rejects.toThrow('Invalid JSON response (HTTP 200)');
});
it('preserves interrupted body failures',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(new ReadableStream({start(controller){controller.error(new TypeError('terminated'));}}),{status:200})));
 await expect(api('/workbench')).rejects.toThrow('terminated');
});
it('preserves JSON authentication failures',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({error:'Sign in required'}),{status:401})));
 await expect(api('/workbench')).rejects.toThrow('Sign in required');
});
