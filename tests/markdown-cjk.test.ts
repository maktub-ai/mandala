import React from "react";
import { expect, it } from "vitest";
import { renderChineseMarkup } from "./helpers/render-ui";
import MarkdownMessage from "../src/MarkdownMessage";

// CommonMark alone leaves `**…。**后文` as literal asterisks, which Agent replies in Chinese produce often.
it("renders Chinese emphasis that closes after full-width punctuation", () => {
  const markup = renderChineseMarkup(React.createElement(MarkdownMessage, { text: "**可以考虑切，但建议先完成新旧映射对照，再整体切换。**重点确认：" }));
  expect(markup).toContain("<strong>可以考虑切，但建议先完成新旧映射对照，再整体切换。</strong>");
  expect(markup).not.toContain("**");
});
