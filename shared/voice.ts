export const VOICE_MAX_SECONDS = 120;
export const VOICE_SAMPLE_RATE = 16000;
export const VOICE_MAX_BYTES = 44 + VOICE_MAX_SECONDS * VOICE_SAMPLE_RATE * 2;
export const voiceModels = [
 {id:'base-q5',name:'Whisper Base Q5',file:'ggml-base-q5_1.bin',bytes:59707625,sha256:'422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898'},
 {id:'small-q5',name:'Whisper Small Q5',file:'ggml-small-q5_1.bin',bytes:190085487,sha256:'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb'},
] as const;
export const voiceLanguages = ['auto','zh','en','ja','ko','fr','de','es'] as const;
export type VoiceSettings = {enabled:boolean;provider:'local'|'openai';localModel:string;language:string;hasApiKey:boolean};
export type VoiceStatus = {settings:VoiceSettings;models:{id:string;installed:boolean;downloaded:number;downloading:boolean;error?:string}[]};
export const defaultVoiceSettings:VoiceSettings = {enabled:false,provider:'local',localModel:'small-q5',language:'auto',hasApiKey:false};
export function appendVoiceText(current:string,transcript:string){return transcript.trim()?current+(current&&!current.endsWith('\n')?'\n':'')+transcript.trim():current;}
/** Mono PCM16 at 16 kHz, shared by local and hosted transcription. */
export function encodeVoiceWav(samples:Float32Array):ArrayBuffer {
 if(!samples.length||samples.length>VOICE_MAX_SECONDS*VOICE_SAMPLE_RATE)throw new Error('Recording must be between 0 and 120 seconds');
 const buffer=new ArrayBuffer(44+samples.length*2),view=new DataView(buffer);
 const text=(offset:number,value:string)=>{for(let i=0;i<value.length;i++)view.setUint8(offset+i,value.charCodeAt(i));};
 text(0,'RIFF');view.setUint32(4,buffer.byteLength-8,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
 view.setUint32(24,VOICE_SAMPLE_RATE,true);view.setUint32(28,VOICE_SAMPLE_RATE*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,samples.length*2,true);
 for(let i=0;i<samples.length;i++){const n=Number.isFinite(samples[i])?Math.max(-1,Math.min(1,samples[i])):0;view.setInt16(44+i*2,n<0?n*32768:n*32767,true);}
 return buffer;
}
