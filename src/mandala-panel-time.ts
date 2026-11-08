/** Short relative time for side-panel meta lines ("3 分钟前", "in 2 h"). Falls back to a date once it is more than a week away. */
export function relativeTime(iso:string|null|undefined,english:boolean,now=Date.now()){
 if(!iso)return '';
 const at=Date.parse(iso);if(!Number.isFinite(at))return '';
 const diff=at-now,future=diff>0,minutes=Math.round(Math.abs(diff)/60000);
 const unit=(value:number,zh:string,en:string)=>english?(future?`in ${value} ${en}`:`${value} ${en} ago`):(future?`${value} ${zh}后`:`${value} ${zh}前`);
 if(minutes<1)return english?(future?'in a moment':'just now'):(future?'即将':'刚刚');
 if(minutes<60)return unit(minutes,'分钟','min');
 const hours=Math.round(minutes/60);if(hours<24)return unit(hours,'小时','h');
 const days=Math.round(hours/24);if(days<=7)return unit(days,'天','d');
 return new Date(at).toLocaleString(english?'en':'zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
}
export const recentWindowMs=24*60*60*1000;
