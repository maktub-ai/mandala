/** Color comes from the tone (state family); the cutout shape names the specific state so related states stay distinguishable without color. */
const cuts={
 check:'M6.2 11.6 8 9.8l3 3 5.5-6 1.9 1.8-7.4 8-4.8-5Z',
 play:'M9.5 6.3 18 12l-8.5 5.7Z',
 clock:'M10.8 5.5h2.4v6h4.3v2.4h-6.7Z',
 alert:'M10.7 5h2.6v9h-2.6Zm0 11h2.6v2.6h-2.6Z',
 minus:'M7 10.8h10v2.4H7Z',
 cross:'M8.2 9.9 9.9 8.2 12 10.3 14.1 8.2 15.8 9.9 13.7 12 15.8 14.1 14.1 15.8 12 13.7 9.9 15.8 8.2 14.1 10.3 12Z',
 reply:'M6.5 12 11 7.5v3h6v3h-6v3Z',
 ring:'M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z',
};
export type StatusShape=keyof typeof cuts;
const toneShape:Record<string,StatusShape>={success:'check',active:'play',warning:'clock',danger:'alert',neutral:'minus'};
export default function StatusMark({tone='neutral',shape}:{tone?:string;shape?:StatusShape}){
 return <svg className="status-mark" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fillRule="evenodd" d={'M12 1.5a10.5 10.5 0 1 1 0 21 10.5 10.5 0 0 1 0-21Z'+cuts[shape??toneShape[tone]??'minus']}/></svg>;
}
/** One shape per Task, Run or execution-chat state; tone still supplies the family color. */
export function statusShape(state:string):StatusShape{
 return ({todo:'ring',queued:'clock',starting:'clock',running:'play',waiting:'alert',attention:'alert',approval:'alert',review:'clock',completed:'check',succeeded:'check',replied:'reply',cancelled:'minus',interrupted:'minus',failed:'cross',error:'cross'} as Record<string,StatusShape>)[state]??'minus';
}
