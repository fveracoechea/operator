import { afterAll, afterEach, beforeAll, describe, expect, test as bunTest } from "bun:test";
import {
  branchReport,
  finalBranch,
  type Registered,
  startBranchReviewer,
} from "./branch-review-fixture.ts";
import {
  acceptProduction,
  acceptReview,
  commitArtifact,
  disposeFindings,
  makeReviewWorkspace,
  PUBLISHED_TEXT,
  reportBody,
  reportReview,
  startProducer,
  startReviewer,
  submissionBody,
  submit,
  type Workspace,
} from "./review-cycle-fixture.ts";
import {
  addRemote,
  apply,
  editState,
  grant,
  NAME,
  normalized,
  plan,
  planAndApprove,
  plannedBody,
  pullsOf,
  reasons,
  remoteRefs,
  restoreState,
  SOURCE,
  STATE_LOST_AFTER_PLAN,
} from "./publish-fixture.ts";
import { readFake, writeFake } from "./source-fixture.ts";
import { githubCalls, nextActions, runJson, runOperator, workspaces } from "./workspace-fixture.ts";

// Each test runs producers, reviewers, a branch reviewer, and gate runs through the CLI.
// Each test states its own bound, because a process-wide default would set the bound of every
// file in the bun test process (#179).
function test(name: string, run: () => Promise<void> | void, timeoutMs = 300_000) {
  bunTest(name, run, timeoutMs);
}

const fixtures = workspaces();

afterEach(async () => {
  await fixtures.removeAll();
});

const BEHAVIOR_CHANGE = {
  statement: "The result page now names the notes it reads.",
  basis: { kind: "requirement", position: 1 },
};

/**
 * A source of two reviewed commits whose branch review reported on the head, with one rejected
 * and one deferred finding, and with the one gate command observed at the head.
 */
async function reviewedBranch(workspace: Workspace) {
  const bare = await addRemote(workspace);
  const final = await finalBranch(workspace, { behaviorChanges: [BEHAVIOR_CHANGE] });
  const firstCommit = final.acceptedFirst.json.data.landing.to as string;
  const secondCommit = final.acceptedSecond.json.data.landing.to as string;
  const registered = final.acceptedSecond.json.data.branchReview as Registered;
  const reviewer = await startBranchReviewer(
    workspace,
    final.producer,
    registered,
    "branch-reviewer",
  );
  const reported = await reportReview(
    workspace,
    reviewer,
    registered.reviewId,
    branchReport(
      workspace,
      registered.snapshotIdentity,
      [
        { key: "order", severity: "improvement", targets: [firstCommit] },
        { key: "naming", severity: "improvement", targets: [secondCommit] },
      ],
      { observedChecks: [{ name: "true", outcome: "passed" }] },
    ),
  );
  expect(reported.json.reason).toBe("review_reported");
  const freed = await acceptReview(workspace, final.producer, {
    reviewAssignmentId: registered.assignmentId,
    attemptId: reviewer.attemptId,
    revision: reviewer.revision,
  });
  expect(freed.json.reason).toBe("assignment_accepted");
  const findings = reported.json.data.findings as Array<{ findingId: string; key: string }>;
  const idOf = (key: string) => findings.find((one) => one.key === key)?.findingId ?? "";
  const disposed = await disposeFindings(workspace, final.producer, registered.reviewId, [
    {
      findingId: idOf("order"),
      disposition: "rejected",
      reason: "The notes never read the result before it lands.",
      evidence: "notes/notes.md names no path of docs/result.md.",
    },
    {
      findingId: idOf("naming"),
      disposition: "deferred",
      reason: "A rename touches every reader of the notes.",
      followUp: "fveracoechea/operator#200",
    },
  ]);
  expect(disposed.json.reason).toBe("findings_disposed");
  return { ...final, bare, registered, firstCommit, secondCommit, idOf };
}

describe("the publish of a stack of one", () => {
  test("publishes one pull request with each commit linked and a closing keyword for each item", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const branch = await reviewedBranch(workspace);
    const localBranches = async () =>
      (
        await Bun.$`git -C ${workspace.repo} for-each-ref --format=${"%(refname)"} refs/heads`.quiet()
      ).stdout
        .toString()
        .trim();
    const branchesBefore = await localBranches();

    const offered = await nextActions(workspace);
    expect(offered.forAction("publish_stack")).toEqual([
      expect.objectContaining({ sourceId: SOURCE, blocker: "approval_required" }),
    ]);

    const planned = await plan(workspace);
    expect(planned.json.reason).toBe("publish_planned");
    expect(planned.json.blockers).toEqual([]);
    const { planRevision, planPath, approval } = planned.json.data;
    expect(approval).toEqual({
      action: "publish",
      targets: [
        NAME,
        "main",
        "github:fveracoechea/operator#1501:resolution",
        "github:fveracoechea/operator#1501:completion",
        "github:fveracoechea/operator#1502:resolution",
        "github:fveracoechea/operator#1502:completion",
      ],
      scope: SOURCE,
      requestRevision: planRevision,
    });
    // The plan changed nothing: no remote branch, no pull request, and no crew record of it.
    expect(await remoteRefs(branch.bare)).not.toContain("operator/");
    expect(await pullsOf(workspace)).toEqual([]);

    const body = await plannedBody(workspace, planPath);
    expect(normalized(body)).toBe(
      await Bun.file(`${import.meta.dir}/publish-body.fixture.md`).text(),
    );
    expect(body).toContain(`/commit/${branch.firstCommit}) Closes fveracoechea/operator#1501.`);
    expect(body).toContain(`/commit/${branch.secondCommit}) Closes fveracoechea/operator#1502.`);

    // Without the approval of this exact revision, nothing is written.
    const unapproved = await apply(workspace, branch.producer, planRevision);
    expect(unapproved.json.reason).toBe("approval_required");
    expect(unapproved.json.blockers[0].approval).toEqual(approval);
    expect(await pullsOf(workspace)).toEqual([]);

    const granted = await grant(workspace, branch.producer, approval);
    expect(granted.json.reason).toBe("approval_granted");
    const approvedNext = await nextActions(workspace);
    expect(approvedNext.of("publish_stack").blocker).toBeNull();

    const published = await apply(workspace, branch.producer, planRevision);
    expect(published.json.reason).toBe("published");
    expect(published.json.data.pullRequests).toEqual([
      expect.objectContaining({ part: 1, headName: NAME, number: expect.any(Number) }),
    ]);

    const pulls = await pullsOf(workspace);
    expect(pulls).toHaveLength(1);
    expect(pulls[0]).toMatchObject({
      state: "open",
      draft: false,
      title: PUBLISHED_TEXT.title,
      head: { ref: NAME },
      base: { ref: "main" },
      body,
    });
    expect(await remoteRefs(branch.bare)).toContain(`refs/heads/${NAME} ${branch.secondCommit}`);

    // The CLI reads GitHub and opens the pull request, and nothing else: it never merges and
    // never turns on auto-merge (D6), and it deletes no branch anywhere (ADR 0010).
    for (const call of await githubCalls(workspace)) {
      expect(call).toMatch(
        /^(GET repos\/fveracoechea\/operator(\/rules\/branches\/main|\/pulls\?.*)?|POST repos\/fveracoechea\/operator\/pulls)$/,
      );
    }
    expect(await localBranches()).toBe(branchesBefore);
    expect(await remoteRefs(branch.bare)).toContain("refs/heads/main");

    const after = await nextActions(workspace);
    expect(after.forAction("publish_stack")).toEqual([]);
    expect(after.forAction("settle_publish")).toEqual([]);
  });

  test("a crew state that the approval read cannot find is reported as such, with no write", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const branch = await reviewedBranch(workspace);
    const { planRevision } = await planAndApprove(workspace, branch.producer);
    const callsBefore = (await githubCalls(workspace)).length;

    const lost = await apply(workspace, branch.producer, planRevision, STATE_LOST_AFTER_PLAN);

    // The state failure is reported as it is, the same as a rebase does, not as a missing
    // approval, and GitHub gets no write.
    expect(lost.json.reason).toBe("state_missing");
    const writes = (await githubCalls(workspace))
      .slice(callsBefore)
      .filter((one) => !one.startsWith("GET "));
    expect(writes).toEqual([]);
    expect(await pullsOf(workspace)).toEqual([]);
    await restoreState(workspace);
    const published = await apply(workspace, branch.producer, planRevision);
    expect(published.json.reason).toBe("published");
  });

  test("the report names the plan file and prints no body, and the plan takes no Operator text", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    await reviewedBranch(workspace);

    const read = await runOperator(workspace, ["publish", "plan", "--source", SOURCE]);
    expect(read.exitCode).toBe(0);
    expect(read.stdout).toContain(".operator/local/publish-plans/");
    expect(read.stdout).not.toContain(PUBLISHED_TEXT.summary);
    expect(read.stdout).not.toContain("## Commits");

    // The reviewer wrote the text, so the command has no input for the Operator to write one.
    const written = await runJson(workspace, [
      "publish",
      "plan",
      "--source",
      SOURCE,
      "--input",
      `${workspace.root}/inputs/sections.json`,
    ]);
    expect(written.json.reason).toBe("invalid_arguments");
  });

  test("a crash after the push and before the create is settled by a repeat that reads GitHub", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const branch = await reviewedBranch(workspace);
    const { planRevision } = await planAndApprove(workspace, branch.producer);

    // The create never reaches GitHub, so its answer is lost and its effect is unknown.
    await Bun.write(
      `${workspace.github}/faults.json`,
      JSON.stringify({ createPull: { kind: "lost", remaining: 1 } }),
    );
    const stopped = await apply(workspace, branch.producer, planRevision);
    expect(stopped.json.reason).toBe("publish_uncertain");
    expect(await remoteRefs(branch.bare)).toContain(`refs/heads/${NAME} ${branch.secondCommit}`);
    expect(await pullsOf(workspace)).toEqual([]);

    const next = await nextActions(workspace);
    expect(next.of("settle_publish")).toMatchObject({ sourceId: SOURCE, blocker: null });
    expect(next.forAction("publish_stack")).toEqual([]);

    // The repeat finds the names at their commits, so it pushes nothing, and opens the one pull
    // request it finds missing.
    const settled = await apply(workspace, branch.producer, planRevision);
    expect(settled.json.reason).toBe("published");
    expect(await pullsOf(workspace)).toHaveLength(1);
    expect((await nextActions(workspace)).forAction("settle_publish")).toEqual([]);
  });

  test("a create that GitHub applied with a lost answer is found by its head, not created twice", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    const branch = await reviewedBranch(workspace);
    const { planRevision } = await planAndApprove(workspace, branch.producer);

    await Bun.write(
      `${workspace.github}/faults.json`,
      JSON.stringify({ createPull: { kind: "applied", remaining: 1 } }),
    );
    const stopped = await apply(workspace, branch.producer, planRevision);
    expect(stopped.json.reason).toBe("publish_uncertain");
    expect(await pullsOf(workspace)).toHaveLength(1);

    const settled = await apply(workspace, branch.producer, planRevision);
    expect(settled.json.reason).toBe("published");
    expect(settled.json.data.pullRequests[0].number).toBe((await pullsOf(workspace))[0]?.number);
    expect(await pullsOf(workspace)).toHaveLength(1);
  });

  test("a source with no commit on its branch has nothing to publish", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    await addRemote(workspace);
    await startProducer(workspace);

    const planned = await plan(workspace);
    expect(planned.json.reason).toBe("publish_refused");
    expect(reasons(planned)).toEqual(["branch_review_missing", "nothing_to_publish"]);
    expect((await nextActions(workspace)).forAction("publish_stack")).toEqual([]);
  });
});

describe("a source with one code commit", () => {
  test("its result review writes the published text, or its report refuses", async () => {
    const workspace = await makeReviewWorkspace(fixtures);
    await addRemote(workspace);
    const producer = await startProducer(workspace);
    const artifact = await commitArtifact(workspace, producer, "# Result\n");
    const submitted = await submit(workspace, producer, submissionBody(producer, artifact));
    expect(submitted.json.reason).toBe("result_submitted");
    const reviewer = await startReviewer(workspace, producer, submitted.json, artifact.commit);
    const brief = await Bun.file(`${reviewer.worktreePath}/.operator/local/brief.md`).text();
    expect(brief).toContain("This is the only code result of its source");

    const silent = await reportReview(
      workspace,
      reviewer,
      submitted.json.data.reviewId,
      reportBody({
        submissionIdentity: submitted.json.data.identity,
        host: workspace.host,
        published: null,
      }),
    );
    expect(silent.json.reason).toBe("review_published_text_missing");

    const reported = await reportReview(
      workspace,
      reviewer,
      submitted.json.data.reviewId,
      reportBody({ submissionIdentity: submitted.json.data.identity, host: workspace.host }),
    );
    expect(reported.json.reason).toBe("review_reported");
    await acceptReview(workspace, producer, {
      reviewAssignmentId: submitted.json.data.reviewAssignmentId,
      attemptId: reviewer.attemptId,
      revision: reviewer.revision,
    });
    const accepted = await acceptProduction(workspace, producer, {
      submissionId: submitted.json.data.submissionId,
      revision: submitted.json.data.revision,
    });
    expect(accepted.json.reason).toBe("assignment_accepted");
    expect(accepted.json.data.branchReview).toBeNull();

    const { planRevision, planPath } = await planAndApprove(workspace, producer);
    const body = await plannedBody(workspace, planPath);
    expect(body).toContain(PUBLISHED_TEXT.summary);
    expect(body).toContain("## Behavior changes\n\nNone.");
    const published = await apply(workspace, producer, planRevision);
    expect(published.json.reason).toBe("published");
    expect((await pullsOf(workspace))[0]?.title).toBe(PUBLISHED_TEXT.title);
  });
});

/**
 * Each refusal of the plan, read from one publishable source. A test changes one recorded fact,
 * GitHub setting, or remote, plans, and puts it back, so the plan, which changes nothing, reads
 * each refusal on its own.
 */
describe("each refusal of the plan", () => {
  const shared = workspaces();
  let workspace: Workspace;
  let branch: Awaited<ReturnType<typeof reviewedBranch>>;

  beforeAll(async () => {
    workspace = await makeReviewWorkspace(shared);
    branch = await reviewedBranch(workspace);
    const planned = await plan(workspace);
    expect(planned.json.reason).toBe("publish_planned");
  }, 300_000);

  afterAll(async () => {
    await shared.removeAll();
  });

  /** Plans with one change in place, and undoes it whatever the plan answered. */
  async function planWith(
    change: () => Promise<unknown> | void,
    undo: () => Promise<unknown> | void,
  ) {
    await change();
    try {
      return await plan(workspace);
    } finally {
      await undo();
    }
  }

  async function withGithub(edit: (state: Awaited<ReturnType<typeof readFake>>) => void) {
    const before = await readFake(workspace.github);
    const changed = structuredClone(before);
    edit(changed);
    return {
      change: () => writeFake(workspace.github, changed),
      undo: () => writeFake(workspace.github, before),
    };
  }

  const reviewId = () => branch.registered.reviewId;

  test("no branch review reported on the head", async () => {
    const planned = await planWith(
      () =>
        editState(workspace, [
          `update reviews set state = 'registered' where id = '${reviewId()}'`,
        ]),
      () =>
        editState(workspace, [`update reviews set state = 'reported' where id = '${reviewId()}'`]),
    );
    expect(reasons(planned)).toEqual(["branch_review_missing"]);
  });

  test("a finding with no disposition", async () => {
    const id = branch.idOf("naming");
    const planned = await planWith(
      () =>
        editState(workspace, [`update review_findings set disposition = null where id = '${id}'`]),
      () =>
        editState(workspace, [
          `update review_findings set disposition = 'deferred' where id = '${id}'`,
        ]),
    );
    expect(reasons(planned)).toEqual(["review_findings_undisposed"]);
  });

  test("a correction that is still pending", async () => {
    const id = branch.idOf("naming");
    const planned = await planWith(
      () =>
        editState(workspace, [
          `update review_findings set disposition = 'corrected' where id = '${id}'`,
        ]),
      () =>
        editState(workspace, [
          `update review_findings set disposition = 'deferred' where id = '${id}'`,
        ]),
    );
    expect(reasons(planned)).toEqual(["review_correction_pending"]);
  });

  test("a gate command the branch review did not observe at the head", async () => {
    const planned = await planWith(
      () =>
        editState(workspace, [
          `update review_reports set observed_checks = '[]' where review_id = '${reviewId()}'`,
        ]),
      () =>
        editState(workspace, [
          `update review_reports set observed_checks = '[{"name":"true","outcome":"passed"}]' where review_id = '${reviewId()}' and axis = 'standards'`,
        ]),
    );
    expect(reasons(planned)).toEqual(["branch_review_checks_missing"]);
  });

  test("an observed gate check that differs from the gate run at the head key", async () => {
    const planned = await planWith(
      () =>
        editState(workspace, [
          `update review_reports set observed_checks = '[{"name":"true","outcome":"failed"}]' where review_id = '${reviewId()}' and axis = 'standards'`,
        ]),
      () =>
        editState(workspace, [
          `update review_reports set observed_checks = '[{"name":"true","outcome":"passed"}]' where review_id = '${reviewId()}' and axis = 'standards'`,
        ]),
    );
    expect(reasons(planned)).toEqual(["branch_review_checks_differ"]);
  });

  test("an integration base with no passing gate run", async () => {
    const statement = (state: string) =>
      `update gate_runs set state = '${state}' where "commit" = '${branch.producer.baseCommit}'`;
    const planned = await planWith(
      () => editState(workspace, [statement("failed")]),
      () => editState(workspace, [statement("passed")]),
    );
    expect(reasons(planned)).toEqual(["gate_base_not_passed"]);
  });

  test("a commit of the head with no passing gate run", async () => {
    const statement = (state: string) =>
      `update gate_runs set state = '${state}' where "commit" = '${branch.secondCommit}'`;
    const planned = await planWith(
      () => editState(workspace, [statement("failed")]),
      () => editState(workspace, [statement("passed")]),
    );
    // The head run is also the run the observed checks compare with, so only the gate refuses.
    expect(reasons(planned)).toEqual(["gate_commit_not_passed"]);
  });

  test("an open invalidation", async () => {
    const id = branch.producer.assignmentId;
    const planned = await planWith(
      () =>
        editState(workspace, [`update assignments set state = 'invalidated' where id = '${id}'`]),
      () => editState(workspace, [`update assignments set state = 'accepted' where id = '${id}'`]),
    );
    expect(reasons(planned)).toEqual(["branch_review_missing", "invalidation_open"]);
  });

  test("a withdrawal whose commit the branch still holds", async () => {
    const id = branch.sibling.assignmentId;
    const planned = await planWith(
      () => editState(workspace, [`update assignments set state = 'withdrawn' where id = '${id}'`]),
      () => editState(workspace, [`update assignments set state = 'accepted' where id = '${id}'`]),
    );
    expect(reasons(planned)).toEqual(["branch_review_missing", "withdrawal_open"]);
  });

  test("an open direction request", async () => {
    const planned = await planWith(
      () =>
        editState(workspace, [
          `insert into direction_requests values ('direction-1', '${branch.producer.assignmentId}', 'rework_cycles', 3, '{"used":3,"detail":"x","attempted":[]}', 'open', null, 1, 'now', 'now')`,
        ]),
      () => editState(workspace, ["delete from direction_requests where id = 'direction-1'"]),
    );
    expect(reasons(planned)).toEqual(["direction_open"]);
  });

  test("a review recorded with no published text, as an earlier release recorded it", async () => {
    const text = JSON.stringify(PUBLISHED_TEXT).replaceAll("'", "''");
    const planned = await planWith(
      () =>
        editState(workspace, [
          `update reviews set published_text = null where id = '${reviewId()}'`,
        ]),
      () =>
        editState(workspace, [
          `update reviews set published_text = '${text}' where id = '${reviewId()}'`,
        ]),
    );
    expect(reasons(planned)).toEqual(["section_missing"]);
    expect(planned.json.data.planRevision).toBeNull();
  });

  test("a body over the GitHub limit", async () => {
    const long = JSON.stringify({ ...PUBLISHED_TEXT, summary: "word ".repeat(14_000) });
    const text = JSON.stringify(PUBLISHED_TEXT).replaceAll("'", "''");
    const planned = await planWith(
      () =>
        editState(workspace, [
          `update reviews set published_text = '${long}' where id = '${reviewId()}'`,
        ]),
      () =>
        editState(workspace, [
          `update reviews set published_text = '${text}' where id = '${reviewId()}'`,
        ]),
    );
    expect(reasons(planned)).toEqual(["body_too_long"]);
  });

  test("a repository that does not allow a merge commit", async () => {
    const edit = await withGithub((state) => {
      state.repositories = {
        "fveracoechea/operator": {
          default_branch: "main",
          allow_merge_commit: false,
          allow_squash_merge: true,
          allow_rebase_merge: false,
        },
      };
    });
    const planned = await planWith(edit.change, edit.undo);
    expect(reasons(planned)).toEqual(["merge_commit_not_allowed"]);
  });

  test("a target that requires a linear history, or whose ruleset leaves out merge", async () => {
    const edit = await withGithub((state) => {
      state.rules = {
        "fveracoechea/operator:main": [
          { type: "required_linear_history" },
          { type: "pull_request", parameters: { allowed_merge_methods: ["squash", "rebase"] } },
        ],
      };
    });
    const planned = await planWith(edit.change, edit.undo);
    expect(reasons(planned)).toEqual(["merge_commit_not_allowed", "merge_commit_not_allowed"]);
  });

  test("a target that requires signed commits", async () => {
    const edit = await withGithub((state) => {
      state.rules = { "fveracoechea/operator:main": [{ type: "required_signatures" }] };
    });
    const planned = await planWith(edit.change, edit.undo);
    expect(reasons(planned)).toEqual(["signatures_required"]);
  });

  test("rules that cannot be read are shown as unverified, never as a pass", async () => {
    const planned = await planWith(
      () =>
        Bun.write(
          `${workspace.github}/faults.json`,
          JSON.stringify({ readRules: { kind: "status:403", remaining: 1 } }),
        ),
      () => Bun.write(`${workspace.github}/faults.json`, "{}"),
    );
    expect(planned.json.reason).toBe("publish_planned");
    expect(planned.json.data.info.unverifiedRules).toEqual([
      expect.stringContaining("classic branch protection"),
      expect.stringContaining("branch rules of main"),
    ]);
  });

  test("no remote that names the repository", async () => {
    const planned = await planWith(
      () => Bun.$`git -C ${workspace.repo} remote rename origin elsewhere`.quiet().then(() => {}),
      () => Bun.$`git -C ${workspace.repo} remote rename elsewhere origin`.quiet().then(() => {}),
    );
    // A rename keeps the URL, so the remote is still found. A URL that names another repository
    // is what refuses.
    expect(reasons(planned)).toEqual([]);
    const missing = await planWith(
      () =>
        Bun.$`git -C ${workspace.repo} remote set-url origin https://github.com/someone/else.git`
          .quiet()
          .then(() => {}),
      () =>
        Bun.$`git -C ${workspace.repo} remote set-url origin https://github.com/fveracoechea/operator.git`
          .quiet()
          .then(() => {}),
    );
    expect(reasons(missing)).toEqual(["remote_missing"]);
  });

  test("two remotes that name the repository", async () => {
    const planned = await planWith(
      () =>
        Bun.$`git -C ${workspace.repo} remote add mirror git@github.com:fveracoechea/operator.git`
          .quiet()
          .then(() => {}),
      () => Bun.$`git -C ${workspace.repo} remote remove mirror`.quiet().then(() => {}),
    );
    expect(reasons(planned)).toEqual(["remote_ambiguous"]);
  });

  test("a remote branch name that already exists", async () => {
    const planned = await planWith(
      () =>
        Bun.$`git -C ${workspace.repo} push -q origin ${branch.firstCommit}:refs/heads/${NAME}`
          .quiet()
          .then(() => {}),
      () => Bun.$`git -C ${branch.bare} update-ref -d refs/heads/${NAME}`.quiet().then(() => {}),
    );
    expect(reasons(planned)).toEqual(["remote_name_taken"]);
  });

  test("an integration base that is not an ancestor of the target tip", async () => {
    const tip = (await Bun.$`git -C ${branch.bare} rev-parse refs/heads/main`.quiet()).stdout
      .toString()
      .trim();
    const planned = await planWith(
      async () => {
        const other =
          await Bun.$`git -C ${workspace.repo} -c user.email=t@example.com -c user.name=Test commit-tree -m unrelated ${`${tip}^{tree}`}`.quiet();
        await Bun.$`git -C ${workspace.repo} push -q --force origin ${other.stdout.toString().trim()}:refs/heads/main`.quiet();
      },
      async () => {
        await Bun.$`git -C ${workspace.repo} push -q --force origin ${tip}:refs/heads/main`.quiet();
      },
    );
    expect(reasons(planned)).toEqual(["base_not_on_target"]);
  });

  test("every refusal is reported at once, in the fixed order", async () => {
    const edit = await withGithub((state) => {
      state.repositories = {
        "fveracoechea/operator": {
          default_branch: "main",
          allow_merge_commit: false,
          allow_squash_merge: true,
          allow_rebase_merge: true,
        },
      };
      state.rules = { "fveracoechea/operator:main": [{ type: "required_signatures" }] };
    });
    const id = branch.idOf("naming");
    const planned = await planWith(
      async () => {
        await edit.change();
        editState(workspace, [
          `update review_findings set disposition = null where id = '${id}'`,
          `update gate_runs set state = 'failed' where "commit" = '${branch.secondCommit}'`,
        ]);
        await Bun.$`git -C ${workspace.repo} push -q origin ${branch.firstCommit}:refs/heads/${NAME}`.quiet();
      },
      async () => {
        await edit.undo();
        editState(workspace, [
          `update review_findings set disposition = 'deferred' where id = '${id}'`,
          `update gate_runs set state = 'passed' where "commit" = '${branch.secondCommit}'`,
        ]);
        await Bun.$`git -C ${branch.bare} update-ref -d refs/heads/${NAME}`.quiet();
      },
    );
    expect(planned.json.reason).toBe("publish_refused");
    expect(reasons(planned)).toEqual([
      "review_findings_undisposed",
      "gate_commit_not_passed",
      "merge_commit_not_allowed",
      "signatures_required",
      "remote_name_taken",
    ]);
  });

  test("a body that changed between the plan and the apply refuses, and nothing is written", async () => {
    const { planRevision } = await planAndApprove(workspace, branch.producer);
    const changed = JSON.stringify({ ...PUBLISHED_TEXT, mergeDanger: "The notes move." });
    const text = JSON.stringify(PUBLISHED_TEXT).replaceAll("'", "''");
    editState(workspace, [
      `update reviews set published_text = '${changed}' where id = '${reviewId()}'`,
    ]);
    try {
      const applied = await apply(workspace, branch.producer, planRevision);
      expect(applied.json.reason).toBe("plan_revision_changed");
      expect(applied.json.blockers[0].planned).not.toBe(planRevision);
    } finally {
      editState(workspace, [
        `update reviews set published_text = '${text}' where id = '${reviewId()}'`,
      ]);
    }
    expect(await remoteRefs(branch.bare)).not.toContain("operator/");
    expect(await pullsOf(workspace)).toEqual([]);
  });
});
