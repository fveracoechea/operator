import { describe, expect, test } from "bun:test";
import { AgentSelection } from "./main.ts";

describe("Effective selection", () => {
  test("prefers a session override over the project configuration", () => {
    const selection = AgentSelection.resolve({
      overrides: { operator: { host: "opencode" } },
      configuration: { operator: { host: "claude-code", model: "sonnet" } },
    });

    expect(selection.operator.host).toEqual({ value: "opencode", source: "session-override" });
    expect(selection.operator.model).toEqual({ value: "sonnet", source: "project-configuration" });
  });

  test("applies precedence field by field instead of role by role", () => {
    const selection = AgentSelection.resolve({
      overrides: { crew: { model: "haiku" } },
      configuration: { crew: { host: "opencode", model: "sonnet" } },
    });

    expect(selection.crew.host).toEqual({ value: "opencode", source: "project-configuration" });
    expect(selection.crew.model).toEqual({ value: "haiku", source: "session-override" });
  });

  test("falls back to the Operator host when no Crew host is configured", () => {
    const selection = AgentSelection.resolve({
      overrides: {},
      configuration: { operator: { host: "claude-code" } },
    });

    expect(selection.crew.host).toEqual({ value: "claude-code", source: "operator-host" });
  });

  test("leaves an omitted model to the selected host default rather than the Operator model", () => {
    const selection = AgentSelection.resolve({
      overrides: {},
      configuration: { operator: { host: "claude-code", model: "opus" }, crew: {} },
    });

    expect(selection.crew.model).toEqual({ value: null, source: "host-default" });
  });

  test("reports an unnamed Operator host instead of choosing one", () => {
    const selection = AgentSelection.resolve({ overrides: {}, configuration: {} });

    expect(selection.operator.host).toEqual({ value: null, source: "unnamed" });
    expect(selection.crew.host).toEqual({ value: null, source: "unnamed" });
  });

  test("names every host a launch would need, so an unavailable one can be refused", () => {
    const selection = AgentSelection.resolve({
      overrides: { crew: { host: "opencode" } },
      configuration: { operator: { host: "claude-code" } },
    });

    expect(AgentSelection.requiredHosts(selection)).toEqual(["claude-code", "opencode"]);
  });

  test("names one host when the Crew follows the Operator", () => {
    const selection = AgentSelection.resolve({
      overrides: {},
      configuration: { operator: { host: "opencode" } },
    });

    expect(AgentSelection.requiredHosts(selection)).toEqual(["opencode"]);
  });
});
