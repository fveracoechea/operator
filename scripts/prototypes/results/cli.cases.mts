import { expect, test } from "bun:test";
// Bun has no temporary directory or directory removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { z } from "zod";
import { designs, type Design } from "./model.mts";
import * as assignment from "../state-machines/assignment/model.ts";
import * as review from "../state-machines/review/model.ts";
import { Database } from "bun:sqlite";

const outputSchema = z.object({
  schemaVersion: z.literal(1),
  operation: z.string(),
  outcome: z.string(),
  reason: z.string(),
  blockers: z.array(z.unknown()),
  data: z
    .object({ revision: z.number(), state: z.union([assignment.stateSchema, review.stateSchema]) })
    .optional(),
});
async function command(root: string, request: unknown, interrupt = false) {
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/cli.mts`, root], {
    stdin: new Blob([JSON.stringify(request)]),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
    },
    ipc(message, child) {
      if (interrupt && message === "external-started") child.kill("SIGINT");
    },
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stderr, output: stdout ? outputSchema.parse(JSON.parse(stdout)) : undefined };
}
async function withRoot(work: (root: string) => Promise<void>) {
  const root = await mkdtemp("/tmp/opencode/operator-261-run-");
  try {
    await work(root);
  } finally {
    await rm(root, { recursive: true });
  }
}
function step(design: Design, workflow: "assignment" | "review", extra: object = {}) {
  return {
    command: "step",
    design,
    workflow,
    action: workflow === "assignment" ? "merge" : "draft",
    mode: "applied",
    revision: 0,
    ...extra,
  };
}
async function calls(root: string) {
  if (!(await Bun.file(`${root}/external.sqlite`).exists())) return 0;
  using db = new Database(`${root}/external.sqlite`, { readonly: true });
  return db.query<{ count: number }, []>("SELECT count(*) AS count FROM calls").get()?.count ?? 0;
}
async function show(root: string) {
  const shown = await command(root, { command: "show" });
  const data = shown.output?.data;
  if (!data) throw new Error("Missing state in show response");
  return data;
}

for (const design of designs) {
  for (const workflow of ["assignment", "review"] as const) {
    test(`${design} ${workflow} CLI completes its external action`, () =>
      withRoot(async (root) => {
        expect((await command(root, { command: "init", workflow })).code).toBe(0);
        const result = await command(root, step(design, workflow));
        expect(result.code).toBe(0);
        expect(result.output?.outcome).toBe("completed");
        expect(result.output?.data?.state.phase).toBe(
          workflow === "assignment" ? "merged" : "approved",
        );
        expect(await calls(root)).toBe(1);
      }));
    test(`${design} ${workflow} refuses without writes or external actions`, () =>
      withRoot(async (root) => {
        await command(root, { command: "init", workflow });
        const before = await Bun.file(`${root}/prototype.sqlite`).bytes();
        const result = await command(
          root,
          step(design, workflow, { approved: false, draftValid: false }),
        );
        expect(result.code).toBe(3);
        expect(result.output?.reason).toBe(
          workflow === "assignment" ? "approval-required" : "invalid-draft",
        );
        expect(await Bun.file(`${root}/prototype.sqlite`).bytes()).toEqual(before);
        expect(await calls(root)).toBe(0);
      }));
    test(`${design} ${workflow} rejects a stale revision without a write`, () =>
      withRoot(async (root) => {
        await command(root, { command: "init", workflow });
        const before = await show(root);
        const result = await command(root, step(design, workflow, { revision: 99 }));
        expect(result.output?.reason).toBe("stale-revision");
        expect(await show(root)).toEqual(before);
        expect(await calls(root)).toBe(0);
      }));
    test(`${design} ${workflow} rolls back a typed failure after a state write`, () =>
      withRoot(async (root) => {
        await command(root, { command: "init", workflow });
        const before = await show(root);
        const result = await command(root, step(design, workflow, { failAfterWrite: true }));
        expect(result.code).toBe(1);
        expect(result.output?.reason).toBe("store");
        expect(await show(root)).toEqual(before);
        expect(await calls(root)).toBe(0);
      }));
    for (const [mode, reason, code] of [
      ["throw", "transport", 5],
      ["reject", "transport", 5],
      ["invalid", "invalid-response", 5],
      ["tool", "tool", 5],
      ["timeout", "timeout", 5],
      ["rejected", "rejected", 1],
    ] as const) {
      test(`${design} ${workflow} CLI preserves evidence after ${mode}`, () =>
        withRoot(async (root) => {
          await command(root, { command: "init", workflow });
          const result = await command(root, step(design, workflow, { mode }));
          expect(result.code).toBe(code);
          expect(result.output?.reason).toBe(reason);
          expect((await show(root)).state.operation.status).toBe(
            mode === "rejected" ? "failed" : "unknown",
          );
          const count = await calls(root);
          if (mode !== "rejected") {
            const retry = await command(
              root,
              step(design, workflow, { action: "retry", revision: 2 }),
            );
            expect(retry.output?.reason).toBe("reconcile-before-retry");
            expect(await calls(root)).toBe(count);
          }
        }));
    }
    test(`${design} ${workflow} interruption preserves the external obligation`, () =>
      withRoot(async (root) => {
        await command(root, { command: "init", workflow });
        const result = await command(root, step(design, workflow, { mode: "timeout" }), true);
        expect(result.code).toBe(130);
        expect(result.output?.outcome).toBe("interrupted");
        expect((await show(root)).state.operation.status).toBe("unknown");
        expect(await calls(root)).toBe(1);
      }));
    for (const crash of ["before-effect", "after-effect"] as const) {
      test(`${design} ${workflow} recovers ${crash} without an automatic retry`, () =>
        withRoot(async (root) => {
          await command(root, { command: "init", workflow });
          const result = await command(root, step(design, workflow, { crash }));
          expect(result.code).toBe(86);
          expect((await show(root)).state.operation.status).toBe("pending");
          const recovered = await command(
            root,
            step(design, workflow, { action: "recover", revision: 1 }),
          );
          if (crash === "before-effect") {
            expect(recovered.output?.reason).toBe("outcome-unknown");
            const retried = await command(
              root,
              step(design, workflow, { action: "retry", revision: 1 }),
            );
            expect(retried.output?.reason).toBe("reconcile-before-retry");
            expect(await calls(root)).toBe(0);
          } else {
            expect(recovered.code).toBe(0);
            expect((await show(root)).state.phase).toBe(
              workflow === "assignment" ? "merged" : "approved",
            );
            expect(await calls(root)).toBe(1);
          }
        }));
    }
    test(`${design} ${workflow} reconciles partial success instead of reposting`, () =>
      withRoot(async (root) => {
        await command(root, { command: "init", workflow });
        const result = await command(root, step(design, workflow, { mode: "lost" }));
        expect(result.code).toBe(5);
        expect((await show(root)).state.operation.status).toBe("unknown");
        expect(
          (await command(root, step(design, workflow, { action: "recover", revision: 2 }))).code,
        ).toBe(0);
        const state = (await show(root)).state;
        expect(state.phase).toBe(workflow === "assignment" ? "merged" : "approved");
        if ("completion" in state && state.operation.status !== "idle")
          expect(state.operation.effect).toBe("delete-remote-branch");
        expect(await calls(root)).toBe(1);
      }));
    test(`${design} ${workflow} exposes callback defects without declaring non-application`, () =>
      withRoot(async (root) => {
        await command(root, { command: "init", workflow });
        const result = await command(root, step(design, workflow, { defect: true }));
        expect(result.code).toBe(1);
        expect(result.output?.outcome).toBe("defect");
        expect((await show(root)).state.operation.status).toBe("pending");
        expect(await calls(root)).toBe(1);
      }));
    test(`${design} ${workflow} rejects an old result after a retry`, () =>
      withRoot(async (root) => {
        await command(root, { command: "init", workflow });
        await command(root, step(design, workflow, { mode: "rejected" }));
        const oldState = (await show(root)).state;
        if (oldState.operation.status === "idle") throw new Error("Missing operation");
        const key =
          "key" in oldState.operation ? oldState.operation.key : oldState.operation.effect.key;
        expect(
          (
            await command(
              root,
              step(design, workflow, { action: "retry", revision: 2, crash: "before-effect" }),
            )
          ).code,
        ).toBe(86);
        const before = await show(root);
        expect(
          (await command(root, step(design, workflow, { action: "result", revision: 3, key })))
            .output?.reason,
        ).toBe("stale-result");
        expect(await show(root)).toEqual(before);
        expect(await calls(root)).toBe(1);
      }));
  }
  test(`${design} rechecks each current PR merge guard before retry`, () =>
    withRoot(async (root) => {
      await command(root, { command: "init", workflow: "assignment" });
      await command(root, step(design, "assignment", { mode: "rejected" }));
      for (const [facts, reason] of [
        [{ approved: false }, "approval-required"],
        [{ checks: "fail" }, "checks-not-passing"],
        [{ threadsResolved: false }, "unresolved-threads"],
        [{ defaultBase: false }, "default-base-required"],
      ] as const) {
        const result = await command(
          root,
          step(design, "assignment", { action: "retry", revision: 2, ...facts }),
        );
        expect(result.output?.reason).toBe(reason);
        expect(await calls(root)).toBe(1);
      }
      expect(
        (await command(root, step(design, "assignment", { action: "retry", revision: 2 }))).code,
      ).toBe(0);
      expect(await calls(root)).toBe(2);
    }));
  test(`${design} rechecks draft validity and current CI before a review retry`, () =>
    withRoot(async (root) => {
      await command(root, { command: "init", workflow: "review" });
      await command(root, step(design, "review", { mode: "rejected" }));
      const before = await show(root);
      const refused = await command(
        root,
        step(design, "review", { action: "retry", revision: 2, draftValid: false }),
      );
      expect(refused.code).toBe(3);
      expect(refused.output?.reason).toBe("invalid-draft");
      expect(await show(root)).toEqual(before);
      expect(await calls(root)).toBe(1);
      const retried = await command(
        root,
        step(design, "review", { action: "retry", revision: 2, failingCI: true }),
      );
      expect(retried.code).toBe(0);
      expect((await show(root)).state.phase).toBe("watching");
      expect(await calls(root)).toBe(2);
    }));
  test(`${design} rechecks the real Git head before a review retry`, () =>
    withRoot(async (root) => {
      await command(root, { command: "init", workflow: "review" });
      await command(root, step(design, "review", { mode: "rejected" }));
      const git = Bun.spawnSync(
        [
          "git",
          "-C",
          root,
          "-c",
          "user.name=Prototype",
          "-c",
          "user.email=prototype@example.invalid",
          "commit",
          "--quiet",
          "--allow-empty",
          "-m",
          "new head",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(git.exitCode).toBe(0);
      const result = await command(root, step(design, "review", { action: "retry", revision: 2 }));
      expect(result.output?.data?.state.phase).toBe("reviewing");
      expect(await calls(root)).toBe(1);
    }));
}
