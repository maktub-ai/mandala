import Icon from './Icon';
import type { Cli } from '../../shared/types';
export default function RuntimeIcon({ cli, size = 16 }: { cli: Cli; size?: number }) {
  if(cli==='hermes'||cli==='openclaw')return <span className="runtime-logo" data-runtime={cli} aria-hidden="true" style={{width:size,height:size}}><Icon name="terminal" size={size}/></span>;
  const hasDarkVariant = cli === 'opencode' || cli === 'cursor';
  return <span className="runtime-logo" data-runtime={cli} aria-hidden="true" style={{ width: size, height: size }}>
    <img src={`/runtime-logos/${cli}.${cli === 'gemini' ? 'png' : 'svg'}`} alt="" width={size} height={size} className={hasDarkVariant ? 'runtime-logo-light' : undefined}/>
    {hasDarkVariant && <img src={`/runtime-logos/${cli}-dark.svg`} alt="" width={size} height={size} className="runtime-logo-dark"/>}
  </span>;
}
