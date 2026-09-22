import { afterEach, describe, expect, test } from "bun:test";
import {
  ACTOR,
  amendmentBody,
  completionBody,
  githubState,
  grantAdditionalWrite,
  makeTrackerWorkspace,
  MAP_BASELINE_IDENTITY,
  MAP_ISSUE,
  readMap,
  recordStep,
  recoverStep,
  REPOSITORY,
  resolutionBody,
  setFault,
  showSteps,
  TICKET,
  type TrackerWorkspace,
  writeGithubState,
} from "./tracker-fixture.ts";
import { githubCalls, workspaces } from "./workspace-fixture.ts";

const fixtures = workspaces();

afterEach(async () => {
  await fixtures.removeAll();
});

async function makeWorkspace(
  options: { mapIssue?: number | null; trackerIssue?: number | null } = {},
) {
  return makeTrackerWorkspace(fixtures, options);
}

/** The comments the tracker holds for one issue, in the order it holds them. */
async function commentsOn(workspace: TrackerWorkspace, issue: number) {
  return (await githubState(workspace)).comments[String(issue)] ?? [];
}

describe("operator tracker record", () => {
  test("records a resolution comment and verifies it from the tracker", async () => {
    const workspace = await makeWorkspace();

    const recorded = await recordStep(workspace, { input: resolutionBody() });

    expect(recorded.exitCode).toBe(0);
    expect(recorded.json.reason).toBe("tracker.completed");
    expect(recorded.json.data.state).toBe("verified");
    expect(recorded.json.data.step).toBe("resolution");
    expect(recorded.json.data.expectedActor).toBe(ACTOR);
    expect(recorded.json.data.target).toEqual({ repository: REPOSITORY, issue: TICKET });
    expect(recorded.json.data.resourceId).toBe("1");
    expect(recorded.json.data.resourceUrl).toContain("#issuecomment-1");
    expect(recorded.json.data.writeAttempts).toHaveLength(1);
    expect(recorded.json.data.writeAttempts[0].state).toBe("succeeded");

    // The comment carries the logical operation marker, so recovery can find it again.
    const comments = await commentsOn(workspace, TICKET);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toStartWith(
      `<!-- operator:tracker-operation:v1 ${recorded.json.data.operationId} -->`,
    );
    expect(comments[0]?.body).toContain("The work is complete and reviewed.");

    // The observation reads the exact resource the write named, not a whole scan.
    const observation = recorded.json.data.observations.at(-1);
    expect(observation.observation.lookup).toBe("known-id");
    expect(observation.observation.coverage.complete).toBe(true);
    expect(observation.observation.exactMatches).toHaveLength(1);
  });

  test("never writes a verified step again", async () => {
    const workspace = await makeWorkspace();
    const first = await recordStep(workspace, { input: resolutionBody() });
    expect(first.json.data.state).toBe("verified");

    const again = await recordStep(workspace, { input: resolutionBody() });

    expect(again.exitCode).toBe(0);
    expect(again.json.data.operationId).toBe(first.json.data.operationId);
    expect(again.json.data.writeAttempts).toHaveLength(1);
    expect(await commentsOn(workspace, TICKET)).toHaveLength(1);
    expect((await githubCalls(workspace)).filter((line) => line.startsWith("POST "))).toHaveLength(
      1,
    );
  });

  test("settles a lost write from a complete scan and keeps its lost history", async () => {
    const workspace = await makeWorkspace();
    // The comment lands and the answer never arrives, which is the case a blind retry duplicates.
    await setFault(workspace, "createComment", "applied-lost");

    const recorded = await recordStep(workspace, { input: resolutionBody() });

    expect(recorded.exitCode).toBe(0);
    expect(recorded.json.reason).toBe("tracker.completed");
    // With no server identifier the step is settled by scanning every accessible page.
    const scanned = recorded.json.data.observations.at(-1);
    expect(scanned.observation.lookup).toBe("scan");
    expect(scanned.observation.coverage.complete).toBe(true);
    expect(scanned.observation.exactMatches).toHaveLength(1);
    // The lost answer stays in the history even though the observed comment satisfies the step.
    expect(recorded.json.data.writeAttempts[0].state).toBe("uncertain");
    expect(recorded.json.data.resourceId).toBeNull();
    expect(await commentsOn(workspace, TICKET)).toHaveLength(1);
  });

  test("keeps a lost write uncertain when a complete scan finds nothing", async () => {
    const workspace = await makeWorkspace();
    await setFault(workspace, "createComment", "lost");

    const recorded = await recordStep(workspace, { input: resolutionBody() });

    expect(recorded.exitCode).toBe(5);
    expect(recorded.json.reason).toBe("tracker.resolution_outcome_unknown");
    // An empty scan is not proof that the write never applied and cannot still apply.
    expect(recorded.json.data.observations.at(-1).observation.coverage.complete).toBe(true);
    expect(recorded.json.data.observations.at(-1).observation.exactMatches).toEqual([]);
    expect(await commentsOn(workspace, TICKET)).toHaveLength(0);
  });

  test("refuses another write after an uncertain answer until a person approves it", async () => {
    const workspace = await makeWorkspace();
    await setFault(workspace, "createComment", "lost");
    const first = await recordStep(workspace, { input: resolutionBody() });
    const operationId = first.json.data.operationId;

    const refused = await recordStep(workspace, { input: resolutionBody() });

    expect(refused.exitCode).toBe(3);
    expect(refused.json.reason).toBe("tracker.approval_required");
    expect(refused.json.blockers[0].action).toBe("tracker.additional_write");
    expect(refused.json.blockers[0].targets).toContain(`operation:${operationId}`);
    expect(await commentsOn(workspace, TICKET)).toHaveLength(0);

    const approvalId = await grantAdditionalWrite(workspace, {
      operationId,
      issue: TICKET,
      scope: "resolution",
      requestRevision: refused.json.blockers[0].requestRevision,
    });
    const approved = await recordStep(workspace, { input: resolutionBody(), approvalId });

    expect(approved.exitCode).toBe(0);
    expect(approved.json.reason).toBe("tracker.completed");
    // The logical operation is unchanged, and the approved write is a second attempt under it.
    expect(approved.json.data.operationId).toBe(operationId);
    expect(approved.json.data.writeAttempts).toHaveLength(2);
    expect(approved.json.data.writeAttempts[0].state).toBe("uncertain");
    expect(approved.json.data.writeAttempts[1].approvalId).toBe(approvalId);
  });

  test("reports two comments under one operation as a conflict", async () => {
    const workspace = await makeWorkspace();
    // The comment lands, the answer is lost, and the scans that follow cannot see it, so the
    // approved additional write is the only way a duplicate is ever created.
    await setFault(workspace, "createComment", "applied-lost");
    await setFault(workspace, "scanComments", "status:502", 3);
    const first = await recordStep(workspace, { input: resolutionBody() });
    expect(first.exitCode).toBe(5);

    const refused = await recordStep(workspace, { input: resolutionBody() });
    expect(refused.json.reason).toBe("tracker.approval_required");
    const approvalId = await grantAdditionalWrite(workspace, {
      operationId: first.json.data.operationId,
      issue: TICKET,
      scope: "resolution",
      requestRevision: refused.json.blockers[0].requestRevision,
    });

    const second = await recordStep(workspace, { input: resolutionBody(), approvalId });

    expect(second.exitCode).toBe(4);
    expect(second.json.reason).toBe("tracker.resolution_conflict");
    expect(second.json.blockers[0].detail).toContain("2 comments");
    expect(await commentsOn(workspace, TICKET)).toHaveLength(2);
  });

  test("reports an edited comment as a conflict and never restores it", async () => {
    const workspace = await makeWorkspace();
    const recorded = await recordStep(workspace, { input: resolutionBody() });

    const state = await githubState(workspace);
    const comment = state.comments[String(TICKET)]?.[0];
    if (comment === undefined) {
      throw new Error("the fixture recorded no comment");
    }
    comment.body = `${comment.body}\n\nSomeone edited this.`;
    comment.updated_at = "2026-09-20T00:00:00Z";
    await writeGithubState(workspace, state);

    const recovered = await recoverStep(workspace, recorded.json.data.operationId);

    expect(recovered.exitCode).toBe(4);
    expect(recovered.json.reason).toBe("tracker.resolution_conflict");
    expect(recovered.json.blockers[0].detail).toContain("not the intended content");
    expect((await commentsOn(workspace, TICKET))[0]?.body).toContain("Someone edited this.");
  });

  test("reports a comment written by another actor as a conflict", async () => {
    const workspace = await makeWorkspace();
    await setFault(workspace, "createComment", "lost");
    const recorded = await recordStep(workspace, { input: resolutionBody() });

    // Another account wrote a comment carrying this operation marker.
    const state = await githubState(workspace);
    state.comments[String(TICKET)] = [
      {
        id: 99,
        html_url: `https://github.com/${REPOSITORY}/issues/${TICKET}#issuecomment-99`,
        user: { login: "someone-else" },
        body: `<!-- operator:tracker-operation:v1 ${recorded.json.data.operationId} -->\n\n## Resolution\n\nThe work is complete and reviewed.\n`,
        created_at: "2026-09-20T00:00:00Z",
        updated_at: "2026-09-20T00:00:00Z",
      },
    ];
    await writeGithubState(workspace, state);

    const recovered = await recoverStep(workspace, recorded.json.data.operationId);

    // An unproven write outranks every other problem, and the actor mismatch is kept beside it.
    expect(recovered.exitCode).toBe(5);
    expect(recovered.json.reason).toBe("tracker.resolution_outcome_unknown");
    const mismatch = recovered.json.blockers.find(
      (one: { reason: string }) => one.reason === "tracker.resolution_conflict",
    );
    expect(mismatch.detail).toContain("someone-else");
  });

  test("reports an incomplete scan as missing evidence, never as absence", async () => {
    const workspace = await makeWorkspace();
    await setFault(workspace, "createComment", "lost");
    const recorded = await recordStep(workspace, { input: resolutionBody() });
    await setFault(workspace, "scanComments", "status:502");

    const recovered = await recoverStep(workspace, recorded.json.data.operationId);

    expect(recovered.exitCode).toBe(5);
    expect(recovered.json.reason).toBe("tracker.resolution_outcome_unknown");
    const incomplete = recovered.json.blockers.find(
      (one: { reason: string }) => one.reason === "tracker.evidence_incomplete",
    );
    expect(incomplete.detail).toBeString();
    expect(recovered.json.data.observations.at(-1).observation.coverage.complete).toBe(false);
  });

  test("reports a refused write as a definite failure", async () => {
    const workspace = await makeWorkspace();
    await setFault(workspace, "createComment", "status:403");

    const recorded = await recordStep(workspace, { input: resolutionBody() });

    expect(recorded.exitCode).toBe(1);
    expect(recorded.json.reason).toBe("tracker.write_rejected");
    expect(recorded.json.data.writeAttempts[0].state).toBe("failed");
  });
});

describe("operator tracker record completion", () => {
  test("completes a ticket and records what it observed without claiming attribution", async () => {
    const workspace = await makeWorkspace();

    const recorded = await recordStep(workspace, { input: completionBody() });

    expect(recorded.exitCode).toBe(0);
    expect(recorded.json.reason).toBe("tracker.completed");
    const observation = recorded.json.data.observations.at(-1).observation;
    expect(observation.kind).toBe("closure");
    expect(observation.state).toBe("closed");
    expect(observation.stateReason).toBe("completed");
    expect(observation.closedBy).toBe(ACTOR);
    expect(observation.closedAt).toBeString();
    expect(observation.events.map((one: { event: string }) => one.event)).toEqual(["closed"]);
  });

  test("reports a different close reason as a conflict", async () => {
    const workspace = await makeWorkspace();
    const state = await githubState(workspace);
    const ticket = state.issues[String(TICKET)];
    if (ticket === undefined) {
      throw new Error("the fixture seeded no ticket");
    }
    // Someone closed it as not planned before Operator asked for completion.
    ticket.state = "closed";
    ticket.state_reason = "not_planned";
    state.events[String(TICKET)] = [
      {
        event: "closed",
        actor: { login: "someone-else" },
        state_reason: "not_planned",
        created_at: "2026-09-20T00:00:00Z",
      },
    ];
    await writeGithubState(workspace, state);

    const recorded = await recordStep(workspace, { input: completionBody() });

    expect(recorded.exitCode).toBe(4);
    expect(recorded.json.reason).toBe("tracker.completion_conflict");
    expect(recorded.json.blockers[0].detail).toContain("not_planned");
  });

  test("stops on a reopen that followed the close", async () => {
    const workspace = await makeWorkspace();
    const recorded = await recordStep(workspace, { input: completionBody() });
    expect(recorded.json.data.state).toBe("verified");

    const state = await githubState(workspace);
    const ticket = state.issues[String(TICKET)];
    if (ticket === undefined) {
      throw new Error("the fixture seeded no ticket");
    }
    ticket.state = "open";
    ticket.state_reason = "reopened";
    state.events[String(TICKET)] = [
      ...(state.events[String(TICKET)] ?? []),
      {
        event: "reopened",
        actor: { login: "someone-else" },
        state_reason: null,
        created_at: "2026-09-21T00:00:00Z",
      },
    ];
    await writeGithubState(workspace, state);

    const recovered = await recoverStep(workspace, recorded.json.data.operationId);

    expect(recovered.exitCode).toBe(4);
    expect(recovered.json.reason).toBe("tracker.completion_conflict");
    expect(recovered.json.blockers[0].detail).toContain("reopened");
    // The reopen is not repaired by closing it again.
    expect((await githubState(workspace)).issues[String(TICKET)]?.state).toBe("open");
  });

  test("settles a lost close from the state the ticket shows", async () => {
    const workspace = await makeWorkspace();
    await setFault(workspace, "closeIssue", "applied-lost");

    const recorded = await recordStep(workspace, { input: completionBody() });

    expect(recorded.exitCode).toBe(0);
    expect(recorded.json.reason).toBe("tracker.completed");
    expect(recorded.json.data.writeAttempts[0].state).toBe("uncertain");
    // The lost answer stays in the history even though the observed state satisfies the step.
    expect(recorded.json.data.state).toBe("verified");
  });

  test("keeps a lost close uncertain while the ticket is still open", async () => {
    const workspace = await makeWorkspace();
    await setFault(workspace, "closeIssue", "lost");

    const recorded = await recordStep(workspace, { input: completionBody() });

    expect(recorded.exitCode).toBe(5);
    expect(recorded.json.reason).toBe("tracker.completion_outcome_unknown");
    expect((await githubState(workspace)).issues[String(TICKET)]?.state).toBe("open");
  });
});

describe("operator tracker map", () => {
  test("amends the map and reads the baseline with every amendment", async () => {
    const workspace = await makeWorkspace();

    const amended = await recordStep(workspace, { input: amendmentBody() });
    expect(amended.exitCode).toBe(0);
    expect(amended.json.data.target).toEqual({ repository: REPOSITORY, issue: MAP_ISSUE });

    const map = await readMap(workspace);

    expect(map.exitCode).toBe(0);
    expect(map.json.data.baselineIdentity).toBe(MAP_BASELINE_IDENTITY);
    expect(map.json.data.amendments).toHaveLength(1);
    expect(map.json.data.amendments[0].sections).toEqual(["Decisions so far"]);
    expect(map.json.data.effective).toHaveLength(1);
    expect(map.json.data.coverage.complete).toBe(true);
    expect(map.json.data.problems).toEqual([]);
  });

  test("combines independent additions and stops on two amendments of one section", async () => {
    const workspace = await makeWorkspace();
    await recordStep(workspace, { input: amendmentBody({ sections: ["Decisions so far"] }) });

    // An ordinary discussion comment is not an amendment.
    const state = await githubState(workspace);
    state.comments[String(MAP_ISSUE)] = [
      ...(state.comments[String(MAP_ISSUE)] ?? []),
      {
        id: 90,
        html_url: `https://github.com/${REPOSITORY}/issues/${MAP_ISSUE}#issuecomment-90`,
        user: { login: "someone-else" },
        body: "I think we should reconsider this.",
        created_at: "2026-09-20T00:00:00Z",
        updated_at: "2026-09-20T00:00:00Z",
      },
      {
        id: 91,
        html_url: `https://github.com/${REPOSITORY}/issues/${MAP_ISSUE}#issuecomment-91`,
        user: { login: ACTOR },
        body: [
          "<!-- operator:tracker-operation:v1 11111111-1111-1111-1111-111111111111 -->",
          "",
          "## Map amendment",
          "",
          `The unchanged baseline body has SHA256 \`${MAP_BASELINE_IDENTITY}\`.`,
          "",
          "### Changes",
          "",
          "- section: Out of scope",
          "",
          "### Detail",
          "",
          "- Jira stays out of the first release.",
        ].join("\n"),
        created_at: "2026-09-20T00:00:00Z",
        updated_at: "2026-09-20T00:00:00Z",
      },
    ];
    await writeGithubState(workspace, state);

    const combined = await readMap(workspace);
    expect(combined.exitCode).toBe(0);
    expect(combined.json.data.amendments).toHaveLength(2);
    expect(combined.json.data.ordinaryComments).toBe(1);
    expect(combined.json.data.problems).toEqual([]);

    // A second amendment of one section, with nothing superseding it, is a conflict.
    const conflicting = await githubState(workspace);
    conflicting.comments[String(MAP_ISSUE)] = [
      ...(conflicting.comments[String(MAP_ISSUE)] ?? []),
      {
        id: 92,
        html_url: `https://github.com/${REPOSITORY}/issues/${MAP_ISSUE}#issuecomment-92`,
        user: { login: ACTOR },
        body: [
          "<!-- operator:tracker-operation:v1 22222222-2222-2222-2222-222222222222 -->",
          "",
          "## Map amendment",
          "",
          `The unchanged baseline body has SHA256 \`${MAP_BASELINE_IDENTITY}\`.`,
          "",
          "### Changes",
          "",
          "- section: Out of scope",
          "",
          "### Detail",
          "",
          "- Jira ships in the first release.",
        ].join("\n"),
        created_at: "2026-09-21T00:00:00Z",
        updated_at: "2026-09-21T00:00:00Z",
      },
    ];
    await writeGithubState(workspace, conflicting);

    const stopped = await readMap(workspace);
    expect(stopped.exitCode).toBe(4);
    expect(stopped.json.reason).toBe("tracker.map_conflict");
    expect(stopped.json.blockers[0].detail).toContain("Out of scope");
  });

  test("stops on an incomplete map read", async () => {
    const workspace = await makeWorkspace();
    await setFault(workspace, "scanComments", "status:502");

    const map = await readMap(workspace);

    expect(map.exitCode).toBe(3);
    expect(map.json.reason).toBe("tracker.evidence_incomplete");
    expect(map.json.data.coverage.complete).toBe(false);
  });

  test("refuses to replace a shared body with no verified conflict guard", async () => {
    const workspace = await makeWorkspace();

    const refused = await recordStep(workspace, { input: amendmentBody({ mode: "replace-body" }) });

    expect(refused.exitCode).toBe(3);
    expect(refused.json.reason).toBe("tracker.capability_unavailable");
    expect(refused.json.blockers[0].capability).toBe("body_replacement_guard");
    expect(await commentsOn(workspace, MAP_ISSUE)).toHaveLength(0);
  });

  test("refuses a map amendment for a source that records no map", async () => {
    const workspace = await makeWorkspace({ mapIssue: null });

    const refused = await recordStep(workspace, { input: amendmentBody() });

    expect(refused.exitCode).toBe(2);
    expect(refused.json.reason).toBe("tracker.invalid_request");
  });
});

describe("operator tracker show", () => {
  test("keeps each step separate and never repeats a verified one", async () => {
    const workspace = await makeWorkspace();
    const resolution = await recordStep(workspace, { input: resolutionBody() });
    expect(resolution.json.data.state).toBe("verified");

    // The completion step is refused by the tracker, and the resolution stays verified.
    await setFault(workspace, "closeIssue", "status:403");
    const completion = await recordStep(workspace, { input: completionBody() });
    expect(completion.exitCode).toBe(1);

    const shown = await showSteps(workspace);

    // A successful status query answers 0 even when the tracker operation is incomplete.
    expect(shown.exitCode).toBe(0);
    expect(shown.json.reason).toBe("tracker_steps_reported");
    expect(shown.json.data.complete).toBe(false);
    expect(shown.json.data.incomplete).toEqual(["completion", "map_amendment"]);

    const steps: Array<{ step: string; state: string; writeAttempts: number }> =
      shown.json.data.steps;
    expect(steps.find((one) => one.step === "resolution")?.state).toBe("verified");
    expect(steps.find((one) => one.step === "completion")?.state).toBe("failed");
    expect(steps.find((one) => one.step === "map_amendment")?.state).toBe("unrecorded");
    // The verified resolution was never written a second time to repair the completion.
    expect(steps.find((one) => one.step === "resolution")?.writeAttempts).toBe(1);
    expect(await commentsOn(workspace, TICKET)).toHaveLength(1);
  });

  test("reports the map step as not applicable when the source records no map", async () => {
    const workspace = await makeWorkspace({ mapIssue: null });

    const shown = await showSteps(workspace);

    expect(shown.exitCode).toBe(0);
    const steps: Array<{ step: string; applicable: boolean }> = shown.json.data.steps;
    expect(steps.find((one) => one.step === "map_amendment")?.applicable).toBe(false);
    expect(shown.json.data.incomplete).toEqual(["resolution", "completion"]);
  });
});

describe("tracker binding", () => {
  test("refuses a request that names another ticket", async () => {
    const workspace = await makeWorkspace();

    const refused = await recordStep(workspace, {
      input: { ...(resolutionBody() as object), target: { repository: REPOSITORY, issue: 999 } },
    });

    expect(refused.exitCode).toBe(2);
    expect(refused.json.reason).toBe("tracker.invalid_request");
    expect(refused.json.blockers[0].recorded).toEqual({ repository: REPOSITORY, issue: TICKET });
    expect(await commentsOn(workspace, TICKET)).toHaveLength(0);
  });

  test("refuses an assignment that was registered with no ticket", async () => {
    const workspace = await makeWorkspace({ trackerIssue: null });

    const refused = await recordStep(workspace, { input: resolutionBody() });

    expect(refused.exitCode).toBe(2);
    expect(refused.json.reason).toBe("tracker.invalid_request");
    expect(refused.json.blockers[0].detail).toContain("no ticket of its own");
  });

  test("refuses changed content under a step that was already written", async () => {
    const workspace = await makeWorkspace();
    await setFault(workspace, "createComment", "lost");
    await recordStep(workspace, { input: resolutionBody() });

    const refused = await recordStep(workspace, { input: resolutionBody("Something else.") });

    expect(refused.exitCode).toBe(2);
    expect(refused.json.reason).toBe("tracker.invalid_request");
    expect(refused.json.blockers[0].recorded).toBeString();
  });

  test("refuses a stale assignment revision before any effect", async () => {
    const workspace = await makeWorkspace();

    const refused = await recordStep(workspace, { input: resolutionBody(), revision: 7 });

    expect(refused.exitCode).toBe(4);
    expect(refused.json.reason).toBe("stale_revision");
    expect(await githubCalls(workspace)).toEqual([]);
  });
});
