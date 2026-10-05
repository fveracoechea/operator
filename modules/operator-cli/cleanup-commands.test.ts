import { registerSource, withdrawIssues, workspaceTarget } from "./source-fixture.ts";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test as bunTest } from "bun:test";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";
import {
  acceptProduction,
  acceptReview,
  commitArtifact,
  delegateRework,
  disposeFindings,
  type Host,
  reportBody,
  reportReview,
  startProducer,
  startReviewer,
  startRework,
  startSibling,
  submissionBody,
  submit,
  writeInput,
  type Workspace,
} from "./review-cycle-fixture.ts";
import {
  headCommit,
  herdrCalls,
  nextActions,
  requestId as request,
  runJson,
  runOperator,
  workspaces,
} from "./workspace-fixture.ts";

// Cleanup tests run full producer and reviewer cycles through separate CLI processes.
// Each test states its own bound, because a process-wide default would set the bound of every
// file in the bun test process (#179).
function test(name: string, run: () => Promise<void> | void, timeoutMs = 60_000) {
  bunTest(name, run, timeoutMs);
}

const fixtures = workspaces();

afterEach(async () => {
  await fixtures.removeAll();
});

// A configured project ignores what Operator writes into a checkout, and `*.tmp` gives the
// tests one ignored path that Operator never wrote. `node_modules/` holds what an install
// command of the project gate writes.
const IGNORE_RULES = [
  ".operator/",
  ".claude/skills/",
  ".agents/skills/",
  "*.tmp",
  "node_modules/",
  "",
].join("\n");

/** Writes what `bun install` leaves in a checkout: many ignored files nobody registered. */
async function writeInstallOutput(worktreePath: string, packages: number): Promise<void> {
  for (let index = 0; index < packages; index += 1) {
    await Bun.write(`${worktreePath}/node_modules/pkg-${index}/index.js`, "export {};\n");
  }
}

const SKILL_PATH: Record<Host, string> = {
  "claude-code": ".claude/skills/code-review/SKILL.md",
  opencode: ".agents/skills/code-review/SKILL.md",
};

/** A fixture project with no remote, because removal proves the work from the local branch. */
async function makeWorkspace(
  options: { host?: Host; reasoningEffort?: string } = {},
): Promise<Workspace> {
  const host = options.host ?? "claude-code";
  const crew: { host: Host; model?: string; reasoningEffort?: string } = { host };
  if (options.reasoningEffort !== undefined) {
    crew.model = "openai/gpt-6-sol";
    crew.reasoningEffort = options.reasoningEffort;
  }
  const fixture = await fixtures.make({
    config: { crew },
    files: { ".gitignore": IGNORE_RULES },
  });

  // The ignore rules cover the skills Operator installs, so the review skill this project owns
  // is committed on its own, exactly as a configured project keeps it.
  await Bun.write(`${fixture.repo}/${SKILL_PATH[host]}`, "---\nname: code-review\n---\n");
  await Bun.$`git -C ${fixture.repo} add -f ${SKILL_PATH[host]}`.quiet();
  await Bun.$`git -C ${fixture.repo} -c user.email=t@example.com -c user.name=Test commit -q -m skill`.quiet();

  return { ...fixture, host };
}

/** One production assignment carried to accepted completion, with a reviewed result. */
async function acceptedCycle(workspace: Workspace) {
  const producer = await startProducer(workspace);
  const artifact = await commitArtifact(workspace, producer, "# Result\n\nThe finished work.\n");
  const submitted = await submit(workspace, producer, submissionBody(producer, artifact));
  const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);

  await reportReview(
    workspace,
    reviewer,
    submitted.json.data.reviewId,
    reportBody({ submissionIdentity: submitted.json.data.identity, host: workspace.host }),
  );
  const accepted = await acceptProduction(workspace, producer, {
    submissionId: submitted.json.data.submissionId,
    revision: submitted.json.data.revision,
  });
  expect(accepted.json.reason).toBe("assignment_accepted");

  return { producer, reviewer, submitted, artifact };
}

async function close(workspace: Workspace, ownerToken: string, attemptId: string) {
  return runJson(workspace, [
    "cleanup",
    "close",
    "--request",
    request(),
    "--owner-token",
    ownerToken,
    "--attempt",
    attemptId,
  ]);
}

async function remove(workspace: Workspace, ownerToken: string, attemptId: string) {
  return runJson(workspace, [
    "cleanup",
    "remove",
    "--request",
    request(),
    "--owner-token",
    ownerToken,
    "--attempt",
    attemptId,
  ]);
}

type Blocker = { reason: string; [key: string]: unknown };

/**
 * Rewrites one column of a recorded launch.
 * These guards answer for a crew state no supported command can produce, such as a checkout
 * that names the controlling repository. The damaged record is built here rather than
 * pretended into existence through a command that would refuse it.
 */
function damageDispatch(
  workspace: Workspace,
  attemptId: string,
  column: "worktree_path" | "pane_id" | "agent_host",
  value: string | null,
): void {
  const state = new Database(`${workspace.repo}/.operator/local/crew-state.sqlite`);
  state.run(`update attempt_dispatch set ${column} = ? where attempt_id = ?`, [value, attemptId]);
  state.close();
}

function reasons(result: { json: { blockers: Blocker[] } }): string[] {
  return result.json.blockers.map((one) => one.reason);
}

/** How many times the fake Herdr was asked for its worktree list so far. */
async function worktreeLists(workspace: Workspace): Promise<number> {
  return (await herdrCalls(workspace)).filter((line) => line.startsWith("worktree list")).length;
}

/** Grants the approval one blocked removal asked for, exactly as it named it. */
async function grantRemoval(
  workspace: Workspace,
  ownerToken: string,
  blocker: Blocker,
  exactText = "Remove this Operative checkout.",
) {
  return runJson(workspace, [
    "approval",
    "grant",
    "--request",
    request(),
    "--owner-token",
    ownerToken,
    "--input",
    await writeInput(workspace, {
      action: blocker.action,
      targets: blocker.targets,
      scope: blocker.scope,
      requestRevision: blocker.requestRevision,
      exactText,
      grantedBy: "human",
    }),
  ]);
}

describe("operator cleanup close", () => {
  test("closes a handed-over Operative and leaves its checkout in place", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);

    const closed = await close(workspace, producer.ownerToken, producer.attemptId);

    expect(closed.exitCode).toBe(0);
    expect(closed.json.reason).toBe("process_closed");
    expect(closed.json.data.state).toBe("done");
    expect(closed.json.data.kind).toBe("process_closure");

    // The evidence lives outside the worktree, and the checkout itself is untouched.
    const names = closed.json.data.evidence.map((one: { name: string }) => one.name);
    expect(names).toEqual(["brief", "control-reference", "release", "artifact-result"]);
    const brief = await Bun.file(
      `${workspace.repo}/${closed.json.data.evidence[0].storedPath}`,
    ).text();
    expect(brief).toContain(`Operative brief for attempt ${producer.attemptId}`);
    expect(await Bun.file(`${producer.worktreePath}/README.md`).exists()).toBe(true);

    const calls = await herdrCalls(workspace);
    expect(calls.some((line) => line.startsWith("agent send-keys "))).toBe(true);
    expect(calls.some((line) => line.startsWith("worktree remove"))).toBe(false);
  });

  test("closes an Operative on opencode through that host's own stop", async () => {
    const workspace = await makeWorkspace({ host: "opencode" });
    const { producer } = await acceptedCycle(workspace);

    const closed = await close(workspace, producer.ownerToken, producer.attemptId);

    expect(closed.exitCode).toBe(0);
    expect(closed.json.data.agentHost).toBe("opencode");
    const stop = (await herdrCalls(workspace)).find((line) => line.startsWith("agent send-keys "));
    expect(stop).toContain("esc ctrl+c ctrl+d");
  });

  test("preserves the OpenCode effort inputs before closing the process", async () => {
    const workspace = await makeWorkspace({ host: "opencode", reasoningEffort: "medium" });
    const { producer } = await acceptedCycle(workspace);

    const closed = await close(workspace, producer.ownerToken, producer.attemptId);

    expect(closed.json.reason).toBe("process_closed");
    expect(closed.json.data.evidence.map((one: { name: string }) => one.name)).toContain(
      "opencode-agent",
    );
    expect(closed.json.data.evidence.map((one: { name: string }) => one.name)).toContain(
      "opencode-effort-plugin",
    );
  });

  test("closes a reviewer whose axes ran as sub-agents of its own host", async () => {
    const workspace = await makeWorkspace();
    const { producer, reviewer } = await acceptedCycle(workspace);

    // A review holds one agent and one checkout; its two axes hold neither.
    const launched = await herdrCalls(workspace);
    expect(launched.filter((line) => line.startsWith("agent start "))).toHaveLength(2);
    expect(launched.filter((line) => line.startsWith("worktree create"))).toHaveLength(2);

    const closed = await close(workspace, producer.ownerToken, reviewer.attemptId);

    expect(closed.exitCode).toBe(0);
    expect(closed.json.reason).toBe("process_closed");
    // A review submits no result of its own, so its evidence is what the launch wrote.
    expect(closed.json.data.evidence.map((one: { name: string }) => one.name)).toEqual([
      "brief",
      "control-reference",
      "release",
    ]);
    // One stop for one agent. The axes had nothing of their own to stop.
    expect(
      (await herdrCalls(workspace)).filter((line) => line.startsWith("agent send-keys")),
    ).toHaveLength(1);

    const producerCleanups = await runJson(workspace, [
      "cleanup",
      "show",
      "--attempt",
      producer.attemptId,
    ]);
    expect(producerCleanups.json.data.cleanups).toEqual([]);
  });

  test("retains the process when the checkout lost the evidence it must preserve", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);
    await rm(`${producer.worktreePath}/.operator/local/brief.md`);

    const blocked = await close(workspace, producer.ownerToken, producer.attemptId);

    expect(blocked.exitCode).toBe(3);
    expect(reasons(blocked)).toEqual(["evidence_missing"]);
    expect(blocked.json.blockers[0].name).toBe("brief");
    expect((await herdrCalls(workspace)).some((line) => line.startsWith("agent send-keys"))).toBe(
      false,
    );
  });

  test("refuses to close an Operative that is still writing and still waits on an answer", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);

    const raised = await runJson(
      workspace,
      [
        "question",
        "raise",
        "--request",
        request(),
        "--attempt",
        producer.attemptId,
        "--input",
        await writeInput(workspace, {
          question: "Does the report render the locale on the viewer's clock?",
          evidence: [{ label: "spec", detail: "The spec names no timezone." }],
          options: [
            { name: "viewer", detail: "Render on the viewer's clock.", risk: "none" },
            { name: "utc", detail: "Render in UTC.", risk: "A reader misreads the time." },
          ],
          recommendation: "Render on the viewer's clock.",
          escalationTriggers: ["visible-behavior"],
          affectedScope: ["the report header"],
          independentWork: ["the data layer"],
        }),
      ],
      producer.worktreePath,
    );
    expect(raised.exitCode).toBe(6);

    const blocked = await close(workspace, producer.ownerToken, producer.attemptId);

    expect(blocked.exitCode).toBe(3);
    expect(blocked.json.reason).toBe("cleanup_blocked");
    expect(reasons(blocked)).toEqual(["writer_active", "question_open"]);
    expect(blocked.json.blockers[0].state).toBe("active");
    expect((await herdrCalls(workspace)).some((line) => line.startsWith("agent send-keys"))).toBe(
      false,
    );
  });

  test("retains the process when the checkout holds work nobody registered", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);
    await Bun.write(`${producer.worktreePath}/notes.md`, "a human edit\n");
    await Bun.write(`${producer.worktreePath}/scratch.tmp`, "an ignored file\n");

    const blocked = await close(workspace, producer.ownerToken, producer.attemptId);

    expect(blocked.exitCode).toBe(3);
    // A closure deletes no file, so the ignored file is left for the removal to read.
    expect(reasons(blocked)).toEqual(["unexpected_work"]);
    expect(blocked.json.blockers[0]).toMatchObject({ paths: ["notes.md"], omitted: 0 });
  });

  test("closes a submitted Operative whose gate install left ignored output", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n\nThe finished work.\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact));
    expect(submitted.json.reason).toBe("result_submitted");
    await writeInstallOutput(producer.worktreePath, 30);

    const closed = await close(workspace, producer.ownerToken, producer.attemptId);

    expect(closed.json.reason).toBe("process_closed");
  });

  test("retains the process when the brief in the checkout is not the brief it was launched with", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);
    // Operator's own paths are excluded from the checkout reading, so an edit here would be
    // invisible without the identity the launch recorded.
    await Bun.write(`${producer.worktreePath}/.operator/local/brief.md`, "a rewritten brief\n");

    const blocked = await close(workspace, producer.ownerToken, producer.attemptId);

    expect(blocked.exitCode).toBe(3);
    expect(reasons(blocked)).toEqual(["evidence_changed"]);
    expect(blocked.json.blockers[0].name).toBe("brief");
  });

  test("retains the process when the fixed evidence a review read no longer matches", async () => {
    const workspace = await makeWorkspace();
    const { producer, submitted } = await acceptedCycle(workspace);
    const stored = `${workspace.repo}/.operator/local/submissions/${submitted.json.data.submissionId}`;
    // The listing order depends on the file system, so the test names the result copy.
    const copies = await Array.fromAsync(
      new Bun.Glob("*-result.md").scan({ cwd: stored, onlyFiles: true }),
    );
    expect(copies).toHaveLength(1);
    await Bun.write(`${stored}/${copies[0]}`, "a different result\n");

    const blocked = await close(workspace, producer.ownerToken, producer.attemptId);

    expect(blocked.exitCode).toBe(3);
    expect(reasons(blocked)).toEqual(["evidence_changed"]);
    expect(blocked.json.blockers[0].name).toBe("artifact-result");
  });

  test("retains the process when the host refuses its own stop", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);
    await Bun.write(`${workspace.herdr}/agent-stop-refused`, "");

    const blocked = await close(workspace, producer.ownerToken, producer.attemptId);

    expect(blocked.exitCode).toBe(3);
    expect(reasons(blocked)).toEqual(["writer_live"]);
  });

  test("retains the process when a child tool outlives the stopped host", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);
    await Bun.write(`${workspace.herdr}/pane-processes`, "4242|mcp-server|mcp-server --app pen\n");
    await Bun.write(`${workspace.herdr}/keep-processes`, "");

    const blocked = await close(workspace, producer.ownerToken, producer.attemptId);

    expect(blocked.exitCode).toBe(3);
    expect(reasons(blocked)).toEqual(["unfamiliar_process"]);
    expect(blocked.json.blockers[0].childTools).toEqual(["mcp-server (4242)"]);
  });

  test("retains the process when another agent occupies the Operative workspace", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);
    // A pane of this workspace holds an agent this attempt never launched.
    await Bun.write(`${workspace.herdr}/agents/stranger`, "w1:p1");

    const blocked = await close(workspace, producer.ownerToken, producer.attemptId);

    expect(blocked.exitCode).toBe(3);
    expect(reasons(blocked)).toEqual(["unfamiliar_process"]);
    expect(blocked.json.blockers[0].occupants).toEqual(["stranger"]);
    expect((await herdrCalls(workspace)).some((line) => line.startsWith("worktree remove"))).toBe(
      false,
    );
  });

  test("keeps an unanswered stop open until a later run settles it", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);
    await Bun.write(`${workspace.herdr}/agent-send-keys.lost`, "");

    const uncertain = await close(workspace, producer.ownerToken, producer.attemptId);
    expect(uncertain.exitCode).toBe(5);
    expect(uncertain.json.reason).toBe("cleanup_uncertain");

    const shown = await runJson(workspace, ["cleanup", "show", "--attempt", producer.attemptId]);
    expect(shown.json.data.cleanups[0].state).toBe("uncertain");

    await rm(`${workspace.herdr}/agent-send-keys.lost`);
    const settled = await close(workspace, producer.ownerToken, producer.attemptId);
    expect(settled.exitCode).toBe(0);
    expect(settled.json.reason).toBe("process_closed");
    // The effect had already landed, so the second run settles the same recorded operation.
    expect(
      (await herdrCalls(workspace)).filter((line) => line.startsWith("agent send-keys")),
    ).toHaveLength(1);
  });
});

describe("cleanup identity", () => {
  test("refuses to act on the controlling checkout", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);
    damageDispatch(workspace, producer.attemptId, "worktree_path", workspace.repo);

    const blocked = await close(workspace, producer.ownerToken, producer.attemptId);

    expect(blocked.exitCode).toBe(3);
    expect(reasons(blocked)).toEqual(["unrelated_resource"]);
    expect(blocked.json.blockers[0].worktreePath).toBe(workspace.repo);
    expect((await herdrCalls(workspace)).some((line) => line.startsWith("agent send-keys"))).toBe(
      false,
    );
  });

  test("refuses to act while another attempt still writes in the checkout", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);

    // A second assignment claims the same checkout path. Its launch fails, but the plan it
    // recorded first makes it a live writer of that directory.
    const registered = await registerSource(workspaceTarget(workspace), producer.ownerToken, {
      sourceKind: "ticket",
      parent: 16,
      items: [{ key: "16.1", title: "Follow-on work", body: "Continue in the same checkout." }],
    });
    const claimed = await runJson(workspace, [
      "work",
      "claim",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--assignment",
      registered.assignments[0]?.assignmentId ?? "",
      "--revision",
      "1",
    ]);
    await runJson(workspace, [
      "attempt",
      "dispatch",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--attempt",
      claimed.json.data.attemptId,
      "--commit",
      await headCommit(workspace),
      "--worktree",
      producer.worktreePath,
    ]);

    const blocked = await close(workspace, producer.ownerToken, producer.attemptId);

    expect(blocked.exitCode).toBe(3);
    expect(reasons(blocked)).toEqual(["checkout_in_use"]);
    expect(blocked.json.blockers[0].attemptIds).toEqual([claimed.json.data.attemptId]);
  });

  test("refuses to act when the launch recorded no Herdr pane", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);
    damageDispatch(workspace, producer.attemptId, "pane_id", null);

    const blocked = await close(workspace, producer.ownerToken, producer.attemptId);

    expect(blocked.exitCode).toBe(3);
    expect(reasons(blocked)).toEqual(["workspace_handle_missing"]);
    expect(blocked.json.blockers[0].missing).toEqual(["pane"]);
  });

  test("refuses a host this release cannot stop, before it reads anything else", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);
    await Bun.write(`${producer.worktreePath}/notes.md`, "a human edit\n");
    damageDispatch(workspace, producer.attemptId, "agent_host", "gemini");

    const blocked = await close(workspace, producer.ownerToken, producer.attemptId);

    expect(blocked.exitCode).toBe(3);
    // The host decides which paths Operator wrote, so nothing else is read until it is known.
    expect(reasons(blocked)).toEqual(["host_unsupported"]);
    expect(blocked.json.blockers[0].host).toBe("gemini");
  });

  test("retains the process when Herdr cannot say who occupies the workspace", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);
    await Bun.write(`${workspace.herdr}/agent-list.error`, "socket_unavailable");

    const blocked = await close(workspace, producer.ownerToken, producer.attemptId);

    expect(blocked.exitCode).toBe(3);
    expect(reasons(blocked)).toEqual(["occupancy_unknown"]);
  });
});

describe("operator cleanup remove", () => {
  test("refuses a withdrawn checkout that holds its commit, and lists it as unlanded", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace, undefined, {
      dependents: [
        {
          key: "22.2",
          kind: "production",
          title: "Other work",
          dependsOn: [],
          writePaths: ["src/"],
        },
      ],
    });
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    await submit(workspace, producer, submissionBody(producer, artifact));
    const { registered } = await withdrawIssues(workspaceTarget(workspace), producer.ownerToken, {
      sourceKind: "specification",
      parent: 15,
      numbers: [1501],
    });
    expect(registered.exitCode).toBe(0);

    const closed = await close(workspace, producer.ownerToken, producer.attemptId);
    expect(closed.json.reason).toBe("process_closed");

    // Only the person removes a checkout that holds unlanded work, so none is offered.
    const next = await nextActions(workspace);
    expect(
      next.forAction("remove_worktree").filter((one) => one.attemptId === producer.attemptId),
    ).toEqual([]);
    const blocked = await remove(workspace, producer.ownerToken, producer.attemptId);
    expect(blocked.exitCode).toBe(3);
    expect(blocked.json.blockers).toEqual([
      {
        reason: "unlanded_work",
        assignmentId: producer.assignmentId,
        cause: "withdrawn",
        commits: [artifact.commit],
      },
    ]);

    const shown = await runJson(workspace, ["cleanup", "show"]);
    expect(shown.json.data.unlanded).toEqual([
      {
        attemptId: producer.attemptId,
        assignmentId: producer.assignmentId,
        worktreePath: producer.worktreePath,
        branch: producer.dispatched.data.branch,
        commit: artifact.commit,
        cause: "withdrawn",
      },
    ]);
  });

  test("offers the removal of a withdrawn checkout that holds no commit, behind an approval", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace, undefined, {
      dependents: [
        {
          key: "22.2",
          kind: "production",
          title: "Other work",
          dependsOn: [],
          writePaths: ["src/"],
        },
      ],
    });
    // A non-code result hands over no commit, so the withdrawn checkout holds no unlanded work.
    const text = "The findings.";
    const artifact = { path: "unused", identity: "unused", commit: producer.baseCommit };
    const submitted = await submit(workspace, producer, {
      ...submissionBody(producer, artifact, { resultKind: "non-code", code: null }),
      artifacts: [{ name: "result", kind: "value", value: text, contentIdentity: null }],
    });
    expect(submitted.json.reason).toBe("result_submitted");
    const { registered } = await withdrawIssues(workspaceTarget(workspace), producer.ownerToken, {
      sourceKind: "specification",
      parent: 15,
      numbers: [1501],
    });
    expect(registered.exitCode).toBe(0);

    const closed = await close(workspace, producer.ownerToken, producer.attemptId);
    expect(closed.json.reason).toBe("process_closed");

    const next = await nextActions(workspace);
    expect(
      next.forAction("remove_worktree").filter((one) => one.attemptId === producer.attemptId),
    ).toHaveLength(1);
    const unapproved = await remove(workspace, producer.ownerToken, producer.attemptId);
    expect(unapproved.exitCode).toBe(3);
    expect(reasons(unapproved)).toEqual(["approval_required", "approval_required"]);
    const shown = await runJson(workspace, ["cleanup", "show"]);
    expect(shown.json.data.unlanded).toEqual([]);
  });

  test("removes an approved checkout with no remote, and keeps its evidence and branch", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);
    const closed = await close(workspace, producer.ownerToken, producer.attemptId);
    expect(closed.json.reason).toBe("process_closed");
    // The proof reads no remote, so a project with none removes a checkout of landed work.
    expect((await Bun.$`git -C ${workspace.repo} remote`.text()).trim()).toBe("");

    const unapproved = await remove(workspace, producer.ownerToken, producer.attemptId);
    expect(unapproved.exitCode).toBe(3);
    expect(reasons(unapproved)).toEqual(["approval_required", "approval_required"]);
    // A person may approve this one cleanup, or the whole workflow. Both are offered by name.
    expect(unapproved.json.blockers.map((one: Blocker) => one.scope)).toEqual([
      "cleanup",
      "workflow",
    ]);
    expect(unapproved.json.blockers[0].targets).toEqual([producer.worktreePath]);

    await grantRemoval(workspace, producer.ownerToken, unapproved.json.blockers[0]);
    const listsBefore = await worktreeLists(workspace);
    const removed = await remove(workspace, producer.ownerToken, producer.attemptId);

    expect(removed.exitCode).toBe(0);
    expect(removed.json.reason).toBe("worktree_removed");
    // A new removal reads the checkout from Herdr for its inspection and for its identity, and
    // never asks Herdr again to recover an effect that this same run just opened.
    expect((await worktreeLists(workspace)) - listsBefore).toBe(2);
    expect(await Bun.file(`${producer.worktreePath}/README.md`).exists()).toBe(false);

    // The evidence outlives the checkout, and nothing else the crew owns is touched.
    const brief = await Bun.file(
      `${workspace.repo}/${closed.json.data.evidence[0].storedPath}`,
    ).text();
    expect(brief).toContain(`Operative brief for attempt ${producer.attemptId}`);
    const branches = await Bun.$`git -C ${workspace.repo} branch --list`.quiet();
    expect(branches.stdout.toString()).toContain("operator/");

    // The two effects are the supported host stop and an unforced worktree removal.
    const calls = await herdrCalls(workspace);
    expect(calls.filter((line) => line.startsWith("worktree remove"))).toEqual([
      "worktree remove --workspace w1 ",
    ]);
    expect(calls.some((line) => line.includes("--force"))).toBe(false);
    expect(calls.some((line) => line.startsWith("workspace close"))).toBe(false);
    expect(calls.some((line) => line.startsWith("pane close"))).toBe(false);

    // The evidence store holds the named inventory and nothing else, so no credential and no
    // lock data is archived beside it.
    const stored = await Array.fromAsync(
      new Bun.Glob("**/*").scan({
        cwd: `${workspace.repo}/.operator/local/evidence/${producer.attemptId}`,
        onlyFiles: true,
      }),
    );
    expect(stored.toSorted()).toEqual(["brief", "control-reference", "release"]);
  });

  test("retains a checkout that holds ignored files, and names only the first of them", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);
    expect((await close(workspace, producer.ownerToken, producer.attemptId)).json.reason).toBe(
      "process_closed",
    );
    await writeInstallOutput(producer.worktreePath, 30);
    await Bun.write(`${producer.worktreePath}/scratch.tmp`, "an ignored file\n");

    const blocked = await remove(workspace, producer.ownerToken, producer.attemptId);

    expect(blocked.exitCode).toBe(3);
    const files = blocked.json.blockers.find((one: Blocker) => one.reason === "unexpected_files");
    expect(files.paths).toHaveLength(20);
    expect(files.omitted).toBe(11);
  });

  test("refuses a removal while the process closure is not recorded as done", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);

    const blocked = await remove(workspace, producer.ownerToken, producer.attemptId);

    expect(blocked.exitCode).toBe(3);
    expect(reasons(blocked)).toEqual(["process_live"]);
    expect(blocked.json.blockers[0].state).toBe("none");
  });

  test("refuses a removal of a result that was never accepted", async () => {
    const workspace = await makeWorkspace();
    const { producer, reviewer } = await acceptedCycle(workspace);
    const closed = await close(workspace, producer.ownerToken, reviewer.attemptId);
    expect(closed.json.reason).toBe("process_closed");

    const blocked = await remove(workspace, producer.ownerToken, reviewer.attemptId);

    expect(blocked.exitCode).toBe(3);
    expect(reasons(blocked)).toEqual(["assignment_not_accepted"]);
    expect(blocked.json.blockers[0].state).toBe("claimed");
  });

  test("a revoked approval covers nothing", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);
    await close(workspace, producer.ownerToken, producer.attemptId);

    const asked = await remove(workspace, producer.ownerToken, producer.attemptId);
    const granted = await grantRemoval(workspace, producer.ownerToken, asked.json.blockers[0]);
    await runJson(workspace, [
      "approval",
      "revoke",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--approval",
      granted.json.data.approvalId,
      "--revision",
      String(granted.json.data.revision),
    ]);

    const blocked = await remove(workspace, producer.ownerToken, producer.attemptId);

    expect(blocked.exitCode).toBe(3);
    expect(reasons(blocked)).toEqual(["approval_revoked"]);
    expect((await herdrCalls(workspace)).some((line) => line.startsWith("worktree remove"))).toBe(
      false,
    );
  });

  test("a workflow approval stops covering once the crew changes owner", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);
    await close(workspace, producer.ownerToken, producer.attemptId);

    const asked = await remove(workspace, producer.ownerToken, producer.attemptId);
    const workflow = asked.json.blockers[1];
    expect(workflow.scope).toBe("workflow");
    await grantRemoval(
      workspace,
      producer.ownerToken,
      workflow,
      "Remove this workflow's checkouts.",
    );

    const frontier = await runJson(workspace, ["work", "frontier"]);
    const taken = await runJson(workspace, [
      "crew",
      "own",
      "--request",
      request(),
      "--owner-label",
      "second-session",
      "--takeover",
      "--ownership-revision",
      String(frontier.json.data.ownership.revision),
    ]);
    expect(taken.exitCode).toBe(0);

    const blocked = await remove(workspace, taken.json.data.ownerToken, producer.attemptId);

    expect(blocked.exitCode).toBe(3);
    expect(reasons(blocked)).toEqual(["approval_required", "approval_required"]);
    expect(blocked.json.blockers[1].requestRevision).not.toBe(workflow.requestRevision);
  });

  test("refuses a removal whose preserved evidence is gone", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);
    const closed = await close(workspace, producer.ownerToken, producer.attemptId);
    await rm(`${workspace.repo}/${closed.json.data.evidence[0].storedPath}`);

    const blocked = await remove(workspace, producer.ownerToken, producer.attemptId);

    expect(blocked.exitCode).toBe(3);
    expect(reasons(blocked)).toEqual(["preservation_failed"]);
    expect(blocked.json.blockers[0].name).toBe("brief");
  });

  test("refuses a removal when the checkout names another attempt", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);
    await close(workspace, producer.ownerToken, producer.attemptId);

    const reference = `${producer.worktreePath}/.operator/local/attempt.json`;
    const held = JSON.parse(await Bun.file(reference).text());
    await Bun.write(reference, JSON.stringify({ ...held, attemptId: "another-attempt" }));

    const blocked = await remove(workspace, producer.ownerToken, producer.attemptId);

    expect(blocked.exitCode).toBe(3);
    expect(reasons(blocked)).toEqual(["identity_mismatch"]);
    expect(blocked.json.blockers[0].mismatches).toEqual([
      { field: "attempt", recorded: producer.attemptId, found: "another-attempt" },
    ]);
    expect((await herdrCalls(workspace)).some((line) => line.startsWith("worktree remove"))).toBe(
      false,
    );
  });

  test("refuses a removal when Herdr names no workspace or branch for the checkout", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);
    await close(workspace, producer.ownerToken, producer.attemptId);
    const asked = await remove(workspace, producer.ownerToken, producer.attemptId);
    await grantRemoval(workspace, producer.ownerToken, asked.json.blockers[0]);
    // Herdr answers with a record that omits the handles a removal would have to act on.
    await Bun.write(`${workspace.herdr}/worktree-handles-missing`, "");

    const blocked = await remove(workspace, producer.ownerToken, producer.attemptId);

    expect(blocked.exitCode).toBe(3);
    expect(reasons(blocked)).toEqual(["identity_mismatch"]);
    expect(blocked.json.blockers[0].mismatches).toEqual([
      { field: "workspace", recorded: "w1", found: "none" },
      {
        field: "branch",
        recorded: `operator/operator-1501-${producer.attemptId.slice(0, 8)}`,
        found: "none",
      },
    ]);
    // Nothing is removed against a handle Herdr never confirmed.
    expect((await herdrCalls(workspace)).some((line) => line.startsWith("worktree remove"))).toBe(
      false,
    );
  });

  test("refuses a checkout Herdr does not hold", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);
    await close(workspace, producer.ownerToken, producer.attemptId);
    await rm(`${workspace.herdr}/worktrees`);

    const blocked = await remove(workspace, producer.ownerToken, producer.attemptId);

    expect(blocked.exitCode).toBe(3);
    expect(reasons(blocked)).toEqual(["unrelated_resource"]);
    expect((await herdrCalls(workspace)).some((line) => line.startsWith("worktree remove"))).toBe(
      false,
    );
  });

  test("settles a removal whose answer was lost from what Herdr shows", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);
    await close(workspace, producer.ownerToken, producer.attemptId);
    const asked = await remove(workspace, producer.ownerToken, producer.attemptId);
    await grantRemoval(workspace, producer.ownerToken, asked.json.blockers[0]);
    await Bun.write(`${workspace.herdr}/worktree-remove.lost`, "");

    const uncertain = await remove(workspace, producer.ownerToken, producer.attemptId);
    expect(uncertain.exitCode).toBe(5);
    expect(uncertain.json.reason).toBe("cleanup_uncertain");

    await rm(`${workspace.herdr}/worktree-remove.lost`);
    const settled = await remove(workspace, producer.ownerToken, producer.attemptId);

    expect(settled.exitCode).toBe(0);
    expect(settled.json.reason).toBe("worktree_removed");
    // The effect had already landed, so the second run settles it instead of asking again.
    expect(
      (await herdrCalls(workspace)).filter((line) => line.startsWith("worktree remove")),
    ).toHaveLength(1);
  });

  test("blocks a lost removal while Herdr cannot say whether the checkout is gone", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);
    await close(workspace, producer.ownerToken, producer.attemptId);
    const asked = await remove(workspace, producer.ownerToken, producer.attemptId);
    await grantRemoval(workspace, producer.ownerToken, asked.json.blockers[0]);
    await Bun.write(`${workspace.herdr}/worktree-remove.lost`, "");
    const uncertain = await remove(workspace, producer.ownerToken, producer.attemptId);
    expect(uncertain.json.reason).toBe("cleanup_uncertain");

    await rm(`${workspace.herdr}/worktree-remove.lost`);
    await Bun.write(`${workspace.herdr}/worktree-list.error`, "server_busy");
    const blocked = await remove(workspace, producer.ownerToken, producer.attemptId);

    expect(blocked.exitCode).toBe(3);
    expect(blocked.json.blockers).toEqual([
      { reason: "checkout_unknown", detail: "server_busy: the fake refused" },
    ]);
    // A removal this run did not open is recovered, never sent a second time.
    expect(
      (await herdrCalls(workspace)).filter((line) => line.startsWith("worktree remove")),
    ).toHaveLength(1);
  });

  test("refuses a new removal while Herdr cannot list the checkout", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);
    await close(workspace, producer.ownerToken, producer.attemptId);
    const asked = await remove(workspace, producer.ownerToken, producer.attemptId);
    await grantRemoval(workspace, producer.ownerToken, asked.json.blockers[0]);
    await Bun.write(`${workspace.herdr}/worktree-list.error`, "server_busy");

    const blocked = await remove(workspace, producer.ownerToken, producer.attemptId);

    expect(blocked.exitCode).toBe(3);
    expect(blocked.json.blockers).toEqual([
      { reason: "checkout_unknown", detail: "server_busy: the fake refused" },
    ]);
    expect((await herdrCalls(workspace)).some((line) => line.startsWith("worktree remove"))).toBe(
      false,
    );
  });
});

/** The integration branch of the fixture source, as the first code dispatch named it. */
async function integrationBranch(workspace: Workspace): Promise<string> {
  const format = "--format=%(refname:short)";
  const listed =
    await Bun.$`git -C ${workspace.repo} for-each-ref ${format} refs/heads/operator/integration/`.text();
  const name = listed.trim().split("\n")[0];
  if (name === undefined || name === "") {
    throw new Error("the fixture source has no integration branch");
  }
  return name;
}

/** Commits as a person would, in one checkout, after the Operative handed its work over. */
async function commitAfter(worktreePath: string): Promise<string> {
  await Bun.$`git -C ${worktreePath} -c user.email=t@example.com -c user.name=Test commit -q --allow-empty -m later`.quiet();
  return (await Bun.$`git -C ${worktreePath} rev-parse HEAD`.text()).trim();
}

const SIBLING = { key: "22.2", kind: "production" as const, title: "Write the notes" };

/** Two items of one source, each with a reviewed result, so the second lands as a merge. */
async function twoReviewedResults(workspace: Workspace) {
  const producer = await startProducer(workspace, undefined, {
    dependents: [{ ...SIBLING, dependsOn: [], writePaths: ["notes/"] }],
  });
  const sibling = await startSibling(workspace, producer, SIBLING.key);
  const reviewed = async (one: typeof producer, text: string, path: string) => {
    const artifact = await commitArtifact(workspace, one, text, path);
    const submitted = await submit(workspace, one, submissionBody(one, artifact));
    const reviewer = await startReviewer(workspace, one, submitted.json, artifact.commit);
    await reportReview(
      workspace,
      reviewer,
      submitted.json.data.reviewId,
      reportBody({ submissionIdentity: submitted.json.data.identity, host: workspace.host }),
    );
    return {
      artifact,
      submissionId: submitted.json.data.submissionId as string,
      revision: submitted.json.data.revision as number,
    };
  };
  const first = await reviewed(producer, "# Result\n", "docs/result.md");
  const second = await reviewed(sibling, "# Notes\n", "notes/notes.md");
  return { producer, sibling, first, second };
}

describe("removal proves the result from the integration branch", () => {
  test("refuses a checkout with a commit after the submission, and names both heads", async () => {
    const workspace = await makeWorkspace();
    const { producer, artifact } = await acceptedCycle(workspace);
    await close(workspace, producer.ownerToken, producer.attemptId);
    const later = await commitAfter(producer.worktreePath);

    const blocked = await remove(workspace, producer.ownerToken, producer.attemptId);

    expect(blocked.exitCode).toBe(3);
    expect(blocked.json.blockers).toEqual([
      {
        reason: "head_moved",
        branch: producer.dispatched.data.branch,
        commit: artifact.commit,
        foundBranch: producer.dispatched.data.branch,
        foundHead: later,
      },
    ]);
  });

  test("refuses a checkout with a detached HEAD, even at the submitted commit", async () => {
    const workspace = await makeWorkspace();
    const { producer, artifact } = await acceptedCycle(workspace);
    await close(workspace, producer.ownerToken, producer.attemptId);
    await Bun.$`git -C ${producer.worktreePath} checkout -q --detach`.quiet();

    const blocked = await remove(workspace, producer.ownerToken, producer.attemptId);

    expect(blocked.json.blockers).toEqual([
      {
        reason: "head_moved",
        branch: producer.dispatched.data.branch,
        commit: artifact.commit,
        foundBranch: null,
        foundHead: artifact.commit,
      },
    ]);
  });

  test("a review checkout passes at its dispatch base, and a later commit there refuses", async () => {
    const workspace = await makeWorkspace();
    const { producer, reviewer, submitted, artifact } = await acceptedCycle(workspace);
    const reviewAccepted = await acceptReview(workspace, producer, {
      reviewAssignmentId: submitted.json.data.reviewAssignmentId,
      attemptId: reviewer.attemptId,
      revision: reviewer.revision,
    });
    expect(reviewAccepted.json.reason).toBe("assignment_accepted");
    await close(workspace, producer.ownerToken, reviewer.attemptId);

    const proven = await remove(workspace, producer.ownerToken, reviewer.attemptId);
    expect(reasons(proven)).toEqual(["approval_required", "approval_required"]);

    const later = await commitAfter(reviewer.worktreePath);
    const blocked = await remove(workspace, producer.ownerToken, reviewer.attemptId);
    expect(blocked.json.blockers).toEqual([
      {
        reason: "head_moved",
        branch: reviewer.dispatched.json.data.branch,
        commit: artifact.commit,
        foundBranch: reviewer.dispatched.json.data.branch,
        foundHead: later,
      },
    ]);
  });

  test("a merge landing passes from the new commit that carries the result", async () => {
    const workspace = await makeWorkspace();
    const { producer, sibling, first, second } = await twoReviewedResults(workspace);
    expect((await acceptProduction(workspace, producer, first)).json.reason).toBe(
      "assignment_accepted",
    );
    const merged = await acceptProduction(workspace, sibling, second);
    expect(merged.json.data.landing.kind).toBe("merge");
    expect(merged.json.data.landing.landed).not.toBe(second.artifact.commit);
    await close(workspace, producer.ownerToken, sibling.attemptId);

    const proven = await remove(workspace, producer.ownerToken, sibling.attemptId);

    expect(reasons(proven)).toEqual(["approval_required", "approval_required"]);
  });

  test("refuses while a landing of the same source has no recorded outcome", async () => {
    const workspace = await makeWorkspace();
    const { producer, sibling, first, second } = await twoReviewedResults(workspace);
    await acceptProduction(workspace, producer, first);
    const branch = await integrationBranch(workspace);
    // A lock file stops every ref write of Git, so the move fails after its intent is recorded.
    const lock = `${workspace.repo}/.git/refs/heads/${branch}.lock`;
    await Bun.write(lock, "");
    const stopped = await acceptProduction(workspace, sibling, second);
    expect(stopped.json.reason).toBe("integration_branch_unread");
    await rm(lock);
    await close(workspace, producer.ownerToken, producer.attemptId);

    const blocked = await remove(workspace, producer.ownerToken, producer.attemptId);

    expect(reasons(blocked)).toEqual(["landing_pending"]);
    expect(blocked.json.blockers[0].pendingAssignmentId).toBe(sibling.assignmentId);
  });

  test("refuses a branch away from its recorded tip, even when it still holds the commit", async () => {
    const workspace = await makeWorkspace();
    const { producer, artifact } = await acceptedCycle(workspace);
    await close(workspace, producer.ownerToken, producer.attemptId);
    const branch = await integrationBranch(workspace);
    // A person adds a commit on top of the landed one, so the branch still contains it.
    const tree = `${artifact.commit}^{tree}`;
    const later = (
      await Bun.$`git -C ${workspace.repo} -c user.email=t@example.com -c user.name=Test commit-tree -p ${artifact.commit} -m person ${tree}`.text()
    ).trim();
    await Bun.$`git -C ${workspace.repo} update-ref ${`refs/heads/${branch}`} ${later}`.quiet();

    const blocked = await remove(workspace, producer.ownerToken, producer.attemptId);

    expect(blocked.json.blockers).toEqual([
      { reason: "integration_branch_moved", branch, recordedTip: artifact.commit, found: later },
    ]);
  });

  test("refuses a deleted integration branch, and falls back to no other ref", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);
    await close(workspace, producer.ownerToken, producer.attemptId);
    const branch = await integrationBranch(workspace);
    await Bun.$`git -C ${workspace.repo} update-ref -d ${`refs/heads/${branch}`}`.quiet();

    const blocked = await remove(workspace, producer.ownerToken, producer.attemptId);

    expect(blocked.json.blockers).toEqual([{ reason: "integration_branch_missing", branch }]);
  });

  test("refuses a replaced commit after its replacement lands, and lists it as unlanded", async () => {
    const workspace = await makeWorkspace();
    const producer = await startProducer(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact));
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);
    const reported = await reportReview(
      workspace,
      reviewer,
      submitted.json.data.reviewId,
      reportBody({
        submissionIdentity: submitted.json.data.identity,
        host: workspace.host,
        standardsFindings: [
          {
            key: "missing-gate",
            severity: "blocker",
            summary: "The result does not state the gate it passed.",
            evidence: "docs/result.md:1",
          },
        ],
      }),
    );
    await disposeFindings(workspace, producer, submitted.json.data.reviewId, [
      {
        findingId: reported.json.data.findings[0].findingId,
        disposition: "corrected",
        reason: "The requirement names the gate, so the result must state it.",
      },
    ]);
    await acceptReview(workspace, producer, {
      reviewAssignmentId: submitted.json.data.reviewAssignmentId,
      attemptId: reviewer.attemptId,
      revision: reviewer.revision,
    });
    const delegated = await delegateRework(workspace, producer, {
      revision: submitted.json.data.revision,
      body: { reason: "findings", reviewId: submitted.json.data.reviewId, conflicts: [] },
    });
    const reworked = await startRework(workspace, producer, {
      revision: delegated.json.data.revision,
      commit: artifact.commit,
      worktreePath: `${workspace.root}/rework`,
    });
    const revised = await commitArtifact(workspace, reworked, "# Result\n\nThe gate passed.\n");
    const resubmitted = await submit(
      workspace,
      reworked,
      submissionBody(reworked, revised, { assignmentRevision: reworked.assignmentRevision }),
    );
    const secondReviewer = await startReviewer(
      workspace,
      producer,
      resubmitted.json,
      revised.commit,
    );
    await reportReview(
      workspace,
      secondReviewer,
      resubmitted.json.data.reviewId,
      reportBody({ submissionIdentity: resubmitted.json.data.identity, host: workspace.host }),
    );
    const accepted = await acceptProduction(workspace, reworked, {
      submissionId: resubmitted.json.data.submissionId,
      revision: resubmitted.json.data.revision,
    });
    expect(accepted.json.reason).toBe("assignment_accepted");
    expect((await close(workspace, producer.ownerToken, producer.attemptId)).json.reason).toBe(
      "process_closed",
    );
    await close(workspace, producer.ownerToken, reworked.attemptId);

    // The replacement landed, so its own checkout passes the proof.
    const replacement = await remove(workspace, producer.ownerToken, reworked.attemptId);
    expect(reasons(replacement)).toEqual(["approval_required", "approval_required"]);

    // The replaced commit is on no integration branch, so only the person removes it (D3).
    const next = await nextActions(workspace);
    expect(
      next.forAction("remove_worktree").filter((one) => one.attemptId === producer.attemptId),
    ).toEqual([]);
    const blocked = await remove(workspace, producer.ownerToken, producer.attemptId);
    expect(blocked.json.blockers).toEqual([
      {
        reason: "unlanded_work",
        assignmentId: producer.assignmentId,
        cause: "replaced",
        commits: [artifact.commit],
      },
    ]);
    const shown = await runJson(workspace, ["cleanup", "show"]);
    expect(shown.json.data.unlanded).toEqual([
      {
        attemptId: producer.attemptId,
        assignmentId: producer.assignmentId,
        worktreePath: producer.worktreePath,
        branch: producer.dispatched.data.branch,
        commit: artifact.commit,
        cause: "replaced",
      },
    ]);
  });
});

describe("interrupted cleanups", () => {
  test("recovers a closure whose Operator died between the intent and the stop", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);
    await Bun.write(`${workspace.herdr}/agent-send-keys.kill`, "");

    // The killed run answers nothing at all, so it is read as a process rather than as JSON.
    const killed = await runOperator(workspace, [
      "cleanup",
      "close",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--attempt",
      producer.attemptId,
      "--json",
    ]);
    expect(killed.exitCode).not.toBe(0);
    expect(killed.stdout).toBe("");

    // The intent outlived the process that wrote it, and nothing was stopped.
    const pending = await runJson(workspace, ["cleanup", "show", "--attempt", producer.attemptId]);
    expect(pending.json.data.cleanups).toHaveLength(1);
    expect(pending.json.data.cleanups[0].state).toBe("pending");
    expect(pending.json.data.cleanups[0].settledAt).toBeNull();

    await rm(`${workspace.herdr}/agent-send-keys.kill`);
    const recovered = await close(workspace, producer.ownerToken, producer.attemptId);

    expect(recovered.exitCode).toBe(0);
    expect(recovered.json.reason).toBe("process_closed");
    const settled = await runJson(workspace, ["cleanup", "show", "--attempt", producer.attemptId]);
    // The recovery settles the effect the dead run opened rather than opening a second one.
    expect(settled.json.data.cleanups).toHaveLength(1);
    expect(settled.json.data.cleanups[0].state).toBe("done");
  });

  test("records a failed removal when Herdr reports success and the checkout stays", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);
    await close(workspace, producer.ownerToken, producer.attemptId);
    const asked = await remove(workspace, producer.ownerToken, producer.attemptId);
    await grantRemoval(workspace, producer.ownerToken, asked.json.blockers[0]);
    await Bun.write(`${workspace.herdr}/pretend-removed`, "");

    const failed = await remove(workspace, producer.ownerToken, producer.attemptId);

    expect(failed.exitCode).toBe(1);
    expect(failed.json.reason).toBe("cleanup_failed");
    expect(await Bun.file(`${producer.worktreePath}/README.md`).exists()).toBe(true);

    // A failed cleanup stays visible, so the resource it still owns is not forgotten.
    const shown = await runJson(workspace, ["cleanup", "show", "--attempt", producer.attemptId]);
    const removal = shown.json.data.cleanups.find(
      (one: { kind: string }) => one.kind === "worktree_removal",
    );
    expect(removal.state).toBe("failed");
    expect(removal.settledAt).not.toBeNull();
  });
});

describe("retention holds and recorded cleanups", () => {
  test("a second hold reports the first, and a release needs a current hold", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);
    const hold = (reason: string) =>
      writeInput(workspace, { reason, detail: "The checkout is still being read." }).then(
        (inputPath) =>
          runJson(workspace, [
            "cleanup",
            "hold",
            "--request",
            request(),
            "--owner-token",
            producer.ownerToken,
            "--attempt",
            producer.attemptId,
            "--input",
            inputPath,
          ]),
      );
    const release = (revision: number) =>
      runJson(workspace, [
        "cleanup",
        "release",
        "--request",
        request(),
        "--owner-token",
        producer.ownerToken,
        "--attempt",
        producer.attemptId,
        "--revision",
        String(revision),
      ]);

    const first = await hold("first-reason");
    expect(first.json.reason).toBe("resources_held");
    const again = await hold("second-reason");
    expect(again.exitCode).toBe(0);
    expect(again.json.reason).toBe("resources_already_held");
    expect(again.json.blockers).toEqual([]);
    expect(again.json.data).toEqual({ ...first.json.data, repeated: false });

    const stale = await release(2);
    expect(stale.exitCode).toBe(4);
    expect(stale.json.reason).toBe("stale_revision");
    expect(stale.json.blockers).toEqual([
      { reason: "stale_revision", holdId: first.json.data.holdId, recordedRevision: 1 },
    ]);

    expect((await release(1)).json.reason).toBe("resources_released");
    const missing = await release(2);
    expect(missing.exitCode).toBe(3);
    expect(missing.json.reason).toBe("no_retention_hold");
    expect(missing.json.blockers).toEqual([
      { reason: "no_retention_hold", attemptId: producer.attemptId },
    ]);
  });

  test("a hold stops every cleanup and outlives the session that placed it", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);

    const held = await runJson(workspace, [
      "cleanup",
      "hold",
      "--request",
      request(),
      "--owner-token",
      producer.ownerToken,
      "--attempt",
      producer.attemptId,
      "--input",
      await writeInput(workspace, {
        reason: "open-investigation",
        detail: "The flaky test is still being diagnosed in this checkout.",
      }),
    ]);
    expect(held.exitCode).toBe(0);
    expect(held.json.reason).toBe("resources_held");

    const blocked = await close(workspace, producer.ownerToken, producer.attemptId);
    expect(reasons(blocked)).toEqual(["retention_hold"]);
    expect(blocked.json.blockers[0].holdReason).toBe("open-investigation");

    // A fresh Operator session reads the same hold, because it lives in the crew state.
    const frontier = await runJson(workspace, ["work", "frontier"]);
    const taken = await runJson(workspace, [
      "crew",
      "own",
      "--request",
      request(),
      "--owner-label",
      "second-session",
      "--takeover",
      "--ownership-revision",
      String(frontier.json.data.ownership.revision),
    ]);
    const ownerToken = taken.json.data.ownerToken;

    const shown = await runJson(workspace, ["cleanup", "show"]);
    expect(shown.json.data.holds).toHaveLength(1);
    expect(shown.json.data.holds[0].state).toBe("held");
    expect(shown.json.data.cleanups[0].state).toBe("blocked");
    expect(shown.json.data.cleanups[0].detail).toBe("retention_hold");

    const released = await runJson(workspace, [
      "cleanup",
      "release",
      "--request",
      request(),
      "--owner-token",
      ownerToken,
      "--attempt",
      producer.attemptId,
      "--revision",
      String(shown.json.data.holds[0].revision),
    ]);
    expect(released.exitCode).toBe(0);

    const closed = await close(workspace, ownerToken, producer.attemptId);
    expect(closed.exitCode).toBe(0);
    expect(closed.json.reason).toBe("process_closed");
  });

  test("reports one attempt's cleanups apart from the rest of the crew", async () => {
    const workspace = await makeWorkspace();
    const { producer, reviewer } = await acceptedCycle(workspace);
    await close(workspace, producer.ownerToken, producer.attemptId);
    await close(workspace, producer.ownerToken, reviewer.attemptId);

    const all = await runJson(workspace, ["cleanup", "show"]);
    expect(all.json.data.cleanups).toHaveLength(2);
    expect(all.json.data.cleanups.every((one: { state: string }) => one.state === "done")).toBe(
      true,
    );

    const one = await runJson(workspace, ["cleanup", "show", "--attempt", reviewer.attemptId]);
    expect(one.json.data.cleanups).toHaveLength(1);
    expect(one.json.data.cleanups[0].attemptId).toBe(reviewer.attemptId);
  });

  test("a closed process stays closed when the same request is sent again", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);
    await close(workspace, producer.ownerToken, producer.attemptId);

    const again = await close(workspace, producer.ownerToken, producer.attemptId);

    expect(again.exitCode).toBe(0);
    expect(again.json.reason).toBe("process_already_closed");
    expect(
      (await herdrCalls(workspace)).filter((line) => line.startsWith("agent send-keys")),
    ).toHaveLength(1);
  });
});
