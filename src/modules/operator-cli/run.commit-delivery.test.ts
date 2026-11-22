import { afterEach, expect, test } from "bun:test";
// Bun has no recursive directory removal API.
import { chmod, rm } from "node:fs/promises";
import { z } from "zod";
import { workerDevice } from "./worker-fixture.ts";

let root = "";
afterEach(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
});

test("commit completion reviews in a fresh launch and lands one commit locally and remotely without PR facts", async () => {
  const device = await workerDevice();
  root = device.root;
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
        kind: "commit-implementation",
        branch: "ticket/411",
        dependencies: [],
        delivery: {
          checks: [
            [process.execPath, "-e", "if (!(await Bun.file('feature').exists())) process.exit(1)"],
          ],
        },
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
  for (const effect of ["read-tree", "update-ref", "push"]) {
    await Bun.write(`${root}/crash-on`, effect);
    const crashed = await device.runRaw(["commit", "deliver", "--file", dispositions], {
      cwd: worktree,
      pane: reviewPane,
    });
    expect(crashed.code).not.toBe(0);
    expect(await Bun.file(`${root}/crash-on`).exists()).toBe(false);
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
    state: "finished",
    assignments: [{ completion: "commit", state: "completed" }],
    pullRequests: [],
  });
  const retried = await device.run(["commit", "deliver", "--file", dispositions], {
    cwd: worktree,
    pane: reviewPane,
  });
  expect(retried.code, retried.stderr).toBe(0);
  expect((await device.exec(["git", "rev-parse", "main"], device.main)).stdout.trim()).toBe(local);
}, 30000);
