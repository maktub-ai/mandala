export function progressReturnPath(){
 try{
  const path=sessionStorage.getItem('mana-progress-route');
  if(path&&/^\/tasks(?:\?|$)/.test(path)){
   const query=new URLSearchParams(path.split('?')[1]);query.delete('action');
   return '/tasks'+(query.size?'?'+query:'');
  }
 }catch{/* Fall back to Progress when storage is unavailable. */}
 return '/tasks';
}
