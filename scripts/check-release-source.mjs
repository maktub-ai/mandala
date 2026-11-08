import {execFileSync} from 'node:child_process';

// Ignore rules do not remove files that were already committed.
const excluded=execFileSync('git',['ls-files','-ci','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
if(excluded.length){
 console.error('Tracked files excluded from distribution:\n'+excluded.join('\n'));
 process.exitCode=1;
}else console.log('Source distribution check passed: no ignored files are tracked.');
