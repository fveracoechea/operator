import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
// Bun has no temporary directory, symlink, or recursive directory removal API.
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { z } from "zod";
import { OperatorRelease } from "../../../modules/operator-release/main.ts";
import { facts as assignmentFacts, pr, report } from "./assignment/cases.fixture.ts";
import * as assignment from "./assignment/model.ts";
import { facts as reviewFacts, reviewing } from "./review/cases.fixture.ts";
import * as review from "./review/model.ts";

const roots: string[] = [];
const sourceRoot = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
const responseSchema = z.object({
  status: z.enum(["changed", "refused"]).optional(),
  reason: z.string().optional(),
  revision: z.number().optional(),
  state: z.union([assignment.stateSchema, review.stateSchema]).optional(),
  effects: z.array(z.object({ type: z.string(), key: z.string() })).default([]),
  nextActions: z.array(z.string()).default([]),
  blockers: z.array(z.string()).default([]),
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch() {
  const root = await mkdtemp("/tmp/opencode/operator-236-");
  roots.push(root);
  await mkdir(`${root}/checkout`);
  for (const args of [
    ["init", "-b", "main"],
    [
      "-c",
      "user.name=Prototype",
      "-c",
      "user.email=prototype@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "scratch",
    ],
  ]) {
    const result = Bun.spawnSync(["git", "-C", `${root}/checkout`, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    expect(result.exitCode).toBe(0);
  }
  const head = Bun.spawnSync(["git", "-C", `${root}/checkout`, "rev-parse", "HEAD"], {
    stdout: "pipe",
  })
    .stdout.toString()
    .trim();
  return { root, head };
}

async function invoke(root: string, request: unknown) {
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/cli.ts`, root], {
    stdin: new TextEncoder().encode(JSON.stringify(request)),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
    },
  });
  const [code, text, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(error).toBe("");
  return { code, output: text ? responseSchema.parse(JSON.parse(text)) : null };
}

function calls(root: string) {
  using db = new Database(`${root}/external.sqlite`, { readonly: true });
  return db
    .query<{ key: string; applied: number }, []>("SELECT key, applied FROM calls ORDER BY rowid")
    .all();
}

for (const design of ["reducer", "table"] satisfies ("reducer" | "table")[]) {
  for (const workflow of ["pr", "report", "review"]) {
    const label = `${design}, ${workflow}`;
    async function setup() {
      const { root, head } = await scratch();
      const isReview = workflow === "review";
      const name = isReview ? "review" : "assignment";
      const state = isReview
        ? reviewing
        : workflow === "pr"
          ? pr
          : { ...report, phase: "reported" };
      expect((await invoke(root, { command: "init", input: { workflow: name, state } })).code).toBe(
        0,
      );
      const input = {
        workflow: name,
        design,
        revision: 0,
        facts: isReview ? { ...reviewFacts, head } : assignmentFacts,
        event: isReview
          ? { type: "draft", head, blockers: 0, strongBreach: false }
          : { type: workflow === "pr" ? "merge" : "accept" },
      };
      return { root, input };
    }

    test(`${label}: competing processes commit one transition and perform one external action`, async () => {
      const { root, input } = await setup();
      const results = await Promise.all(
        [1, 2].map(() =>
          invoke(root, {
            command: "step",
            input: { ...input, execute: true, externalOutcome: "not-applied" },
          }),
        ),
      );
      expect(results.map((result) => result.code).toSorted()).toEqual([0, 3]);
      expect(results.find((result) => result.code === 3)?.output?.reason).toBe("stale-revision");
      expect(calls(root)).toHaveLength(1);
      expect(calls(root)[0]?.applied).toBe(0);
      const state = (await invoke(root, { command: "show" })).output;
      expect(state?.revision).toBe(2);
      expect(state?.state?.operation.status).toBe("failed");
    });

    test(`${label}: crash after external success recovers without repeating the action`, async () => {
      const { root, input } = await setup();
      expect(
        (
          await invoke(root, {
            command: "step",
            input: { ...input, execute: true, crash: "after-effect" },
          })
        ).code,
      ).toBe(86);
      expect(calls(root)).toHaveLength(1);
      const before = (await invoke(root, { command: "show" })).output;
      expect(before?.revision).toBe(1);
      expect(before?.state?.operation.status).toBe("pending");
      const retry = await invoke(root, {
        command: "step",
        input: { ...input, revision: 1, event: { type: "retry" }, execute: true },
      });
      expect(retry.code).toBe(3);
      expect(retry.output?.reason).toBe("reconcile-before-retry");
      const recovered = await invoke(root, {
        command: "step",
        input: { ...input, revision: 1, event: { type: "recover" } },
      });
      expect(recovered.code).toBe(0);
      expect(recovered.output?.state?.phase).toBe(
        workflow === "pr" ? "merged" : workflow === "report" ? "completed" : "approved",
      );
      expect(calls(root)).toHaveLength(1);
    });

    test(`${label}: crash before execution retains uncertainty, refusal writes nothing`, async () => {
      const { root, input } = await setup();
      expect(
        (
          await invoke(root, {
            command: "step",
            input: { ...input, execute: true, crash: "before-effect" },
          })
        ).code,
      ).toBe(86);
      const before = await Bun.file(`${root}/prototype.sqlite`).bytes();
      const recovered = await invoke(root, {
        command: "step",
        input: { ...input, revision: 1, event: { type: "recover" }, execute: true },
      });
      expect(recovered.code).toBe(3);
      expect(recovered.output?.reason).toBe("outcome-unknown");
      expect(recovered.output?.effects).toEqual([]);
      expect(recovered.output?.nextActions).not.toContain("retry");
      expect(await Bun.file(`${root}/prototype.sqlite`).bytes()).toEqual(before);
      expect(await Bun.file(`${root}/external.sqlite`).exists()).toBe(false);
    });

    test(`${label}: definite failure retries, stale events have no effects`, async () => {
      const { root, input } = await setup();
      const failed = await invoke(root, {
        command: "step",
        input: { ...input, execute: true, externalOutcome: "not-applied" },
      });
      expect(failed.output?.state?.operation.status).toBe("failed");
      const retried = await invoke(root, {
        command: "step",
        input: { ...input, revision: 2, event: { type: "retry" }, execute: true },
      });
      expect(retried.code).toBe(0);
      expect(retried.output?.state?.phase).toBe(
        workflow === "pr" ? "merged" : workflow === "report" ? "completed" : "approved",
      );
      const count = calls(root).length;
      const before = await Bun.file(`${root}/prototype.sqlite`).bytes();
      const repeated = await invoke(root, {
        command: "step",
        input: { ...input, revision: retried.output?.revision, execute: true },
      });
      expect(repeated.code).toBe(3);
      expect(repeated.output?.effects).toEqual([]);
      expect(await Bun.file(`${root}/prototype.sqlite`).bytes()).toEqual(before);
      expect(calls(root)).toHaveLength(count);
    });
  }
}

test("closed events and completion types reject invalid JSON input before writes", async () => {
  const { root } = await scratch();
  await invoke(root, { command: "init", input: { workflow: "assignment", state: pr } });
  const before = await Bun.file(`${root}/prototype.sqlite`).bytes();
  const invalid = await invoke(root, {
    command: "step",
    input: {
      workflow: "assignment",
      design: "table",
      revision: 0,
      event: { type: "complete-from-host" },
      facts: assignmentFacts,
    },
  });
  expect(invalid.code).toBe(2);
  expect(invalid.output?.reason).toBe("invalid-input");
  expect(await Bun.file(`${root}/prototype.sqlite`).bytes()).toEqual(before);
  expect(await Bun.file(`${root}/external.sqlite`).exists()).toBe(false);
  expect(assignment.stateSchema.safeParse({ ...report, phase: "merged" }).success).toBe(false);
});

test("prototype entry point requires a named scratch root, not a default state root", async () => {
  const result = await invoke("/tmp/opencode", { command: "show" });
  expect(result.code).toBe(2);
  expect(result.output?.reason).toBe("explicit-scratch-root-required");
});

test.each(["reducer", "table"])(
  "%s CLI submits a report before independent acceptance",
  async (design) => {
    const { root } = await scratch();
    await Bun.write(`${root}/report.md`, "Conclusion and evidence for the prototype.\n");
    await invoke(root, { command: "init", input: { workflow: "assignment", state: report } });
    const input = { workflow: "assignment", design, facts: assignmentFacts, revision: 0 };
    const submitted = await invoke(root, {
      command: "step",
      input: { ...input, event: { type: "submit", report: `${root}/report.md` } },
    });
    expect(submitted.output?.state?.phase).toBe("reported");
    expect(await Bun.file(`${root}/external.sqlite`).exists()).toBe(false);
    const worker = await invoke(root, {
      command: "step",
      input: {
        ...input,
        revision: 1,
        facts: { ...assignmentFacts, actor: "worker" },
        event: { type: "accept" },
        execute: true,
      },
    });
    expect(worker.code).toBe(3);
    expect(worker.output?.reason).toBe("superagent-required");
    expect(await Bun.file(`${root}/external.sqlite`).exists()).toBe(false);
    const accepted = await invoke(root, {
      command: "step",
      input: { ...input, revision: 1, event: { type: "accept" }, execute: true },
    });
    expect(accepted.output?.state?.phase).toBe("completed");
    expect(calls(root)).toHaveLength(1);
  },
);

test.each(["reducer", "table"])(
  "%s CLI observes a real Git head move before posting",
  async (design) => {
    const { root, head } = await scratch();
    await invoke(root, { command: "init", input: { workflow: "review", state: reviewing } });
    const commit = Bun.spawnSync(
      [
        "git",
        "-C",
        `${root}/checkout`,
        "-c",
        "user.name=Prototype",
        "-c",
        "user.email=prototype@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "next head",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(commit.exitCode).toBe(0);
    const result = await invoke(root, {
      command: "step",
      input: {
        workflow: "review",
        design,
        revision: 0,
        facts: { ...reviewFacts, head, relation: "fast-forward" },
        event: { type: "draft", head, blockers: 0, strongBreach: false },
        execute: true,
      },
    });
    expect(result.output?.reason).toBe("review-new-commits");
    expect(result.output?.effects).toEqual([]);
    expect(await Bun.file(`${root}/external.sqlite`).exists()).toBe(false);
  },
);

test.each(["reducer", "table"])("%s CLI rechecks the merge gate on retry", async (design) => {
  const { root } = await scratch();
  await invoke(root, { command: "init", input: { workflow: "assignment", state: pr } });
  const input = {
    workflow: "assignment",
    design,
    revision: 0,
    facts: assignmentFacts,
    event: { type: "merge" },
    execute: true,
    externalOutcome: "not-applied",
  };
  await invoke(root, { command: "step", input });
  const result = await invoke(root, {
    command: "step",
    input: {
      ...input,
      revision: 2,
      event: { type: "retry" },
      facts: { ...assignmentFacts, approved: false },
    },
  });
  expect(result.code).toBe(3);
  expect(result.output?.reason).toBe("approval-required");
  expect(calls(root)).toHaveLength(1);
});

test.each(["reducer", "table"])("%s CLI rechecks review CI on retry", async (design) => {
  const { root, head } = await scratch();
  await invoke(root, { command: "init", input: { workflow: "review", state: reviewing } });
  const input = {
    workflow: "review",
    design,
    revision: 0,
    facts: { ...reviewFacts, head },
    event: { type: "draft", head, blockers: 0, strongBreach: false },
    execute: true,
    externalOutcome: "not-applied",
  };
  await invoke(root, { command: "step", input });
  const result = await invoke(root, {
    command: "step",
    input: {
      ...input,
      revision: 2,
      event: { type: "retry" },
      facts: { ...reviewFacts, failingCI: true },
      execute: false,
    },
  });
  const state = review.stateSchema.parse(result.output?.state);
  expect(state.operation.status).toBe("pending");
  if (state.operation.status !== "idle") expect(state.operation.effect.event).toBe("COMMENT");
});

test.each(["reducer", "table"])("%s CLI rechecks a real Git head on retry", async (design) => {
  const { root, head } = await scratch();
  await invoke(root, { command: "init", input: { workflow: "review", state: reviewing } });
  const input = {
    workflow: "review",
    design,
    revision: 0,
    facts: { ...reviewFacts, head },
    event: { type: "draft", head, blockers: 0, strongBreach: false },
    execute: true,
    externalOutcome: "not-applied",
  };
  const first = await invoke(root, { command: "step", input });
  const prior = review.stateSchema.parse(first.output?.state).operation;
  if (prior.status === "idle") throw new Error("Expected a failed post");
  const commit = Bun.spawnSync(
    [
      "git",
      "-C",
      `${root}/checkout`,
      "-c",
      "user.name=Prototype",
      "-c",
      "user.email=prototype@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "new retry head",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(commit.exitCode).toBe(0);
  const result = await invoke(root, {
    command: "step",
    input: {
      ...input,
      revision: 2,
      event: { type: "retry" },
      facts: { ...reviewFacts, relation: "fast-forward" },
    },
  });
  expect(result.output?.reason).toBe("review-new-commits");
  expect(result.output?.effects).toEqual([]);
  expect(calls(root)).toHaveLength(1);
  const newHead = Bun.spawnSync(["git", "-C", `${root}/checkout`, "rev-parse", "HEAD"], {
    stdout: "pipe",
  })
    .stdout.toString()
    .trim();
  const next = await invoke(root, {
    command: "step",
    input: {
      ...input,
      revision: 3,
      event: { type: "draft", head: newHead, blockers: 0, strongBreach: false },
      execute: false,
    },
  });
  expect(next.output?.state?.phase).toBe("posting");
  const stale = await invoke(root, {
    command: "step",
    input: {
      ...input,
      revision: 4,
      event: { type: "result", key: prior.effect.key, outcome: "done" },
      execute: false,
    },
  });
  expect(stale.code).toBe(3);
  expect(stale.output?.reason).toBe("stale-result");
});

test("release excludes the experiment and artifact CLI exposes no prototype command", async () => {
  const { root } = await scratch();
  const artifactRoot = `${root}/artifact`;
  const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: sourceRoot, stdout: "pipe" })
    .stdout.toString()
    .trim();
  expect((await OperatorRelease.build({ sourceRoot, artifactRoot, commit })).status).toBe("built");
  const contents = await OperatorRelease.contents({ artifactRoot });
  expect(contents.some((path) => path.includes("prototype") || path.startsWith("scripts/"))).toBe(
    false,
  );
  await symlink(`${sourceRoot}/node_modules`, `${artifactRoot}/node_modules`);
  const child = Bun.spawn([process.execPath, `${artifactRoot}/cli.js`, "--help"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
    },
  });
  const [code, help] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(code).toBe(0);
  expect(help).toBe("Usage: operator --help | --version [--json]\n");
});
