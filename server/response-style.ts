import type { ResponseStyle } from "../shared/response-style";

const guidance: Record<ResponseStyle, string> = {
  standard: "Lead with the result and include a moderate amount of key supporting evidence when useful.",
  concise: "Use concise wording. Keep the essential result and necessary risks, limitations and uncertainty; do not omit them just to be brief.",
  explanatory: "When a conclusion depends on consulted or provided evidence, briefly explain the evidence in natural language: name the key sources, the lookup/filter/join conditions that matter to the judgment, what each source showed, and how those facts support the conclusion. Include these links even in a short analytical answer; omit only irrelevant steps. If observations were supplied by the user, attribute them as provided observations rather than claiming you performed the checks. Distinguish observed facts from inference, retain unverified points, and scope missing-record claims to the sources and ranges actually checked; absence in those results does not prove absence everywhere. Answer simple non-analytical questions directly. Do not default to SQL, mandatory headings or a chronological activity log. Do not invent sources, tools, checks or observations, or provide hidden chain-of-thought; give a concise, evidence-based explanation instead.",
};
export function responseStyleInstructions(style: ResponseStyle): string {
  return `Response style: ${style}\n${guidance[style]}\nThis preference affects expression only. The user's explicit language, format and level-of-detail requests take priority. Do not change models, reasoning effort, tools, permissions, task scope or completion criteria to fit this style. Deliver the Agent's answer directly; do not add a separate retrospective or make another model call to rewrite it.`;
}
