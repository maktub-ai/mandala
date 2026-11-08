export type DiffRow = {kind:'hunk'|'context'|'add'|'remove'|'note';text:string;oldLine?:number;newLine?:number};
export function diffRows(patch:string):DiffRow[] {
 const rows:DiffRow[]=[];let oldLine=0,newLine=0,inHunk=false;
 for(const line of patch.split('\n')) {
  const hunk=/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if(hunk){oldLine=Number(hunk[1]);newLine=Number(hunk[2]);inHunk=true;rows.push({kind:'hunk',text:line});continue;}
  if(line.startsWith('diff --git ')){inHunk=false;continue;}
  if(!inHunk)continue;
  if(line.startsWith('+'))rows.push({kind:'add',text:line.slice(1),newLine:newLine++});
  else if(line.startsWith('-'))rows.push({kind:'remove',text:line.slice(1),oldLine:oldLine++});
  else if(line.startsWith(' '))rows.push({kind:'context',text:line.slice(1),oldLine:oldLine++,newLine:newLine++});
  else if(line.startsWith('\\'))rows.push({kind:'note',text:line});
 }
 return rows;
}
export function splitRows(rows:DiffRow[]):{left?:DiffRow;right?:DiffRow;header?:DiffRow}[] {
 const result:{left?:DiffRow;right?:DiffRow;header?:DiffRow}[]=[];
 for(let i=0;i<rows.length;) {
  const row=rows[i];
  if(row.kind==='hunk'||row.kind==='note'){result.push({header:row});i++;}
  else if(row.kind==='context'){result.push({left:row,right:row});i++;}
  else {
   const removed:DiffRow[]=[],added:DiffRow[]=[];
   while(i<rows.length&&(rows[i].kind==='remove'||rows[i].kind==='add')){(rows[i].kind==='remove'?removed:added).push(rows[i++]);}
   for(let j=0;j<Math.max(removed.length,added.length);j++)result.push({left:removed[j],right:added[j]});
  }
 }
 return result;
}
