import React from "react";
import { renderChineseMarkup } from "./helpers/render-ui";
import { describe, expect, it, vi } from "vitest";
import MarkdownMessage from "../src/MarkdownMessage";

const samples = [
  ["ts", 'const answer: number = 42;'],
  ["js", 'const answer = "hello";'],
  ["json", '{"answer": true}'],
  ["python", 'def greet():\n    return "hello"'],
  ["bash", 'echo "$HOME"'],
  ["sql", 'SELECT name FROM users WHERE id = 1;'],
  ["css", 'body { color: red; }'],
  ["html", '<div class="safe">Hello</div>'],
  ["diff", '-old\n+new'],
] as const;

describe("Markdown code highlighting", () => {
  it.each(samples)("highlights fenced %s code", (language, text) => {
    const markup = renderChineseMarkup(React.createElement(MarkdownMessage, { text: `\`\`\`${language}\n${text}\n\`\`\`` }));
    expect(markup).toContain('class="hljs-');
    expect(markup).toContain('aria-label="复制代码"');
  });

  it("keeps inline code and unknown languages as plain text", () => {
    const markup = renderChineseMarkup(React.createElement(MarkdownMessage, { text: '`const inline = true`\n\n```unregistered\nconst answer = true;\n```' }));
    expect(markup).not.toContain('class="hljs-');
    expect(markup).toContain('<code>const inline = true</code>');
  });

  it("keeps Mermaid diagram and source controls", () => {
    vi.stubGlobal("document", { documentElement: { dataset: { theme: "dark" } } });
    try {
      const markup = renderChineseMarkup(React.createElement(MarkdownMessage, { text: '```mermaid\nflowchart LR\nA --> B\n```' }));
      expect(markup).toContain('mermaid-diagram');
      expect(markup).toContain('查看源码');
      expect(markup).not.toContain('class="hljs-');
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("reusable file code preview", () => {
  it.each(samples)("preserves all source text for %s", async (language, text) => {
    const { CodePreview } = await import("../src/CodePreview");
    const source = `  ${text}\n\n`;
    const markup = renderChineseMarkup(React.createElement(CodePreview, { text: source, language }));
    const restored = markup.replace(/<[^>]*>/g, "").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    expect(restored).toBe(source);
  });

  it("escapes executable HTML rather than injecting it", async () => {
    const { CodePreview } = await import("../src/CodePreview");
    const markup = renderChineseMarkup(React.createElement(CodePreview, { text: '<img src=x onerror="alert(1)"><script>alert(2)</script>', language: "html" }));
    expect(markup).not.toContain('<img');
    expect(markup).not.toContain('<script');
    expect(markup).toContain('&lt;');
  });

  it("uses plain text for unknown, missing and oversized languages", async () => {
    const { CodePreview } = await import("../src/CodePreview");
    for (const [language, text] of [["unknown", "const a = true;"], [undefined, "const a = true;"], ["js", "const a = true;\n".repeat(4000)]] as const) {
      const markup = renderChineseMarkup(React.createElement(CodePreview, { text, language }));
      expect(markup).not.toContain('class="hljs-');
      expect(markup).toContain(text);
    }
  });

  it("infers supported languages from file extensions without guessing unknown files", async () => {
    const { codeLanguage } = await import("../src/CodePreview");
    for (const [file, language] of [["src/App.TSX", "typescript"], ["script.mjs", "javascript"], ["config.json", "json"], ["task.py", "python"], ["run.zsh", "bash"], ["query.sql", "sql"], ["style.css", "css"], ["index.htm", "xml"], ["change.patch", "diff"], ["config.yml", "yaml"], ["config.toml", "ini"]]) {
      expect(codeLanguage(file)).toBe(language);
    }
    expect(codeLanguage("notes.txt")).toBeUndefined();
    expect(codeLanguage("README")).toBeUndefined();
    expect(codeLanguage("sql")).toBeUndefined();
    expect(codeLanguage("constructor")).toBeUndefined();
  });
});
