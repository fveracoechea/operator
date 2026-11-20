import { afterAll, afterEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { OkAsync } from "unthrown";
import { GithubApi } from "../github-api/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { Projects } from "../projects/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { dispatchDevice, git, removeDevices } from "./dispatch-fixture.ts";
import { WorkerDispatch } from "./main.ts";

afterEach(() => {
  mock.restore();
  setSystemTime();
});
afterAll(removeDevices);

const branch = "feature/existing";

/**
 * A device with a second source whose one PR assignment adopts PR #41. The PR's branch holds
 * one pushed commit on the fixture's reachable remote, and no local branch exists yet.
 */
async function adoptionDevice(
  pr: { draft?: boolean; state?: string; ref?: string; repo?: string | null } = {},
) {
  const device = await dispatchDevice();
  const { checkout } = device;
  git(checkout, "checkout", "-q", "-b", branch);
  await Bun.write(`${checkout}/existing.ts`, "existing\n");
  git(checkout, "add", "existing.ts");
  git(checkout, "commit", "-q", "-m", "existing work");
  git(checkout, "push", "-q", "local", branch);
  const head = git(checkout, "rev-parse", "HEAD");
  git(checkout, "checkout", "-q", "main");
  git(checkout, "branch", "-q", "-D", branch);
  spyOn(Projects, "githubRemote").mockReturnValue(OkAsync("local"));
  const github = spyOn(GithubApi, "call").mockResolvedValue({
    status: "succeeded",
    value: {
      httpStatus: 200,
      body: {
        number: 41,
        html_url: "https://github.com/example/one/pull/41",
        state: pr.state ?? "open",
        draft: pr.draft ?? false,
        head: {
          ref: pr.ref ?? branch,
          sha: head,
          repo: pr.repo === null ? null : { full_name: pr.repo ?? "example/one" },
        },
      },
    },
  });
  await Bun.write(
    `${device.root}/adopt.json`,
    JSON.stringify({
      trackerKey: "github:example/one#41",
      assignments: [
        {
          key: "adopted",
          trackerKey: "github:example/one#41",
          instructions: "Carry PR #41 through its review.",
          kind: "implementation",
          resources: "worktree",
          branch,
          adopt: 41,
          dependencies: [],
        },
      ],
    }),
  );
  const registered = await WorkSources.register({
    paths: device.paths,
    cwd: checkout,
    file: `${device.root}/adopt.json`,
  });
  const sourceId = registered.tag === "Ok" ? registered.value.id : "";
  const request = { paths: device.paths, cwd: checkout, sourceId, assignment: "adopted" };
  async function launches() {
    const shown = await WorkSources.show(request);
    return (shown.getOr(undefined)?.launches ?? []).filter((row) => row.assignment === "adopted");
  }
  function brief() {
    return Bun.file(
      OperatorHome.assignmentFiles(device.paths, {
        repository: "example/one",
        sourceId,
        assignment: "adopted",
      }).brief,
    ).text();
  }
  return Object.assign(device, { head, github, request, launches, brief });
}

test("an adopted ready PR starts on its own branch at the PR head, with no internal review", async () => {
  await using device = await adoptionDevice();
  expect(await WorkerDispatch.dispatch(device.request)).toMatchObject({
    tag: "Ok",
    value: { branch },
  });
  expect(device.github).toHaveBeenCalledWith({
    args: ["repos/example/one/pulls/41"],
    timeoutMs: 60000,
  });
  expect(device.herdr.createWorktree).toHaveBeenLastCalledWith({
    workspaceId: "w1",
    branch,
    label: "pr-one-41-adopted",
    base: undefined,
  });
  const [launch] = await device.launches();
  expect(launch).toMatchObject({ branch, internalReview: false });
  const worktree = launch?.worktreePath ?? "";
  expect(git(worktree, "rev-parse", "HEAD")).toBe(device.head);
  expect(git(worktree, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe(`local/${branch}`);
  const brief = await device.brief();
  expect(brief).toContain(`Head: \`${device.head}\``);
  expect(brief).toContain("## Adopted PR\n\nPR #41: https://github.com/example/one/pull/41");
  expect(brief).toContain(
    "Read reviews, comments, unresolved threads, and checks before changing code or waiting.",
  );
  expect(brief).toContain("Keep existing commits; open no second PR.");
  expect(brief).toContain("State: `ready`.");
  expect(brief).not.toContain("Open one PR");
  expect(brief).toContain("Internal review: `off`");
});

test.each(["implementation", "review", "pr-feedback"])(
  "a null-kind unassociated adoption fills implementation despite its historical %s plan kind",
  async (kind) => {
    await using device = await adoptionDevice();
    using db = new Database(device.paths.database);
    db.query("UPDATE assignments SET kind = NULL WHERE source_id = ?").run(device.request.sourceId);
    db.query(
      "UPDATE sources SET plan = json_set(plan, '$.assignments[0].kind', ?) WHERE id = ?",
    ).run(kind, device.request.sourceId);
    const plan = db.query("SELECT plan FROM sources WHERE id = ?").get(device.request.sourceId);
    expect(db.query("SELECT * FROM pull_requests").all()).toEqual([]);
    const next = await WorkSources.next(device.request);
    expect(next.tag).toBe("Ok");
    if (next.tag !== "Ok") expect.unreachable("The null adoption must be readable.");
    expect(
      next.value.sources
        .flatMap((row) => row.actions)
        .filter((row) => "assignment" in row && row.assignment === "adopted")
        .map(({ action, reason, ...row }) => ({
          kind: "kind" in row ? row.kind : undefined,
          action,
          reason,
        })),
    ).toEqual([{ kind: null, action: "ready_assignment", reason: "assignment_ready" }]);
    const filled = await WorkerDispatch.dispatch({ ...device.request, kind: "implementation" });
    expect(filled).toMatchObject({
      tag: "Ok",
      value: { branch, kind: { name: "implementation" } },
    });
    expect(await device.launches()).toMatchObject([
      { kind: { name: "implementation" }, internalReview: false },
    ]);
    expect(db.query("SELECT plan FROM sources WHERE id = ?").get(device.request.sourceId)).toEqual(
      plan,
    );
  },
);

test("an adopted draft keeps internal review, so its owner associates the draft for a reviewer", async () => {
  await using device = await adoptionDevice({ draft: true });
  expect(await WorkerDispatch.dispatch(device.request)).toMatchObject({ tag: "Ok" });
  expect(await device.launches()).toMatchObject([{ internalReview: true }]);
  const brief = await device.brief();
  expect(brief).toContain("State: `draft`.");
  expect(brief).toContain("Internal review: `on`");
  expect(brief).not.toContain("Open one draft PR");
});

test("a replacement before the association reopens the worktree and reads the PR again", async () => {
  await using device = await adoptionDevice();
  await WorkerDispatch.dispatch(device.request);
  device.exited("p2");
  device.reopening();
  expect(await WorkerDispatch.dispatch(device.request)).toMatchObject({ tag: "Ok" });
  const [first, second] = await device.launches();
  expect(second).toMatchObject({ worktreePath: first?.worktreePath, internalReview: false });
  expect(device.github).toHaveBeenCalledTimes(2);
});

test("a local branch behind the PR head moves forward to it", async () => {
  await using device = await adoptionDevice();
  git(device.checkout, "branch", "-q", branch, "main");
  expect(await WorkerDispatch.dispatch(device.request)).toMatchObject({ tag: "Ok" });
  const [launch] = await device.launches();
  expect(git(launch?.worktreePath ?? "", "rev-parse", "HEAD")).toBe(device.head);
});

test("a local branch with commits the PR lacks refuses and names the branch", async () => {
  await using device = await adoptionDevice();
  const { checkout } = device;
  git(checkout, "checkout", "-q", "-b", branch, `local/${branch}`);
  await Bun.write(`${checkout}/local.ts`, "local\n");
  git(checkout, "add", "local.ts");
  git(checkout, "commit", "-q", "-m", "local work");
  const local = git(checkout, "rev-parse", "HEAD");
  git(checkout, "checkout", "-q", "main");
  const result = await WorkerDispatch.dispatch(device.request);
  expect(result).toMatchObject({ tag: "Err", error: { reason: "adopt_branch_diverged" } });
  expect(result.tag === "Err" ? result.error.detail : "").toContain(
    `The local branch ${branch} has 1 commit that PR #41 lacks.`,
  );
  expect(git(checkout, "rev-parse", branch)).toBe(local);
  expect(await device.launches()).toEqual([]);
  expect(device.herdr.createWorktree).not.toHaveBeenCalled();
});

test("a branch checked out in a worktree refuses and names that worktree", async () => {
  await using device = await adoptionDevice();
  const elsewhere = `${device.root}/elsewhere`;
  git(device.checkout, "worktree", "add", "-q", "-b", branch, elsewhere, `local/${branch}`);
  const clean = await WorkerDispatch.dispatch(device.request);
  expect(clean).toMatchObject({ tag: "Err", error: { reason: "adopt_branch_checked_out" } });
  expect(clean.tag === "Err" ? clean.error.detail : "").toContain(
    `${branch} is checked out in ${elsewhere}.`,
  );
  await Bun.write(`${elsewhere}/draft.ts`, "draft\n");
  const dirty = await WorkerDispatch.dispatch(device.request);
  expect(dirty).toMatchObject({ tag: "Err", error: { reason: "adopt_branch_dirty" } });
  expect(dirty.tag === "Err" ? dirty.error.detail : "").toContain(
    `${branch} is checked out in ${elsewhere} with uncommitted changes.`,
  );
  expect(await Bun.file(`${elsewhere}/draft.ts`).text()).toBe("draft\n");
  expect(await device.launches()).toEqual([]);
});

test.each([
  [{ state: "closed" }, "adopt_pr_not_open"],
  [{ ref: "feature/other" }, "adopt_pr_branch_mismatch"],
  [{ repo: "fork/one" }, "adopt_pr_branch_mismatch"],
  [{ repo: null }, "adopt_pr_branch_mismatch"],
])("PR %o refuses with %s before any record", async (pr, reason) => {
  await using device = await adoptionDevice(pr);
  expect(await WorkerDispatch.dispatch(device.request)).toMatchObject({
    tag: "Err",
    error: { reason },
  });
  expect(await device.launches()).toEqual([]);
  expect(git(device.checkout, "branch", "--list", branch)).toBe("");
});

test("an unreadable PR refuses before any record", async () => {
  await using device = await adoptionDevice();
  device.github.mockResolvedValue({ status: "uncertain", detail: "timeout" });
  expect(await WorkerDispatch.dispatch(device.request)).toMatchObject({
    tag: "Err",
    error: { reason: "adopt_pr_unreadable" },
  });
  expect(await device.launches()).toEqual([]);
});
