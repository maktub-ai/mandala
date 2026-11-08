import type { CSSProperties } from 'react';
import { Archive, Braces, CodeXml, File, FileText, Film, Image, LibraryBig, Music, Presentation, Sheet, Sparkles, TextAlignStart, type LucideIcon } from 'lucide-react';
import { fileCategory, fileExtension } from '../shared/file-types';
// One tinted rounded tile for every library item: tone carries the category, the glyph carries the type.
type Tone={icon:LucideIcon;tone:string};
const tones:Record<string,Tone>={
 pdf:{icon:FileText,tone:'#d23c3c'},spreadsheet:{icon:Sheet,tone:'#1e8449'},presentation:{icon:Presentation,tone:'#d0601a'},
 image:{icon:Image,tone:'#8a52c8'},audio:{icon:Music,tone:'#c2448c'},video:{icon:Film,tone:'#b13f74'},archive:{icon:Archive,tone:'#a8721a'},
 code:{icon:CodeXml,tone:'#2f6dbf'},data:{icon:Braces,tone:'#a3780f'},doc:{icon:FileText,tone:'#2b5fb3'},document:{icon:TextAlignStart,tone:'#5d6b80'},
 file:{icon:File,tone:'#5d6b80'},wiki:{icon:LibraryBig,tone:'#23897c'},skill:{icon:Sparkles,tone:'#5b5bd6'}};
const data=['json','yaml','yml','xml','toml'],word=['doc','docx','odt','rtf','pages'];
export function assetIconTone(name:string,mediaType?:string,kind?:string){
 if(kind==='wiki'||kind==='skill')return kind;
 const ext=fileExtension(name);if(!ext)return 'file';
 return data.includes(ext)?'data':word.includes(ext)?'doc':fileCategory(name,mediaType);
}
export default function AssetFileIcon({name,mediaType,kind,size=23}:{name:string;mediaType?:string;kind?:string;size?:number}){
 const key=assetIconTone(name,mediaType,kind),{icon:Glyph,tone}=tones[key]??tones.file;
 return <span className="asset-type-icon" data-tone={key} aria-hidden="true" style={{width:size,height:size,'--tone':tone} as CSSProperties}>
  <Glyph width={Math.round(size*0.58)} height={Math.round(size*0.58)} strokeWidth={1.9} focusable={false}/>
 </span>;
}
