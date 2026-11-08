import { describe, expect, it } from "vitest";
import { identityCells, identityColor } from "../shared/identity";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import IdentityAvatar from "../src/IdentityAvatar";

describe("identity appearance", () => {
  it("renders a selected project icon with its identity color and defaults older projects to the project symbol", () => {
    const identity = { id: "design", name: "Design", color: "#124abc", icon: "book" as const };
    const selected = renderToStaticMarkup(createElement(IdentityAvatar, { identity, kind: "project" }));
    expect(selected).toContain('data-project-icon="book"');
    expect(selected).toContain("lucide-book-open");
    expect(selected).toContain("#124abc");
    const legacy = renderToStaticMarkup(createElement(IdentityAvatar, { identity: { id: "older", name: "Older" }, kind: "project" }));
    expect(legacy).toContain('data-project-icon="project"');
    expect(legacy).not.toContain("lucide-folder");
  });
  it("represents projects as project folders while agents retain individual avatars", () => {
    const identity = { id: "shared-reader", name: "Shared reader", color: "#124abc", avatarSeed: "pattern" };
    const project = renderToStaticMarkup(createElement(IdentityAvatar, { identity, kind: "project" }));
    const agent = renderToStaticMarkup(createElement(IdentityAvatar, { identity, kind: "agent" }));
    expect(project).toContain('data-project-marker');
    expect(project).not.toContain('<rect');
    expect(agent).toContain('<rect');
    expect(project).toBe(renderToStaticMarkup(createElement(IdentityAvatar, { identity: { ...identity, avatarSeed: "other" }, kind: "project" })));
  });
  it("keeps the same identity appearance across project relationships", () => {
    const agent = { id: "shared-reader", name: "Shared reader" };
    expect(identityColor(agent, "agent")).toBe(identityColor({ ...agent }, "agent"));
    expect(identityColor(agent, "agent")).toMatch(/^#[0-9a-f]{6}$/i);
    expect(identityCells("agent:shared-reader")).toEqual(identityCells("agent:shared-reader"));
    expect(agent).not.toHaveProperty("color");
    expect(agent).not.toHaveProperty("avatarSeed");
  });

  it("uses explicit colors without tying default color to avatar regeneration", () => {
    expect(identityColor({ id: "reader", color: "#124abc" }, "agent")).toBe("#124abc");
    expect(identityColor({ id: "reader", avatarSeed: "new-seed" }, "agent"))
      .toBe(identityColor({ id: "reader" }, "agent"));
  });

  it("generates a nonempty mirrored 5 by 5 geometry with distinct seeds and kinds", () => {
    const cells = identityCells("agent:reader");
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.length).toBeLessThanOrEqual(25);
    for (const cell of cells) {
      expect(cell.x).toBeGreaterThanOrEqual(0);
      expect(cell.x).toBeLessThan(5);
      expect(cell.y).toBeGreaterThanOrEqual(0);
      expect(cell.y).toBeLessThan(5);
      expect(cells).toContainEqual({ x: 4 - cell.x, y: cell.y });
    }
    expect(identityCells("project:reader")).not.toEqual(cells);
    expect(identityCells("agent:new-seed")).not.toEqual(cells);
  });
});

it("distinguishes Agent robot symbols from human accounts and renders every project choice", async () => {
  const { default: Icon } = await import("../src/ui/Icon");
  const { projectIcons } = await import("../shared/identity");
  const agent = renderToStaticMarkup(createElement(Icon, { name: "agent", size: 16 }));
  const user = renderToStaticMarkup(createElement(Icon, { name: "user", size: 16 }));
  expect(agent).not.toEqual(user);
  expect(agent).not.toContain("lucide-user-round");
  expect(projectIcons).toHaveLength(48);
  expect(new Set(projectIcons).size).toBe(48);
  for (const icon of projectIcons) {
    const markup = renderToStaticMarkup(createElement(IdentityAvatar, { identity: { id: "p", name: "Project", icon }, kind: "project", size: 16 }));
    expect(markup).toContain(`data-project-icon="${icon}"`);
    expect(markup).toContain('width="16"');
  }
});

it("uses recognizable domain icons while retaining generic utility symbols", async () => {
  const { default: Icon } = await import("../src/ui/Icon");
  const expected = { agent: "bot", market: "store", memory: "brain", usage: "chart-column-increasing", schedule: "calendar-clock" } as const;
  for (const [name, glyph] of Object.entries(expected)) {
    expect(renderToStaticMarkup(createElement(Icon, { name: name as keyof typeof expected }))).toContain(`lucide-${glyph}`);
  }
});

it("accepts exactly one emoji grapheme as an identity symbol", async () => {
  const { isIdentityEmoji } = await import("../shared/identity");
  for (const ok of ["🚀", "🧑‍💻", "🇸🇬", "👍🏽", "❤️", "🕵️"]) expect(isIdentityEmoji(ok)).toBe(true);
  for (const bad of ["", "a", "🚀🚀", "<b>", "1", "🚀a", 42, null, "x".repeat(40)]) expect(isIdentityEmoji(bad)).toBe(false);
});

it("keeps Agents in a circle and Projects bare whichever symbol they choose", () => {
  for (const look of [{ emoji: "🦊" }, { icon: "rocket" as const }, {}]) {
    const agent = renderToStaticMarkup(createElement(IdentityAvatar, { identity: { id: "a", name: "A", ...look }, kind: "agent" }));
    const project = renderToStaticMarkup(createElement(IdentityAvatar, { identity: { id: "p", name: "P", ...look }, kind: "project" }));
    expect(agent).toContain('class="identity-avatar"');
    expect(project).toContain('data-project-marker="true"');
    expect(project).not.toContain("identity-avatar");
  }
  const emojiProject = renderToStaticMarkup(createElement(IdentityAvatar, { identity: { id: "p", name: "P", emoji: "🌐", icon: "book" }, kind: "project" }));
  expect(emojiProject).toContain('data-identity-emoji="🌐"');
  expect(emojiProject).not.toContain("data-project-icon");
  const iconAgent = renderToStaticMarkup(createElement(IdentityAvatar, { identity: { id: "a", name: "A", icon: "rocket" }, kind: "agent" }));
  expect(iconAgent).toContain('data-agent-icon="rocket"');
  expect(iconAgent).not.toContain("<rect");
});
