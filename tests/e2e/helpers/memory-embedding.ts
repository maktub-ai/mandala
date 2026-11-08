// Deterministic lexical vectors for UI protocol tests; real local semantic quality is tested separately.
export async function fixtureMemoryEmbed(texts:string[]):Promise<number[][]>{
 return texts.map(text=>{
  const vector=Array(256).fill(0) as number[],body=text.replace(/^(?:title: memory \| text: |task: search result \| query: )/,'');
  for(const term of body.toLowerCase().match(/[\p{L}\p{N}_]+/gu)??[]){
   let hash=2166136261;for(const letter of term)hash=Math.imul(hash^letter.codePointAt(0)!,16777619);
   vector[(hash>>>0)%vector.length]++;
  }
  if(!vector.some(Boolean))vector[0]=1;return vector;
 });
}
