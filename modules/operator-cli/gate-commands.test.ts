import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  commitArtifact,
  makeReviewWorkspace,
  startProducer,
  startReviewer,
  submissionBody,
  submit,
} from "./review-cycle-fixture.ts";
import { FIXTURE_GATE, workspaces } from "./workspace-fixture.ts";

// These tests create Git worktrees and run several CLI processes under the parallel CI gate.
setDefaultTimeout(120_000);

const fixtures = workspaces();

afterEach(async () => {
  await fixtures.removeAll();
});

// Both commands pass at once, so the base gate run before the first dispatch passes.
const TWO_COMMANDS = {
  ...FIXTURE_GATE,
  commands: [
    { name: "install", argv: ["git", "--version"], timeoutSeconds: 600 },
    { name: "quality", argv: ["true"], timeoutSeconds: 1800 },
  ],
};

function passed(name: string, command: string) {
  return { name, command, outcome: "passed", detail: "" };
}

describe("the project gate at dispatch", () => {
  test("a base commit with no gate launches nothing, and names the commit", async () => {
    const workspace = await makeReviewWorkspace(fixtures, { gate: null });
    const producer = await startProducer(workspace, undefined, { acknowledge: false });

    expect(producer.dispatched).toMatchObject({
      outcome: "missing-condition",
      reason: "project_gate_missing",
      blockers: [{ commit: producer.baseCommit, path: "operator-gate.json" }],
    });
    expect(await Bun.file(`${producer.worktreePath}/.operator/local/brief.md`).exists()).toBe(
      false,
    );
  });

  test("an invalid gate is refused with the field that is wrong", async () => {
    const workspace = await makeReviewWorkspace(fixtures, {
      gate: { ...FIXTURE_GATE, commands: [{ name: "quality", argv: ["bun", "run", "quality"] }] },
    });
    const producer = await startProducer(workspace, undefined, { acknowledge: false });

    expect(producer.dispatched.reason).toBe("project_gate_invalid");
  });

  test("the brief states the committed gate, and an uncommitted edit has no effect", async () => {
    const workspace = await makeReviewWorkspace(fixtures, { gate: TWO_COMMANDS });
    await Bun.write(`${workspace.repo}/operator-gate.json`, JSON.stringify(FIXTURE_GATE));
    const producer = await startProducer(workspace);

    const brief = await Bun.file(`${producer.worktreePath}/.operator/local/brief.md`).text();
    const submitAt = brief.indexOf("attempt submit --request");
    const install = brief.indexOf("- `install`: `git --version` (time limit 600 seconds)");
    const quality = brief.indexOf("- `quality`: `true` (time limit 1800 seconds)");
    expect(submitAt).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(submitAt);
    expect(quality).toBeGreaterThan(install);
    expect(brief).toContain(
      `run each command of the project gate at commit ${producer.baseCommit}`,
    );
  });
});

describe("the project gate at submit", () => {
  test("refuses a code result that shows a gate command as missing or flaky", async () => {
    const workspace = await makeReviewWorkspace(fixtures, { gate: TWO_COMMANDS });
    const producer = await startProducer(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");

    const refused = await submit(
      workspace,
      producer,
      submissionBody(producer, artifact, {
        checks: [
          passed("quality", "bun run quality"),
          { name: "quality", command: "bun run quality", outcome: "failed", detail: "1 test" },
        ],
      }),
    );

    expect(refused.json).toMatchObject({
      outcome: "conflict",
      reason: "project_gate_not_passed",
      blockers: [
        {
          reason: "project_gate_not_passed",
          gateCommit: producer.baseCommit,
          commands: [
            { name: "install", recorded: [] },
            { name: "quality", recorded: ["passed", "failed"] },
          ],
        },
      ],
    });

    // The refusal recorded nothing, so the same attempt submits once every gate command passed.
    const accepted = await submit(
      workspace,
      producer,
      submissionBody(producer, artifact, {
        checks: [
          passed("install", "bun install --frozen-lockfile"),
          passed("quality", "bun run quality"),
        ],
      }),
    );
    expect(accepted.json.reason).toBe("result_submitted");
  });

  test("a non-code result needs no gate check", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const producer = await startProducer(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");

    const submitted = await submit(workspace, producer, {
      ...submissionBody(producer, artifact),
      resultKind: "non-code",
      checks: [],
      code: null,
    });

    expect(submitted.json.reason).toBe("result_submitted");
  });

  test("the reviewer is permitted to run each gate command", async () => {
    const workspace = await makeReviewWorkspace(fixtures, { gate: TWO_COMMANDS });
    const producer = await startProducer(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    // The producer ran its checks with other words, so only the gate can permit the commands.
    const submitted = await submit(
      workspace,
      producer,
      submissionBody(producer, artifact, {
        checks: [passed("install", "bun install"), passed("quality", "bun run check")],
      }),
    );
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);

    const brief = await Bun.file(`${reviewer.worktreePath}/.operator/local/brief.md`).text();
    expect(brief).toContain("- git --version\n- true\n");
  });
});
