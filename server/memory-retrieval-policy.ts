export type MemoryRecallPlan = {query:string|null;reason:'acknowledgment'|'request'|'continuation'|'history'};

const acknowledgment=/^(?:好(?:的)?|可以|收到|明白(?:了)?|了解(?:了)?|谢谢(?:你)?|感谢|嗯嗯?|你好|您好|hi|hello|hey|ok(?:ay)?|thanks|thank you|got it|understood|noted)[\s.!！。👍]*$/iu;
const continuation=/^(?:请)?(?:继续|接着)|(?:按(?:照)?|沿用)(?:刚才|上次|之前|那个|这个|上述|上面)|(?:那个|这个|刚才的|上述|上面的)(?:方案|决定|参数|问题|做法)|\b(?:continue|go on|proceed|that (?:plan|approach|decision)|same (?:plan|approach)|as (?:before|above))\b/iu;
const history=/之前|上次|以前|过去|记得|曾经|\b(?:previous|earlier|last time|remember|history|historical)\b/iu;
const bareContinuation=/^(?:请)?(?:继续|接着|接下来|continue|go on|proceed)[\s.!！。]*$/iu;
// Match the native tool's UTF-16 length limit without cutting a surrogate pair.
const clip=(value:string,limit:number)=>value.slice(0,limit).replace(/[\uD800-\uDBFF]$/u,'');

export function planMemoryRecall(input:{request:string;recentRequests:string[];taskRequest?:string}):MemoryRecallPlan {
 const request=input.request.trim();
 if(!request||acknowledgment.test(request))return {query:null,reason:'acknowledgment'};
 const reason=continuation.test(request)?'continuation':history.test(request)?'history':'request';
 const recent=reason==='request'?[]:input.recentRequests.map(text=>text.trim()).filter(text=>text&&text!==request&&!acknowledgment.test(text)&&!bareContinuation.test(text)).slice(-2);
 const context=[...new Set([...recent,input.taskRequest?.trim()??''])].filter(text=>text&&text!==request);
 const parts=[clip(request,context.length?1200:2000),...context.map(text=>clip(text,350))];
 return {query:clip(parts.join('\n'),2000),reason};
}
