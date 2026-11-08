import { expect, it } from "vitest";
import { resolveCapabilities } from "../server/capabilities";
import type { Agent, Project } from "../shared/types";

const project: Project = {
  id: "p", name: "Project", cwd: "/tmp", agentIds: ["a"], resources: [],
  mcp: [{ name: "shared", transport: "stdio", command: "project-tool" }],
  skills: [{ name: "review", path: "/tmp/project-review" }],
};
const agent: Agent = {
  id: "a", name: "Agent", instructions: "Review", defaultCli: "codex",
  models: {},
  mcp: [{ name: "shared", transport: "stdio", command: "agent-tool" }],
  skills: [{ name: "review", path: "/tmp/agent-review" }],
};

it("resolves whole named capabilities by project, agent, then native precedence", () => {
  const result = resolveCapabilities(project, agent, {
    mcp: [{ name: "shared", source: "native", path: "/tmp/native" },
      { name: "native-only", source: "native", path: "/tmp/native" }],
    skills: [{ name: "review", source: "native", path: "/tmp/native-review" }],
  });
  expect(result.mcp.find((x) => x.name === "shared")).toMatchObject({
    source: "project", overridden: ["agent", "native"],
  });
  expect(result.mcp.find((x) => x.name === "native-only")?.source).toBe("native");
  expect(result.skills.find((x) => x.name === "review")).toMatchObject({
    source: "project", overridden: ["agent", "native"],
  });
});
