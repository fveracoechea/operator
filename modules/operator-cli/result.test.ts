import { expect, spyOn, test } from "bun:test";
import { useProjectInvocation, writeJsonResult } from "./result.ts";

test("renders a selected JSR healthcheck reproof command in JSON", () => {
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    useProjectInvocation("jsr");
    writeJsonResult({
      outcome: "completed",
      reason: "version_reported",
      blockers: [],
      operation: "version",
      data: { reproof: "operator setup probe plan --opencode --json" },
    });
    expect(JSON.parse(String(output.mock.calls[0]?.[0])).data.reproof).toBe(
      "bun run operator setup probe plan --opencode --json",
    );
  } finally {
    output.mockRestore();
    useProjectInvocation(null);
  }
});

test("renders a selected source reproof command at its pinned commit", () => {
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    const commit = "f".repeat(40);
    useProjectInvocation("github-source", commit);
    writeJsonResult({
      outcome: "completed",
      reason: "version_reported",
      blockers: [],
      operation: "version",
      data: { reproof: "operator setup probe plan --opencode --json" },
    });
    expect(JSON.parse(String(output.mock.calls[0]?.[0])).data.reproof).toBe(
      `bunx "github:fveracoechea/operator#${commit}" setup probe plan --opencode --json`,
    );
  } finally {
    output.mockRestore();
    useProjectInvocation(null);
  }
});
