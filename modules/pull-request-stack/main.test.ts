import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
// Bun has no recursive directory removal API.
import { rm } from "node:fs/promises";
import { PullRequestStack } from "./main.ts";

const roots: string[] = [];
const realGit = Bun.which("git") ?? "git";
const inheritedPath = process.env.PATH ?? "";
const wrapper = `${Bun.env.TMPDIR ?? "/tmp"}/operator-stack-git-${crypto.randomUUID()}`;
const gitLog = `${wrapper}/calls.log`;
const repositoryAnswer = `${wrapper}/repository.json`;
const rulesAnswer = `${wrapper}/rules.json`;
const pullsState = `${wrapper}/pulls.json`;

// With a pulls state file, gh is a small stateful stand-in for the pull request writes. A fault
// applies the write and then loses its answer, so recovery has to read to find out what happened.
// A "drop:" fault loses the answer of a write that never applied, and a "#n" fault loses the
// answer of the nth such call only.
const pullsGh = `const statePath = ${JSON.stringify(pullsState)};
const state = await Bun.file(statePath).json();
const args = process.argv.slice(2);
const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
const path = (args.find((one) => one.startsWith("repos/") || one === "graphql") ?? "").split("?")[0];
const input = args[args.indexOf("--input") + 1] === "-" ? await Bun.stdin.json() : null;
const call = method + " " + path;
state.calls.push(call);
const nth = call + "#" + state.calls.filter((one) => one === call).length;
const dropped = state.faults.includes("drop:" + call);
const fault = dropped || state.faults.includes(call) || state.faults.includes(nth);
state.faults = state.faults.filter((one) => ![call, "drop:" + call, nth].includes(one));
const pull = state.pulls[(/pulls\\/(\\d+)$/.exec(path) ?? [])[1]];
const issue = (/issues\\/(\\d+)\\/comments$/.exec(path) ?? [])[1];
let body = null;
if (dropped) {
} else if (path === "graphql") {
  state.pulls[input.variables.id.slice(3)].draft = true;
  body = { data: { convertPullRequestToDraft: { pullRequest: { isDraft: true } } } };
} else if (pull !== undefined) {
  if (input?.base !== undefined) pull.base = { ref: input.base };
  if (input?.state !== undefined) pull.state = input.state;
  body = pull;
} else if (method === "POST") {
  state.comments[issue] = [...(state.comments[issue] ?? []), input.body];
  body = {};
} else {
  body = (state.comments[issue] ?? []).map((one) => ({ body: one }));
}
await Bun.write(statePath, JSON.stringify(state));
if (fault) {
  process.stderr.write("gh: the answer to " + call + " was lost");
  process.exit(1);
}
process.stdout.write("HTTP/2.0 200 OK\\n\\n" + JSON.stringify(body));
`;

// Git runs through a wrapper that logs each call, so a test reads every option a push used.
beforeAll(async () => {
  await Bun.$`mkdir -p ${wrapper}/bin`.quiet();
  await Bun.write(
    `${wrapper}/bin/git`,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${gitLog}\nexec ${realGit} "$@"\n`,
  );
  // gh answers from a file, or with a 404 when the file is absent.
  await Bun.write(`${wrapper}/pulls-gh.ts`, pullsGh);
  await Bun.write(
    `${wrapper}/bin/gh`,
    `#!/bin/sh\nif [ -f ${pullsState} ]; then exec ${process.execPath} ${wrapper}/pulls-gh.ts "$@"; fi\ncase "$*" in *rules/branches*) file=${rulesAnswer} ;; *) file=${repositoryAnswer} ;; esac\nif [ -f "$file" ]; then printf 'HTTP/2.0 200 OK\\n\\n'; cat "$file"; else printf 'HTTP/2.0 404 Not Found\\n\\n{"message":"Not Found"}'; fi\n`,
  );
  await Bun.$`chmod +x ${wrapper}/bin/git ${wrapper}/bin/gh`.quiet();
  process.env.PATH = `${wrapper}/bin:${inheritedPath}`;
});

afterAll(async () => {
  process.env.PATH = inheritedPath;
  await rm(wrapper, { force: true, recursive: true });
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  await Promise.all(
    [gitLog, repositoryAnswer, rulesAnswer, pullsState].map((file) => rm(file, { force: true })),
  );
});

/** A project with two commits and a bare remote that holds only its first one. */
async function project() {
  const root = `${Bun.env.TMPDIR ?? "/tmp"}/operator-stack-${crypto.randomUUID()}`;
  roots.push(root);
  const repo = `${root}/repo`;
  const remote = `${root}/remote.git`;
  const commit = (message: string) =>
    Bun.$`${realGit} -C ${repo} -c user.email=t@example.com -c user.name=Test commit --allow-empty -q -m ${message}`.quiet();
  await Bun.$`${realGit} init -q -b main ${repo}`.quiet();
  await Bun.$`${realGit} init -q --bare ${remote}`.quiet();
  await commit("first");
  await Bun.$`${realGit} -C ${repo} remote add origin ${remote}`.quiet();
  await Bun.$`${realGit} -C ${repo} push -q origin main`.quiet();
  const first = (await Bun.$`${realGit} -C ${repo} rev-parse HEAD`.quiet()).stdout
    .toString()
    .trim();
  await commit("second");
  const second = (await Bun.$`${realGit} -C ${repo} rev-parse HEAD`.quiet()).stdout
    .toString()
    .trim();
  return { repo, remote, first, second };
}

async function remoteRefs(remote: string): Promise<string> {
  return (
    await Bun.$`${realGit} -C ${remote} for-each-ref --format=${"%(refname) %(objectname)"}`.quiet()
  ).stdout
    .toString()
    .trim();
}

async function pushCalls(): Promise<string[]> {
  const file = Bun.file(gitLog);
  const text = (await file.exists()) ? await file.text() : "";
  return text.split("\n").filter((line) => / push( |$)/.test(` ${line}`));
}

describe("the push of a stack publication", () => {
  test("pushes every new name at once with no force option, and a repeat writes nothing", async () => {
    const { repo, remote, second } = await project();
    const effect = {
      kind: "push" as const,
      remote: "origin",
      refs: [{ name: "operator/source/1/1", commit: second }],
    };

    const pushed = await PullRequestStack.write({ repoRoot: repo, effect });
    expect(pushed).toEqual({ status: "done", how: "written", number: null, url: null });
    expect(await remoteRefs(remote)).toContain(`refs/heads/operator/source/1/1 ${second}`);

    const repeated = await PullRequestStack.write({ repoRoot: repo, effect });
    expect(repeated).toEqual({ status: "done", how: "observed", number: null, url: null });

    const calls = await pushCalls();
    expect(calls).toHaveLength(1);
    for (const call of calls) {
      expect(call).toContain("--atomic");
      expect(call).not.toMatch(
        /--force|--force-with-lease|--force-if-includes|--delete|--mirror|--prune|(^| )-f( |$)|(^| )\+/,
      );
    }
  });

  test("a name the remote already holds at another commit is a conflict, never pushed over", async () => {
    const { repo, remote, first, second } = await project();
    await Bun.$`${realGit} -C ${repo} push -q origin ${first}:refs/heads/operator/source/1/1`.quiet();
    const before = await remoteRefs(remote);

    const outcome = await PullRequestStack.write({
      repoRoot: repo,
      effect: {
        kind: "push",
        remote: "origin",
        refs: [{ name: "operator/source/1/1", commit: second }],
      },
    });

    // The commit there is an ancestor, so a plain push would move the name. The read refuses it.
    expect(outcome).toEqual({
      status: "conflict",
      found: `operator/source/1/1 at ${first}`,
    });
    expect(await remoteRefs(remote)).toBe(before);
    expect(await pushCalls()).toEqual([]);
  });

  test("a half push is recovered as a conflict for a person, not pushed again", async () => {
    const { repo, remote, second } = await project();
    await Bun.$`${realGit} -C ${repo} push -q origin ${second}:refs/heads/operator/source/1/1`.quiet();
    const before = await remoteRefs(remote);

    const outcome = await PullRequestStack.write({
      repoRoot: repo,
      effect: {
        kind: "push",
        remote: "origin",
        refs: [
          { name: "operator/source/1/1", commit: second },
          { name: "operator/source/1/2", commit: second },
        ],
      },
    });

    expect(outcome.status).toBe("conflict");
    expect(await remoteRefs(remote)).toBe(before);
    expect(await pushCalls()).toEqual([]);
  });

  test("a push the remote rejects lands nothing and records the message of the remote", async () => {
    const { repo, remote, second } = await project();
    await Bun.write(
      `${remote}/hooks/pre-receive`,
      "#!/bin/sh\necho 'signed commits are required' >&2\nexit 1\n",
    );
    await Bun.$`chmod +x ${remote}/hooks/pre-receive`.quiet();

    const outcome = await PullRequestStack.write({
      repoRoot: repo,
      effect: {
        kind: "push",
        remote: "origin",
        refs: [{ name: "operator/source/1/1", commit: second }],
      },
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" ? outcome.message : "").toContain(
      "signed commits are required",
    );
    expect(await remoteRefs(remote)).not.toContain("operator/source");
  });
});

const TEXT = { title: "Title", summary: "Summary", startHere: "main.ts", mergeDanger: "None." };

function planOf(
  repo: string,
  branch: { base: string; head: string },
  text: Parameters<typeof PullRequestStack.plan>[0]["text"],
) {
  return PullRequestStack.plan({
    repoRoot: repo,
    repository: "owner/repo",
    sourceSlug: "source",
    publication: 1,
    branch,
    commits: [{ commit: branch.head, closes: null, behaviorChanges: [], concerns: [] }],
    text,
    verified: { gateCommands: [], gateRuns: [], reviews: [] },
    rejected: [],
    deferred: [],
  });
}

function reasonsOf(planned: Awaited<ReturnType<typeof PullRequestStack.plan>>): string[] {
  return planned.status === "planned" ? planned.refusals.map((one) => one.reason) : [];
}

// The order of the refusals is a contract (decision 10), so these read it at the interface.
describe("the refusals of a stack plan", () => {
  test("the body comes before the repository settings, and those before the remote", async () => {
    const { repo, first, second } = await project();
    const long = { ...TEXT, summary: "word ".repeat(14_000), cuts: [] };

    const planned = await planOf(repo, { base: first, head: second }, long);

    expect(planned.status === "planned" ? planned.ships : "unread").toBeNull();
    expect(reasonsOf(planned)).toEqual(["body_too_long", "repository_unread", "remote_missing"]);
  });

  test("a cut comes first, and an ambiguous remote is named after the settings", async () => {
    const { repo, first, second } = await project();
    for (const name of ["origin", "mirror"]) {
      await Bun.$`${realGit} -C ${repo} config remote.${name}.url https://github.com/owner/repo.git`.quiet();
    }
    const cut = { ...TEXT, after: second, reason: "Too late." };

    const planned = await planOf(repo, { base: first, head: second }, { ...TEXT, cuts: [cut] });

    expect(reasonsOf(planned)).toEqual([
      "cut_not_between_commits",
      "repository_unread",
      "remote_ambiguous",
    ]);
  });

  test("the settings and rules come before the names, and the names before the base", async () => {
    const { repo, remote, second } = await project();
    await Bun.$`${realGit} -C ${repo} remote set-url origin https://github.com/owner/repo.git`.quiet();
    await Bun.$`${realGit} -C ${repo} config url.${remote}.insteadOf https://github.com/owner/repo.git`.quiet();
    await Bun.$`${realGit} -C ${repo} push -q origin ${second}:refs/heads/operator/source/1/1`.quiet();
    await Bun.write(
      repositoryAnswer,
      JSON.stringify({ default_branch: "main", allow_merge_commit: false }),
    );
    await Bun.write(rulesAnswer, JSON.stringify([{ type: "required_signatures" }]));

    // The remote target holds only the first commit, so the second one is not on it.
    const planned = await planOf(repo, { base: second, head: second }, { ...TEXT, cuts: [] });

    expect(reasonsOf(planned)).toEqual([
      "merge_commit_not_allowed",
      "signatures_required",
      "remote_name_taken",
      "base_not_on_target",
    ]);
    expect(planned.status === "planned" ? planned.ships?.parts.length : null).toBe(1);
  });
});

type FakePull = {
  number: number;
  node_id: string;
  state: string;
  draft: boolean;
  merged: boolean;
  head: { sha: string };
  base: { ref: string };
};

/** Holds one pull request on the gh stand-in, with the calls whose answer is lost. */
async function holdPull(change: Partial<FakePull>, faults: string[] = []): Promise<void> {
  const pull: FakePull = {
    number: 7,
    node_id: "PR_7",
    state: "open",
    draft: false,
    merged: false,
    head: { sha: "a".repeat(40) },
    base: { ref: "main" },
    ...change,
  };
  await Bun.write(
    pullsState,
    JSON.stringify({ pulls: { 7: pull }, comments: {}, faults, calls: [] }),
  );
}

async function heldPulls(): Promise<{
  pull: FakePull;
  comments: string[];
  writes: string[];
}> {
  const state = await Bun.file(pullsState).json();
  return {
    pull: state.pulls[7],
    comments: state.comments[7] ?? [],
    writes: state.calls.filter((one: string) => !one.startsWith("GET ")),
  };
}

const PULL = "repos/owner/repo/pulls/7";
const COMMENTS = "repos/owner/repo/issues/7/comments";
const write = (effect: Parameters<typeof PullRequestStack.write>[0]["effect"]) =>
  PullRequestStack.write({ repoRoot: "/nonexistent", effect });
const RECALL = {
  kind: "recall",
  repository: "owner/repo",
  number: 7,
  comment: "<!-- recall -->\nRecalled.",
  marker: "<!-- recall -->",
} as const;
const CLOSE = {
  kind: "close",
  repository: "owner/repo",
  number: 7,
  publication: 2,
  replacement: 9,
  head: "a".repeat(40),
} as const;

// Each write reads first, so a repeat after a lost answer writes nothing twice (ADR 0005).
describe("the pull request writes", () => {
  test("a recall whose draft answer is lost reads the draft and writes one comment", async () => {
    await holdPull({}, ["POST graphql"]);

    const first = await write(RECALL);
    expect(first).toEqual({ status: "done", how: "written", number: 7, url: null });
    const repeated = await write(RECALL);
    expect(repeated).toEqual({ status: "done", how: "observed", number: 7, url: null });

    const held = await heldPulls();
    expect(held.pull).toMatchObject({ draft: true, state: "open" });
    expect(held.comments).toEqual([RECALL.comment]);
    expect(held.writes).toEqual(["POST graphql", `POST ${COMMENTS}`]);
  });

  test("a recall whose comment answer is lost is uncertain, and its repeat writes no second comment", async () => {
    await holdPull({}, [`POST ${COMMENTS}`]);

    const first = await write(RECALL);
    expect(first.status).toBe("uncertain");
    const repeated = await write(RECALL);
    expect(repeated).toEqual({ status: "done", how: "observed", number: 7, url: null });

    const held = await heldPulls();
    expect(held.comments).toEqual([RECALL.comment]);
    expect(held.writes).toEqual(["POST graphql", `POST ${COMMENTS}`]);
  });

  test("a recall whose draft answer and second read are lost names the second read", async () => {
    await holdPull({}, ["drop:POST graphql", `GET ${PULL}#2`]);

    const outcome = await write(RECALL);

    expect(outcome.status).toBe("uncertain");
    expect(outcome.status === "uncertain" ? outcome.detail : "").toContain(`GET ${PULL} was lost`);
    expect((await heldPulls()).comments).toEqual([]);
  });

  test("a recall of a pull request that merged first is a conflict, with no draft and no comment", async () => {
    await holdPull({ state: "closed", merged: true });

    const outcome = await write(RECALL);

    expect(outcome).toEqual({ status: "conflict", found: "#7 is merged into main" });
    const held = await heldPulls();
    expect(held.pull.draft).toBe(false);
    expect(held.writes).toEqual([]);
  });

  test("a close whose comment answer is lost is uncertain, and its repeat closes with one comment", async () => {
    await holdPull({}, [`POST ${COMMENTS}`]);

    const first = await write(CLOSE);
    expect(first.status).toBe("uncertain");
    expect((await heldPulls()).pull.state).toBe("open");
    const repeated = await write(CLOSE);
    expect(repeated).toEqual({ status: "done", how: "written", number: 7, url: null });

    const held = await heldPulls();
    expect(held.pull.state).toBe("closed");
    expect(held.comments).toHaveLength(1);
    expect(held.comments[0]).toContain(
      "Stack publication 2 replaces this pull request: it starts at #9.",
    );
    expect(held.writes).toEqual([`POST ${COMMENTS}`, `PATCH ${PULL}`]);
  });

  test("a close whose answer is lost reads the close, and a repeat writes nothing", async () => {
    await holdPull({}, [`PATCH ${PULL}`]);

    expect(await write(CLOSE)).toEqual({ status: "done", how: "written", number: 7, url: null });
    expect(await write(CLOSE)).toEqual({ status: "done", how: "observed", number: 7, url: null });

    expect((await heldPulls()).writes).toEqual([`POST ${COMMENTS}`, `PATCH ${PULL}`]);
  });

  test("a close that never applied stays uncertain, and its repeat closes with no second comment", async () => {
    await holdPull({}, [`drop:PATCH ${PULL}`]);

    expect(await write(CLOSE)).toEqual({ status: "uncertain", detail: "#7 is still open." });
    expect(await write(CLOSE)).toEqual({ status: "done", how: "written", number: 7, url: null });

    const held = await heldPulls();
    expect(held.pull.state).toBe("closed");
    expect(held.comments).toHaveLength(1);
    expect(held.writes).toEqual([`POST ${COMMENTS}`, `PATCH ${PULL}`, `PATCH ${PULL}`]);
  });

  test("a close of a pull request whose head a person moved is a conflict that writes nothing", async () => {
    await holdPull({ head: { sha: "b".repeat(40) } });

    const outcome = await write(CLOSE);

    expect(outcome).toEqual({
      status: "conflict",
      found: `#7 has head ${"b".repeat(40)}, not the published commit ${"a".repeat(40)}`,
    });
    expect((await heldPulls()).writes).toEqual([]);
  });

  test("a retarget whose answer is lost reads the new base, and a repeat writes nothing", async () => {
    await holdPull({ base: { ref: "operator/source/1/1" } }, [`PATCH ${PULL}`]);
    const effect = {
      kind: "retarget",
      repository: "owner/repo",
      number: 7,
      from: "operator/source/1/1",
      base: "main",
    } as const;

    expect(await write(effect)).toEqual({ status: "done", how: "written", number: 7, url: null });
    expect(await write(effect)).toEqual({ status: "done", how: "observed", number: 7, url: null });

    expect((await heldPulls()).writes).toEqual([`PATCH ${PULL}`]);
  });

  test("a retarget of a pull request that is no longer open is a conflict that writes nothing", async () => {
    await holdPull({ state: "closed", base: { ref: "operator/source/1/1" } });

    const outcome = await write({
      kind: "retarget",
      repository: "owner/repo",
      number: 7,
      from: "operator/source/1/1",
      base: "main",
    });

    expect(outcome).toEqual({ status: "conflict", found: "#7 is closed into operator/source/1/1" });
    expect((await heldPulls()).writes).toEqual([]);
  });
});
