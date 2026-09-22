import { afterEach, describe, expect, test } from "bun:test";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";
import {
  acceptProduction,
  commitArtifact,
  type Host,
  reportBody,
  reportReview,
  startProducer,
  startReviewer,
  submissionBody,
  submit,
  writeInput,
  type Workspace,
} from "./review-cycle-fixture.ts";
import {
  headCommit,
  herdrCalls,
  requestId as request,
  runJson,
  workspaces,
} from "./workspace-fixture.ts";

const fixtures = workspaces();

afterEach(async () => {
  await fixtures.removeAll();
});

// A configured project ignores what Operator writes into a checkout, and `*.tmp` gives the
// tests one ignored path that Operator never wrote.
const IGNORE_RULES = [".operator/", ".claude/skills/", ".agents/skills/", "*.tmp", ""].join("\n");

const SKILL_PATH: Record<Host, string> = {
  "claude-code": ".claude/skills/code-review/SKILL.md",
  opencode: ".agents/skills/code-review/SKILL.md",
};

/** A fixture project with a remote, so a cleanup can prove where the commits also live. */
async function makeWorkspace(options: { host?: Host } = {}): Promise<Workspace> {
  const host = options.host ?? "claude-code";
  const fixture = await fixtures.make({
    config: { crew: { host } },
    files: { ".gitignore": IGNORE_RULES },
  });

  // The ignore rules cover the skills Operator installs, so the review skill this project owns
  // is committed on its own, exactly as a configured project keeps it.
  await Bun.write(`${fixture.repo}/${SKILL_PATH[host]}`, "---\nname: code-review\n---\n");
  await Bun.$`git -C ${fixture.repo} add -f ${SKILL_PATH[host]}`.quiet();
  await Bun.$`git -C ${fixture.repo} -c user.email=t@example.com -c user.name=Test commit -q -m skill`.quiet();

  await Bun.$`git init --bare -b main ${fixture.root}/remote.git`.quiet();
  await Bun.$`git -C ${fixture.repo} remote add origin ${fixture.root}/remote.git`.quiet();
  return { ...fixture, host };
}

/** One production assignment carried to accepted completion, with a reviewed result. */
async function acceptedCycle(workspace: Workspace) {
  const producer = await startProducer(workspace);
  const base = await headCommit(workspace);
  const artifact = await commitArtifact(workspace, producer, "# Result\n\nThe finished work.\n");
  const submitted = await submit(workspace, producer, submissionBody(producer, artifact, base));
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
    prHead: artifact.commit,
  });
  expect(accepted.json.reason).toBe("assignment_accepted");

  return { producer, reviewer, submitted, artifact };
}

/** Publishes the Operative branch, which is what removal reads as remote preservation. */
async function pushWork(worktreePath: string): Promise<void> {
  await Bun.$`git -C ${worktreePath} push -q -u origin HEAD`.quiet();
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

function reasons(result: { json: { blockers: Blocker[] } }): string[] {
  return result.json.blockers.map((one) => one.reason);
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

  test("refuses to close an Operative that handed nothing over and still waits on an answer", async () => {
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
    expect(reasons(blocked)).toEqual(["handoff_missing", "question_open"]);
    expect((await herdrCalls(workspace)).some((line) => line.startsWith("agent send-keys"))).toBe(
      false,
    );
  });

  test("retains the process when the checkout holds work or files nobody registered", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);
    await Bun.write(`${producer.worktreePath}/notes.md`, "a human edit\n");
    await Bun.write(`${producer.worktreePath}/scratch.tmp`, "an ignored file\n");

    const blocked = await close(workspace, producer.ownerToken, producer.attemptId);

    expect(blocked.exitCode).toBe(3);
    expect(reasons(blocked)).toEqual(["unexpected_work", "unexpected_files"]);
    expect(blocked.json.blockers[0].paths).toEqual(["notes.md"]);
    expect(blocked.json.blockers[1].paths).toEqual(["scratch.tmp"]);
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

describe("operator cleanup remove", () => {
  test("removes an approved checkout and keeps its evidence, branch, and remote work", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);
    await pushWork(producer.worktreePath);
    const closed = await close(workspace, producer.ownerToken, producer.attemptId);
    expect(closed.json.reason).toBe("process_closed");

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
    const removed = await remove(workspace, producer.ownerToken, producer.attemptId);

    expect(removed.exitCode).toBe(0);
    expect(removed.json.reason).toBe("worktree_removed");
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

  test("refuses a removal while the process closure is not recorded as done", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);
    await pushWork(producer.worktreePath);

    const blocked = await remove(workspace, producer.ownerToken, producer.attemptId);

    expect(blocked.exitCode).toBe(3);
    expect(reasons(blocked)).toEqual(["process_live"]);
    expect(blocked.json.blockers[0].state).toBe("none");
  });

  test("refuses a removal of commits no remote keeps", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);
    await close(workspace, producer.ownerToken, producer.attemptId);

    const blocked = await remove(workspace, producer.ownerToken, producer.attemptId);

    expect(blocked.exitCode).toBe(3);
    expect(reasons(blocked)).toEqual(["unpushed_commits"]);
    expect(blocked.json.blockers[0].commits).toHaveLength(1);
  });

  test("refuses a removal of a result that was never accepted", async () => {
    const workspace = await makeWorkspace();
    const { producer, reviewer } = await acceptedCycle(workspace);
    const closed = await close(workspace, producer.ownerToken, reviewer.attemptId);
    expect(closed.json.reason).toBe("process_closed");

    const blocked = await remove(workspace, producer.ownerToken, reviewer.attemptId);

    expect(blocked.exitCode).toBe(3);
    expect(reasons(blocked)).toEqual(["not_accepted"]);
    expect(blocked.json.blockers[0].state).toBe("claimed");
  });

  test("a revoked approval covers nothing", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);
    await pushWork(producer.worktreePath);
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
    await pushWork(producer.worktreePath);
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
    await pushWork(producer.worktreePath);
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
    await pushWork(producer.worktreePath);
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
    await pushWork(producer.worktreePath);
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
        recorded: `operator/22-1-${producer.attemptId.slice(0, 8)}`,
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
    await pushWork(producer.worktreePath);
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
    await pushWork(producer.worktreePath);
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
});

describe("retention holds and recorded cleanups", () => {
  test("a hold stops every cleanup and outlives the session that placed it", async () => {
    const workspace = await makeWorkspace();
    const { producer } = await acceptedCycle(workspace);
    await pushWork(producer.worktreePath);

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
