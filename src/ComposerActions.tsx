import Button from './ui/Button';
import { useLanguage } from './i18n';
import Icon from './ui/Icon';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from './components/ui/dropdown-menu';
export default function ComposerActions({busy,waiting=false,stopping,disabled,stopDisabled,continuing,recovering=false,onStop,onSend,onInterrupt}:{busy:boolean;waiting?:boolean;stopping:boolean;disabled:boolean;stopDisabled:boolean;continuing:boolean;recovering?:boolean;onStop:()=>void;onSend:()=>void;onInterrupt:()=>void}) {
 const {text: localize, t}=useLanguage();
 const label=recovering?(localize('核对上次发送', 'Check previous send')):busy?t('排队发送'):continuing?t('继续执行'):t('发送消息');
 return <div className="composer-actions">
  {busy&&<Button type="button" className="stop-button" aria-label={t('停止执行')} title={t(stopping?'正在停止…':'停止')} disabled={stopDisabled} onClick={onStop}><Icon name="stop" size={16}/></Button>}
  {!busy&&waiting&&<Button type="button" className="cancel-wait-button" aria-label={t('取消等待协作')} title={t('取消等待协作')} disabled={stopDisabled} onClick={onStop}><Icon name="close" size={14}/><span>{t('取消等待')}</span></Button>}
  {busy&&!recovering&&<DropdownMenu><DropdownMenuTrigger asChild><Button type="button" className="send-options" disabled={disabled} aria-label={localize('发送选项', 'Send options')}><Icon name="chevronDown" size={16}/></Button></DropdownMenuTrigger><DropdownMenuContent side="top" align="end"><DropdownMenuItem disabled={disabled} onSelect={onInterrupt}><Icon name="stop" size={16}/>{t('打断并发送')}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}
  <Button type="button" className="send-button" aria-label={label} aria-keyshortcuts="Enter" title={label+' · Enter · '+(localize('换行：Shift + Enter', 'New line: Shift + Enter'))} disabled={disabled} onClick={onSend}><Icon name={recovering?'refresh':busy?'clock':'arrowUp'} size={20}/></Button>
 </div>;
}
