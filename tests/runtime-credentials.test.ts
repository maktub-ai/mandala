import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {claudeNativeEnv} from '../server/runtime-credentials';

const homes:string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();await Promise.all(homes.splice(0).map(home=>rm(home,{recursive:true,force:true})));});
it('loads only native Anthropic environment settings and lets explicit runtime values win',async()=>{
 const home=await mkdtemp(join(tmpdir(),'native-credentials-'));homes.push(home);await mkdir(join(home,'.claude'));
 await writeFile(join(home,'.claude/settings.json'),JSON.stringify({env:{ANTHROPIC_AUTH_TOKEN:'native-secret',ANTHROPIC_BASE_URL:'http://127.0.0.1:1234',ANTHROPIC_DEFAULT_SONNET_MODEL:'native-model',NODE_OPTIONS:'bad',CLAUDE_PLUGIN_ROOT:'/private/plugin'}}));
 vi.stubEnv('CLAUDE_CONFIG_DIR',join(home,'.claude'));
 expect(await claudeNativeEnv({ANTHROPIC_AUTH_TOKEN:'override'})).toEqual({ANTHROPIC_AUTH_TOKEN:'override',ANTHROPIC_BASE_URL:'http://127.0.0.1:1234',ANTHROPIC_DEFAULT_SONNET_MODEL:'native-model'});
 vi.stubEnv('CLAUDE_CONFIG_DIR',join(home,'missing'));
 expect(await claudeNativeEnv({},join(home,'missing'))).toEqual({});
});
