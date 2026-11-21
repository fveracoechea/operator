import { afterEach, expect, test } from "bun:test";
// Bun has no recursive directory removal or permission API.
import { chmod, rm } from "node:fs/promises";
import { z } from "zod";
import { workerDevice } from "./worker-fixture.ts";
import { fakeGithubScript } from "./github-fixture.ts";

type Device = Awaited<ReturnType<typeof workerDevice>>;
let device: Device | undefined;
const panes = new Map<string, string>();

afterEach(async () => {
  if (device !== undefined) await rm(device.root, { recursive: true, force: true });
  device = undefined;
  panes.clear();
});

async function git(cwd: string, ...args: string[]) {
  const result = await (device as Device).exec(["git", ...args], cwd);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
}

const fixtureState = z.looseObject({ pulls: z.array(z.looseObject({ number: z.number() })) });
async function github(change: (state: z.infer<typeof fixtureState>) => void) {
  const file = Bun.file(`${(device as Device).root}/github.json`);
  const state = fixtureState.parse(await file.json());
  change(state);
  await Bun.write(file, JSON.stringify(state));
}

async function open(assignment: string, source: string, number: number, base: string) {
  const launched = await (device as Device).dispatch(source, assignment);
  const cwd = launched.worktreePath ?? "";
  await Bun.write(`${cwd}/${assignment}.txt`, `${assignment}\n`);
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-qm", assignment);
  await git(cwd, "push", "-qu", "origin", `task/${assignment}`);
  await github((state) => {
    state.pulls.push({
      number,
      url: `https://github.com/example/one/pull/${number}`,
      headRefName: `task/${assignment}`,
      headRepository: "example/one",
      state: "OPEN",
      baseRefName: base,
    });
  });
  const associated = await (device as Device).run(["pr", "associate"], {
    cwd,
    pane: launched.paneId,
  });
  expect(associated.code, associated.stderr).toBe(0);
  await feedbackOwner(assignment, source, cwd);
  return cwd;
}

async function feedbackOwner(assignment: string, source: string, cwd: string) {
  const shown = z.object({
    data: z.object({
      launches: z.array(
        z.object({
          assignment: z.string(),
          state: z.string(),
          kind: z.object({ name: z.string() }).nullable(),
          paneId: z.string().nullable(),
        }),
      ),
    }),
  });
  let feedback = false;
  for (let attempt = 0; attempt < 100 && !feedback; attempt++) {
    const state = shown.parse(
      (await (device as Device).run(["source", "show", "--source", source])).output,
    );
    feedback = state.data.launches.some(
      (row) =>
        row.assignment === assignment &&
        row.state === "running" &&
        row.kind?.name === "pr-feedback",
    );
    const current = state.data.launches.findLast(
      (row) => row.assignment === assignment && row.state === "running",
    );
    if (current?.paneId !== undefined && current.paneId !== null) panes.set(cwd, current.paneId);
    if (!feedback) await Bun.sleep(100);
  }
  expect(
    feedback,
    JSON.stringify((await (device as Device).run(["source", "show", "--source", source])).output),
  ).toBe(true);
}

async function stackDevice(options: { multiple?: boolean } = {}) {
  device = await workerDevice();
  const { root, main } = device;
  const remote = `${root}/remote.git`;
  await git(root, "init", "-q", "--bare", "-b", "main", remote);
  await git(main, "remote", "set-url", "origin", remote);
  await git(main, "remote", "add", "github", "https://github.com/example/one.git");
  await git(main, "push", "-qu", "origin", "main");
  await Bun.write(`${root}/tools/gh`, fakeGithubScript(root));
  await chmod(`${root}/tools/gh`, 0o755);
  await Bun.write(`${root}/github.json`, JSON.stringify({ remote, pulls: [] }));
  const source = await device.register({
    trackerKey: "github:example/one#1",
    internalReview: false,
    assignments: [
      {
        key: "parent",
        trackerKey: "github:example/one#2",
        instructions: "Parent.",
        kind: "implementation",
        branch: "task/parent",
        dependencies: [],
      },
      {
        key: "child",
        trackerKey: "github:example/one#3",
        instructions: "Child.",
        kind: "implementation",
        branch: "task/child",
        dependencies: options.multiple === true ? ["parent", "sibling"] : ["parent"],
      },
      {
        key: "sibling",
        trackerKey: "github:example/one#4",
        instructions: "Sibling.",
        kind: "implementation",
        branch: "task/sibling",
        dependencies: [],
      },
    ],
  });
  const parent = await open("parent", source, 6, "main");
  if (options.multiple === true) {
    const sibling = await open("sibling", source, 9, "main");
    return { parent, child: "", source, sibling };
  }
  const child = await open("child", source, 8, "task/parent");
  return { parent, child, source, sibling: "" };
}

test("owner previews and refreshes a child onto its newer OPEN parent without changing the parent's refs", async () => {
  const { parent, child, source: sourceId } = await stackDevice();
  const original = await git(child, "rev-parse", "HEAD");
  await Bun.write(`${parent}/new-parent.txt`, "new parent\n");
  await git(parent, "add", ".");
  await git(parent, "commit", "-qm", "new parent");
  await git(parent, "push", "-q");
  const parentHead = await git(parent, "rev-parse", "HEAD");
  const preview = await (device as Device).run(["pr", "stack", "plan"], { cwd: child });
  expect(preview.code, preview.stderr).toBe(0);
  const plan = z
    .object({
      data: z.object({
        id: z.string(),
        sourceId: z.string(),
        head: z.string(),
        parents: z.array(z.object({ head: z.string() })),
      }),
    })
    .parse(preview.output).data;
  expect(plan.head).toBe(original);
  expect(plan.parents.map((row) => row.head)).toEqual([parentHead]);
  expect(await git(child, "rev-parse", "HEAD")).toBe(original);
  const applied = await (device as Device).run(["pr", "stack", "apply", "--plan", plan.id], {
    cwd: child,
  });
  expect(applied.code, applied.stderr).toBe(0);
  expect(await Bun.file(`${child}/new-parent.txt`).text()).toBe("new parent\n");
  expect(await Bun.file(`${child}/child.txt`).text()).toBe("child\n");
  expect(await git(parent, "rev-parse", "HEAD")).toBe(parentHead);
  expect(await git(child, "diff", "task/parent...HEAD", "--name-only")).toBe("child.txt");
  expect(await git(child, "ls-remote", "origin", "refs/heads/task/child")).toStartWith(
    await git(child, "rev-parse", "HEAD"),
  );
  const source = await (device as Device).run(["source", "show", "--source", plan.sourceId]);
  const childReadiness = z
    .object({
      data: z.object({
        pullRequests: z.array(z.object({ assignment: z.string(), readiness: z.unknown() })),
        stackOperations: z.array(z.object({ reviewHistory: z.string().nullable() })),
      }),
    })
    .parse(source.output).data;
  expect(childReadiness.pullRequests.find((pr) => pr.assignment === "child")?.readiness).toBeNull();
  expect(childReadiness.stackOperations[0]?.reviewHistory).toContain(original);
  const reviews = z
    .object({
      data: z.object({
        internalReviews: z.array(z.object({ state: z.string(), readyHead: z.string().nullable() })),
      }),
    })
    .parse(source.output).data.internalReviews;
  expect(reviews[0]).toEqual({ state: "reviewing", readyHead: null });
  const githubState = fixtureState.parse(
    await Bun.file(`${(device as Device).root}/github.json`).json(),
  );
  expect(githubState.pulls.find((row) => row.number === 8)?.isDraft).toBe(true);
  const brief = await Bun.file(
    `${(device as Device).root}/state/operator/projects/example/one/sources/${sourceId}/assignments/child/brief.md`,
  ).text();
  expect(brief).toContain(`operator pr stack review --plan ${plan.id}`);
  expect(brief).toContain(parentHead);
  const repeated = await (device as Device).run(["pr", "stack", "apply", "--plan", plan.id], {
    cwd: child,
  });
  expect(repeated.code, repeated.stderr).toBe(0);
  const oldReady = await (device as Device).run(["pr", "ready"], {
    cwd: child,
    pane: panes.get(child),
  });
  expect(oldReady.output.reason).toBe("stack_review_required");
  const handoff = await (device as Device).run(["pr", "stack", "review", "--plan", plan.id], {
    cwd: child,
    pane: panes.get(child),
  });
  expect(handoff.code, handoff.stderr).toBe(0);
  expect(handoff.output.reason).toBe("stack_review_started");
  const handedOff = z.object({
    data: z.object({
      handoffs: z.array(
        z.object({ assignment: z.string(), handoffState: z.string(), nextKind: z.string() }),
      ),
      launches: z.array(
        z.object({
          assignment: z.string(),
          attempt: z.number(),
          state: z.string(),
          worktreePath: z.string().nullable(),
          internalReview: z.boolean().optional(),
          paneId: z.string().nullable(),
          kind: z.object({ name: z.string() }).nullable(),
        }),
      ),
    }),
  });
  let state = handedOff.parse(
    (await (device as Device).run(["source", "show", "--source", plan.sourceId])).output,
  ).data;
  for (
    let attempt = 0;
    attempt < 100 &&
    !state.launches.some(
      (launch) =>
        launch.assignment === "child" && launch.attempt === 3 && launch.state === "running",
    );
    attempt++
  ) {
    await Bun.sleep(100);
    state = handedOff.parse(
      (await (device as Device).run(["source", "show", "--source", plan.sourceId])).output,
    ).data;
  }
  expect(state.handoffs.find((row) => row.assignment === "child")).toMatchObject({
    handoffState: "done",
    nextKind: "review",
  });
  expect(
    state.launches.find((launch) => launch.assignment === "child" && launch.attempt === 3),
  ).toMatchObject({
    assignment: "child",
    attempt: 3,
    state: "running",
    worktreePath: child,
    internalReview: true,
    kind: { name: "review" },
  });
  const reviewerBrief = await Bun.file(
    `${(device as Device).root}/state/operator/projects/example/one/sources/${sourceId}/assignments/child/brief.md`,
  ).text();
  expect(reviewerBrief).not.toContain(`operator pr stack review --plan ${plan.id}`);
  expect(reviewerBrief).toContain("review");
  const reviewerPane =
    state.launches.find((launch) => launch.assignment === "child" && launch.attempt === 3)
      ?.paneId ?? "";
  const round = await (device as Device).writeText("fresh-stack-round.md", "## Findings\n");
  expect(
    (
      await (device as Device).run(["pr", "round", "--file", round], {
        cwd: child,
        pane: reviewerPane,
      })
    ).code,
  ).toBe(0);
  const summary = await (device as Device).writeText(
    "fresh-stack-summary.md",
    "## Overview\nReviewed the actual integration against its new base.\n\n## Dispositions\n",
  );
  const ready = await (device as Device).run(["pr", "ready", "--file", summary], {
    cwd: child,
    pane: reviewerPane,
  });
  expect(ready.code, ready.stderr).toBe(0);
  await feedbackOwner("child", sourceId, child);
}, 60000);

test("a true no-op preserves the exact ready frontier and starts no new review", async () => {
  const { child, source } = await stackDevice();
  const before = await (device as Device).run(["source", "show", "--source", source]);
  const facts = z.object({
    data: z.object({
      pullRequests: z.array(z.object({ assignment: z.string(), readiness: z.unknown() })),
      launches: z.array(z.object({ id: z.string() })),
    }),
  });
  const original = await git(child, "rev-parse", "HEAD");
  const planned = await (device as Device).run(["pr", "stack", "plan"], { cwd: child });
  const id = z.object({ data: z.object({ id: z.string() }) }).parse(planned.output).data.id;
  const applied = await (device as Device).run(["pr", "stack", "apply", "--plan", id], {
    cwd: child,
  });
  expect(applied.code, applied.stderr).toBe(0);
  const after = await (device as Device).run(["source", "show", "--source", source]);
  expect(facts.parse(after.output).data).toEqual(facts.parse(before.output).data);
  expect(await git(child, "rev-parse", "HEAD")).toBe(original);
  expect(
    (await (device as Device).run(["pr", "stack", "review", "--plan", id], { cwd: child })).output
      .reason,
  ).toBe("stack_review");
}, 60000);

test("an older known prerequisite ancestor cannot be used as a cut that replays prerequisite work", async () => {
  const { parent, child } = await stackDevice();
  const root = await git(parent, "rev-parse", "main");
  const original = await git(child, "rev-parse", "HEAD");
  const refused = await (device as Device).run(["pr", "stack", "plan", "--cut", root], {
    cwd: child,
  });
  expect(refused.output.reason).toBe("stack_attribution");
  expect(await git(child, "rev-parse", "HEAD")).toBe(original);
}, 60000);

test("a rejected child push retains the installed candidate and resumes without replaying child work", async () => {
  const { parent, child, source } = await stackDevice();
  await Bun.write(`${parent}/new.txt`, "parent update\n");
  await git(parent, "add", ".");
  await git(parent, "commit", "-qm", "parent update");
  await git(parent, "push", "-q");
  const original = await git(child, "rev-parse", "HEAD");
  const preview = await (device as Device).run(["pr", "stack", "plan"], { cwd: child });
  expect(preview.code, preview.stderr).toBe(0);
  const id = z.object({ data: z.object({ id: z.string() }) }).parse(preview.output).data.id;
  const hook = `${(device as Device).root}/remote.git/hooks/pre-receive`;
  await Bun.write(hook, "#!/bin/sh\nexit 1\n");
  await chmod(hook, 0o755);
  const failed = await (device as Device).run(["pr", "stack", "apply", "--plan", id], {
    cwd: child,
  });
  expect(failed.output.reason).toBe("stack_push");
  const candidate = await git(child, "rev-parse", "HEAD");
  expect(candidate).not.toBe(original);
  expect(await git(child, "ls-remote", "origin", "refs/heads/task/child")).toStartWith(original);
  const shown = await (device as Device).run(["source", "show", "--source", source]);
  const operations = z
    .object({
      data: z.object({
        stackOperations: z.array(
          z.object({
            state: z.string(),
            data: z.object({
              step: z.string(),
              failures: z.array(z.object({ reason: z.string() })),
            }),
          }),
        ),
      }),
    })
    .parse(shown.output).data.stackOperations;
  expect(operations[0]).toEqual({
    state: "blocked",
    data: { step: "installed", failures: [{ reason: "stack_push" }] },
  });
  await rm(hook);
  const uncertain = await (device as Device).run(["pr", "stack", "apply", "--plan", id], {
    cwd: child,
  });
  expect(uncertain.output.reason).toBe("stack_push_uncertain");
  expect(await git(child, "ls-remote", "origin", "refs/heads/task/child")).toStartWith(original);
  await git(
    child,
    "push",
    `--force-with-lease=refs/heads/task/child:${original}`,
    "origin",
    `${candidate}:refs/heads/task/child`,
  );
  const resumed = await (device as Device).run(["pr", "stack", "apply", "--plan", id], {
    cwd: child,
  });
  expect(resumed.code, resumed.stderr).toBe(0);
  expect(await git(child, "rev-parse", "HEAD")).toBe(candidate);
  expect(await git(child, "ls-remote", "origin", "refs/heads/task/child")).toStartWith(candidate);
  expect(await git(child, "diff", "task/parent...HEAD", "--name-only")).toBe("child.txt");
}, 60000);

test("a failed PR-base write remains blocked without blind retries and finishes only after observing the requested base", async () => {
  const { child, source } = await stackDevice();
  await open("sibling", source, 9, "main");
  const preview = await (device as Device).run(["pr", "stack", "plan", "--parent", "sibling"], {
    cwd: child,
  });
  expect(preview.code, preview.stderr).toBe(0);
  const plan = z
    .object({ data: z.object({ id: z.string(), targetBranch: z.string() }) })
    .parse(preview.output).data;
  await github((state) => {
    state.failPatch = "unavailable";
  });
  const failed = await (device as Device).run(["pr", "stack", "apply", "--plan", plan.id], {
    cwd: child,
  });
  expect(failed.output.reason).toBe("stack_retarget_uncertain");
  const candidate = await git(child, "rev-parse", "HEAD");
  await github((state) => {
    delete state.failPatch;
  });
  const refused = await (device as Device).run(["pr", "stack", "apply", "--plan", plan.id], {
    cwd: child,
  });
  expect(refused.output.reason).toBe("stack_retarget_uncertain");
  const unchanged = fixtureState.parse(
    await Bun.file(`${(device as Device).root}/github.json`).json(),
  );
  expect(unchanged.pulls.find((row) => row.number === 8)?.baseRefName).toBe("task/parent");
  await github((state) => {
    const pr = state.pulls.find((row) => row.number === 8);
    if (pr !== undefined) pr.baseRefName = plan.targetBranch;
  });
  const resumed = await (device as Device).run(["pr", "stack", "apply", "--plan", plan.id], {
    cwd: child,
  });
  expect(resumed.code, resumed.stderr).toBe(0);
  expect(await git(child, "rev-parse", "HEAD")).toBe(candidate);
  expect(await Bun.file(`${child}/child.txt`).text()).toBe("child\n");
}, 60000);

test("a parent move after the child push permits cancellation and replanning without losing the pushed child delta", async () => {
  const { parent, child } = await stackDevice();
  await Bun.write(`${parent}/new.txt`, "first parent update\n");
  await git(parent, "add", ".");
  await git(parent, "commit", "-qm", "first update");
  await git(parent, "push", "-q");
  const preview = await (device as Device).run(["pr", "stack", "plan"], { cwd: child });
  expect(preview.code, preview.stderr).toBe(0);
  const id = z.object({ data: z.object({ id: z.string() }) }).parse(preview.output).data.id;
  await Bun.write(`${parent}/later.txt`, "later update\n");
  await git(parent, "add", ".");
  await git(parent, "commit", "-qm", "later update");
  const later = await git(parent, "rev-parse", "HEAD");
  await git(parent, "push", "-q", "origin", "HEAD:refs/heads/stored-later");
  const hook = `${(device as Device).root}/remote.git/hooks/post-receive`;
  await Bun.write(hook, `#!/bin/sh\ngit update-ref refs/heads/task/parent ${later}\n`);
  await chmod(hook, 0o755);
  const applied = await (device as Device).run(["pr", "stack", "apply", "--plan", id], {
    cwd: child,
  });
  expect(applied.output.reason).toBe("stack_stale");
  const candidate = await git(child, "rev-parse", "HEAD");
  await rm(hook);
  const cancelled = await (device as Device).run(["pr", "stack", "cancel", "--plan", id], {
    cwd: child,
  });
  expect(cancelled.code, cancelled.stderr).toBe(0);
  expect(await git(child, "rev-parse", "HEAD")).toBe(candidate);
  const next = await (device as Device).run(["pr", "stack", "plan"], { cwd: child });
  expect(next.code, next.stderr).toBe(0);
  const nextId = z.object({ data: z.object({ id: z.string() }) }).parse(next.output).data.id;
  const refreshed = await (device as Device).run(["pr", "stack", "apply", "--plan", nextId], {
    cwd: child,
  });
  expect(refreshed.code, refreshed.stderr).toBe(0);
  expect(await Bun.file(`${child}/later.txt`).text()).toBe("later update\n");
  expect(await git(child, "diff", `${later}...HEAD`, "--name-only")).toBe("child.txt");
}, 60000);

test("a conflicting refresh preserves child work and its owner can cancel the unapplied operation", async () => {
  const { parent, child } = await stackDevice();
  await Bun.write(`${child}/parent.txt`, "child resolution\n");
  await git(child, "add", ".");
  await git(child, "commit", "-qm", "child resolution");
  await git(child, "push", "-q");
  await Bun.write(`${parent}/parent.txt`, "changed parent\n");
  await git(parent, "add", ".");
  await git(parent, "commit", "-qm", "changed parent");
  await git(parent, "push", "-q");
  const original = await git(child, "rev-parse", "HEAD");
  const preview = await (device as Device).run(["pr", "stack", "plan"], { cwd: child });
  expect(preview.code, preview.stderr).toBe(0);
  const id = z.object({ data: z.object({ id: z.string() }) }).parse(preview.output).data.id;
  const failed = await (device as Device).run(["pr", "stack", "apply", "--plan", id], {
    cwd: child,
  });
  expect(failed.output.reason).toBe("stack_conflict");
  expect(await git(child, "rev-parse", "HEAD")).toBe(original);
  expect(await Bun.file(`${child}/parent.txt`).text()).toBe("child resolution\n");
  expect(await git(child, "ls-remote", "origin", "refs/heads/task/child")).toStartWith(original);
  const cancelled = await (device as Device).run(["pr", "stack", "cancel", "--plan", id], {
    cwd: child,
  });
  expect(cancelled.code, cancelled.stderr).toBe(0);
  const next = await (device as Device).run(["pr", "stack", "plan"], { cwd: child });
  expect(next.code, next.stderr).toBe(0);
}, 60000);

test("a child with several OPEN parents dispatches, waits for every merge, and relays only its own delta", async () => {
  const { parent, source, sibling } = await stackDevice({ multiple: true });
  const dispatched = await (device as Device).dispatch(source, "child");
  const child = dispatched.worktreePath ?? "";
  const target = await git(child, "rev-parse", "HEAD");
  const branch = `operator/stacks/${source}/child/${target}`;
  expect(await Bun.file(`${child}/parent.txt`).text()).toBe("parent\n");
  expect(await Bun.file(`${child}/sibling.txt`).text()).toBe("sibling\n");
  const brief = await Bun.file(dispatched.brief).text();
  expect(brief).toContain(branch);
  expect(brief).toContain("sibling");
  expect(await git(parent, "ls-remote", "origin", `refs/heads/${branch}`)).toStartWith(target);
  await Bun.write(`${child}/child.txt`, "child\n");
  await git(child, "add", ".");
  await git(child, "commit", "-qm", "child");
  await git(child, "push", "-qu", "origin", "task/child");
  await github((state) =>
    state.pulls.push({
      number: 8,
      url: "https://github.com/example/one/pull/8",
      headRefName: "task/child",
      headRepository: "example/one",
      state: "OPEN",
      baseRefName: branch,
    }),
  );
  const associated = await (device as Device).run(["pr", "associate"], {
    cwd: child,
    pane: dispatched.paneId,
  });
  expect(associated.code, associated.stderr).toBe(0);
  await feedbackOwner("child", source, child);
  expect(await git(child, "diff", `${target}...HEAD`, "--name-only")).toBe("child.txt");
  const childHead = await git(child, "rev-parse", "HEAD");
  await github((state) => {
    const first = state.pulls.find((row) => row.number === 6);
    if (first !== undefined) Object.assign(first, { state: "MERGED" });
    const pr = state.pulls.find((row) => row.number === 8);
    if (pr !== undefined)
      pr.comments = [
        {
          id: "first-feedback",
          body: "Retain this real feedback while another parent stays open.",
          author: "reviewer",
        },
      ];
  });
  const waiting = await (device as Device).run(["pr", "wait", "--timeout", "0"], { cwd: child });
  expect(waiting.code, waiting.stderr).toBe(0);
  expect(await git(child, "rev-parse", "HEAD")).toBe(childHead);
  const observed = fixtureState.parse(
    await Bun.file(`${(device as Device).root}/github.json`).json(),
  );
  expect(observed.pulls.find((row) => row.number === 8)?.baseRefName).toBe(branch);
  const oldSibling = await git(sibling, "rev-parse", "HEAD");
  await git(sibling, "switch", "-qc", "rewritten-sibling", "main");
  await Bun.write(`${sibling}/replacement.txt`, "new sibling implementation\n");
  await git(sibling, "add", ".");
  await git(sibling, "commit", "-qm", "replacement sibling");
  await git(
    sibling,
    "push",
    `--force-with-lease=refs/heads/task/sibling:${oldSibling}`,
    "origin",
    "HEAD:refs/heads/task/sibling",
  );
  const merger = `${(device as Device).root}/merger`;
  await git(
    (device as Device).root,
    "clone",
    "-q",
    `${(device as Device).root}/remote.git`,
    merger,
  );
  for (const prerequisite of ["parent", "sibling"]) {
    await git(merger, "merge", "-q", "--squash", `origin/task/${prerequisite}`);
    await git(merger, "commit", "-qm", `merge ${prerequisite}`);
  }
  await git(merger, "push", "-q", "origin", "main");
  await github((state) => {
    const second = state.pulls.find((row) => row.number === 9);
    if (second !== undefined) Object.assign(second, { state: "MERGED" });
  });
  const relayed = await (device as Device).run(["pr", "wait", "--timeout", "0"], { cwd: child });
  expect(relayed.code, relayed.stderr).toBe(0);
  expect(await Bun.file(`${child}/sibling.txt`).exists()).toBe(false);
  expect(await Bun.file(`${child}/replacement.txt`).text()).toBe("new sibling implementation\n");
  expect(
    await git(child, "diff", `${await git(merger, "rev-parse", "HEAD")}...HEAD`, "--name-only"),
  ).toBe("child.txt");
  const finalState = fixtureState.parse(
    await Bun.file(`${(device as Device).root}/github.json`).json(),
  );
  expect(finalState.pulls.find((row) => row.number === 8)?.baseRefName).toBe("main");
  expect(finalState.pulls.find((row) => row.number === 8)?.isDraft).toBe(true);
}, 60000);

test("an existing child adds an implemented sibling through a dependency-only managed base without editing its plan", async () => {
  const { parent, child, source } = await stackDevice();
  const sibling = await open("sibling", source, 9, "main");
  const parentHead = await git(parent, "rev-parse", "HEAD");
  const siblingHead = await git(sibling, "rev-parse", "HEAD");
  const before = await (device as Device).run(["source", "show", "--source", source]);
  const preview = await (device as Device).run(["pr", "stack", "plan", "--parent", "sibling"], {
    cwd: child,
  });
  expect(preview.code, preview.stderr).toBe(0);
  const plan = z
    .object({ data: z.object({ id: z.string(), target: z.string(), targetBranch: z.string() }) })
    .parse(preview.output).data;
  const applied = await (device as Device).run(["pr", "stack", "apply", "--plan", plan.id], {
    cwd: child,
  });
  expect(applied.code, applied.stderr).toBe(0);
  expect(await Bun.file(`${child}/sibling.txt`).text()).toBe("sibling\n");
  expect(await git(child, "diff", `${plan.target}...HEAD`, "--name-only")).toBe("child.txt");
  expect(await git(child, "ls-remote", "origin", `refs/heads/${plan.targetBranch}`)).toStartWith(
    plan.target,
  );
  expect(await git(parent, "rev-parse", "HEAD")).toBe(parentHead);
  expect(await git(sibling, "rev-parse", "HEAD")).toBe(siblingHead);
  const after = await (device as Device).run(["source", "show", "--source", source]);
  const planned = z.object({
    data: z.object({ plan: z.unknown() }),
  });
  expect(planned.parse(after.output).data.plan).toEqual(planned.parse(before.output).data.plan);
  const githubState = fixtureState.parse(
    await Bun.file(`${(device as Device).root}/github.json`).json(),
  );
  expect(githubState.pulls.find((row) => row.number === 8)?.baseRefName).toBe(plan.targetBranch);
  const refreshed = await (device as Device).run(["pr", "stack", "plan"], { cwd: child });
  expect(refreshed.code, refreshed.stderr).toBe(0);
  expect(
    z
      .object({ data: z.object({ parents: z.array(z.object({ assignment: z.string() })) }) })
      .parse(refreshed.output)
      .data.parents.map((row) => row.assignment),
  ).toEqual(["parent", "sibling"]);
}, 60000);

test("rewritten OPEN parent refresh retains only the child's delta after a proven historical cut", async () => {
  const { parent, child } = await stackDevice();
  const oldParent = await git(parent, "rev-parse", "HEAD");
  const original = await git(child, "rev-parse", "HEAD");
  await git(parent, "switch", "-qc", "rewritten-parent", "main");
  await Bun.write(`${parent}/replacement.txt`, "replacement parent\n");
  await git(parent, "add", ".");
  await git(parent, "commit", "-qm", "rewritten parent");
  const replacement = await git(parent, "rev-parse", "HEAD");
  await git(
    parent,
    "push",
    `--force-with-lease=refs/heads/task/parent:${oldParent}`,
    "origin",
    "HEAD:refs/heads/task/parent",
  );
  const preview = await (device as Device).run(["pr", "stack", "plan", "--cut", oldParent], {
    cwd: child,
  });
  expect(preview.code, preview.stderr).toBe(0);
  const plan = z
    .object({ data: z.object({ id: z.string(), cut: z.string() }) })
    .parse(preview.output).data;
  expect(plan.cut).toBe(oldParent);
  const applied = await (device as Device).run(["pr", "stack", "apply", "--plan", plan.id], {
    cwd: child,
  });
  expect(applied.code, applied.stderr).toBe(0);
  expect(await Bun.file(`${child}/parent.txt`).exists()).toBe(false);
  expect(await Bun.file(`${child}/replacement.txt`).text()).toBe("replacement parent\n");
  expect(await Bun.file(`${child}/child.txt`).text()).toBe("child\n");
  expect(await git(child, "rev-parse", `refs/operator/stacks/${plan.id}/original`)).toBe(original);
  expect(await git(child, "diff", `${replacement}...HEAD`, "--name-only")).toBe("child.txt");
}, 60000);
