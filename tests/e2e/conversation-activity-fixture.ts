import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Store} from '../../server/store';
import type {SessionManager} from '../../server/sessions';
import type {CodexOptions} from '../../server/codex';

export async function conversationActivityFixture(req:IncomingMessage,res:ServerResponse,store:Store,manager:SessionManager,native:Map<string,CodexOptions>){
 if(req.method!=='POST'||!['/__test__/conversation-activity-fixture','/__test__/conversation-activity-approval'].includes(req.url??''))return false;
 let body='';for await(const chunk of req)body+=chunk;
 const input=JSON.parse(body||'{}') as {state?:string;conversationId?:string};
 const approval=(id:string)=>{
  const chat=store.getConversation(id)!,options=native.get(chat.nativeId!)!;
  options.onApproval({id:'activity-native-approval',method:'item/commandExecution/requestApproval',params:{threadId:chat.nativeId,turnId:chat.turnId,command:'node scripts/validate-export.mjs --env test --read-only',cwd:'/synthetic/project',reason:'访问测试存储服务以校验导出记录数',networkApprovalContext:{host:'test-storage.example',protocol:'https'},availableDecisions:['accept','decline']}});
 };
 if(req.url==='/__test__/conversation-activity-approval'){
  if(input.state==='resolved'){
   const chat=store.getConversation(input.conversationId!)!;
   native.get(chat.nativeId!)!.onEvent({method:'serverRequest/resolved',params:{threadId:chat.nativeId,turnId:chat.turnId,requestId:'activity-native-approval'}});
  }else approval(input.conversationId!);
  res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');return true;
 }
 const chat=await manager.create('activity','inspector');
 await manager.send(chat.id,'activity-flow');
 const current=store.getConversation(chat.id)!,options=native.get(current.nativeId!)!;
 const runId=(store.listEvents(chat.id,0).find(event=>event.kind==='user')!.data as {runId:string}).runId;
 store.appendEvent(chat.id,'metadata',{status:'loaded',cli:input.state==='reasoning-groups'?'codex':'omp'});
 const emit=(method:string,item:Record<string,unknown>)=>options.onEvent({method,params:{threadId:current.nativeId,turnId:current.turnId,item}});
 const report=(text:string,steps:{text:string;status:string}[])=>store.appendEvent(chat.id,'progress',{runId,source:'cli',text,steps});
 report('先核对导出约定和输入字段，再运行校验。',[{text:'核对字段',status:'running'},{text:'运行校验',status:'pending'}]);
 emit('item/completed',{id:'commentary',type:'agentMessage',phase:'commentary',text:'我会先查看现有脚本，确认 CSV 编码和列顺序。随后逐项核对输入字段、导出约定与记录数，保留原始数据，并说明校验结果和仍需确认的事项。'});
 emit('item/completed',{id:'reasoning',type:'reasoning',summary:[input.state==='reasoning-groups'?'**确认输入来源**\n\n先读取导出约定。\n\n## 先核对字段与编码约定，再检查导出结果。\n\n然后运行逐项校验。':'先核对字段与编码约定，再检查导出结果。']});
 if(input.state==='reasoning-groups'){
  for(const name of ['fields','encoding','records'])emit('item/completed',{id:name,type:'commandExecution',command:'node scripts/check-'+name+'.mjs',status:'completed',exitCode:0,aggregatedOutput:'Synthetic check output: '+name});
 }else{
 for(const path of ['src/export-billing.ts','docs/billing-fields.md','src/csv-options.ts'])emit('item/completed',{id:path,type:'mcpToolCall',server:'OMP',tool:'read',arguments:{path},status:'completed',result:'Synthetic file contents: '+path});
 for(const pattern of ['billingColumns','encoding'])emit('item/completed',{id:pattern,type:'mcpToolCall',server:'OMP',tool:'grep',arguments:{pattern,path:'src/'},status:'completed',result:'Synthetic matches'});
 }
 const latest=report('字段和编码约定已核对，接下来运行导出校验。',[{text:'核对字段',status:'completed'},{text:'检查编码',status:'completed'},{text:'运行校验',status:'pending'}]);
 if(input.state==='acp-approval')options.onApproval({id:'activity-acp-approval',method:'acp/permission',params:{threadId:current.nativeId,turnId:current.turnId,title:'读取导出约定',message:'需要确认后才能读取本地文件。',toolCall:{rawInput:{path:'/synthetic/project/docs/billing-fields.md'},locations:[{path:'/synthetic/project/docs/billing-fields.md'}]},options:[{kind:'allow_once',optionId:'once'},{kind:'allow_always',optionId:'always'},{kind:'reject_once',optionId:'reject'}]}});
 else if(input.state==='approval')approval(chat.id);
 else{
  if(input.state==='command-failure'){
   emit('item/completed',{id:'command-success',type:'commandExecution',command:'node scripts/check-fields.mjs',status:'completed',exitCode:0,aggregatedOutput:'字段校验通过'});
   emit('item/completed',{id:'command-failure',type:'commandExecution',command:'missing-validation-command',status:'failed',exitCode:127,aggregatedOutput:'Command exited with code 127'});
  }
  emit('item/started',{id:'validation',type:'commandExecution',command:'node scripts/validate-export.mjs --env test --read-only',status:'inProgress'});
  options.onEvent({method:'item/commandExecution/outputDelta',params:{threadId:current.nativeId,turnId:current.turnId,itemId:'validation',delta:'字段顺序：匹配\n文件编码：UTF-8\n记录数校验：执行中…'}});
  if(input.state==='ended'){
   emit('item/completed',{id:'validation',type:'commandExecution',command:'node scripts/validate-export.mjs --env test --read-only',status:'completed',exitCode:0,aggregatedOutput:'字段顺序：匹配\n文件编码：UTF-8\n记录数校验：通过'});
   emit('item/completed',{id:'answer',type:'agentMessage',phase:'final_answer',text:'导出校验通过。字段顺序、UTF-8 编码与记录数均符合约定。本次没有修改导出脚本。'});
   options.onEvent({method:'turn/completed',params:{threadId:current.nativeId,turn:{id:current.turnId,status:'completed'}}});
  }
 }
 res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:chat.id,reportId:latest.id}));
 return true;
}
