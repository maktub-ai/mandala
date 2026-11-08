import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { Config } from "../shared/types";
import SkillLibrary from "../src/SkillLibrary";
import IdentityAvatar from "../src/IdentityAvatar";
import { LanguageProvider } from "../src/i18n";

it("shows each agent's own avatar in skill assignments", () => {
  const agents = [
    { id: "a", name: "Agent", skills: [], skillIds: ["s"], avatarSeed: "custom", color: "#124abc" },
    { id: "mandala", name: "Mandala", skills: [], systemRole: "mandala" as const },
  ];
  const config = { agents, projects: [], skillLibrary: [{ id: "s", name: "example", path: "" }] } as unknown as Config;
  const html = renderToStaticMarkup(createElement(LanguageProvider, null, createElement(SkillLibrary, { config, onChange: () => {} })));
  for (const agent of agents) {
    expect(html).toContain(renderToStaticMarkup(createElement(IdentityAvatar, { identity: agent, kind: "agent", size: 20 })));
  }
});
