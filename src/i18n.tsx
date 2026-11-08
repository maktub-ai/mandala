import { english } from './messages';
import { localizeMessage, type LanguagePack } from '../shared/ui-extensions';
import { useUiExtensions } from './UiExtensions';
import './language.css';
import { devicePreferences } from './devicePreferences';
import { automationErrors } from "./automationMessages";
import { sshErrorText } from "./ssh-errors";
import React, { createContext, useContext, useEffect, useState } from "react";

export type Language = string;
export type Message = keyof typeof english;
type Values = Record<string, string | number>;
function translate(language: Language, message: Message, values: Values = {}, pack?: LanguagePack) {
  const key = language === 'zh-CN' ? message.replace(/\bAgents?\b/g, '智能体') : message;
  return localizeMessage(language, pack, key, english[message], values);
}

const errors: Record<string, Message> = {
  "提交状态待确认；输入已保留。恢复连接后再次发送只核对本机记录，不会重发。请检查对话历史，确认未提交后再重新提出。": "提交状态待确认；输入已保留。恢复连接后再次发送只核对本机记录，不会重发。请检查对话历史，确认未提交后再重新提出。",
  "No completed reply to fork": "请在一轮回答完整结束后创建对话分支。",
  "invalid repository URL": "请输入有效的 HTTPS 或 SSH 仓库地址。",
  "invalid clone workspace": "工作目录组信息无效。",
  "git is not installed": "未找到 Git，请先安装 Git。",
  "git clone failed; check the repository URL, network, and native Git authentication": "克隆失败，请检查仓库地址、网络和本机 Git 认证。",
  "No comparison base is available for this branch": "未找到此分支的比较基线（远程默认分支或 main/master）。",
  "No common ancestor is available for this branch": "此分支与比较基线没有可用的共同祖先。",
  "引用内容太长，请缩小选区后再加入对话。": "引用内容太长，请缩小选区后再加入对话。",
  "File is outside this conversation's workspace preview scope": "该文件不在此对话的预览范围内。",
  "Working directory is unavailable": "工作目录不可用。",
  "Working directory changed while loading; open it again": "工作目录或访问范围已变化，请重新打开。",
  "Git filter configuration is unavailable": "无法安全读取 Git 过滤器配置。",
  "File diff is unavailable or too large to preview": "文件差异不可用或过大，无法预览。",
  "停止尚未确认，请稍后重试；消息仍保留在输入框。": "停止尚未确认，请稍后重试；消息仍保留在输入框。",
  "question expired": "问题已过期，请查看当前问题。",
  "invalid question answers": "请完整填写每个问题的回答。",
  "File preview requires a chat": "请在对话中打开文件链接。",
  "File is outside this chat's preview scope": "该文件不在此对话的预览范围内。",
  "Local file is unavailable": "本地文件不存在或已不可用。",
  "Only text files can be previewed here": "此处仅支持文本文件预览。",
  "File is too large to preview": "文件超过 1 MB，无法在此预览。",
  "File changed while loading; open it again": "文件或访问范围已变化，请重新打开。",
  "Invalid local file path": "本地文件路径无效。",
  "invalid reasoning effort": "思考强度无效。",
  "Attachment exceeds 20 MB": "单个附件不能超过 20 MB。",
  "Attachment must be between 1 byte and 20 MB": "单个附件须为 1 字节至 20 MB。",
  "invalid attachment references": "附件不属于此对话或已不可用，请重新上传。",
  "invalid attachment name": "附件名称无效。",
  ...automationErrors,
  "Cannot load confirmed memory; check the MANA library and retry this turn.": "无法读取已确认记忆，请检查 MANA 资料库后重试。",
  "CLI did not acknowledge memory instructions; retry this turn.": "CLI 未确认记忆加载，请重试本轮。",
  "Native reply branching unavailable": "当前 CLI 版本未提供完整会话 Fork，请升级 CLI 后重试。",
  "Native message branching unavailable": "当前 CLI 不支持可验证的消息分支。",
  "Native message history does not match; branching unavailable": "原生历史与消息记录不一致，无法安全创建分支。",
  "Native branch prefix could not be verified": "无法验证分支上下文，未重新发送消息。",
  "Native branch did not create a new conversation": "原生执行端未创建独立分支。",
  "Native branch was cancelled": "已取消分支创建。",
  "Native session does not match": "原生会话不匹配，无法创建分支。",
  "invalid reply checkpoint": "请选择已完成的回答。",
  "invalid branch message": "请选择有效的历史用户消息。",

  项目名称不能为空: "项目名称不能为空",
  "Agent 名称不能为空": "Agent 名称不能为空",
  "Runtime disabled": "此执行端已停用，请在执行端接入中启用后新建对话。",
  "configuration changed": "配置已被其他窗口或文件修改，请关闭配置后重新打开。",
  "invalid configuration": "配置无效，请检查项目、Agent 和目录设置。",
  "invalid project directory": "工作目录无效，请选择一个已存在的绝对路径。",
  "conversation not found": "对话不存在。",
  "invalid project or agent": "项目或 Agent 不存在，请检查配置。",
  "CLI did not finish stopping; its runtime was terminated. You can continue this conversation.": "CLI 未响应停止，已终止执行端。可以继续此对话。",
  "conversation busy": "对话正在执行，请等待完成或停止。",
  "conversation interrupted; use continue": "对话已中断，请使用继续执行。",
  "conversation not running": "对话未在执行。",
  "approval expired": "审批已过期，请检查最新执行状态。",
  "invalid empty message": "消息不能为空。",
  "invalid title: maximum 80 characters": "标题不能超过 80 个字符。",
  "service closed": "本地服务已关闭，请重新启动。",
  "Request origin rejected": "请求来源被拒绝。",
  "unsupported approval; use the native CLI or stop this turn":
    "暂不支持此类原生交互，请停止后使用 CLI",
  "Failed to fetch": "无法连接本地服务，请检查服务是否运行。",
};
function translatedError(language: Language, message: string, pack?: LanguagePack) {
  const ssh = sshErrorText(language, message);
  if (ssh) return ssh;
  if (/already has an active writer/i.test(message)) return language !== "zh-CN"
    ? "This native thread is still held by another writer. Wait for its execution to finish, or use the saved request in a new chat.\n" + message
    : "此原生线程仍被其他执行进程占用。可等待原执行结束，或将已保存的请求用于新对话。\n" + message;
  if (Object.hasOwn(errors, message)) return translate(language, errors[message], {}, pack);
  const reserved = message.match(/^Reserved (codex|omp) runtime argument: (.+)$/);
  const environment = message.match(/^Reserved runtime environment variable: (.+)$/);
  const missing = message.match(/^Missing environment variable: (.+)$/);
  const value = message.match(/^Missing value for runtime argument: (.+)$/);
  if (language !== "zh-CN") return message;
  if (reserved) return `${reserved[1]} 的参数 ${reserved[2]} 由系统管理，不能在此覆盖。`;
  if (environment) return `环境变量 ${environment[1]} 由原生运行环境管理，不能在此覆盖。`;
  if (missing) return `环境变量 ${missing[1]} 尚未在本地服务中定义。`;
  if (value) return `启动参数 ${value[1]} 缺少值。`;
  if (message === "Runtime positional arguments are not allowed") return "每个启动参数须以选项开头，不能在这里传入任务或子命令。";
  return message;
}
const defaultContext = {
  language: "en" as Language,
  setLanguage: (_language: Language) => {},
  text: (_zh: string, en: string) => en,
  languages: [{ value: "en", label: "English" }, { value: "zh-CN", label: "简体中文" }],
  t: (message: Message, values?: Values) => translate("en", message, values),
  errorText: (message: string) => translatedError("en", message),
};
const LanguageContext = createContext(defaultContext);
export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const { snapshot } = useUiExtensions();
  const packs = (snapshot?.items ?? []).flatMap(item => item.data.format === 'mandala-language' ? [item.data] : []);
  const [choice, setChoice] = useState(() => devicePreferences.getItem('mana-language') ?? 'en');
  const pack = packs.find(item => item.locale === choice);
  const language = choice === 'zh-CN' || choice === 'en' || pack ? choice : 'en';
  const setLanguage = (value: Language) => {
    if (!['zh-CN', 'en', ...packs.map(item => item.locale)].includes(value)) return;
    devicePreferences.setItem('mana-language', value); setChoice(value);
  };
  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = pack?.direction ?? 'ltr';
  }, [language, pack?.direction]);
  useEffect(() => {
    // Only a successful store read establishes removal; a network failure must not erase the choice.
    if (snapshot && choice !== language) { devicePreferences.setItem('mana-language', language); setChoice(language); }
  }, [snapshot, choice, language]);
  return (
    <LanguageContext.Provider
      value={{
        language,
        setLanguage,
        t: (message, values) => translate(language, message, values, pack),
        text: (zh, en) => localizeMessage(language, pack, zh, en),
        languages: [...defaultContext.languages, ...packs.map(item => ({ value: item.locale, label: item.name }))],
        errorText: (message) => translatedError(language, message, pack),
      }}
    >
      {children}
    </LanguageContext.Provider>
  );
}
export const useLanguage = () => useContext(LanguageContext);
