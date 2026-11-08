import React, { useMemo } from "react";
import type { RootContent } from "hast";
import { createLowlight } from "lowlight";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import sql from "highlight.js/lib/languages/sql";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import diff from "highlight.js/lib/languages/diff";
import yaml from "highlight.js/lib/languages/yaml";
import ini from "highlight.js/lib/languages/ini";
import "./code-highlight.css";

const highlighter = createLowlight({ javascript, typescript, json, python, bash, sql, css, xml, diff, yaml, ini });
const extensions: Record<string, string> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  json: "json", jsonc: "json", py: "python", sh: "bash", bash: "bash", zsh: "bash",
  sql: "sql", css: "css", html: "xml", htm: "xml", xml: "xml", svg: "xml",
  diff: "diff", patch: "diff", yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini",
};

export function codeLanguage(name: string): string | undefined {
  const extension = name.split(/[\\/]/).pop()?.match(/\.([^.]+)$/)?.[1].toLowerCase() ?? "";
  return Object.hasOwn(extensions, extension) ? extensions[extension] : undefined;
}

function renderTokens(nodes: RootContent[]): React.ReactNode {
  return nodes.map((node, index) => node.type === "text" ? node.value : node.type === "element"
    ? <span key={index} className={(node.properties.className as string[] | undefined)?.join(" ")}>{renderTokens(node.children)}</span>
    : null);
}

export function CodePreview({ text, language }: { text: string; language?: string }) {
  const name = language?.trim().toLowerCase();
  const highlighted = useMemo(() => {
    if (!name || text.length > 50_000 || !highlighter.registered(name)) return text;
    try { return renderTokens(highlighter.highlight(name, text).children); }
    catch { return text; }
  }, [text, name]);
  return <pre className="code-preview"><code className={name ? `language-${name}` : undefined}>{highlighted}</code></pre>;
}
