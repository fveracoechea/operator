import { z } from "zod";
// Bun has no real-path API.
import { realpath } from "node:fs/promises";
import { Assignment } from "./assignment.mts";
import { Review } from "./review.mts";
import * as assignment from "../state-machines/assignment/model.ts";
import * as review from "../state-machines/review/model.ts";
import {
  designs,
  diagnostic,
  err,
  ok,
  type Execute,
  type OperationError,
  type Receipt,
  type Result,
  type Wire,
} from "./model.mts";
import { initialize, open, read } from "./store.mts";

const workflowSchema = z.enum(["assignment", "review"]);
const requestSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("init"), workflow: workflowSchema }),
  z.object({ command: z.literal("show") }),
  z.object({
    command: z.literal("step"),
    workflow: workflowSchema,
    design: z.enum(designs),
    action: z.enum(["merge", "draft", "retry", "recover", "result"]).default("merge"),
    revision: z.number().int().nonnegative(),
    mode: z
      .enum(["applied", "rejected", "invalid", "tool", "lost", "timeout", "throw", "reject"])
      .default("applied"),
    crash: z.enum(["none", "before-effect", "after-effect"]).default("none"),
    failAfterWrite: z.boolean().default(false),
    defect: z.boolean().default(false),
    approved: z.boolean().default(true),
    checks: z.enum(["pass", "fail", "pending"]).default("pass"),
    threadsResolved: z.boolean().default(true),
    defaultBase: z.boolean().default(true),
    draftValid: z.boolean().default(true),
    failingCI: z.boolean().default(false),
    observationMode: z.enum(["valid", "invalid-json"]).default("valid"),
    head: z.string().optional(),
    key: z.string().default("obsolete-effect"),
  }),
]);
type Step = Extract<z.infer<typeof requestSchema>, { command: "step" }>;

function envelope(
  operation: string,
  outcome: string,
  reason: string,
  data?: unknown,
  blockers: unknown[] = [],
) {
  return { schemaVersion: 1, operation, outcome, reason, blockers, data };
}
function report(
  operation: string,
  result: Result<unknown, { type: string; reason?: string }>,
  failure?: OperationError,
) {
  if (!result.ok) {
    process.exitCode = result.error.type === "refused" ? 3 : 1;
    return envelope(
      operation,
      result.error.type === "refused" ? "refused" : "failed",
      result.error.reason ?? result.error.type,
      undefined,
      [result.error],
    );
  }
  if (failure) {
    process.exitCode = failure.type === "cancelled" ? 130 : failure.evidence === "unknown" ? 5 : 1;
    return envelope(
      operation,
      failure.type === "cancelled"
        ? "interrupted"
        : failure.evidence === "unknown"
          ? "uncertain"
          : "failed",
      failure.type,
      result.value,
      [failure],
    );
  }
  return envelope(operation, "completed", "step-recorded", result.value);
}

async function invoke(
  root: string,
  key: string,
  mode: Step["mode"] | "observe" | "observe-invalid-json",
  signal: AbortSignal,
): Promise<Wire> {
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/external.mts`, root, key, mode], {
    stdout: "pipe",
    stderr: "pipe",
    signal,
    ipc(message) {
      process.send?.(message);
    },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (signal.aborted) throw new DOMException("Interrupted", "AbortError");
  return { exitCode, stdout, stderr };
}

async function execute(
  root: string,
  key: string,
  input: Step,
): Promise<Result<Receipt, OperationError>> {
  if (input.crash === "before-effect") process.exit(86);
  const { execute: run }: { execute: Execute } = await import(`./${input.design}.mts`);
  const controller = new AbortController();
  function interrupt() {
    controller.abort();
  }
  process.on("SIGINT", interrupt);
  let timedOut = false;
  const timer =
    input.mode === "timeout"
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, 250)
      : undefined;
  try {
    const result = await run({
      signal: controller.signal,
      invoke(signal) {
        if (input.mode === "throw") throw new Error("Controlled synchronous third-party throw");
        if (input.mode === "reject")
          return Promise.reject(new Error("Controlled rejected promise"));
        return invoke(root, key, input.mode, signal);
      },
      project(receipt) {
        if (input.defect) throw new TypeError("Controlled projection defect");
        return receipt;
      },
    });
    if (input.crash === "after-effect") process.exit(86);
    return timedOut ? err({ type: "timeout", evidence: "unknown", milliseconds: 250 }) : result;
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", interrupt);
  }
}

async function observe(
  root: string,
  key: string,
  mode: Step["observationMode"],
): Promise<Result<"done" | "not-done" | "unknown", OperationError>> {
  const wire = await invoke(
    root,
    key,
    mode === "invalid-json" ? "observe-invalid-json" : "observe",
    new AbortController().signal,
  );
  if (wire.exitCode !== 0)
    return err({ type: "tool", evidence: "unknown", exitCode: wire.exitCode, stderr: wire.stderr });
  let raw: unknown;
  try {
    raw = JSON.parse(wire.stdout);
  } catch (cause) {
    return err({
      type: "invalid-response",
      evidence: "unknown",
      detail: diagnostic(cause).message,
    });
  }
  const parsed = z
    .object({ evidence: z.enum(["applied", "not-applied", "unknown"]) })
    .safeParse(raw);
  if (!parsed.success)
    return err({ type: "invalid-response", evidence: "unknown", detail: parsed.error.message });
  return ok(
    parsed.data.evidence === "applied"
      ? "done"
      : parsed.data.evidence === "not-applied"
        ? "not-done"
        : "unknown",
  );
}

async function runAssignment(root: string, input: Step) {
  using db = open(root);
  const current = assignment.stateSchema.parse(read(db).state);
  const observed: Result<assignment.Facts["observation"], OperationError> =
    input.action === "recover" && current.operation.status !== "idle"
      ? await observe(root, current.operation.key, input.observationMode)
      : ok("unknown");
  if (!observed.ok) return report("assignment", ok(read(db)), observed.error);
  const facts: assignment.Facts = {
    dependenciesReady: true,
    actor: "worker",
    worker: "running",
    approved: input.approved,
    checks: input.checks,
    threadsResolved: input.threadsResolved,
    defaultBase: input.defaultBase,
    safeToRemove: true,
    observation: observed.value,
  };
  const event: assignment.Event =
    input.action === "result"
      ? { type: "result", key: input.key, outcome: "done" }
      : input.action === "draft"
        ? { type: "merge" }
        : { type: input.action };
  const planned = Assignment.step({ ...input, db, event, facts });
  if (!planned.ok) return report("assignment", planned);
  if (input.action === "recover") return report("assignment", planned);
  const effect = planned.value.effects[0];
  if (!effect) return report("assignment", planned);
  const result = await execute(root, effect.key, input);
  const applied = Assignment.result({
    db,
    revision: planned.value.revision,
    key: effect.key,
    facts,
    result,
  });
  return report("assignment", applied, result.ok ? undefined : result.error);
}

async function runReview(root: string, input: Step) {
  using db = open(root);
  const current = review.stateSchema.parse(read(db).state);
  const git = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (git.exitCode !== 0) throw new Error(git.stderr.toString());
  const head = git.stdout.toString().trim();
  const observed: Result<review.Facts["observation"], OperationError> =
    input.action === "recover" && current.operation.status !== "idle"
      ? await observe(root, current.operation.effect.key, input.observationMode)
      : ok("unknown");
  if (!observed.ok) return report("review", ok(read(db)), observed.error);
  const facts: review.Facts = {
    head,
    relation: "fast-forward",
    draftValid: input.draftValid,
    failingCI: input.failingCI,
    origin: "slack",
    ownPr: false,
    activity: "none",
    observation: observed.value,
    worker: "running",
  };
  const event: review.Event =
    input.action === "retry" || input.action === "recover"
      ? { type: input.action }
      : input.action === "result"
        ? { type: "result", key: input.key, outcome: "done" }
        : { type: "draft", head: input.head ?? head, blockers: 0, strongBreach: false };
  const planned = Review.step({ ...input, db, event, facts });
  if (!planned.ok) return report("review", planned);
  const effect = planned.value.effects[0];
  if (!effect) return report("review", planned);
  const result = await execute(root, effect.key, input);
  const applied = Review.result({
    db,
    revision: planned.value.revision,
    key: effect.key,
    facts,
    result,
  });
  return report("review", applied, result.ok ? undefined : result.error);
}

function init(root: string, workflow: z.infer<typeof workflowSchema>) {
  using db = open(root, true);
  const state: assignment.State | review.State =
    workflow === "assignment"
      ? { completion: "pr", phase: "pr-open", generation: 0, operation: { status: "idle" } }
      : {
          phase: "reviewing",
          round: 1,
          headMoves: 0,
          scope: "full",
          operation: { status: "idle" },
        };
  initialize(db, state);
  if (workflow === "review") {
    for (const args of [
      ["init", "--quiet"],
      [
        "-c",
        "user.name=Prototype",
        "-c",
        "user.email=prototype@example.invalid",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "scratch",
      ],
    ]) {
      const git = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
      if (git.exitCode !== 0) throw new Error(git.stderr.toString());
    }
  }
  return envelope("init", "completed", "initialized", read(db));
}

async function main() {
  const root = Bun.argv[2];
  if (
    !root ||
    !/^\/tmp\/opencode\/operator-261-run-[^/]+$/.test(root) ||
    (await realpath(root)) !== root
  ) {
    process.exitCode = 2;
    return envelope("parse", "invalid", "explicit-scratch-root-required");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await Bun.stdin.text());
  } catch {
    process.exitCode = 2;
    return envelope("parse", "invalid", "invalid-input");
  }
  const request = requestSchema.safeParse(raw);
  if (!request.success) {
    process.exitCode = 2;
    return envelope("parse", "invalid", "invalid-input");
  }
  const input = request.data;
  if (input.command === "init") return init(root, input.workflow);
  if (input.command === "show") {
    using db = open(root);
    return envelope("show", "completed", "state-read", read(db));
  }
  return input.workflow === "assignment" ? runAssignment(root, input) : runReview(root, input);
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await main()));
  } catch (cause) {
    console.error(cause);
    console.log(
      JSON.stringify(
        envelope("exception", "defect", "unexpected-defect", undefined, [diagnostic(cause)]),
      ),
    );
    process.exitCode = 1;
  }
}
