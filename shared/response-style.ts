export const responseStyles = ["standard", "concise", "explanatory"] as const;
export type ResponseStyle = typeof responseStyles[number];
export const responseStyleLabels = { standard: "标准", concise: "简洁", explanatory: "解释型" } as const;
export const responseStyleDescriptions = {
  standard: "以结果为主，补充适量关键依据。",
  concise: "精简表达，保留必要风险、限制和不确定性。",
  explanatory: "按需说明来源、查法、事实及结论依据，区分事实与推断。",
} as const;
export function effectiveResponseStyle(config: { responseStyle?: ResponseStyle }, agent?: { responseStyle?: ResponseStyle }): ResponseStyle {
  return agent?.responseStyle ?? config.responseStyle ?? "standard";
}
