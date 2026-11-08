import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AttachmentItem from "../src/AttachmentItem";
import TurnProcess from "../src/TurnProcess";
import { groupChatTurns } from "../src/chatTurns";
import { LanguageProvider } from "../src/i18n";
import { renderChineseMarkup } from "./helpers/render-ui";

afterEach(() => vi.unstubAllGlobals());
for (const language of ["zh-CN", "en"]) {
  it(`renders a preview button for stored images and plain text for files in ${language}`, () => {
    vi.stubGlobal("localStorage", { getItem: () => language });
    const item = { id: "image-id", name: "sample.png", size: 80, mimeType: "image/png" };
    const render = (mimeType: string) => renderToStaticMarkup(createElement(LanguageProvider, null,
      createElement(AttachmentItem, { item: { ...item, mimeType }, conversationId: "chat" })));
    const image = render("image/png");
    expect(image).toContain('src="/api/conversations/chat/attachments/image-id"');
    expect(image).toContain('alt="sample.png"');
    expect(image).toContain(language === "en" ? "Preview image sample.png" : "预览图片 sample.png");
    expect(render("application/octet-stream")).not.toContain("<img");
    expect(render("image/svg+xml")).not.toContain("<img");
  });
}

it("keeps completed turn text without a success check icon", () => {
  const turn = groupChatTurns([
    { id: 1, conversationId: "chat", kind: "user", data: { text: "Synthetic request" }, createdAt: "2026-10-06T00:00:00Z" },
    { id: 2, conversationId: "chat", kind: "text", data: { text: "Synthetic reply", phase: "final_answer" }, createdAt: "2026-10-06T00:00:01Z" },
    { id: 3, conversationId: "chat", kind: "status", data: { status: "idle" }, createdAt: "2026-10-06T00:00:02Z" },
  ])[0];
  const markup = renderChineseMarkup(createElement(TurnProcess, { turn, onInspect() {} }));
  expect(markup).toContain("本轮已回复");
  expect(markup).not.toContain("lucide-check");
});
