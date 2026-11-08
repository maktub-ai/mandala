// Model prose is never proof of a host-accepted business CLI mutation.
export function hasBusinessProgressReceipt(events:readonly {kind:string;data:unknown}[]):boolean{
 return events.some(event=>{
  const data=event.data as {source?:unknown;commandKey?:unknown;text?:unknown}|null;
  return event.kind==='progress'&&data?.source==='cli'&&data.commandKey==='smoke-resume'&&data.text==='MANDALA_BUSINESS_OK';
 });
}
