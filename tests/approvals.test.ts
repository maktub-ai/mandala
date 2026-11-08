import { expect, it } from "vitest";
import { approvalChoices, nativeApprovalDecision, nativeApprovalResponse } from "../shared/approvals";
import type { Approval } from "../shared/types";
const request = (params: unknown = {}, method = "item/commandExecution/requestApproval"): Approval => ({id:"a",conversationId:"c",nativeRequestId:42,method,params});
it("exposes session and exact native prefix approvals without inventing a prefix", () => {
  const a = request({ proposedExecpolicyAmendment: ["git", "status"] });
  expect(approvalChoices(a)).toEqual(["reject", "approve", "approve-session", "approve-rule"]);
  expect(nativeApprovalDecision(a, "approve-session")).toBe("acceptForSession");
  expect(nativeApprovalDecision(a, "approve-rule")).toEqual({acceptWithExecpolicyAmendment:{execpolicy_amendment:["git","status"]}});
  expect(approvalChoices(request())).not.toContain("approve-rule");
});
it("honors restricted native decisions and refuses an unadvertised approval", () => {
  const a = request({availableDecisions:["accept","decline"],proposedExecpolicyAmendment:["git"]});
  expect(approvalChoices(a)).toEqual(["reject","approve"]);
  expect(() => nativeApprovalDecision(a,"approve-rule")).toThrow("unsupported approval decision");
  expect(() => nativeApprovalDecision(a,"approve-session")).toThrow("unsupported approval decision");
});
it("does not offer remembered approvals for OMP confirms or arbitrary interactive requests", () => {
  expect(approvalChoices(request({},"omp/confirm"))).toEqual(["reject","approve"]);
  expect(approvalChoices(request({},"omp/input"))).toEqual([]);
});
it("never broadens a native amendment or substitutes a platform-supplied prefix", () => {
  const a = request({availableDecisions:["accept", {acceptWithExecpolicyAmendment:{execpolicy_amendment:["git","status"]}},"decline"],proposedExecpolicyAmendment:["git"]});
  expect(approvalChoices(a)).not.toContain("approve-rule");
  expect(approvalChoices(request({proposedExecpolicyAmendment:[]}))).not.toContain("approve-rule");
});
it("shows cancel when the native prompt only supports stopping on denial", () => {
  const a = request({availableDecisions:["accept","cancel"]});
  expect(approvalChoices(a)).toEqual(["reject-stop","approve"]);
  expect(nativeApprovalDecision(a,"reject-stop")).toBe("cancel");
});
it("handles Codex MCP tool approval as an empty form elicitation, not a command decision", () => {
  const a = request({mode:"form",serverName:"openmana_tasks",requestedSchema:{type:"object",properties:{}},
    _meta:{codex_approval_kind:"mcp_tool_call",persist:["session","always"]}}, "mcpServer/elicitation/request");
  expect(approvalChoices(a)).toEqual(["reject","approve","approve-session","approve-always"]);
  expect(nativeApprovalResponse(a,"approve")).toEqual({action:"accept",content:null});
  expect(nativeApprovalResponse(a,"reject")).toEqual({action:"decline",content:null});
  expect(nativeApprovalResponse(a,"approve-session")).toEqual({action:"accept",content:null,_meta:{persist:"session"}});
  expect(nativeApprovalResponse(a,"approve-always")).toEqual({action:"accept",content:null,_meta:{persist:"always"}});
  expect(() => nativeApprovalResponse(a,"approve-rule")).toThrow("unsupported approval decision");
});
it("only offers advertised MCP persistence and never accepts forms needing user input", () => {
  const params={mode:"form",requestedSchema:{type:"object",properties:{}},_meta:{codex_approval_kind:"mcp_tool_call",persist:"session"}};
  const a=request(params,"mcpServer/elicitation/request");
  expect(approvalChoices(a)).toEqual(["reject","approve","approve-session"]);
  expect(() => nativeApprovalResponse(a,"approve-always")).toThrow("unsupported approval decision");
  for(const p of [{...params,mode:"url"},{...params,_meta:{}},{...params,requestedSchema:{type:"object",properties:{name:{type:"string"}}}}])
    expect(approvalChoices(request(p,"mcpServer/elicitation/request"))).toEqual([]);
  expect(nativeApprovalResponse(request(),"approve")).toEqual({decision:"accept"});
});

it('exposes only advertised native ACP always choices and returns their exact option ID',()=>{
 const a=request({options:[{kind:'allow_once',optionId:'once'},{kind:'allow_always',optionId:'remember-native'},{kind:'reject_once',optionId:'no'}]},'acp/permission');
 expect(approvalChoices(a)).toContain('approve-always');
 expect(nativeApprovalResponse(a,'approve-always')).toEqual({outcome:{outcome:'selected',optionId:'remember-native'}});
 expect(()=>nativeApprovalResponse(request({options:[{kind:'allow_once',optionId:'once'}]},'acp/permission'),'approve-always')).toThrow();
});
