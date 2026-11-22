import { afterAll, afterEach, beforeAll, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { Err, ErrAsync, Ok, OkAsync, fromSafeThrowable } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import { Projects } from "../projects/main.ts";
import { WorkerKinds } from "../worker-kinds/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
// Bun has no symlink creation API.
import { symlink } from "node:fs/promises";
import { Workflow, stopped } from "./workflow.ts";
import { workflowFixture, workflowSeed } from "./workflow-fixture.ts";

let seed: Awaited<ReturnType<typeof workflowSeed>>;
let f: ReturnType<typeof workflowFixture>;
beforeAll(async () => {
  seed = await workflowSeed();
});
beforeEach(() => {
  f = workflowFixture(seed);
});
afterEach(() => {
  jest.restoreAllMocks();
});
afterAll(async () => {
  await seed.fixture.dispose();
});

function expectRefusal(
  result:
    | Awaited<ReturnType<typeof Workflow.deliver>>
    | Awaited<ReturnType<typeof Workflow.review>>,
  reason: string,
) {
  expect(result).toMatchObject({
    tag: "Err",
    error: {
      reason,
      detail: expect.stringMatching(/\S/) as string,
      next: expect.anything() as unknown,
    },
  });
}

test("every modeled process I/O failure preserves the person decision and unknown failures stay defects", async () => {
  for (const code of [
    "EACCES",
    "ENOENT",
    "ENOTDIR",
    "EEXIST",
    "EPERM",
    "EROFS",
    "ENOSPC",
    "EIO",
    "EMFILE",
    "ENFILE",
    "EPIPE",
  ]) {
    f.state.intercept = async () => {
      // oxlint-disable-next-line unthrown/no-throw -- Inject a process I/O failure at the public transport.
      throw Object.assign(new Error(`modeled ${code}`), { code });
    };
    expect(await Workflow.review(f.input)).toMatchObject({
      tag: "Err",
      error: {
        reason: "commit_io_failed",
        detail: `Error: modeled ${code}`,
        next: {
          decider: "person",
          question:
            "How should the filesystem failure be recovered without discarding partial effects?",
        },
      },
    });
  }
  for (const cause of [
    new Error("bug"),
    Object.assign(new Error("bug"), { code: "ERR_ASSERTION" }),
    Object.assign(new Error("bug"), { code: 17 }),
    { code: "EACCES" },
    null,
  ]) {
    f.state.intercept = async () => {
      // oxlint-disable-next-line unthrown/no-throw -- Unmodeled process failures retain the defect channel.
      throw cause;
    };
    expect(await Workflow.review(f.input)).toMatchObject({ tag: "Defect", cause });
  }
  expect(f.state.writes).toEqual([]);
});

test("unavailable and unanswered Git observations are not successful empty observations", async () => {
  for (const result of [
    { status: "unavailable", tool: "git", detail: "missing" },
    { status: "no-answer", detail: "timeout" },
  ] as const) {
    f.state.intercept = () => result;
    expectRefusal(await Workflow.review(f.input), "commit_git_failed");
  }
  expect(f.state.writes).toEqual([]);
});

test("new initialization stops at each failed observation and state-owner refusal", async () => {
  f.source.commitDeliveries = [];
  const input = {
    ...f.input,
    ...f.target,
    repository: "example/one",
    ticket: "#411",
    checkout: f.checkout,
    checks: [["git", "diff"]],
  };
  for (let failed = 0; failed < 5; failed++) {
    let call = 0;
    f.state.intercept = () => (call++ === failed ? f.completed("", 1) : undefined);
    expectRefusal(await Workflow.initialize(input), "commit_git_failed");
    expect(f.state.writes).toEqual([]);
  }
  f.state.intercept = undefined;
  const failure = {
    reason: "source_not_found" as const,
    detail: "No target.",
    next: { command: "operator next", why: "Recover." },
  };
  const projectFailure = {
    reason: "project_io_failed" as const,
    detail: "Cannot read registry.",
    next: { decider: "super-agent" as const, question: "Recover?" },
    state: { code: "EACCES" },
  };
  spyOn(Projects, "githubRemote").mockReturnValue(ErrAsync(projectFailure));
  expect(await Workflow.initialize(input)).toMatchObject({ tag: "Err", error: projectFailure });
  spyOn(DeviceState, "readSources").mockReturnValue(Err(failure));
  expect(await Workflow.initialize(input)).toMatchObject({ tag: "Err", error: failure });
  expect(await Workflow.review(f.input)).toMatchObject({ tag: "Err", error: failure });
  expect(f.state.writes).toEqual([]);
});

test("missing source rows or optional delivery rows can initialize but cannot select a worker target", async () => {
  const read = spyOn(DeviceState, "readSources");
  for (const rows of [[], [{ ...f.source, commitDeliveries: undefined }]]) {
    read.mockReturnValue(Ok(rows));
    expectRefusal(await Workflow.review(f.input), "commit_target_missing");
    expect(
      (
        await Workflow.initialize({
          ...f.input,
          ...f.target,
          repository: "example/one",
          ticket: "#411",
          checkout: f.checkout,
          checks: [["git", "diff"]],
        })
      ).tag,
    ).toBe("Ok");
  }
});

test.each(["fetch", "push"])(
  "a changed %s origin identity refuses before publication",
  async (side) => {
    await f.ready();
    if (side === "fetch") f.state.fetchUrl = "https://foreign/repo";
    else f.state.pushUrl = "https://foreign/repo";
    expectRefusal(await Workflow.deliver(f.delivery), "commit_remote_changed");
    expect(f.state.local).toBe(f.base);
    expect(f.state.remote).toBe(f.base);
  },
);

test("dirty and empty ticket worktrees preserve their contents and create no candidate", async () => {
  const ticket = f.tree(f.worktree);
  ticket.others = "personal\n";
  expectRefusal(await Workflow.review(f.input), "commit_worktree_unclean");
  expect(f.state.writes).toEqual([]);
  ticket.others = "";
  ticket.headTree = f.baseTree;
  ticket.index = f.baseTree;
  ticket.worktree = f.baseTree;
  expectRefusal(await Workflow.review(f.input), "commit_empty");
  expect(f.state.writes).toEqual([]);
});

test("review creates the promised command protocol and returns the handoff target", async () => {
  expect(await Workflow.review(f.input)).toMatchObject({
    tag: "Ok",
    value: { sourceId: "source", assignment: "ticket", checkout: f.checkout },
  });
  const candidate = f.candidate();
  expect(candidate.branch).toMatch(/^operator\/commit-candidate\/[a-f0-9-]+$/);
  const calls = f.tools.mock.calls.map(([input]) => input);
  expect(calls).toContainEqual({
    tool: "git",
    args: ["status", "--porcelain", "--untracked-files=all"],
    cwd: f.worktree,
    timeoutMs: 120000,
    input: undefined,
  });
  expect(calls).toContainEqual({
    tool: "git",
    args: ["worktree", "add", "-b", candidate.branch, candidate.path, f.base],
    cwd: f.checkout,
    timeoutMs: 120000,
    input: undefined,
  });
  expect(calls).toContainEqual({
    tool: "git",
    args: ["commit", "-m", "Ticket #411\n\nOperator-Ticket: source/ticket"],
    cwd: candidate.path,
    timeoutMs: 120000,
    input: undefined,
  });
  expect(calls).toContainEqual({
    tool: "git",
    args: ["show", "-s", "--format=%H%n%P%n%T%n%B", "HEAD"],
    cwd: candidate.path,
    timeoutMs: 120000,
    input: undefined,
  });
  expect(calls).toContainEqual({
    tool: "git",
    args: [
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-textconv",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      f.base,
      f.ticketTree,
      "--",
    ],
    cwd: candidate.path,
    timeoutMs: 120000,
    input: undefined,
  });
  expect(calls).toContainEqual({
    tool: "git",
    args: ["apply", "--index", "--whitespace=nowarn"],
    cwd: candidate.path,
    timeoutMs: 120000,
    input: "independent fixture binary patch\n",
  });
  expectRefusal(await Workflow.review(f.input), "commit_review_started");
});

test.each(["parent", "tree", "identity", "coauthor"])(
  "invalid candidate %s is not recorded as a reviewed commit",
  async (fault) => {
    if (fault === "parent") f.state.parent = "f".repeat(40);
    if (fault === "identity") f.state.message = "unrelated ticket";
    if (fault === "coauthor") f.state.message += "\nCo-Authored-By: Other <other@example.com>";
    if (fault === "tree")
      f.state.intercept = (input) =>
        input.args[0] === "show"
          ? f.completed(
              `${f.candidateHead}\n${f.base}\n${f.baseTree}\nOperator-Ticket: source/ticket`,
            )
          : undefined;
    expectRefusal(await Workflow.review(f.input), "commit_candidate_invalid");
    expect(f.data().candidate?.head).toBeNull();
    expect(f.data().history).toEqual([]);
    expect(f.state.local).toBe(f.base);
  },
);

test("ordinary message text mentioning attribution does not invent a coauthor trailer", async () => {
  f.state.message += "\nWe forbid co-authored-by: trailers.\nOperator-Ticket:\nsource/ticket";
  expect((await Workflow.review(f.input)).tag).toBe("Ok");
});

test.each(["no-implementer", "same-launch", "wrong-stage"])(
  "%s cannot record rounds or deliver as a fresh reviewer",
  async (fault) => {
    await f.review();
    const data = f.data();
    if (fault === "no-implementer") {
      data.implementer = null;
      data.stage = "build";
    }
    if (fault === "same-launch") data.implementer = "reviewer";
    if (fault === "wrong-stage") data.stage = "build";
    f.replace(data);
    const before = f.data();
    expectRefusal(
      await Workflow.round({ ...f.input, text: "## Findings" }),
      "commit_reviewer_required",
    );
    if (fault !== "wrong-stage")
      expectRefusal(await Workflow.deliver(f.delivery), "commit_reviewer_required");
    expect(f.data()).toEqual(before);
  },
);

test("rounds preserve parsed findings and refuse invalid, unchanged and exhausted reviews", async () => {
  await f.review();
  const before = f.data();
  expect(await Workflow.round({ ...f.input, text: "invalid" })).toMatchObject({
    tag: "Err",
    error: {
      reason: "internal_review_findings_invalid",
      next: { command: "operator commit round --file <path|->" },
    },
  });
  expect(f.data()).toEqual(before);
  const finding = {
    severity: "nice-to-have",
    axis: "Spec",
    location: "feature",
    claim: "Explain behavior.",
  };
  expect(
    await Workflow.round({
      ...f.input,
      text: "## Findings\n- nice-to-have, Spec, feature: Explain behavior.",
    }),
  ).toMatchObject({
    tag: "Ok",
    value: { rounds: [{ head: f.candidateHead, tree: f.ticketTree, findings: [finding] }] },
  });
  expectRefusal(
    await Workflow.round({ ...f.input, text: "## Findings" }),
    "commit_round_head_unchanged",
  );
  const data = f.data();
  data.rounds.push({ head: "f".repeat(40), tree: f.ticketTree, findings: [] });
  f.replace(data);
  expect(await Workflow.round({ ...f.input, text: "## Findings" })).toMatchObject({
    tag: "Err",
    error: {
      reason: "commit_review_limit",
      detail: "Two review rounds are exhausted. Automatic delivery stops.",
      next: {
        decider: "person",
        question: "How should this ticket continue after its two review rounds are exhausted?",
      },
    },
  });
});

test("a findings defect remains a defect rather than a malformed-input refusal", async () => {
  await f.review();
  const cause = new Error("parser defect");
  const defect = fromSafeThrowable(() => {
    // oxlint-disable-next-line unthrown/no-throw -- Inject an unmodeled collaborator failure.
    throw cause;
  })();
  spyOn(WorkSources, "parseFindings").mockReturnValue(defect);
  const result = await Workflow.round({ ...f.input, text: "## Findings" });
  expect(result.tag).toBe("Defect");
  if (result.tag !== "Defect") return expect.unreachable();
  expect(result.cause).toBe(cause);
});

test("invalid disposition syntax never changes review or publication evidence", async () => {
  await f.ready();
  const before = f.data();
  for (const text of [
    "",
    "## Disposition",
    "## Dispositions\nx- 1.1 applied",
    "## Dispositions\n- 1.1 applied suffix",
    "## Dispositions\n- 1x1 applied",
    "## Dispositions\n- x.1 applied",
    "## Dispositions\n- 1.x applied",
    "## Dispositions\n- 1.1 declined:",
  ]) {
    expectRefusal(await Workflow.deliver({ ...f.input, text }), "commit_input_invalid");
    expect(f.data()).toEqual(before);
  }
});

test("dispositions preserve applied, declined, multi-digit identifiers and whitespace", async () => {
  await f.ready();
  const data = f.data();
  const findings = Array.from({ length: 12 }, (_, index) => ({
    severity: "nice-to-have" as const,
    axis: "Spec" as const,
    location: "feature",
    claim: `Finding ${index}`,
  }));
  data.rounds[0] = { head: f.candidateHead, tree: f.ticketTree, findings };
  f.replace(data);
  const rows = findings.map(
    (_, index) => `- 1.${index + 1} ${index === 0 ? "declined: Already documented." : "applied"}`,
  );
  const text = `  ## Dispositions\r\n\r\n ${rows.join("\r\n ")} \r\n`;
  const expected = findings.map((_, index) =>
    index === 0
      ? { round: 1, finding: 1, disposition: "declined" as const, reason: "Already documented." }
      : { round: 1, finding: index + 1, disposition: "applied" as const },
  );
  const delivered = await Workflow.deliver({ ...f.input, text });
  expect(delivered).toMatchObject({
    tag: "Ok",
    value: { dispositions: expected },
  });
  if (delivered.tag !== "Ok") return expect.unreachable();
  expect(delivered.value.dispositions).toStrictEqual(expected);
});

test.each(["missing", "incomplete", "blocker", "limit", "changed"])(
  "%s review policy refuses with its exact next action and only allowed evidence writes",
  async (kind) => {
    await f.ready();
    const data = f.data();
    if (kind === "missing") data.rounds = [];
    if (kind === "changed")
      data.rounds[0] = { head: "f".repeat(40), tree: f.ticketTree, findings: [] };
    if (kind === "incomplete" || kind === "blocker" || kind === "limit")
      data.rounds[0] = {
        head: f.candidateHead,
        tree: f.ticketTree,
        findings: [{ severity: "blocker", axis: "Spec", location: "feature", claim: "Fix." }],
      };
    if (kind === "limit")
      data.rounds.unshift({ head: "f".repeat(40), tree: f.ticketTree, findings: [] });
    f.replace(data);
    const before = f.data();
    const writesBefore = f.state.writes.length;
    const text =
      kind === "blocker"
        ? "## Dispositions\n- 1.1 applied"
        : kind === "limit"
          ? "## Dispositions\n- 2.1 applied"
          : "## Dispositions";
    const reason = {
      missing: "review_missing",
      incomplete: "dispositions_incomplete",
      blocker: "blocker_requires_review",
      limit: "review_limit",
      changed: "candidate_changed",
    }[kind];
    const next =
      kind === "limit"
        ? {
            decider: "person",
            question: "How should this ticket continue after its two review rounds are exhausted?",
          }
        : kind === "blocker"
          ? {
              command: "operator commit round --file <file>",
              why: "Commit the blocker fixes, then review the newer candidate.",
            }
          : {
              command: "operator next",
              why: "Read the recorded commit-delivery state. Preserve partial effects and retained history.",
            };
    expect(await Workflow.deliver({ ...f.input, text })).toMatchObject({
      tag: "Err",
      error: {
        reason: `commit_${reason}`,
        next,
        detail:
          "Automatic delivery requires complete dispositions and a clean final round on the exact candidate. Preserve work and ask the person when two rounds are exhausted.",
      },
    });
    if (kind !== "blocker" && kind !== "limit") {
      expect(f.data()).toEqual(before);
      expect(f.state.writes).toHaveLength(writesBefore);
    } else
      expect(f.data().dispositions).toEqual([
        { round: kind === "limit" ? 2 : 1, finding: 1, disposition: "applied" },
      ]);
    expect(f.state.local).toBe(f.base);
    expect(f.state.remote).toBe(f.base);
  },
);

test.each(["null", "headless"])("%s candidate cannot begin delivery", async (kind) => {
  await f.ready();
  const data = f.data();
  data.candidate = kind === "null" ? null : { ...f.candidate(), head: null };
  data.stage = "build";
  f.replace(data);
  expectRefusal(await Workflow.deliver(f.delivery), "commit_candidate_missing");
  expect(f.state.local).toBe(f.base);
});

test("delivery uses exact repository observations, safe apply, CAS and non-forced publication", async () => {
  await f.ready();
  f.tools.mockClear();
  expect((await Workflow.deliver(f.delivery)).tag).toBe("Ok");
  const calls = f.tools.mock.calls.map(([input]) => input);
  for (const args of [
    ["symbolic-ref", "HEAD"],
    ["worktree", "list", "--porcelain"],
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    ["diff", "--name-only", f.ticketTree, "--"],
    ["ls-files", "--others", "--exclude-standard"],
    ["update-ref", "-m", "Operator ticket ticket", "refs/heads/main", f.candidateHead, f.base],
    ["fetch", "--no-tags", "origin", f.base],
    ["push", "origin", `${f.candidateHead}:refs/heads/main`],
  ])
    expect(calls).toContainEqual({
      tool: "git",
      args,
      cwd: f.checkout,
      timeoutMs: 120000,
      input: undefined,
    });
  expect(calls).toContainEqual({
    tool: "git",
    args: ["merge-base", "--is-ancestor", f.candidateHead, f.base],
    cwd: f.checkout,
    timeoutMs: 10000,
  });
});

test.each(["index", "worktree", "untracked", "head"])(
  "configured checks cannot dirty candidate %s",
  async (part) => {
    await f.ready();
    f.state.intercept = (input) => {
      if (input.args.join(" ") === "diff --exit-code") {
        const candidate = f.tree(f.candidate().path);
        if (part === "head") candidate.head = "f".repeat(40);
        if (part === "index") candidate.index = f.baseTree;
        if (part === "worktree") candidate.worktree = f.baseTree;
        if (part === "untracked") candidate.others = "personal\n";
      }
      return undefined;
    };
    expectRefusal(
      await Workflow.deliver(f.delivery),
      part === "head" ? "commit_candidate_changed" : "commit_worktree_unclean",
    );
    expect(f.state.local).toBe(f.base);
    expect(f.state.remote).toBe(f.base);
    expect(f.data().checks).toBeNull();
  },
);

test.each(["no-answer", "nonzero", "io", "defect"])(
  "configured check %s failure releases ownership without approving a candidate",
  async (kind) => {
    await f.ready();
    f.state.intercept = async (input) => {
      if (input.args.join(" ") !== "diff --exit-code") return undefined;
      if (kind === "no-answer") return { status: "no-answer", detail: "timeout" };
      if (kind === "nonzero") return f.completed("failed", 17);
      // oxlint-disable-next-line unthrown/no-throw -- Inject failures at the public process boundary.
      throw Object.assign(new Error("check defect"), {
        code: kind === "io" ? "EACCES" : "ERR_ASSERTION",
      });
    };
    const result = await Workflow.deliver(f.delivery);
    if (kind === "defect") expect(result.tag).toBe("Defect");
    else expectRefusal(result, kind === "io" ? "commit_io_failed" : "commit_checks_failed");
    if (kind === "nonzero")
      expect(result).toMatchObject({
        tag: "Err",
        error: {
          detail:
            'Configured check failed: {"argv":["git","diff","--exit-code"],"result":{"status":"completed","exitCode":17,"stdout":"failed","stderr":""}}',
        },
      });
    expect(f.data()).toMatchObject({ checks: null, ownerPid: null, leaseAt: null });
    expect(f.state.local).toBe(f.base);
  },
);

test.each([
  "ticket",
  "local",
  "remote",
  "repository",
  "branch",
  "root",
  "foreign-target",
  "multiple-targets",
  "missing-target",
])("%s changed observation refuses without overwriting targets", async (kind) => {
  await f.ready();
  if (kind === "ticket") {
    Object.assign(f.tree(f.worktree), {
      headTree: f.baseTree,
      index: f.baseTree,
      worktree: f.baseTree,
    });
  }
  if (kind === "local") f.state.local = "f".repeat(40);
  if (kind === "remote") f.state.remote = "f".repeat(40);
  if (kind === "repository") f.state.common.set(f.checkout, "/foreign/.git");
  if (kind === "branch") f.state.localRef = "refs/heads/other";
  if (kind === "root")
    f.state.intercept = (input) =>
      input.cwd === f.checkout && input.args.includes("--show-toplevel")
        ? f.completed("/foreign")
        : undefined;
  if (kind === "foreign-target")
    f.state.worktrees = `worktree ${f.checkout}-foreign\nHEAD ${f.base}\nbranch refs/heads/main\n`;
  if (kind === "multiple-targets")
    f.state.worktrees = `worktree ${f.checkout}\nHEAD ${f.base}\nbranch refs/heads/main\n\nworktree /other\nHEAD ${f.base}\nbranch refs/heads/main\n`;
  if (kind === "missing-target")
    f.state.worktrees = `worktree ${f.checkout}\nHEAD ${f.base}\nbranch refs/heads/other\n`;
  const reason = {
    ticket: "candidate_changed",
    local: "local_advanced",
    remote: "remote_advanced",
    repository: "foreign_checkout",
    branch: "unsupported_checkout",
    root: "foreign_checkout",
    "foreign-target": "unsupported_checkout",
    "multiple-targets": "unsupported_checkout",
    "missing-target": "unsupported_checkout",
  }[kind];
  expectRefusal(await Workflow.deliver(f.delivery), `commit_${reason}`);
  expect(f.state.local).toBe(kind === "local" ? "f".repeat(40) : f.base);
  expect(f.state.remote).toBe(kind === "remote" ? "f".repeat(40) : f.base);
});

test("unrelated checked-out branches do not make the single main checkout unsupported", async () => {
  await f.ready();
  f.state.worktrees = `worktree ${f.checkout}\nHEAD ${f.base}\nbranch refs/heads/main\n\nworktree /ticket\nHEAD ${f.base}\nbranch refs/heads/other\n`;
  expect((await Workflow.deliver(f.delivery)).tag).toBe("Ok");
});

test.each([
  "index.lock",
  "HEAD.lock",
  "refs/heads/main.lock",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "rebase-merge",
  "rebase-apply",
  "sequencer",
])("%s marker preserves its file and prevents target writes", async (marker) => {
  await f.ready();
  const file = `${f.root}/busy/${marker}`;
  await Bun.write(file, "personal lock\n");
  f.state.intercept = (input) =>
    input.args[0] === "rev-parse" &&
    input.args.includes("--git-path") &&
    input.args.at(-1) === marker
      ? f.completed(file)
      : undefined;
  expect(await Workflow.deliver(f.delivery)).toMatchObject({
    tag: "Err",
    error: {
      reason: "commit_checkout_busy",
      detail: `The controlling checkout is busy at ${marker}. Nothing was overwritten.`,
    },
  });
  expect(await Bun.file(file).text()).toBe("personal lock\n");
  await Bun.file(file).delete();
  expect(f.state.local).toBe(f.base);
});

test("relative Git marker paths resolve against the controlling checkout", async () => {
  await f.ready();
  const file = `${f.checkout}/relative-marker`;
  await Bun.write(file, "busy\n");
  f.state.intercept = (input) =>
    input.args.includes("--git-path") ? f.completed("relative-marker") : undefined;
  expectRefusal(await Workflow.deliver(f.delivery), "commit_checkout_busy");
  await Bun.file(file).delete();
});

test("filesystem obstructions stay intact and are operational failures", async () => {
  const obstruction = `${f.root}/obstruction`;
  await Bun.write(obstruction, "personal\n");
  spyOn(OperatorHome, "commitCandidateRoot").mockReturnValue(obstruction);
  spyOn(OperatorHome, "commitCandidate").mockReturnValue(`${obstruction}/candidate`);
  expectRefusal(await Workflow.review(f.input), "commit_io_failed");
  expect(await Bun.file(obstruction).text()).toBe("personal\n");
  expect(f.data().history).toEqual([]);
  expect(f.tools.mock.calls.some(([input]) => input.args[0] === "worktree")).toBe(false);
  await Bun.file(obstruction).delete();
});

test("malformed remote observations never invent an unambiguous target", async () => {
  await f.ready();
  for (const observed of [
    `prefix${f.base}\trefs/heads/main`,
    `${f.base}\trefs/heads/main-suffix`,
    `${f.base}\trefs/heads/main\n${f.base}\trefs/heads/main`,
    "",
    `${"a".repeat(39)}\trefs/heads/main`,
  ]) {
    f.state.intercept = (input) =>
      input.args[0] === "ls-remote" ? f.completed(observed) : undefined;
    expectRefusal(await Workflow.deliver(f.delivery), "commit_remote_invalid");
    expect(f.state.local).toBe(f.base);
  }
  f.state.intercept = (input) =>
    input.args[0] === "ls-remote" ? f.completed(`${f.state.remote} \t refs/heads/main`) : undefined;
  expect((await Workflow.deliver(f.delivery)).tag).toBe("Ok");
});

for (const operation of ["review", "round", "deliver"] as const) {
  test(`${operation} preserves every state-owner refusal rather than continuing effects`, async () => {
    if (operation !== "review") await f.review();
    if (operation === "deliver")
      expect((await Workflow.round({ ...f.input, text: "## Findings" })).tag).toBe("Ok");
    function run() {
      return operation === "review"
        ? Workflow.review(f.input)
        : operation === "round"
          ? Workflow.round({ ...f.input, text: "## Findings" })
          : Workflow.deliver(f.delivery);
    }
    f.write.mockClear();
    expect((await run()).tag).toBe("Ok");
    const writes = f.write.mock.calls.length;
    for (let failed = 0; failed < writes; failed++) {
      jest.restoreAllMocks();
      f = workflowFixture(seed);
      if (operation !== "review") await f.review();
      if (operation === "deliver")
        expect((await Workflow.round({ ...f.input, text: "## Findings" })).tag).toBe("Ok");
      const original = f.write.getMockImplementation() ?? expect.unreachable();
      const failure = {
        reason: "commit_delivery_running",
        detail: `write ${failed}`,
        next: { command: "operator next --wait", why: "Wait." },
      };
      let call = 0;
      f.write.mockImplementation((...args) =>
        call++ === failed ? Err(failure) : original(...args),
      );
      expect(await run(), `${operation} write ${failed}`).toMatchObject({
        tag: "Err",
        error: failure,
      });
      expect(f.state.writes.some((change) => change.complete)).toBe(false);
    }
  });
}

test.each(["missing", "intent", "mismatched"])(
  "a %s creation receipt is reconciled against the pinned object",
  async (kind) => {
    await f.ready();
    const data = f.data();
    data.journal = data.journal.filter((row) => row.effect !== "candidate_creation");
    if (kind === "intent")
      data.journal.push({ effect: "candidate_creation", state: "intent", at: "old" });
    // An unrelated receipt must not prove candidate creation.
    data.journal.push({ effect: "unrelated", state: "verified", at: "old" });
    f.replace(data);
    if (kind === "mismatched") f.tree(f.candidate().path).head = "f".repeat(40);
    const result = await Workflow.deliver(f.delivery);
    if (kind === "mismatched") {
      expect(result).toMatchObject({
        tag: "Err",
        error: {
          reason: "commit_candidate_changed",
          detail: "The pinned candidate no longer matches its creation intent.",
        },
      });
      expect(f.data().checks).toBeNull();
      expect(f.data().journal.some((row) => row.effect === "delivery_admission")).toBe(false);
    } else {
      expect(result.tag).toBe("Ok");
      expect(f.data().journal.filter((row) => row.effect === "candidate_creation")).toMatchObject([
        ...(kind === "intent"
          ? [{ effect: "candidate_creation", state: "intent", at: "old" }]
          : []),
        {
          effect: "candidate_creation",
          state: "verified",
          at: expect.stringMatching(/\S/) as string,
        },
      ]);
    }
  },
);

test("a retry observes an already-created candidate without another commit or worktree", async () => {
  await f.review();
  const data = f.data();
  data.stage = "build";
  data.implementer = null;
  data.candidate = { ...f.candidate(), head: null };
  data.history = [];
  data.journal = data.journal.filter(
    (row) => row.state !== "verified" || row.effect !== "candidate_creation",
  );
  f.replace(data);
  f.tools.mockClear();
  expect((await Workflow.review(f.input)).tag).toBe("Ok");
  expect(f.data()).toMatchObject({
    history: [f.candidateHead],
    candidate: { head: f.candidateHead },
  });
  expect(
    f.tools.mock.calls.some(
      ([input]) => input.args[0] === "commit" || input.args[0] === "worktree",
    ),
  ).toBe(false);
});

test.each(["intent", "missing", "verified-only", "foreign-intent"])(
  "candidate index recovery requires its own %s receipt",
  async (kind) => {
    await f.review();
    const candidate = f.candidate();
    const data = f.data();
    data.stage = "build";
    data.implementer = null;
    data.candidate = { ...candidate, head: null };
    data.history = [];
    data.journal = [{ effect: "unrelated", state: "verified", at: "old" }];
    if (kind !== "missing")
      data.journal.push({
        effect: kind === "foreign-intent" ? "foreign" : `candidate_index:${candidate.branch}`,
        state: kind === "verified-only" ? "verified" : "intent",
        at: "old",
      });
    f.replace(data);
    Object.assign(f.tree(candidate.path), { head: f.base, headTree: f.baseTree });
    f.tools.mockClear();
    const result = await Workflow.review(f.input);
    if (kind === "intent") {
      expect(result.tag).toBe("Ok");
      expect(f.data().journal).toContainEqual({
        effect: `candidate_index:${candidate.branch}`,
        state: "verified",
        at: expect.stringMatching(/\S/) as string,
      });
      expect(f.tools.mock.calls.some(([input]) => input.args[0] === "apply")).toBe(false);
    } else expectRefusal(result, "commit_worktree_unclean");
  },
);

test.each(["candidate", "checkout"])(
  "a concurrent %s installation change is not journaled as verified",
  async (location) => {
    if (location === "checkout") await f.ready();
    f.state.intercept = (input) => {
      if (input.args[0] === "apply") {
        const current = f.tree(input.cwd ?? expect.unreachable());
        current.index = f.ticketTree;
        current.worktree = f.baseTree;
        return f.completed();
      }
      return undefined;
    };
    expectRefusal(
      await (location === "candidate" ? Workflow.review(f.input) : Workflow.deliver(f.delivery)),
      "commit_checkout_changed",
    );
    expect(f.state.local).toBe(f.base);
    expect(
      f
        .data()
        .journal.some(
          (row) =>
            row.effect ===
              (location === "candidate"
                ? `candidate_index:${f.candidate().branch}`
                : "checkout_index") && row.state === "verified",
        ),
    ).toBe(false);
  },
);

test.each(["intent", "missing", "verified-only", "foreign-intent"])(
  "checkout recovery requires its own %s receipt",
  async (kind) => {
    await f.ready();
    // Stop immediately before the target changes, then model an interrupted owned installation.
    f.state.intercept = (input) =>
      input.args[0] === "apply" && input.cwd === f.checkout ? f.completed("", 1) : undefined;
    expectRefusal(await Workflow.deliver(f.delivery), "commit_git_failed");
    const data = f.data();
    data.journal = data.journal.filter((row) => row.effect !== "checkout_index");
    if (kind !== "missing")
      data.journal.push({
        effect: kind === "foreign-intent" ? "foreign" : "checkout_index",
        state: kind === "verified-only" ? "verified" : "intent",
        at: "old",
      });
    f.replace(data);
    Object.assign(f.tree(f.checkout), { index: f.ticketTree, worktree: f.ticketTree });
    f.state.intercept = undefined;
    f.tools.mockClear();
    const result = await Workflow.deliver(f.delivery);
    if (kind === "intent") {
      expect(result.tag).toBe("Ok");
      expect(
        f.tools.mock.calls.some(
          ([input]) => input.args[0] === "apply" || input.args.join(" ") === "diff --exit-code",
        ),
      ).toBe(false);
    } else expectRefusal(result, "commit_worktree_unclean");
  },
);

test.each(["remote", "finalize"])(
  "a %s retry reuses local advancement and never regresses its stage",
  async (stage) => {
    await f.ready();
    f.state.intercept = (input) => (input.args[0] === "push" ? f.completed("", 1) : undefined);
    expectRefusal(await Workflow.deliver(f.delivery), "commit_git_failed");
    const data = f.data();
    data.stage = stage;
    f.replace(data);
    f.state.intercept = undefined;
    f.tools.mockClear();
    const offset = f.state.writes.length;
    expect((await Workflow.deliver(f.delivery)).tag).toBe("Ok");
    const changes = f.state.writes
      .slice(offset)
      .map((change) => DeviceState.commitDeliverySchema().parse(JSON.parse(change.data)));
    expect(changes.find((change) => change.journal.at(-1)?.effect === "local_ref")?.stage).toBe(
      stage,
    );
    expect(
      f.tools.mock.calls.some(([input]) =>
        ["commit", "apply", "update-ref"].includes(input.args[0] ?? ""),
      ),
    ).toBe(false);
  },
);

test.each([
  "already-contained",
  "uncertain-success",
  "uncertain-failure",
  "defect-after-push",
  "no-answer-ancestry",
])("%s publication reconciles evidence without forced retry", async (kind) => {
  await f.ready();
  f.state.intercept = (input) => {
    if (input.args[0] === "push") {
      if (kind === "uncertain-success" || kind === "defect-after-push")
        f.state.remote = f.candidateHead;
      if (kind === "uncertain-success" || kind === "uncertain-failure") return f.completed("", 1);
      if (kind === "defect-after-push") {
        // oxlint-disable-next-line unthrown/no-throw -- A push programming failure is not hidden by successful remote observation.
        throw new Error("push defect");
      }
    }
    if (input.args[0] === "merge-base" && kind === "no-answer-ancestry")
      return { status: "no-answer", detail: "ancestry timeout" };
    if (
      input.args[0] === "remote" &&
      f.state.local === f.candidateHead &&
      kind === "already-contained"
    ) {
      f.state.contains = true;
      f.state.remote = "f".repeat(40);
    }
    return undefined;
  };
  const result = await Workflow.deliver(f.delivery);
  if (kind === "uncertain-failure") expectRefusal(result, "commit_git_failed");
  else if (kind === "no-answer-ancestry") expectRefusal(result, "commit_remote_uncertain");
  else if (kind === "defect-after-push") expect(result.tag).toBe("Defect");
  else {
    expect(result.tag).toBe("Ok");
    expect(f.data().publishedHead).toBe(
      kind === "already-contained" ? "f".repeat(40) : f.candidateHead,
    );
  }
  if (kind === "already-contained")
    expect(f.tools.mock.calls.some(([input]) => input.args[0] === "push")).toBe(false);
});

test.each([
  "completion",
  "kind-completion",
  "kind-missing",
  "launch-missing",
  "stopped",
  "worktree-missing",
])("%s worker facts refuse before any Git or state effects", async (kind) => {
  const launch = f.pane.launch ?? expect.unreachable();
  if (kind === "completion") f.pane.assignment.completion = "report";
  if (kind === "kind-completion")
    launch.kind = JSON.stringify(WorkerKinds.resolve("implementation"));
  if (kind === "kind-missing") launch.kind = null;
  if (kind === "launch-missing") f.pane.launch = null;
  if (kind === "stopped") launch.state = "finished";
  if (kind === "worktree-missing") launch.worktreePath = null;
  expectRefusal(await Workflow.review(f.input), "commit_owner_inactive");
  expect(f.tools).not.toHaveBeenCalled();
  expect(f.state.writes).toEqual([]);
});

test("missing caller identifiers stay empty and the state owner's refusal is preserved", async () => {
  delete f.environment.HERDR_SOCKET_PATH;
  delete f.environment.HERDR_PANE_ID;
  const failure = {
    reason: "worker_launch_not_found",
    detail: "No caller.",
    next: { command: "operator next", why: "Recover." },
  };
  const read = spyOn(DeviceState, "readReport").mockReturnValue(Err(failure));
  expect(await Workflow.review(f.input)).toMatchObject({ tag: "Err", error: failure });
  expect(read).toHaveBeenCalledWith(f.paths, { by: "pane", socket: "", paneId: "" });
  expect(f.tools).not.toHaveBeenCalled();
});

test.each([null, "custom-review"])(
  "review handoff uses the snapshot successor %s",
  async (nextKind) => {
    const launch = f.pane.launch ?? expect.unreachable();
    const snapshot = WorkerKinds.snapshotSchema().parse(JSON.parse(launch.kind ?? ""));
    launch.kind = JSON.stringify({ ...snapshot, nextKind });
    expect((await Workflow.review(f.input)).tag).toBe("Ok");
    expect(f.state.writes.at(-1)?.handoff).toBe(nextKind ?? "commit-review");
  },
);

test("a foreign caller and a missing assignment target cannot create candidates", async () => {
  f.state.toplevel = "/foreign";
  expectRefusal(await Workflow.review(f.input), "commit_foreign_worktree");
  expect(f.state.writes).toEqual([]);
  f.state.toplevel = f.worktree;
  for (const rows of [
    undefined,
    [],
    [{ ...(f.source.commitDeliveries?.[0] ?? expect.unreachable()), assignment: "other" }],
  ]) {
    f.source.commitDeliveries = rows;
    expectRefusal(await Workflow.review(f.input), "commit_target_missing");
  }
  expect(f.state.writes).toEqual([]);
});

test("initialization reuses the matching assignment target without another observation or write", async () => {
  const initial = f.data();
  const row = f.source.commitDeliveries?.[0] ?? expect.unreachable();
  const different = { ...initial, ticket: "#999" };
  f.source.commitDeliveries = [
    { ...row, assignment: "other", data: JSON.stringify(different) },
    row,
  ];
  expect(
    await Workflow.initialize({
      ...f.input,
      ...f.target,
      repository: "example/one",
      ticket: "#411",
      checkout: f.checkout,
      checks: [["git", "diff", "--exit-code"]],
    }),
  ).toMatchObject({ tag: "Ok", value: initial });
  expect(f.tools).not.toHaveBeenCalled();
  expect(f.state.writes).toEqual([]);
});

test("new initialization pins the repository, refs, base and configured checks", async () => {
  f.source.commitDeliveries = [];
  const result = await Workflow.initialize({
    ...f.input,
    ...f.target,
    repository: "example/one",
    ticket: "#411",
    checkout: f.checkout,
    checks: [["git", "status"]],
  });
  expect(result).toMatchObject({
    tag: "Ok",
    value: {
      repository: "example/one",
      ticket: "#411",
      checkout: f.checkout,
      localRef: "refs/heads/main",
      remoteRef: "refs/heads/main",
      base: f.base,
      remote: "https://github.com/example/one.git",
      publishedHead: null,
      candidate: null,
      history: [],
      implementer: null,
      rounds: [],
      dispositions: [],
      policy: { checks: [["git", "status"]], review: "required", publication: "local-and-origin" },
      checks: null,
      journal: [],
      stage: "build",
      ownerPid: null,
      leaseAt: null,
    },
  });
});

test.each(["upstream", "diverged"])(
  "new %s target refuses without replacing evidence",
  async (scenario) => {
    f.source.commitDeliveries = [];
    if (scenario === "upstream")
      spyOn(Projects, "githubRemote").mockReturnValue(OkAsync("upstream"));
    else f.state.remote = "f".repeat(40);
    expectRefusal(
      await Workflow.initialize({
        ...f.input,
        ...f.target,
        repository: "example/one",
        ticket: "#411",
        checkout: f.checkout,
        checks: [["git", "diff", "--exit-code"]],
      }),
      scenario === "upstream" ? "commit_remote_invalid" : "commit_base_diverged",
    );
    expect(f.state.writes).toEqual([]);
  },
);

test("new ticket changes create a newer candidate and round while retaining its predecessor", async () => {
  await f.review();
  const original = f.candidate();
  const newerTree = "f".repeat(40);
  const newerHead = "a".repeat(40);
  Object.assign(f.tree(f.worktree), { headTree: newerTree, index: newerTree, worktree: newerTree });
  f.state.intercept = (input) => {
    if (input.args[0] === "commit") {
      Object.assign(f.tree(input.cwd ?? expect.unreachable()), {
        head: newerHead,
        headTree: newerTree,
      });
      return f.completed();
    }
    return undefined;
  };
  const result = await Workflow.round({ ...f.input, text: "## Findings" });
  expect(result.tag).toBe("Ok");
  if (result.tag !== "Ok") return expect.unreachable();
  expect(result.value.rounds).toStrictEqual([{ head: newerHead, tree: newerTree, findings: [] }]);
  expect(result.value.history).toEqual([f.candidateHead, newerHead]);
  expect(result.value.candidate?.branch).not.toBe(original.branch);
});

test("recovery of a committed but headless candidate returns its exact round facts", async () => {
  await f.review();
  const data = f.data();
  data.candidate = { ...f.candidate(), head: null };
  f.replace(data);
  const result = await Workflow.round({ ...f.input, text: "## Findings" });
  expect(result.tag).toBe("Ok");
  if (result.tag !== "Ok") return expect.unreachable();
  expect(result.value.rounds).toStrictEqual([
    { head: f.candidateHead, tree: f.ticketTree, findings: [] },
  ]);
});

test("a trailer split across message lines cannot fabricate the ticket identity", async () => {
  f.state.message = "Ticket #411\n\nOperator-Ticket: source/\nticket";
  expectRefusal(await Workflow.review(f.input), "commit_candidate_invalid");
});

test("multi-digit round identifiers parse and then fail the review policy, rather than the document grammar", async () => {
  await f.ready();
  expectRefusal(
    await Workflow.deliver({ ...f.input, text: "## Dispositions\n- 12.1 applied" }),
    "commit_dispositions_incomplete",
  );
});

test("both repository observations require absolute common-directory output", async () => {
  await f.ready();
  expect((await Workflow.deliver(f.delivery)).tag).toBe("Ok");
  expect(f.tools.mock.calls.map(([input]) => input)).toContainEqual({
    tool: "git",
    cwd: f.worktree,
    args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    timeoutMs: 120000,
    input: undefined,
  });
});

test.each(["candidate", "marker"])(
  "%s filesystem errors stop before any forbidden external effect",
  async (kind) => {
    const file = `${f.root}/filesystem-obstruction`;
    await Bun.write(file, "personal\n");
    if (kind === "candidate")
      spyOn(OperatorHome, "commitCandidate").mockReturnValue(`${file}/candidate`);
    else {
      await f.ready();
      f.state.intercept = (input) =>
        input.args.includes("--git-path") ? f.completed(`${file}/marker`) : undefined;
    }
    f.tools.mockClear();
    const result = await (kind === "candidate"
      ? Workflow.review(f.input)
      : Workflow.deliver(f.delivery));
    expectRefusal(result, "commit_io_failed");
    expect(
      f.tools.mock.calls.some(([input]) =>
        ["worktree", "apply", "update-ref", "push"].includes(input.args[0] ?? ""),
      ),
    ).toBe(kind === "marker");
    // Marker inspection runs worktree list, but no external write is authorized.
    expect(
      f.tools.mock.calls.some(([input]) =>
        ["apply", "update-ref", "push"].includes(input.args[0] ?? ""),
      ),
    ).toBe(false);
    expect(await Bun.file(file).text()).toBe("personal\n");
    await Bun.file(file).delete();
  },
);

test("unmodeled filesystem errors preserve their actual defect instead of treating the candidate as absent", async () => {
  const link = `${f.root}/filesystem-loop`;
  await symlink(link, link);
  spyOn(OperatorHome, "commitCandidate").mockReturnValue(link);
  const result = await Workflow.review(f.input);
  expect(result.tag).toBe("Defect");
  if (result.tag !== "Defect") return expect.unreachable();
  expect(result.cause).toMatchObject({ code: "ELOOP" });
  expect(f.tools.mock.calls.some(([input]) => input.args[0] === "worktree")).toBe(false);
});

test.each(["check", "ancestry"])("%s defects retain the exact original cause", async (boundary) => {
  await f.ready();
  const cause = new Error(`${boundary} invariant`);
  f.state.intercept = (input) => {
    if (
      (boundary === "check" && input.args.join(" ") === "diff --exit-code") ||
      (boundary === "ancestry" && input.args[0] === "merge-base")
    ) {
      // oxlint-disable-next-line unthrown/no-throw -- Assert defect identity at the process boundary.
      throw cause;
    }
    return undefined;
  };
  const result = await Workflow.deliver(f.delivery);
  expect(result.tag).toBe("Defect");
  if (result.tag !== "Defect") return expect.unreachable();
  expect(result.cause).toBe(cause);
});

test("a check defect takes precedence over the candidate change it caused", async () => {
  await f.ready();
  const cause = new Error("check invariant");
  f.state.intercept = (input) => {
    if (input.args.join(" ") === "diff --exit-code") {
      f.tree(f.candidate().path).head = "f".repeat(40);
      // oxlint-disable-next-line unthrown/no-throw -- Preserve an unmodeled check failure despite its partial effect.
      throw cause;
    }
    return undefined;
  };
  const result = await Workflow.deliver(f.delivery);
  expect(result.tag).toBe("Defect");
  if (result.tag !== "Defect") return expect.unreachable();
  expect(result.cause).toBe(cause);
});

test("failed and unfinished configured commands expose different complete diagnostics", async () => {
  await f.ready();
  f.state.intercept = (input) =>
    input.args.join(" ") === "diff --exit-code"
      ? { status: "no-answer", detail: "timeout" }
      : undefined;
  let result = await Workflow.deliver(f.delivery);
  expect(result.tag).toBe("Err");
  if (result.tag !== "Err") return expect.unreachable();
  expect(result.error.detail).toBe(
    'Configured check did not complete: {"status":"no-answer","detail":"timeout"}',
  );
  f.state.intercept = (input) =>
    input.args.join(" ") === "diff --exit-code" ? f.completed("failure", 17) : undefined;
  result = await Workflow.deliver(f.delivery);
  expect(result.tag).toBe("Err");
  if (result.tag !== "Err") return expect.unreachable();
  expect(result.error.detail).toBe(
    'Configured check failed: {"argv":["git","diff","--exit-code"],"result":{"status":"completed","exitCode":17,"stdout":"failure","stderr":""}}',
  );
});

test("an accepted push without verified remote ancestry remains uncertain", async () => {
  await f.ready();
  f.state.intercept = (input) => (input.args[0] === "push" ? f.completed() : undefined);
  const result = await Workflow.deliver(f.delivery);
  expect(result).toMatchObject({
    tag: "Err",
    error: {
      reason: "commit_remote_uncertain",
      detail:
        "Push returned, but origin/main does not verify the pinned candidate. Local delivery may have succeeded.",
    },
  });
  expect(f.state.local).toBe(f.candidateHead);
  expect(f.state.remote).toBe(f.base);
  expect(f.data().stage).toBe("remote");
});

test("unavailable remote ancestry verification preserves local delivery without inventing publication", async () => {
  await f.ready();
  f.state.intercept = (input) =>
    input.args[0] === "merge-base"
      ? { status: "unavailable", tool: "git", detail: "Git disappeared from PATH." }
      : undefined;
  expect(await Workflow.deliver(f.delivery)).toMatchObject({
    tag: "Err",
    error: {
      reason: "commit_remote_uncertain",
      detail: "Remote ancestry could not be verified. Local effects may remain.",
    },
  });
  expect(f.state.local).toBe(f.candidateHead);
  expect(f.state.remote).toBe(f.base);
  expect(f.data()).toMatchObject({
    stage: "remote",
    publishedHead: null,
    ownerPid: null,
    leaseAt: null,
  });
  expect(f.tools.mock.calls.some(([input]) => input.args[0] === "push")).toBe(false);
});

test("delivery renews a nonblocking lease and cancels its timer after a failed effect", async () => {
  await f.ready();
  const intervals = spyOn(globalThis, "setInterval");
  const cleared = spyOn(globalThis, "clearInterval");
  f.state.intercept = (input) => {
    if (input.args.join(" ") !== "diff --exit-code") return undefined;
    const timer = intervals.mock.results[0] ?? expect.unreachable();
    if (timer.type !== "return") return expect.unreachable();
    expect(timer.value.hasRef()).toBe(false);
    const [callback, delay] = intervals.mock.calls[0] ?? expect.unreachable();
    expect(delay).toBe(1000);
    const count = f.state.writes.length;
    callback();
    expect(f.state.writes).toHaveLength(count + 1);
    expect(f.data()).toMatchObject({
      ownerPid: process.pid,
      leaseAt: expect.stringMatching(/\S/) as string,
    });
    return f.completed("", 1);
  };
  expectRefusal(await Workflow.deliver(f.delivery), "commit_checks_failed");
  expect(f.data()).toMatchObject({ ownerPid: null, leaseAt: null });
  expect(cleared).toHaveBeenCalledTimes(1);
  const timer = intervals.mock.results[0] ?? expect.unreachable();
  if (timer.type !== "return") return expect.unreachable();
  expect(cleared.mock.calls[0]?.[0]).toBe(timer.value);
});

test("candidate creation, review and publication record one exact commit and every effect", async () => {
  await f.ready();
  expect(await Workflow.deliver(f.delivery)).toMatchObject({
    tag: "Ok",
    value: {
      stage: "complete",
      publishedHead: f.candidateHead,
      history: [f.candidateHead],
      candidate: { head: f.candidateHead, tree: f.ticketTree },
      ownerPid: null,
      leaseAt: null,
      checks: {
        candidate: f.candidateHead,
        base: f.base,
        tree: f.ticketTree,
        results: [{ argv: ["git", "diff", "--exit-code"], exitCode: 0 }],
      },
    },
  });
  expect(f.state.local).toBe(f.candidateHead);
  expect(f.state.remote).toBe(f.candidateHead);
  expect(f.state.writes.at(-1)?.complete).toBe(true);
  expect(f.data().journal.map(({ effect, state }) => [effect, state])).toEqual([
    ["candidate_creation", "intent"],
    [`candidate_index:${f.candidate().branch}`, "intent"],
    [`candidate_index:${f.candidate().branch}`, "verified"],
    ["candidate_creation", "verified"],
    ["delivery_admission", "intent"],
    ["checkout_index", "intent"],
    ["checkout_index", "verified"],
    ["local_ref", "intent"],
    ["local_ref", "verified"],
    ["remote_publication", "intent"],
    ["remote_publication", "verified"],
    ["database_finalization", "intent"],
    ["database_finalization", "verified"],
  ]);
});

test("completed delivery is idempotent without another tool or evidence write", async () => {
  await f.ready();
  expect((await Workflow.deliver(f.delivery)).tag).toBe("Ok");
  const before = f.data();
  const writes = f.state.writes.length;
  f.tools.mockClear();
  expect(await Workflow.deliver(f.delivery)).toMatchObject({ tag: "Ok", value: before });
  expect(f.tools.mock.calls.map(([input]) => input.args)).toEqual([
    ["rev-parse", "--show-toplevel"],
  ]);
  expect(f.state.writes).toHaveLength(writes);
});

test("failure projection preserves operational failures and defects, and refuses an unexpected success", () => {
  const failure = {
    reason: "stopped",
    detail: "Stop.",
    next: { command: "operator next", why: "Recover." },
  };
  expect(stopped(Err(failure))).toMatchObject({ tag: "Err", error: failure });
  const defect = fromSafeThrowable(() => {
    // oxlint-disable-next-line unthrown/no-throw -- Exercise the unmodeled failure channel.
    throw new Error("bug");
  })();
  expect(stopped(defect).tag).toBe("Defect");
  expect(stopped(Ok("unexpected"))).toMatchObject({
    tag: "Err",
    error: {
      reason: "commit_state_changed",
      detail: "The operation no longer matches its recorded state.",
      next: {
        command: "operator next",
        why: "Read the recorded commit-delivery state. Preserve partial effects and retained history.",
      },
    },
  });
});

for (const operation of ["review", "round", "deliver"] as const) {
  test(`${operation} stops at every failed Git observation or effect without mistaking it for success`, async () => {
    if (operation !== "review") await f.review();
    if (operation === "deliver")
      expect((await Workflow.round({ ...f.input, text: "## Findings" })).tag).toBe("Ok");
    function run() {
      return operation === "review"
        ? Workflow.review(f.input)
        : operation === "round"
          ? Workflow.round({ ...f.input, text: "## Findings" })
          : Workflow.deliver(f.delivery);
    }
    f.tools.mockClear();
    expect((await run()).tag).toBe("Ok");
    const commands = f.tools.mock.calls.map(([input]) => input.args);
    for (const [index, argv] of commands.entries()) {
      jest.restoreAllMocks();
      f = workflowFixture(seed);
      if (operation !== "review") await f.review();
      if (operation === "deliver")
        expect((await Workflow.round({ ...f.input, text: "## Findings" })).tag).toBe("Ok");
      let call = 0;
      f.state.intercept = () =>
        call++ === index
          ? {
              status: "completed",
              exitCode: argv[0] === "merge-base" ? 2 : 1,
              stdout: "",
              stderr: "injected",
            }
          : undefined;
      const result = await run();
      const reason =
        argv[0] === "diff" && argv.includes("--exit-code")
          ? "commit_checks_failed"
          : argv[0] === "merge-base"
            ? "commit_remote_uncertain"
            : "commit_git_failed";
      expect(result, `${operation} call ${index}: ${argv.join(" ")}`).toMatchObject({
        tag: "Err",
        error: { reason, detail: expect.stringMatching(/\S/) as string },
      });
      expect(f.state.writes.some((change) => change.complete)).toBe(false);
    }
  });
}
