import { expect, spyOn, test } from "bun:test";
import { commandWords } from "./operations.ts";
import { useProjectInvocation, writeJsonResult } from "./result.ts";

test("renders a selected JSR healthcheck reproof command in JSON", () => {
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    useProjectInvocation("jsr", null, commandWords);
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
    useProjectInvocation(null, null, []);
  }
});

test("renders a selected source reproof command at its pinned commit", () => {
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    const commit = "f".repeat(40);
    useProjectInvocation("github-source", commit, commandWords);
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
    useProjectInvocation(null, null, []);
  }
});

test("renders every operation word of a selected JSR project command", () => {
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    useProjectInvocation("jsr", null, commandWords);
    writeJsonResult({
      outcome: "completed",
      reason: "version_reported",
      blockers: [],
      operation: "version",
      data: {
        commands: [
          "operator publish apply --source s --json",
          "operator gate run --source s --json",
          "operator work rebase --source s --base b --json",
        ].map((command) => ({ command })),
      },
    });
    expect(
      JSON.parse(String(output.mock.calls[0]?.[0])).data.commands.map(
        (one: { command: string }) => one.command,
      ),
    ).toEqual([
      "bun run operator publish apply --source s --json",
      "bun run operator gate run --source s --json",
      "bun run operator work rebase --source s --base b --json",
    ]);
  } finally {
    output.mockRestore();
    useProjectInvocation(null, null, []);
  }
});
