import { z } from "zod";
// Bun has no real-path API.
import { realpath } from "node:fs/promises";
import { AssignmentPrototype } from "./assignment/main.ts";
import * as assignment from "./assignment/model.ts";
import { ReviewPrototype } from "./review/main.ts";
import * as review from "./review/model.ts";
import { initialize, open, read } from "./store.ts";

const designSchema = z.enum(["reducer", "table"]);
const options = {
  revision: z.number().int().nonnegative(),
  design: designSchema,
  execute: z.boolean().default(false),
  externalOutcome: z.enum(["done", "not-applied", "unknown"]).default("done"),
  crash: z.enum(["none", "before-effect", "after-effect"]).default("none"),
};
const stepSchema = z.discriminatedUnion("workflow", [
  z.object({
    ...options,
    workflow: z.literal("assignment"),
    event: assignment.eventSchema,
    facts: assignment.factsSchema,
  }),
  z.object({
    ...options,
    workflow: z.literal("review"),
    event: review.eventSchema,
    facts: review.factsSchema,
  }),
]);
const initSchema = z.discriminatedUnion("workflow", [
  z.object({ workflow: z.literal("assignment"), state: assignment.stateSchema }),
  z.object({ workflow: z.literal("review"), state: review.stateSchema }),
]);
const requestSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("init"), input: initSchema }),
  z.object({ command: z.literal("show") }),
  z.object({ command: z.literal("step"), input: stepSchema }),
]);

async function external(
  root: string,
  key: string,
  outcome: "done" | "not-applied" | "unknown" | "observe",
) {
  const child = Bun.spawn(
    [process.execPath, `${import.meta.dir}/external.fixture.ts`, root, key, outcome],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, text, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`External fixture failed: ${error}`);
  return z.object({ outcome: z.enum(["done", "not-applied", "unknown"]) }).parse(JSON.parse(text));
}

async function runAssignment(
  root: string,
  input: Extract<z.infer<typeof stepSchema>, { workflow: "assignment" }>,
) {
  using db = open(`${root}/prototype.sqlite`);
  const state = assignment.stateSchema.parse(read(db).state);
  const observed =
    input.event.type === "recover" && state.operation.status !== "idle"
      ? await external(root, state.operation.key, "observe")
      : null;
  const facts = observed
    ? ({
        ...input.facts,
        observation: observed.outcome === "not-applied" ? "not-done" : observed.outcome,
      } satisfies assignment.Facts)
    : input.facts;
  let result = AssignmentPrototype.run({ ...input, facts, db });
  if (input.crash === "before-effect") process.exit(86);
  while (input.execute && result.effects.length > 0) {
    const effect = result.effects[0]!;
    const outcome = await external(root, effect.key, input.externalOutcome);
    if (input.crash === "after-effect") process.exit(86);
    result = AssignmentPrototype.run({
      ...input,
      facts,
      db,
      revision: result.revision,
      event: { type: "result", key: effect.key, ...outcome },
    });
  }
  return result;
}

async function runReview(
  root: string,
  input: Extract<z.infer<typeof stepSchema>, { workflow: "review" }>,
) {
  using db = open(`${root}/prototype.sqlite`);
  // Git is observed before the transaction. It supplies the real reviewed checkout's head.
  const git = Bun.spawnSync(["git", "-C", `${root}/checkout`, "rev-parse", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (git.exitCode !== 0) throw new Error(git.stderr.toString());
  const state = review.stateSchema.parse(read(db).state);
  const observed =
    input.event.type === "recover" && state.operation.status !== "idle"
      ? await external(root, state.operation.effect.key, "observe")
      : null;
  const observation: review.Facts["observation"] = observed
    ? observed.outcome === "not-applied"
      ? "not-done"
      : observed.outcome
    : input.facts.observation;
  const facts = { ...input.facts, head: git.stdout.toString().trim(), observation };
  let result = ReviewPrototype.run({ ...input, facts, db });
  if (input.crash === "before-effect") process.exit(86);
  while (input.execute && result.effects.length > 0) {
    const effect = result.effects[0]!;
    const outcome = await external(root, effect.key, input.externalOutcome);
    if (input.crash === "after-effect") process.exit(86);
    result = ReviewPrototype.run({
      ...input,
      facts,
      db,
      revision: result.revision,
      event: { type: "result", key: effect.key, ...outcome },
    });
  }
  return result;
}

async function main() {
  const root = process.argv[2];
  if (
    !root ||
    !/^\/tmp\/opencode\/operator-236-[^/]+$/.test(root) ||
    (await realpath(root)) !== root
  ) {
    console.log(
      JSON.stringify({ status: "refused", reason: "explicit-scratch-root-required", effects: [] }),
    );
    process.exitCode = 2;
    return;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await Bun.stdin.text());
  } catch {
    console.log(JSON.stringify({ status: "refused", reason: "invalid-input", effects: [] }));
    process.exitCode = 2;
    return;
  }
  const request = requestSchema.safeParse(raw);
  if (!request.success) {
    console.log(JSON.stringify({ status: "refused", reason: "invalid-input", effects: [] }));
    process.exitCode = 2;
    return;
  }
  switch (request.data.command) {
    case "init": {
      using db = open(`${root}/prototype.sqlite`, true);
      initialize(db, request.data.input.state);
      console.log(JSON.stringify({ revision: 0, state: request.data.input.state }));
      break;
    }
    case "show": {
      using db = open(`${root}/prototype.sqlite`);
      console.log(JSON.stringify(read(db)));
      break;
    }
    case "step": {
      const input = request.data.input;
      const result =
        input.workflow === "assignment"
          ? await runAssignment(root, input)
          : await runReview(root, input);
      console.log(JSON.stringify(result));
      process.exitCode = result.status === "refused" ? 3 : 0;
    }
  }
}

if (import.meta.main) await main();
