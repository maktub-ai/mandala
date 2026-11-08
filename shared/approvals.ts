import type { Approval } from "./types";

export type ApprovalDecision = "approve" | "reject" | "reject-stop" | "approve-session" | "approve-rule" | "approve-always" | "approve-conversation";
export type NativeApprovalDecision = "accept" | "decline" | "cancel" | "acceptForSession" |
  { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } };

export function isMcpToolApproval(approval: Approval): boolean {
  const params = approval.params as {mode?: string; _meta?: {codex_approval_kind?: string}; requestedSchema?: {
    type?: string; properties?: Record<string, unknown>; required?: unknown[];
  }} | null;
  const schema = params?.requestedSchema;
  return approval.method === "mcpServer/elicitation/request" && params?.mode === "form" &&
    params._meta?.codex_approval_kind === "mcp_tool_call" && schema?.type === "object" &&
    !!schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties) &&
    Object.keys(schema.properties).length === 0 && (!schema.required || schema.required.length === 0);
}

function nativeChoices(approval: Approval): ApprovalDecision[] {
  if (approval.method === "acp/permission") {
    const options = (approval.params as {options: {kind: string}[]}).options;
    return ["reject", ...(options.some(option => option.kind === "allow_once") ? ["approve"] : []),
      ...(options.some(option => option.kind === "allow_always") ? ["approve-always"] : [])] as ApprovalDecision[];
  }
  if (approval.method === "omp/confirm") return ["reject", "approve"];
  if (isMcpToolApproval(approval)) {
    const persist = (approval.params as {_meta: {persist?: unknown}})._meta.persist;
    const supports = (mode: string) => persist === mode || Array.isArray(persist) && persist.includes(mode);
    return ["reject", "approve", ...(supports("session") ? ["approve-session"] : []),
      ...(supports("always") ? ["approve-always"] : [])] as ApprovalDecision[];
  }
  if (!["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(approval.method)) return [];
  const params = approval.params as { availableDecisions?: unknown[] | null; proposedExecpolicyAmendment?: string[] };
  const choices: [ApprovalDecision, NativeApprovalDecision][] = [
    ["reject", "decline"], ["approve", "accept"], ["approve-session", "acceptForSession"],
  ];
  if (Array.isArray(params.availableDecisions) && params.availableDecisions.includes("cancel"))
    choices.unshift(["reject-stop", "cancel"]);
  const prefix = params.proposedExecpolicyAmendment;
  if (approval.method === "item/commandExecution/requestApproval" && Array.isArray(prefix) &&
      prefix.length > 0 && prefix.every(part => typeof part === "string" && part.length > 0))
    choices.push(["approve-rule", { acceptWithExecpolicyAmendment: { execpolicy_amendment: prefix } }]);
  return choices.filter(([, native]) => !Array.isArray(params.availableDecisions) ||
    params.availableDecisions.some(value => JSON.stringify(value) === JSON.stringify(native))).map(([choice]) => choice);
}

export function supportsConversationApproval(approval: Approval): boolean {
  if (!nativeChoices(approval).includes("approve")) return false;
  const params = approval.params as { wholeTurnApproval?:boolean; grantRoot?: unknown; toolApproval?: boolean; additionalPermissions?: unknown; networkApprovalContext?: unknown; proposedNetworkPolicyAmendments?: unknown };
  return !params.wholeTurnApproval && !params.grantRoot && !params.additionalPermissions && !params.networkApprovalContext && !params.proposedNetworkPolicyAmendments && (approval.method !== "omp/confirm" || params.toolApproval === true);
}

export function approvalChoices(approval: Approval): ApprovalDecision[] {
  const choices = nativeChoices(approval);
  return approval.conversationApproval && supportsConversationApproval(approval) ? [...choices, "approve-conversation"] : choices;
}

export function nativeApprovalDecision(approval: Approval, decision: ApprovalDecision): NativeApprovalDecision {
  if (isMcpToolApproval(approval) || !nativeChoices(approval).includes(decision)) throw new Error("unsupported approval decision");
  if (decision === "approve-rule") return { acceptWithExecpolicyAmendment: {
    execpolicy_amendment: (approval.params as { proposedExecpolicyAmendment: string[] }).proposedExecpolicyAmendment,
  } };
  return decision === "approve-session" ? "acceptForSession" : decision === "approve" ? "accept" : decision === "reject-stop" ? "cancel" : "decline";
}

export function nativeApprovalResponse(approval: Approval, decision: ApprovalDecision) {
  if (decision === "approve-conversation") {
    if (!approvalChoices(approval).includes(decision)) throw new Error("unsupported approval decision");
    decision = "approve";
  }
  if (approval.method === "acp/permission") {
    if (!approvalChoices(approval).includes(decision)) throw new Error("unsupported approval decision");
    const option = (approval.params as {options: {kind:string;optionId:string}[]}).options.find(option => option.kind === (decision === "approve-always" ? "allow_always" : decision === "approve" ? "allow_once" : "reject_once"));
    return {outcome: option ? {outcome:"selected",optionId:option.optionId} : {outcome:"cancelled"}};
  }
  if (!isMcpToolApproval(approval)) return {decision: nativeApprovalDecision(approval, decision)};
  if (!approvalChoices(approval).includes(decision)) throw new Error("unsupported approval decision");
  return {action: decision === "reject" ? "decline" : "accept", content: null,
    ...(decision === "approve-session" || decision === "approve-always"
      ? {_meta: {persist: decision === "approve-session" ? "session" : "always"}} : {})};
}
