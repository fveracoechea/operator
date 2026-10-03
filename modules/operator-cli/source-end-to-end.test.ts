import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { reviewedResult } from "./branch-review-fixture.ts";
import {
  acceptAssignment,
  acceptProduction,
  acceptReview,
  commitArtifact,
  makeReviewWorkspace,
  PLANNING_RECORD,
  type Producer,
  reportBody,
  reportReview,
  startReviewer,
  submissionBody,
  submit,
  type Workspace,
  writeInput,
} from "./review-cycle-fixture.ts";
import {
  addRemote,
  apply,
  grant,
  mergeOnGithub,
  normalized,
  plannedBody,
  publishStatus,
  pullsOf,
  recordTracker,
  REPOSITORY,
  SOURCE,
} from "./publish-fixture.ts";
import { readFake, registerSource, workspaceTarget } from "./source-fixture.ts";
import {
  githubCalls,
  headCommit,
  herdrCalls,
  nextActions,
  ownCrew,
  passBaseGate,
  requestId as request,
  runJson,
  runOperator,
  workspaces,
} from "./workspace-fixture.ts";

// One test runs a whole source: four items, three producers, their reviewers, a branch reviewer,
// four gate runs, a publish, and the tracker steps, each one a separate CLI process.
setDefaultTimeout(600_000);

const fixtures = workspaces();

afterEach(async () => {
  await fixtures.removeAll();
});

const BRIEF = ".operator/local/brief.md";

/** The issue number of each item, in sub-issue order under parent 15. */
const ISSUE = { plan: 1501, store: 1502, notes: 1503, api: 1504 } as const;

/** The text the branch reviewer writes for the one pull request (D1). */
const PUBLISHED = {
  title: "Store, notes, and API of the planned feature",
  summary: "Adds the store, its notes, and the API that reads the store.",
  startHere: "Read store/store.md first, because the notes and the API read it.",
  mergeDanger: "Nothing known: the change adds three new files.",
  cuts: [],
};

/**
 * One parent issue with one planning item and three production items, with blocking links and
 * narrow write paths. `notes` writes inside the folder of `store`, so the frontier holds it
 * while `store` is in flight. `api` is two steps below the planning item.
 */
async function registerFeature(workspace: Workspace, ownerToken: string) {
  const item = (
    key: keyof typeof ISSUE,
    kind: "planning" | "production",
    title: string,
    writePaths: string[],
    dependsOn: Array<keyof typeof ISSUE>,
  ) => ({
    key,
    title,
    body: title,
    kind,
    acceptanceRequirements: ["The quality gate passes."],
    permissions: { writePaths, allowedCommands: ["bun test"], network: false },
    dependsOn: dependsOn.map((one) => ({ key: one })),
  });
  const registered = await registerSource(workspaceTarget(workspace), ownerToken, {
    sourceKind: "specification",
    parent: 15,
    items: [
      item("plan", "planning", "Decide where the store lives", ["docs/"], []),
      item("store", "production", "Build the store", ["store/"], ["plan"]),
      item("notes", "production", "Write the store notes", ["store/notes/"], ["plan"]),
      item("api", "production", "Build the API on the store", ["api/"], ["store"]),
    ],
  });
  expect(registered.json.reason).toBe("work_registered");
  return {
    ids: registered.keys as Map<keyof typeof ISSUE, string>,
    sourceRevision: registered.json.data.source.revision as string,
  };
}

/** Claims and dispatches one production item into its own worktree, and acknowledges its brief. */
async function launch(
  workspace: Workspace,
  options: {
    ownerToken: string;
    assignmentId: string;
    sourceRevision: string;
    worktree: string;
    first?: boolean;
  },
): Promise<Producer> {
  const claimed = await runJson(workspace, [
    "work",
    "claim",
    "--request",
    request(),
    "--owner-token",
    options.ownerToken,
    "--assignment",
    options.assignmentId,
    "--revision",
    "1",
  ]);
  expect(claimed.json.reason).toBe("assignment_claimed");
  const attemptId = claimed.json.data.attemptId as string;
  const worktreePath = `${workspace.root}/${options.worktree}`;
  // The first code dispatch of a source starts from its base, after the base passed the gate.
  // Every later one starts from the recorded tip of the integration branch.
  const base = options.first === true ? await headCommit(workspace) : null;
  if (base !== null) {
    const gated = await passBaseGate(workspace, {
      ownerToken: options.ownerToken,
      attemptId,
      commit: base,
    });
    expect(gated?.json.reason).toBe("gate_run_started");
  }
  const dispatched = await runJson(workspace, [
    "attempt",
    "dispatch",
    "--request",
    request(),
    "--owner-token",
    options.ownerToken,
    "--attempt",
    attemptId,
    ...(base === null ? [] : ["--commit", base]),
    "--worktree",
    worktreePath,
  ]);
  expect(dispatched.json.outcome).toBe("pending");
  const acknowledged = await runJson(
    workspace,
    ["attempt", "acknowledge", "--request", request(), "--attempt", attemptId],
    worktreePath,
  );
  expect(acknowledged.exitCode).toBe(0);
  return {
    ownerToken: options.ownerToken,
    assignmentId: options.assignmentId,
    attemptId,
    worktreePath,
    baseCommit: await headCommit(workspace, worktreePath),
    assignmentRevision: claimed.json.data.revision as number,
    dispatched: dispatched.json,
    dependents: new Map(),
    sourceRevision: options.sourceRevision,
  };
}

async function frontierBlockers(workspace: Workspace, assignmentId: string) {
  const frontier = await runJson(workspace, ["work", "frontier"]);
  const entry = (
    frontier.json.data.blocked as Array<{ assignmentId: string; blockers: unknown[] }>
  ).find((one) => one.assignmentId === assignmentId);
  return entry?.blockers ?? [];
}

/** Every passed gate run of the source, by the commit it ran on. */
function passedGateCommits(workspace: Workspace): string[] {
  const sqlite = new Database(`${workspace.repo}/.operator/local/crew-state.sqlite`, {
    readonly: true,
  });
  try {
    return sqlite
      .query<{ commit: string }, []>(`select "commit" from gate_runs where state = 'passed'`)
      .all()
      .map((one) => one.commit);
  } finally {
    sqlite.close();
  }
}

function gateCheckouts(workspace: Workspace): string[] {
  const sqlite = new Database(`${workspace.repo}/.operator/local/crew-state.sqlite`, {
    readonly: true,
  });
  try {
    return sqlite
      .query<{ path: string }, []>("select path from gate_checkouts")
      .all()
      .map((one) => one.path);
  } finally {
    sqlite.close();
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await Bun.$`git -C ${cwd} ${args}`.quiet()).stdout.toString().trim();
}

describe("one source end to end", () => {
  test("one parent issue becomes one merged integrated pull request with one gated commit for each item", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    await addRemote(workspace);
    const base = await headCommit(workspace);
    const ownerToken = await ownCrew(workspace);
    const { ids, sourceRevision } = await registerFeature(workspace, ownerToken);
    const id = (key: keyof typeof ISSUE) => ids.get(key) ?? "";

    // The planning item is accepted with its planning record, which resolves it.
    const planned = await acceptAssignment(workspace, { ownerToken } as Producer, {
      assignmentId: id("plan"),
      revision: 1,
      record: PLANNING_RECORD,
    });
    expect(planned.json.reason).toBe("assignment_accepted");
    const recordId = planned.json.data.planningRecordId as string;

    // The direct dependent starts with that record in its brief.
    const store = await launch(workspace, {
      ownerToken,
      assignmentId: id("store"),
      sourceRevision,
      worktree: "operative-store",
      first: true,
    });
    const storeBrief = await Bun.file(`${store.worktreePath}/${BRIEF}`).text();
    expect(storeBrief).toContain("## Planning records");
    expect(storeBrief).toContain(recordId);

    // `notes` writes inside `store/`, so the frontier holds it until `store` is accepted.
    expect(await frontierBlockers(workspace, id("notes"))).toEqual([
      expect.objectContaining({
        reason: "write_paths_overlap",
        holders: [expect.objectContaining({ assignmentId: id("store") })],
      }),
    ]);
    // `api` waits for its blocking link.
    expect(await frontierBlockers(workspace, id("api"))).toEqual([
      expect.objectContaining({ reason: "dependency_pending" }),
    ]);

    // The store result writes a file outside its worktree during the attempt.
    const stray = `${workspace.root}/stray.txt`;
    await Bun.write(stray, "written next to the worktree\n");
    const storeArtifact = await commitArtifact(workspace, store, "# Store\n", "store/store.md");
    const storeSubmitted = await submit(workspace, store, submissionBody(store, storeArtifact));
    expect(storeSubmitted.json.reason).toBe("result_submitted");
    expect(storeSubmitted.json.data.outsideChanges).toBe(1);
    const storeReviewer = await startReviewer(
      workspace,
      store,
      storeSubmitted.json,
      storeArtifact.commit,
      { worktreePath: `${workspace.root}/reviewer-store` },
    );
    const storeReported = await reportReview(
      workspace,
      storeReviewer,
      storeSubmitted.json.data.reviewId,
      reportBody({ submissionIdentity: storeSubmitted.json.data.identity, host: workspace.host }),
    );
    expect(storeReported.json.reason).toBe("review_reported");
    const storeFreed = await acceptReview(workspace, store, {
      reviewAssignmentId: storeSubmitted.json.data.reviewAssignmentId,
      attemptId: storeReviewer.attemptId,
      revision: storeReviewer.revision,
    });
    expect(storeFreed.json.reason).toBe("assignment_accepted");

    // Acceptance waits for the disposition of the outside change.
    const storeResult = {
      submissionId: storeSubmitted.json.data.submissionId as string,
      revision: storeSubmitted.json.data.revision as number,
    };
    const waiting = await acceptProduction(workspace, store, storeResult);
    expect(waiting.json.reason).toBe("outside_changes_undisposed");
    const shown = await runJson(workspace, [
      "review",
      "show",
      "--review",
      storeSubmitted.json.data.reviewId,
    ]);
    const [change] = shown.json.data.submission.outsideChanges as Array<{ changeId: string }>;
    // Only the person deletes the file; the CLI proves the delete with a new scan (D4).
    await Bun.$`rm ${stray}`.quiet();
    const disposed = await runJson(workspace, [
      "work",
      "dispose",
      "--request",
      request(),
      "--owner-token",
      ownerToken,
      "--submission",
      storeResult.submissionId,
      "--input",
      await writeInput(workspace, {
        dispositions: [{ changeId: change?.changeId, disposition: "removed" }],
      }),
    ]);
    expect(disposed.json.data.outstanding).toEqual([]);
    const storeAccepted = await acceptProduction(workspace, store, storeResult);
    expect(storeAccepted.json.reason).toBe("assignment_accepted");

    // The hold ends with the acceptance, and the next items start from the recorded tip.
    expect(await frontierBlockers(workspace, id("notes"))).toEqual([]);
    const notes = await launch(workspace, {
      ownerToken,
      assignmentId: id("notes"),
      sourceRevision,
      worktree: "operative-notes",
    });
    expect(notes.baseCommit).toBe(storeAccepted.json.data.landing.to);
    expect(await Bun.file(`${notes.worktreePath}/${BRIEF}`).text()).toContain(recordId);
    const notesResult = await reviewedResult(workspace, notes, {
      text: "# Notes\n",
      path: "store/notes/notes.md",
      worktree: "reviewer-notes",
    });
    // A candidate with no passing gate run does not land, and the branch stays where it was.
    const ungated = await acceptProduction(workspace, notes, { ...notesResult, gate: false });
    expect(ungated.json.reason).toBe("gate_pending");
    expect(
      await git(workspace.repo, [
        "for-each-ref",
        "--format=%(objectname)",
        "refs/heads/operator/integration/",
      ]),
    ).toBe(storeAccepted.json.data.landing.to);
    const notesAccepted = await acceptProduction(workspace, notes, notesResult);
    expect(notesAccepted.json.reason).toBe("assignment_accepted");

    const api = await launch(workspace, {
      ownerToken,
      assignmentId: id("api"),
      sourceRevision,
      worktree: "operative-api",
    });
    expect(api.baseCommit).toBe(notesAccepted.json.data.landing.to);
    // The planning record reaches only its direct dependents.
    expect(await Bun.file(`${api.worktreePath}/${BRIEF}`).text()).not.toContain(recordId);
    const apiResult = await reviewedResult(workspace, api, {
      text: "# API\n",
      path: "api/api.md",
      worktree: "reviewer-api",
    });
    const apiAccepted = await acceptProduction(workspace, api, apiResult);
    expect(apiAccepted.json.reason).toBe("assignment_accepted");

    // The integration branch holds one commit for each item, in dependency order, on the base.
    const landed = [storeAccepted, notesAccepted, apiAccepted].map(
      (one) => one.json.data.landing.to as string,
    );
    const head = landed[2] ?? "";
    expect(await git(workspace.repo, ["rev-list", "--reverse", `${base}..${head}`])).toBe(
      landed.join("\n"),
    );
    const files = await Promise.all(
      landed.map((commit) =>
        git(workspace.repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", commit]),
      ),
    );
    expect(files).toEqual(["store/store.md", "store/notes/notes.md", "api/api.md"]);
    // A passing gate run at the base and at every commit.
    const passed = passedGateCommits(workspace);
    for (const commit of [base, ...landed]) {
      expect(passed).toContain(commit);
    }

    // The last acceptance registers the branch review, and it reports on the head.
    const branchReview = apiAccepted.json.data.branchReview as {
      reviewId: string;
      assignmentId: string;
      snapshotIdentity: string;
      headCommit: string;
    };
    expect(branchReview.headCommit).toBe(head);
    const branchClaimed = await runJson(workspace, [
      "work",
      "claim",
      "--request",
      request(),
      "--owner-token",
      ownerToken,
      "--assignment",
      branchReview.assignmentId,
      "--revision",
      "1",
    ]);
    const branchReviewer = {
      attemptId: branchClaimed.json.data.attemptId as string,
      worktreePath: `${workspace.root}/branch-reviewer`,
      revision: branchClaimed.json.data.revision as number,
    };
    await runJson(workspace, [
      "attempt",
      "dispatch",
      "--request",
      request(),
      "--owner-token",
      ownerToken,
      "--attempt",
      branchReviewer.attemptId,
      "--worktree",
      branchReviewer.worktreePath,
    ]);
    await runJson(
      workspace,
      ["attempt", "acknowledge", "--request", request(), "--attempt", branchReviewer.attemptId],
      branchReviewer.worktreePath,
    );
    const { submissionIdentity: _unused, ...report } = reportBody({
      submissionIdentity: "unused",
      host: workspace.host,
      checked: ["diff", "requirements", "checks"],
      observedChecks: [{ name: "true", outcome: "passed" }],
    });
    // Nothing publishes before the branch review reports on the head.
    const early = await runJson(workspace, ["publish", "plan", "--source", SOURCE]);
    expect(early.json.blockers.map((one: { reason: string }) => one.reason)).toEqual([
      "branch_review_missing",
    ]);
    expect((await nextActions(workspace)).forAction("publish_stack")).toEqual([]);
    const branchReported = await reportReview(workspace, branchReviewer, branchReview.reviewId, {
      ...report,
      snapshotIdentity: branchReview.snapshotIdentity,
      published: PUBLISHED,
    });
    expect(branchReported.json.reason).toBe("review_reported");
    const branchFreed = await acceptReview(workspace, store, {
      reviewAssignmentId: branchReview.assignmentId,
      attemptId: branchReviewer.attemptId,
      revision: branchReviewer.revision,
    });
    expect(branchFreed.json.reason).toBe("assignment_accepted");

    // The publish plan is a short summary that points to the file of the body (R5).
    expect((await nextActions(workspace)).of("publish_stack").sourceId).toBe(SOURCE);
    const shortPlan = await runOperator(workspace, ["publish", "plan", "--source", SOURCE]);
    expect(shortPlan.exitCode).toBe(0);
    expect(shortPlan.stdout).toContain(".operator/local/publish-plans/");
    expect(shortPlan.stdout).not.toContain(PUBLISHED.summary);
    const plan = await runJson(workspace, ["publish", "plan", "--source", SOURCE]);
    expect(plan.json.reason).toBe("publish_planned");
    const { planRevision, planPath, approval } = plan.json.data;

    // The approval names each tracker step after the merge as a target (D2).
    const closes = (key: keyof typeof ISSUE) => `github:${REPOSITORY}#${ISSUE[key]}`;
    expect(approval.targets).toEqual([
      "operator/fveracoechea-operator-15/1/1",
      "main",
      ...(["store", "notes", "api"] as const).flatMap((key) => [
        `${closes(key)}:resolution`,
        `${closes(key)}:completion`,
      ]),
    ]);
    // The body holds the text of the branch reviewer and the records, and nothing else (D1).
    const body = await plannedBody(workspace, planPath);
    expect(normalized(body)).toBe(
      await Bun.file(`${import.meta.dir}/source-end-to-end-body.fixture.md`).text(),
    );

    const granted = await grant(workspace, store, approval);
    expect(granted.json.reason).toBe("approval_granted");
    const published = await apply(workspace, store, planRevision);
    expect(published.json.reason).toBe("published");
    const [pull] = await pullsOf(workspace);
    expect(pull?.title).toBe(PUBLISHED.title);
    expect(pull?.body).toBe(body);

    // A person merges it on GitHub with a merge commit, and the read observes the merge.
    const callsBeforeMerge = (await githubCalls(workspace)).length;
    const mergeCommit = await mergeOnGithub(workspace, { head, method: "merge" });
    const read = await publishStatus(workspace, store);
    expect(read.json.reason).toBe("publish_observed");
    expect(read.json.data.seen).toEqual([
      expect.objectContaining({ part: 1, state: "merged", fault: null }),
    ]);

    // The tracker steps of each item run under the publish approval.
    const revisions = new Map<string, number>([
      [id("plan"), planned.json.data.revision as number],
      [id("store"), storeAccepted.json.data.revision as number],
      [id("notes"), notesAccepted.json.data.revision as number],
      [id("api"), apiAccepted.json.data.revision as number],
    ]);
    const owed = (await nextActions(workspace)).forAction("record_tracker");
    expect(owed.map((one) => [one.assignmentId, one.blocker])).toEqual(
      expect.arrayContaining(
        (["plan", "store", "notes", "api"] as const).flatMap((key) => [
          [id(key), null],
          [id(key), null],
        ]),
      ),
    );
    let last: Awaited<ReturnType<typeof recordTracker>> | null = null;
    for (const key of ["plan", "store", "notes", "api"] as const) {
      for (const input of [{ step: "resolution" }, { step: "completion", reason: "completed" }]) {
        last = await recordTracker(
          workspace,
          { ...store, assignmentId: id(key) },
          { revision: revisions.get(id(key)) ?? 0, input },
        );
        expect([key, input.step, last.json.reason]).toEqual([key, input.step, "tracker.completed"]);
      }
    }
    const fake = await readFake(workspace.github);
    for (const key of ["plan", "store", "notes", "api"] as const) {
      expect([key, fake.issues[String(ISSUE[key])]?.state]).toEqual([key, "closed"]);
    }
    const resolution = (fake.comments[String(ISSUE.api)] ?? [])[0]?.body ?? "";
    expect(resolution).toContain(
      `in ${REPOSITORY}#${pull?.number}, merged into \`main\` by a merge commit.`,
    );
    expect(resolution).not.toContain(mergeCommit);

    // The last step finishes the source and removes its gate checkout, unforced.
    expect(last?.json.data.finish).toEqual({
      status: "finished",
      gateCheckout: "removed",
      detail: null,
    });
    expect(gateCheckouts(workspace)).toEqual([]);
    for (const one of (await herdrCalls(workspace)).filter((call) =>
      call.includes("worktree remove"),
    )) {
      expect(one).not.toContain("--force");
    }
    expect((await nextActions(workspace)).forAction("record_tracker")).toEqual([]);

    // Nothing merged on GitHub but the person, and nothing turned on auto-merge (R2, D6).
    for (const call of (await githubCalls(workspace)).slice(callsBeforeMerge)) {
      expect(call).not.toMatch(/merge|graphql/i);
    }
    // Nothing tore down a branch: the integration branch still holds the head (R3).
    const integration = await git(workspace.repo, [
      "for-each-ref",
      "--format=%(objectname)",
      "refs/heads/operator/integration/",
    ]);
    expect(integration).toBe(head);
  });
});

test("the operator router states the five rules of the person as a whole, before every topic", async () => {
  const router = await Bun.file(`${import.meta.dir}/../../skills/operator/SKILL.md`).text();
  const start = router.indexOf("## The rules of the person");
  const end = router.indexOf("\n## ", start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeLessThan(router.indexOf("## Where to start") + 1);
  const section = router.slice(start, end);
  const rules = section.split("\n").filter((line) => /^- R\d\. /.test(line));
  expect(rules.map((line) => line.slice(2, 4))).toEqual(["R1", "R2", "R3", "R4", "R5"]);
  expect(section).toContain("- R1. You are read-only. You never make a change on your own.");
  expect(section).toContain(
    "- R2. Nothing merges a pull request without the explicit approval of the person.",
  );
  expect(section).toContain("- R3. Nothing tears down unlanded work.");
  expect(section).toContain("- R4. An Operative never addresses the person directly.");
  expect(section).toContain("- R5. Keep your own context as low as possible.");
  // A topic file can only narrow a rule, so the router names the precedence once.
  expect(section).toContain("obey the rule and bring the conflict to the user");
});
