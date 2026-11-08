import {useEffect,useRef,useState} from 'react';
import QRCode from 'qrcode';
import type {TelegramStatus} from '../shared/telegram';
import {telegramRequest} from './telegram-api';
import {useLanguage} from './i18n';
import Button from './ui/Button';
import Disclosure from './ui/Disclosure';
import Field from './ui/Field';
import Input from './ui/Input';
import LoadingState from './ui/LoadingState';
import StatusLabel from './ui/StatusLabel';
import './telegram.css';

function Connection(){
 const {text:t}=useLanguage();
 const [status,setStatus]=useState<TelegramStatus>(),[token,setToken]=useState(''),[error,setError]=useState(''),[readError,setReadError]=useState('');
 const [busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[unlink,setUnlink]=useState(false),[qr,setQr]=useState(''),[now,setNow]=useState(Date.now());
 const generation=useRef(0),working=useRef(false),reading=useRef(false),refreshRequested=useRef(false),alive=useRef(true),unlinkTrigger=useRef<HTMLButtonElement>(null);
 const load=async()=>{
  if(working.current||reading.current||document.hidden)return;
  reading.current=true;refreshRequested.current=false;
  const request=++generation.current;
  try{const value=await telegramRequest<TelegramStatus>();if(alive.current&&request===generation.current){setStatus(value);setReadError('');}}
  catch(reason){if(alive.current&&request===generation.current)setReadError((reason as Error).message);}
  finally{reading.current=false;if(alive.current&&refreshRequested.current)void load();}
 };
 const invalidate=()=>{generation.current++;refreshRequested.current=true;setStatus(undefined);void load();};
 useEffect(()=>{
  alive.current=true;void load();
  const timer=setInterval(()=>{setNow(Date.now());void load();},3000);
  document.addEventListener('visibilitychange',load);
  window.addEventListener('mandala-telegram-changed',invalidate);
  return()=>{alive.current=false;generation.current++;clearInterval(timer);document.removeEventListener('visibilitychange',load);window.removeEventListener('mandala-telegram-changed',invalidate);};
 },[]);
 const pairing=status?.pairing,expired=!!pairing&&Date.parse(pairing.expiresAt)<=now;
 useEffect(()=>{
  let active=true;setQr('');
  if(pairing&&!expired)void QRCode.toDataURL(pairing.url,{width:192,margin:3,errorCorrectionLevel:'M'}).then(value=>{if(active)setQr(value);}).catch(()=>{if(active)setError(t('二维码生成失败，请使用下方链接。','Could not generate QR code. Use the link below.'));});
  return()=>{active=false;};
 },[pairing?.url,expired]);
 const act=async(path:string,method='POST',body?:unknown)=>{
  if(working.current)return;
  working.current=true;generation.current++;setBusy(true);setError('');setNotice('');
  try{
   const value=await telegramRequest<TelegramStatus>(path,method,body);
   window.dispatchEvent(new Event('mandala-telegram-changed'));
   if(!alive.current)return;
   setStatus(value);setReadError('');setNow(Date.now());
   if(path==='/configure'&&value.configured)setToken('');
   if(method==='DELETE'){setUnlink(false);setToken('');}
   if(path==='/test')setNotice(t('测试消息已发送，请在 Telegram 查看。','Test message sent. Check Telegram.'));
  }catch(reason){if(alive.current)setError((reason as Error).message);}
  finally{working.current=false;if(alive.current){setBusy(false);if(refreshRequested.current)void load();}}
 };
 const states:Record<TelegramStatus['state'],string>={unconfigured:t('未连接','Not configured'),connecting:t('连接中','Connecting'),connected:t('已连接','Connected'),disconnected:t('连接已断开','Disconnected'),conflict:t('Bot 被其他程序占用','Bot is in use'),error:t('连接异常','Connection error')};
 return <section className="telegram-connection" aria-label={t('Telegram 连接','Telegram connection')}>
  <span role="status" className="sr-only">{status?.candidate&&t('已收到账号 '+status.candidate.name+' 的绑定请求，请核对后确认。','Pairing request received from '+status.candidate.name+'. Review and confirm this account.')}</span>
  <p className="field-hint">{t('只连接这台电脑的 Mandala 主会话。发送到 Bot 的内容会经过 Telegram；电脑必须运行并能访问 Telegram。','Connects only to this computer’s Mandala main chat. Content sent to the bot passes through Telegram; the computer must be running and able to reach Telegram.')}</p>
  {!status&&!readError&&<LoadingState label={t('正在读取连接…','Loading connection…')}/>}
  {status&&<div className="telegram-status"><StatusLabel icon={status.state==='connected'?'check':'clock'} tone={status.state==='connected'?'success':['error','conflict','disconnected'].includes(status.state)?'warning':'neutral'}>{states[status.state]}</StatusLabel>{status.bot&&<span>@{status.bot.username}</span>}{status.lastConnectedAt&&<small>{t('最后连接：','Last connected: ')}{new Date(status.lastConnectedAt).toLocaleString()}</small>}</div>}
  {(error||readError||status?.error)&&<p role="alert" className="form-error">{error||readError||status?.error} <Button disabled={busy} onClick={()=>void load()}>{t('刷新状态','Refresh status')}</Button></p>}
  {status&&!status.configured&&<form onSubmit={event=>{event.preventDefault();void act('/configure','POST',{token:token.trim()});}}>
   <p>{t('在 ','Open ')}<a href="https://t.me/BotFather" target="_blank" rel="noreferrer">BotFather</a>{t(' 发送 /newbot，创建一个专用 Bot，再把 Token 填在这里。请勿复用其他程序正在使用的 Bot。',' and send /newbot to create a dedicated bot, then enter its token here. Do not reuse a bot connected to another program.')}</p>
   <Field label="Bot Token" hint={t('仅保存到本机私有凭据，不会显示在聊天中。','Saved only in private local credentials; never shown in chat.')}><Input type="password" autoComplete="new-password" spellCheck={false} value={token} onChange={event=>setToken(event.target.value)} disabled={busy} required/></Field>
   <div className="telegram-actions"><Button variant="primary" type="submit" busy={busy} disabled={!token.trim()}>{t('连接 Bot','Connect bot')}</Button></div>
  </form>}
  {status?.configured&&!status.binding&&<>
   <p>{t('用手机打开专用 Bot，点击「开始」，再回到这里确认你的账号。','Open your dedicated bot on your phone, tap Start, then confirm your account here.')}</p>
   <Button disabled={busy} onClick={()=>void act('/pair')}>{t(pairing?'重新生成绑定二维码':'生成绑定二维码',pairing?'Generate a new pairing code':'Generate pairing code')}</Button>
   {pairing&&!expired&&<div className="telegram-pairing">{qr&&<img src={qr} width={192} height={192} alt={t('Telegram 绑定二维码','Telegram pairing QR code')}/>}<div><a href={pairing.url} target="_blank" rel="noreferrer">{t('在 Telegram 打开','Open in Telegram')}</a><p className="field-hint">{t('有效期至：','Valid until: ')}{new Date(pairing.expiresAt).toLocaleTimeString()}</p></div></div>}
   {expired&&<p className="field-hint">{t('绑定链接已过期，请重新生成。','The pairing link has expired. Generate a new one.')}</p>}
   {status.candidate&&<div className="telegram-candidate"><p>{t('待确认账号：','Account awaiting confirmation: ')}<strong>{status.candidate.name}</strong>{status.candidate.username&&<> · @{status.candidate.username}</>} · ID {status.candidate.userId}</p><Button variant="primary" disabled={busy||expired} onClick={()=>void act('/confirm','POST',{userId:status.candidate!.userId})}>{t('确认绑定此账号','Confirm this account')}</Button></div>}
  </>}
  {status?.binding&&<>
   <p>{t('已绑定：','Connected account: ')}<strong>{status.binding.name}</strong>{status.binding.username&&<> · @{status.binding.username}</>} · ID {status.binding.userId}</p>
   <label className="telegram-option"><Input type="checkbox" checked={status.attention} disabled={busy} onChange={event=>void act('/notifications','PATCH',{attention:event.target.checked})}/><span>{t('需要我处理时通知手机','Notify my phone when I need to act')}</span></label>
   <p className="field-hint">{t('手机发起的请求会收到回复。电脑普通聊天不转发；任务完成通知在对应任务上开启。','Requests from your phone receive replies. Ordinary desktop chats are not forwarded; enable completion notifications on individual tasks.')}</p>
   <div className="telegram-actions"><Button disabled={busy||status.state!=='connected'} onClick={()=>void act('/test')}>{t('发送测试消息','Send test message')}</Button></div>
  </>}
  {!!status?.deliveries?.length&&<div><strong>{t('消息投递需要关注','Message delivery needs attention')}</strong>{status.deliveries.map(item=><p key={item.id}>{item.state==='uncertain'?t('送达待确认','Delivery unconfirmed'):t('发送失败','Delivery failed')} · {item.summary}</p>)}<p className="field-hint">{t('请先在 Telegram 核对结果；投递异常不会重新执行任务。','Check Telegram first; delivery failures never rerun the task.')}</p></div>}
  {status?.configured&&<div className="telegram-actions">{unlink?<><p>{t('解除后旧按钮立即失效，Telegram 历史消息仍会保留。','Unlinking immediately invalidates old buttons. Telegram history will remain.')}</p><Button variant="danger" disabled={busy} onClick={()=>void act('','DELETE')}>{t('确认解除绑定','Confirm unlink')}</Button><Button autoFocus disabled={busy} onClick={()=>{setUnlink(false);requestAnimationFrame(()=>unlinkTrigger.current?.focus());}}>{t('保留连接','Keep connection')}</Button></>:<Button ref={unlinkTrigger} variant="ghost" disabled={busy} onClick={()=>setUnlink(true)}>{t('解除绑定','Unlink')}</Button>}</div>}
  {notice&&<p role="status">{notice}</p>}
  <p className="field-hint">{t('离线时 Bot 无法即时回复。恢复后，离线新指令需要你确认；Telegram 最多保留 24 小时未接收的消息，不保证全部找回。','The bot cannot reply while this computer is offline. On reconnect, new offline instructions need your confirmation. Telegram retains unreceived updates for at most 24 hours; recovery is not guaranteed.')}</p>
 </section>;
}

export default function TelegramSettings(){
 const {text:t}=useLanguage(),[expanded,setExpanded]=useState(false);
 return <Disclosure className="telegram-settings" title={t('手机连接 · Telegram','Phone connection · Telegram')} onToggle={event=>{if(event.target===event.currentTarget)setExpanded(event.currentTarget.open);}}>{expanded&&<Connection/>}</Disclosure>;
}
