import {useEffect,useRef,useState} from 'react';
import {api,requestJson} from './api';
import {useLanguage} from './i18n';
import {encodeVoiceWav,VOICE_MAX_SECONDS,VOICE_SAMPLE_RATE,type VoiceStatus} from '../shared/voice';
import Button from './ui/Button';
import Icon from './ui/Icon';
import './voice.css';

export default function VoiceInput({disabled,onText,onBusyChange}:{disabled:boolean;onText:(text:string)=>void;onBusyChange:(busy:boolean)=>void}){
 const {text:l}=useLanguage(),[settings,setSettings]=useState<VoiceStatus>(),[phase,setPhase]=useState<'idle'|'requesting'|'recording'|'transcribing'>('idle'),[error,setError]=useState('');
 const current=useRef<{controller:AbortController;stream?:MediaStream;recorder?:MediaRecorder;timer?:ReturnType<typeof setTimeout>}|undefined>(undefined),onTextRef=useRef(onText),busyRef=useRef(onBusyChange);
 onTextRef.current=onText;busyRef.current=onBusyChange;
 function cancel(){const session=current.current;current.current=undefined;if(session){session.controller.abort();clearTimeout(session.timer);if(session.recorder?.state==='recording')session.recorder.stop();session.stream?.getTracks().forEach(track=>track.stop());}setPhase('idle');busyRef.current(false);}
 useEffect(()=>{const controller=new AbortController();const load=()=>{void api<VoiceStatus>('/voice','GET',undefined,controller.signal).then(setSettings).catch(()=>{});};load();window.addEventListener('mandala:voice-settings',load);return()=>{controller.abort();window.removeEventListener('mandala:voice-settings',load);cancel();};},[]);
 useEffect(()=>{if(disabled)cancel();},[disabled]);
 useEffect(()=>{const hide=()=>{if(document.hidden)cancel();};const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'&&current.current){e.preventDefault();e.stopImmediatePropagation();cancel();}};document.addEventListener('visibilitychange',hide);window.addEventListener('keydown',escape,true);window.addEventListener('pagehide',cancel);return()=>{document.removeEventListener('visibilitychange',hide);window.removeEventListener('keydown',escape,true);window.removeEventListener('pagehide',cancel);};},[]);
 function stop(){const session=current.current;if(session?.recorder?.state==='recording'){clearTimeout(session.timer);setPhase('transcribing');session.recorder.stop();session.stream?.getTracks().forEach(track=>track.stop());}}
 async function start(){
  if(current.current||disabled)return;
  setError('');const session:{controller:AbortController;stream?:MediaStream;recorder?:MediaRecorder;timer?:ReturnType<typeof setTimeout>}={controller:new AbortController()};current.current=session;setPhase('requesting');busyRef.current(true);
  const valid=()=>current.current===session&&!session.controller.signal.aborted;
  try{
   if(!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined')throw new Error(l('此环境不支持录音，请使用桌面 App 或 HTTPS 页面。','Recording is unavailable. Use the desktop app or an HTTPS page.'));
   const stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true},video:false});
   if(!valid()){stream.getTracks().forEach(track=>track.stop());return;}session.stream=stream;
   const recorder=new MediaRecorder(stream,{audioBitsPerSecond:64000});session.recorder=recorder;const chunks:Blob[]=[];
   recorder.ondataavailable=e=>{if(valid()&&e.data.size)chunks.push(e.data);};
   recorder.onerror=()=>{if(valid()){setError(l('录音中断，请重试。','Recording was interrupted. Please retry.'));cancel();}};
   recorder.onstop=()=>{void (async()=>{
    if(!valid())return;
    try{
     const context=new AudioContext();let decoded:AudioBuffer;
     try{decoded=await context.decodeAudioData(await new Blob(chunks,{type:recorder.mimeType}).arrayBuffer());}finally{await context.close();}
     if(!valid())return;
     const length=Math.min(Math.floor(decoded.duration*VOICE_SAMPLE_RATE),VOICE_MAX_SECONDS*VOICE_SAMPLE_RATE);
     if(length<1600)throw new Error(l('录音太短，请重试。','Recording is too short. Please retry.'));
     const offline=new OfflineAudioContext(1,length,VOICE_SAMPLE_RATE),source=offline.createBufferSource();source.buffer=decoded;source.connect(offline.destination);source.start();
     const samples=(await offline.startRendering()).getChannelData(0);if(!valid())return;
     let energy=0;for(const sample of samples)energy+=sample*sample;
     if(Math.sqrt(energy/samples.length)<.003)throw new Error(l('没有检测到声音，请检查麦克风。','No sound detected. Check your microphone.'));
     const result=await requestJson<{text:string}>('/api/voice/transcribe',{method:'POST',headers:{'Content-Type':'audio/wav','X-Mandala-Voice-Provider':settings!.settings.provider},body:encodeVoiceWav(samples),signal:session.controller.signal},185000);
     if(!valid())return;if(!result.text.trim())throw new Error(l('未识别到文字，请重试。','No speech recognized. Please retry.'));onTextRef.current(result.text);
    }catch(e){if(valid())setError((e as Error).message);}finally{if(valid())cancel();}
   })();};
   recorder.start(1000);setPhase('recording');session.timer=setTimeout(stop,VOICE_MAX_SECONDS*1000);
  }catch(e){if(valid()){setError((e as Error).name==='NotAllowedError'?l('麦克风权限被拒绝，请在系统或浏览器设置中允许。','Microphone access was denied. Allow it in system or browser settings.'):(e as Error).message);cancel();}}
 }
 if(!settings?.settings.enabled)return null;
 const ready=settings.settings.provider==='openai'?settings.settings.hasApiKey:settings.models.some(model=>model.id===settings.settings.localModel&&model.installed);
 return <div className="voice-input">
  {phase==='idle'?<Button className="ghost" aria-label={l('语音输入','Voice input')} title={ready?(settings.settings.provider==='local'?l('本地语音输入 · 音频不上传','Local voice input · Audio stays on this computer'):l('云端语音输入 · 音频发送至 OpenAI','Cloud voice input · Audio is sent to OpenAI')):l('请先在通用设置中下载模型或配置 API Key','Download a model or configure an API key in General settings first')} disabled={disabled||!ready} onClick={()=>void start()}><Icon name="microphone" size={17}/></Button>:<>
   <span role="status">{phase==='requesting'?l('等待麦克风…','Waiting for microphone…'):phase==='recording'?l('正在录音…','Recording…'):l('正在转写…','Transcribing…')}</span>
   {phase==='recording'&&<Button aria-label={l('停止录音','Stop recording')} onClick={stop}><Icon name="stop" size={16}/></Button>}
   <Button aria-label={l('取消语音输入','Cancel voice input')} onClick={cancel}><Icon name="close" size={16}/></Button>
  </>}
  {error&&<span className="voice-error" role="alert">{error}<Button aria-label={l('关闭语音提示','Dismiss voice message')} onClick={()=>setError('')}><Icon name="close" size={14}/></Button></span>}
 </div>;
}
