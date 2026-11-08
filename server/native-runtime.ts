import type {Cli} from '../shared/types';
import type {CodexClient,CodexOptions} from './codex';
import {startAcp} from './acp';
import {startPi} from './pi';
import {startLocalCli} from './local-cli';

export async function startNativeRuntime(cli:Cli,options:CodexOptions):Promise<CodexClient>{
 if(options.gateway && options.gateway !== 'native')throw new Error('This model route is unavailable; select native CLI settings before continuing');
 return cli==='pi'?startPi(options):cli==='cursor'||cli==='antigravity'?startLocalCli(cli,options):startAcp(cli,options);
}
