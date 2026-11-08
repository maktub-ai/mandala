import Button from './ui/Button';
import Dialog from './Dialog';
import Icon from './ui/Icon';
import { useLanguage } from './i18n';
import { shortcuts, shortcutLabel, type ShortcutId } from './shortcuts';
import './shortcuts.css';

export default function KeyboardShortcuts({ onClose }: { onClose: () => void }) {
 const {text: localize } = useLanguage(), say = (zh: string, en: string) => localize(zh, en);
 return <Dialog label={say('快捷键', 'Keyboard shortcuts')} className="keyboard-shortcuts" onClose={onClose}>
  <header><h2>{say('快捷键', 'Keyboard shortcuts')}</h2><Button type="button" className="icon-button" aria-label={say('关闭快捷键', 'Close keyboard shortcuts')} onClick={onClose}><Icon name="close" size={16}/></Button></header>
  <dl>{(Object.keys(shortcuts) as ShortcutId[]).map(id => <div key={id}><dt>{localize(shortcuts[id].label[0], shortcuts[id].label[1])}</dt><dd><kbd>{shortcutLabel(id)}</kbd></dd></div>)}
   <div><dt>{say('发送消息', 'Send message')}</dt><dd><kbd>Enter</kbd></dd></div>
   <div><dt>{say('输入框内换行', 'New line in message')}</dt><dd><kbd>Shift + Enter</kbd></dd></div>
  </dl>
  <p>{say('查找、聚焦输入框和终端切换用于当前对话。发送沿用当前对话的排队规则。', 'Find, focus input and terminal toggle apply to the current chat. Sending follows the current chat’s queue rules.')}</p>
  <p>{say('组合输入时不触发快捷键。终端聚焦时，除 Ctrl + ` 外，按键交由终端处理。', 'Shortcuts pause during IME composition. When the terminal has focus, only Ctrl + ` is reserved by the app.')}</p>
 </Dialog>;
}
