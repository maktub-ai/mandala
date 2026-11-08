import type { Message } from "./i18n";

export type ManaTab = "memory" | "document" | "skill" | "organization" | "automation";
export const manaTabs: Record<ManaTab, Message | "Skills"> = { memory: "记忆", document: "文档", skill: "Skills", organization: "组织", automation: "自动化" };
