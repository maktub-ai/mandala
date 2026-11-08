import {expect,it} from 'vitest';
import {hasBusinessProgressReceipt} from '../scripts/acp-smoke-evidence';
it('accepts only an authenticated CLI progress receipt with the smoke command identity',()=>{
 const receipt={kind:'progress',data:{source:'cli',commandKey:'smoke-resume',text:'MANDALA_BUSINESS_OK'}};
 expect(hasBusinessProgressReceipt([receipt])).toBe(true);
 for(const kind of ['reasoning','plan','approval','metadata','user','text','tool'])expect(hasBusinessProgressReceipt([{...receipt,kind}])).toBe(false);
 for(const data of [{source:'model',commandKey:'smoke-resume',text:'MANDALA_BUSINESS_OK'},{source:'cli',commandKey:'other',text:'MANDALA_BUSINESS_OK'},{source:'cli',commandKey:'smoke-resume',text:'echo MANDALA_BUSINESS_OK'}])expect(hasBusinessProgressReceipt([{kind:'progress',data}])).toBe(false);
});
