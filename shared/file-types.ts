const mediaTypes:Record<string,string>={
 txt:'text/plain',md:'text/markdown',markdown:'text/markdown',csv:'text/csv',tsv:'text/tab-separated-values',
 json:'application/json',xml:'text/xml',html:'text/html',htm:'text/html',yaml:'text/plain',yml:'text/plain',log:'text/plain',
 js:'text/plain',jsx:'text/plain',ts:'text/plain',tsx:'text/plain',py:'text/plain',css:'text/plain',sql:'text/plain',sh:'text/plain',
 pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',svg:'image/svg+xml',avif:'image/avif',bmp:'image/bmp',
 mp3:'audio/mpeg',wav:'audio/wav',ogg:'audio/ogg',m4a:'audio/mp4',flac:'audio/flac',mp4:'video/mp4',webm:'video/webm',mov:'video/quicktime',
};
export function fileExtension(name:string){return name.split('/').at(-1)?.split('.').slice(1).at(-1)?.toLowerCase()??'';}
export function fileMediaType(name:string,mediaType='application/octet-stream'){
 return mediaType==='application/octet-stream'?(mediaTypes[fileExtension(name)]??mediaType):mediaType;
}
export function filePreviewKind(name:string,mediaType:string){
 const type=fileMediaType(name,mediaType);
 if(['image/png','image/jpeg','image/gif','image/webp','image/svg+xml','image/avif','image/bmp'].includes(type))return 'image';
 if(type==='application/pdf')return 'pdf';
 if(type.startsWith('audio/'))return 'audio';
 if(type.startsWith('video/'))return 'video';
 if(type==='text/csv'||type==='text/tab-separated-values')return 'table';
 if(type.startsWith('text/')||type==='application/json')return 'text';
 return null;
}
export function fileCategory(name:string,mediaType='application/octet-stream'){
 const ext=fileExtension(name),preview=filePreviewKind(name,mediaType);
 if(preview==='image'||preview==='audio'||preview==='video'||preview==='pdf')return preview;
 if(['csv','tsv','xls','xlsx','ods'].includes(ext))return 'spreadsheet';
 if(['ppt','pptx','odp'].includes(ext))return 'presentation';
 if(['zip','rar','7z','tar','gz','bz2','xz'].includes(ext))return 'archive';
 if(['js','jsx','ts','tsx','py','css','sql','sh','json','xml','yaml','yml','html','htm'].includes(ext))return 'code';
 if(preview==='text'||['doc','docx','odt','rtf','pages'].includes(ext))return 'document';
 return 'file';
}
