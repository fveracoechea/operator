import { afterEach, expect, test } from "bun:test";
// Bun has no recursive directory removal API.
import { chmod, rename, rm } from "node:fs/promises";
import { z } from "zod";
import { workerDevice } from "./worker-fixture.ts";

let root = "";
afterEach(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
});

test.each(["commit-implementation", "custom-commit"])(
  "commit completion reviews in a fresh launch and lands one commit locally and remotely without PR facts (%s)",
  async (kind) => {
    const device = await workerDevice({
      kinds: {
        "custom-commit": {
          completion: "commit",
          resources: "worktree",
          profile: null,
          nextKind: null,
          readsNote: false,
          dispatchable: true,
          guide: "custom-commit/SKILL.md",
          skillsToRead: [],
          workPhases: [{ name: "build", goal: "Implement this ticket without a PR." }],
        },
      },
    });
    root = device.root;
    await Bun.write(
      `${root}/release/custom-commit/SKILL.md`,
      "# Custom commit\nFollow the task without a PR.\n",
      { createPath: true },
    );
    const gitPath = z.string().parse(Bun.which("git"));
    const bare = `${root}/origin.git`;
    expect((await device.exec([gitPath, "init", "--bare", "-q", bare], device.main)).code).toBe(0);
    expect((await device.exec([gitPath, "push", bare, "main"], device.main)).code).toBe(0);
    // Only transport is redirected; project identity remains the registered GitHub repository.
    await Bun.write(
      `${root}/tools/git`,
      `#!${process.execPath}
const args = process.argv.slice(2);
const command = args.find(a => ["push","fetch","ls-remote"].includes(a));
if (command) {
  const i = args.indexOf("origin");
  if(i >= 0) args[i] = ${JSON.stringify(bare)};
}
const child = Bun.spawn([${JSON.stringify(gitPath)}, ...args], {stdin:"inherit",stdout:"inherit",stderr:"inherit"});
const code = await child.exited;
const crash = Bun.file(${JSON.stringify(`${root}/crash-on`)});
if (code === 0 && await crash.exists() && (await crash.text()).trim() === args[0]) {
  await crash.delete();
  process.kill(process.ppid, "SIGKILL");
}
process.exit(code);
`,
    );
    await chmod(`${root}/tools/git`, 0o755);
    const source = await device.register({
      trackerKey: "#411",
      assignments: [
        {
          key: "ticket",
          trackerKey: "#411",
          instructions: "Add the file.",
          kind,
          branch: "ticket/411",
          dependencies: [],
          delivery: {
            checks: [
              [
                process.execPath,
                "-e",
                "if (!(await Bun.file('feature').exists())) process.exit(1)",
              ],
            ],
          },
        },
        {
          key: "verify",
          trackerKey: "#411-verify",
          instructions: "Inspect delivered work.",
          kind: "research",
          resources: "pane",
          dependencies: ["ticket"],
        },
      ],
    });
    const implementer = await device.dispatch(source, "ticket");
    const worktree = z.string().parse(implementer.worktreePath);
    await Bun.write(`${worktree}/feature`, "ticket change\n");
    expect((await device.exec(["git", "add", "."], worktree)).code).toBe(0);
    expect(
      (await device.exec(["git", "commit", "-qm", "intermediate implementation"], worktree)).code,
    ).toBe(0);
    const hook = `${device.main}/.git/hooks/pre-commit`;
    await Bun.write(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);
    expect(
      (await device.run(["commit", "review"], { cwd: worktree, pane: implementer.paneId })).code,
    ).not.toBe(0);
    const pending =
      z
        .object({
          data: z.object({
            commitDeliveries: z.array(
              z.object({
                data: z.object({
                  candidate: z.object({ path: z.string(), head: z.null(), branch: z.string() }),
                  history: z.array(z.string()),
                  journal: z.array(
                    z.object({ effect: z.string(), state: z.string(), at: z.string() }),
                  ),
                }),
              }),
            ),
          }),
        })
        .parse((await device.run(["source", "show", "--source", source])).output).data
        .commitDeliveries[0]?.data ?? expect.unreachable();
    await Bun.write(`${pending.candidate.path}/package.json`, "personal staged work\n");
    expect((await device.exec(["git", "add", "package.json"], pending.candidate.path)).code).toBe(
      0,
    );
    const staged = (await device.exec(["git", "ls-files", "--stage"], pending.candidate.path))
      .stdout;
    await Bun.file(hook).delete();
    const refused = await device.run(["commit", "review"], {
      cwd: worktree,
      pane: implementer.paneId,
    });
    expect(refused.output.reason).toBe("commit_worktree_unclean");
    expect(await Bun.file(`${pending.candidate.path}/package.json`).text()).toBe(
      "personal staged work\n",
    );
    expect((await device.exec(["git", "ls-files", "--stage"], pending.candidate.path)).stdout).toBe(
      staged,
    );
    const retained: unknown = (await device.run(["source", "show", "--source", source])).output;
    expect(retained).toMatchObject({
      data: {
        commitDeliveries: [
          {
            data: {
              candidate: pending.candidate,
              history: [],
              journal: expect.arrayContaining(pending.journal) as unknown,
            },
          },
        ],
      },
    });
    // The fixture person removes only their staged edit. Recovery must keep the installed ticket tree.
    expect(
      (
        await device.exec(
          ["git", "restore", "--source", "HEAD", "--staged", "--worktree", "package.json"],
          pending.candidate.path,
        )
      ).code,
    ).toBe(0);
    const started = await device.run(["commit", "review"], {
      cwd: worktree,
      pane: implementer.paneId,
    });
    expect(started.code, started.stderr).toBe(0);
    let reviewer: { paneId: string; brief: string } | null = null;
    for (let attempt = 0; attempt < 100; attempt++) {
      const read = await device.run(["source", "show", "--source", source]);
      const launches = z
        .object({
          data: z.object({
            launches: z.array(
              z.object({
                state: z.string(),
                paneId: z.string().nullable(),
                kind: z.object({ name: z.string() }).nullable(),
              }),
            ),
          }),
        })
        .parse(read.output).data.launches;
      const found = launches.find(
        (row) => row.kind?.name === "commit-review" && row.state === "running",
      );
      if (found?.paneId) {
        reviewer = { paneId: found.paneId, brief: implementer.brief };
        break;
      }
      await Bun.sleep(50);
    }
    expect(reviewer).not.toBeNull();
    const reviewPane = z.object({ paneId: z.string() }).parse(reviewer).paneId;
    expect(reviewPane).not.toBe(implementer.paneId);
    const reviewFacts = await device.run(["source", "show", "--source", source]);
    const target = z
      .object({
        data: z.object({
          commitDeliveries: z.array(
            z.object({
              data: z.object({
                base: z.string(),
                candidate: z.object({ head: z.string(), tree: z.string() }),
              }),
            }),
          ),
        }),
      })
      .parse(reviewFacts.output).data.commitDeliveries[0];
    const brief = await Bun.file(implementer.brief).text();
    expect(brief).toContain(z.string().parse(target?.data.candidate.head));
    expect(brief).toContain(z.string().parse(target?.data.base));
    expect(brief).toContain("refs/heads/main");
    expect(brief).toContain("local-and-origin");
    expect(brief).not.toContain("## Note");
    const findings = await device.writeText("findings.md", "## Findings\n");
    const recorded = await device.run(["commit", "round", "--file", findings], {
      cwd: worktree,
      pane: reviewPane,
    });
    expect(recorded.code, recorded.stderr).toBe(0);
    expect(await device.next("verify")).toMatchObject([
      {
        reason: "dependencies_pending",
        blockers: [{ assignment: "ticket", completion: "commit", required: "completed" }],
      },
    ]);
    const dispositions = await device.writeText("delivery.md", "## Dispositions\n");
    const base = (await device.exec(["git", "rev-parse", "main"], device.main)).stdout.trim();
    // Even coincidentally identical staged work belongs to the person, not this operation.
    await Bun.write(`${device.main}/feature`, "ticket change\n");
    expect((await device.exec(["git", "add", "feature"], device.main)).code).toBe(0);
    const dirty = await device.run(["commit", "deliver", "--file", dispositions], {
      cwd: worktree,
      pane: reviewPane,
    });
    expect(dirty.output.reason).toBe("commit_worktree_unclean");
    expect((await device.exec(["git", "rev-parse", "main"], device.main)).stdout.trim()).toBe(base);
    expect(
      (await device.exec(["git", "diff", "--cached", "--name-only"], device.main)).stdout.trim(),
    ).toBe("feature");
    expect(
      (
        await device.exec(
          ["git", "restore", "--source", "HEAD", "--staged", "--worktree", "feature"],
          device.main,
        )
      ).code,
    ).toBe(0);
    await Bun.write(`${device.main}/.git/info/exclude`, "\nfeature\n");
    await Bun.write(`${device.main}/feature`, "personal ignored work\n");
    const ignoredIndex = (await device.exec(["git", "ls-files", "--stage"], device.main)).stdout;
    for (let attempt = 0; attempt < 2; attempt++) {
      const ignored = await device.run(["commit", "deliver", "--file", dispositions], {
        cwd: worktree,
        pane: reviewPane,
      });
      expect(ignored.output.reason).toBe("commit_git_failed");
      expect(await Bun.file(`${device.main}/feature`).text()).toBe("personal ignored work\n");
      expect((await device.exec(["git", "ls-files", "--stage"], device.main)).stdout).toBe(
        ignoredIndex,
      );
      expect((await device.exec(["git", "rev-parse", "main"], device.main)).stdout.trim()).toBe(
        base,
      );
      expect(
        (
          await device.exec([gitPath, "--git-dir", bare, "rev-parse", "main"], device.main)
        ).stdout.trim(),
      ).toBe(base);
      expect((await device.run(["source", "show", "--source", source])).output.data).toMatchObject({
        commitDeliveries: [{ data: { publishedHead: null, stage: "checkout" } }],
      });
    }
    await Bun.file(`${device.main}/feature`).delete();
    for (const effect of ["apply", "update-ref", "push"]) {
      await Bun.write(`${root}/crash-on`, effect);
      const crashed = await device.runRaw(["commit", "deliver", "--file", dispositions], {
        cwd: worktree,
        pane: reviewPane,
      });
      expect(crashed.code).not.toBe(0);
      expect(await Bun.file(`${root}/crash-on`).exists()).toBe(false);
      expect(await device.next("verify")).toMatchObject([{ reason: "dependencies_pending" }]);
    }
    const delivered = await device.run(["commit", "deliver", "--file", dispositions], {
      cwd: worktree,
      pane: reviewPane,
    });
    expect(delivered.code, delivered.stderr).toBe(0);
    expect(await Bun.file(`${device.main}/feature`).text()).toBe("ticket change\n");
    expect((await device.exec(["git", "status", "--porcelain"], device.main)).stdout).toBe("");
    const local = (await device.exec(["git", "rev-parse", "main"], device.main)).stdout.trim();
    expect(
      (
        await device.exec([gitPath, "--git-dir", bare, "rev-parse", "main"], device.main)
      ).stdout.trim(),
    ).toBe(local);
    expect(
      (await device.exec(["git", "rev-list", "--count", "main"], device.main)).stdout.trim(),
    ).toBe("2");
    expect((await device.exec(["git", "log", "-1", "--format=%s"], device.main)).stdout).toContain(
      "#411",
    );
    expect(await Bun.file(`${worktree}/feature`).text()).toBe("ticket change\n");
    expect(
      (await device.exec(["git", "log", "--format=%s", "ticket/411"], device.main)).stdout,
    ).toContain("intermediate implementation");
    const read = await device.run(["source", "show", "--source", source]);
    expect(read.output.data).toMatchObject({
      state: "open",
      assignments: [
        { completion: "commit", state: "completed" },
        { completion: "report", state: "ready" },
      ],
      pullRequests: [],
    });
    const retried = await device.run(["commit", "deliver", "--file", dispositions], {
      cwd: worktree,
      pane: reviewPane,
    });
    expect(retried.code, retried.stderr).toBe(0);
    expect((await device.exec(["git", "rev-parse", "main"], device.main)).stdout.trim()).toBe(
      local,
    );
    expect(await device.next("verify")).toMatchObject([{ action: "ready_assignment" }]);
    const awakened = await device.run(["next", "--source", source, "--wait", "--timeout", "0"]);
    expect(awakened.code, awakened.stderr).toBe(0);
    expect(JSON.stringify(awakened.output.data)).toContain("ready_assignment");
    const verifier = await device.dispatch(source, "verify");
    const report = await device.writeReport("verified.md", {
      conclusion: "The delivered feature is present.",
      evidence: ["feature contains ticket change."],
      unresolved: [],
      decisions: [],
    });
    expect(
      (
        await device.run(["report", "submit", "--file", report], {
          cwd: device.main,
          pane: verifier.paneId,
        })
      ).code,
    ).toBe(0);
    expect(
      (await device.run(["report", "accept", "--source", source, "--assignment", "verify"])).code,
    ).toBe(0);
    const finished = await device.run(["source", "show", "--source", source]);
    expect(finished.output.data).toMatchObject({ state: "finished", pullRequests: [] });
  },
  60000,
);

test("a lost ticket worktree refuses replacement without losing the pinned candidate or implementation history", async () => {
  const device = await workerDevice();
  root = device.root;
  const git = z.string().parse(Bun.which("git"));
  const bare = `${root}/origin.git`;
  expect((await device.exec([git, "init", "--bare", "-q", bare], device.main)).code).toBe(0);
  expect((await device.exec([git, "push", bare, "main"], device.main)).code).toBe(0);
  await Bun.write(
    `${root}/tools/git`,
    `#!${process.execPath}
const args = process.argv.slice(2);
if (["push", "fetch", "ls-remote"].includes(args[0])) {
  const index = args.indexOf("origin");
  if (index >= 0) args[index] = ${JSON.stringify(bare)};
}
const child = Bun.spawn([${JSON.stringify(git)}, ...args], {stdin:"inherit",stdout:"inherit",stderr:"inherit"});
process.exit(await child.exited);
`,
  );
  await chmod(`${root}/tools/git`, 0o755);
  const source = await device.register({
    trackerKey: "#411-lost",
    assignments: [
      {
        key: "ticket",
        trackerKey: "#411-lost",
        instructions: "Preserve this work.",
        kind: "commit-implementation",
        branch: "ticket/lost",
        dependencies: [],
        delivery: { checks: [[process.execPath, "-e", "process.exit(0)"]] },
      },
    ],
  });
  const implementer = await device.dispatch(source, "ticket");
  const worktree = z.string().parse(implementer.worktreePath);
  await Bun.write(`${worktree}/feature`, "retained intermediate work\n");
  expect((await device.exec(["git", "add", "."], worktree)).code).toBe(0);
  expect(
    (await device.exec(["git", "commit", "-qm", "retained implementation"], worktree)).code,
  ).toBe(0);
  const intermediate = (await device.exec(["git", "rev-parse", "HEAD"], worktree)).stdout.trim();
  expect(
    (await device.run(["commit", "review"], { cwd: worktree, pane: implementer.paneId })).code,
  ).toBe(0);
  const snapshot = z.object({
    data: z.object({
      assignments: z.array(z.object({ state: z.string() })),
      launches: z.array(
        z.object({ name: z.string(), paneId: z.string().nullable(), state: z.string() }),
      ),
      commitDeliveries: z.array(
        z.object({
          data: z.object({
            candidate: z.object({ head: z.string(), branch: z.string(), path: z.string() }),
            history: z.array(z.string()),
          }),
        }),
      ),
    }),
  });
  let read = snapshot.parse((await device.run(["source", "show", "--source", source])).output).data;
  for (
    let attempt = 0;
    attempt < 100 &&
    !read.launches.some((row) => row.state === "running" && row.paneId !== implementer.paneId);
    attempt++
  ) {
    await Bun.sleep(50);
    read = snapshot.parse((await device.run(["source", "show", "--source", source])).output).data;
  }
  const reviewer = read.launches.find(
    (row) => row.state === "running" && row.paneId !== implementer.paneId,
  );
  expect(reviewer).toBeDefined();
  const pinned = read.commitDeliveries;
  await device.setHerdr({ agents: [], tabs: [] });
  const resumed = await device.dispatch(source, "ticket");
  expect(resumed.worktreePath).toBe(worktree);
  expect(resumed.paneId).not.toBe(reviewer?.paneId);
  read = snapshot.parse((await device.run(["source", "show", "--source", source])).output).data;
  expect(read.commitDeliveries).toEqual(pinned);
  await rename(worktree, `${root}/retained-ticket`);
  await device.setHerdr({ agents: [], tabs: [] });
  const before = (await device.herdrCalls()).filter(
    (args) => args[0] === "worktree" && args[1] === "create",
  ).length;
  const replacement = await device.run(["dispatch", "--source", source, "--assignment", "ticket"]);
  expect(replacement.code).not.toBe(0);
  expect(replacement.output.reason).toBe("assignment_not_dispatchable");
  const after = snapshot.parse(
    (await device.run(["source", "show", "--source", source])).output,
  ).data;
  expect(after.commitDeliveries).toEqual(pinned);
  expect(after.launches).toHaveLength(read.launches.length);
  expect(
    (await device.herdrCalls()).filter((args) => args[0] === "worktree" && args[1] === "create"),
  ).toHaveLength(before);
  expect((await device.exec(["git", "rev-parse", "ticket/lost"], device.main)).stdout.trim()).toBe(
    intermediate,
  );
  const candidate = z
    .object({ head: z.string(), branch: z.string(), path: z.string() })
    .parse(pinned[0]?.data.candidate);
  expect(
    (await device.exec(["git", "rev-parse", candidate.branch], device.main)).stdout.trim(),
  ).toBe(candidate.head);
  expect(await Bun.file(`${candidate.path}/feature`).text()).toBe("retained intermediate work\n");
  expect(await Bun.file(`${root}/retained-ticket/feature`).text()).toBe(
    "retained intermediate work\n",
  );
  expect((await device.exec(["git", "rev-parse", "main"], device.main)).stdout.trim()).not.toBe(
    candidate.head,
  );
}, 30000);
