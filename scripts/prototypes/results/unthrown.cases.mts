import { expect, test } from "bun:test";
import { Err, Ok, fromPromise, fromSafePromise } from "unthrown";
import { fromSchema, fromSchemaAsync } from "@unthrown/standard-schema";
import { z } from "zod";
import { operation } from "./unthrown.mts";

test("unthrown captures a callback defect without adding it to the modeled error", async () => {
  const cause = new TypeError("broken projection");
  const result = await operation({
    invoke: () =>
      Promise.resolve({ exitCode: 0, stdout: '{"status":"applied","reference":"42"}', stderr: "" }),
    signal: new AbortController().signal,
    project() {
      throw cause;
    },
  });
  expect(result.isOk()).toBe(false);
  expect(result.isErr()).toBe(false);
  expect(result.isDefect()).toBe(true);
  if (!result.isDefect()) throw new Error("Expected defect");
  expect(result.cause).toBe(cause);
});

test("unthrown promise thunk catches synchronous argument work but eager arguments still throw", async () => {
  function foreign(): Promise<never> {
    throw new TypeError("before Promise");
  }
  expect(() => fromPromise(foreign(), () => ({ type: "transport" }))).toThrow("before Promise");
  const result = await fromPromise(
    () => foreign(),
    () => ({ type: "transport" }),
  );
  expect(result.isErr()).toBe(true);
  if (!result.isErr()) throw new Error("Expected error");
  expect(result.error).toEqual({ type: "transport" });
});

test("unthrown qualifier defects and rejected safe promises preserve their causes", async () => {
  const cause = new TypeError("qualifier defect");
  const qualified = await fromPromise(
    () => Promise.reject("foreign"),
    () => {
      throw cause;
    },
  );
  const safe = await fromSafePromise(() => Promise.reject(cause));
  for (const result of [qualified, safe]) {
    expect(result.isDefect()).toBe(true);
    if (!result.isDefect()) throw new Error("Expected defect");
    expect(result.cause).toBe(cause);
  }
});

test("unthrown construction is eager and flatMap defers later work after failure", async () => {
  const calls: string[] = [];
  const first = fromPromise(
    async () => {
      calls.push("first");
      return 1;
    },
    () => ({ type: "first" }),
  );
  const second = fromPromise(
    async () => {
      calls.push("second");
      return 2;
    },
    () => ({ type: "second" }),
  );
  await Promise.resolve();
  expect(calls).toEqual(["first", "second"]);
  await first;
  await second;
  const stopped = await Err({ type: "refused" })
    .toAsync()
    .flatMap(() => {
      calls.push("forbidden");
      return Ok(3);
    });
  expect(stopped.isErr()).toBe(true);
  expect(calls).not.toContain("forbidden");
});

test("Standard Schema preserves Zod output inference and validation issue paths", () => {
  const parse = fromSchema(
    z.object({ revision: z.string().transform(Number).pipe(z.number().int()) }),
  );
  const result = parse({ revision: "42" });
  if (!result.isOk()) throw new Error("Expected parsed output");
  const revision: number = result.value.revision;
  expect(revision).toBe(42);
  const invalid = parse({ revision: "bad" });
  expect(invalid.isErr()).toBe(true);
  if (!invalid.isErr()) throw new Error("Expected validation error");
  expect(invalid.error[0]?.path).toEqual(["revision"]);
  expect(invalid.error[0]?.message).toBeString();
});

test("Standard Schema accepts asynchronous Zod validation only through the async bridge", async () => {
  const schema = z.string().refine(async (value) => value === "valid", "Invalid identifier");
  expect(() => fromSchema(schema)("valid")).toThrow("fromSchemaAsync");
  expect((await fromSchemaAsync(schema)("valid")).isOk()).toBe(true);
  expect((await fromSchemaAsync(schema)("invalid")).isErr()).toBe(true);
});

test("Zod Standard Schema turns a throwing sync transform into async validation", () => {
  const schema = z.string().transform(() => {
    throw new TypeError("validator bug");
  });
  expect(() => fromSchema(schema)("x")).toThrow("fromSchemaAsync");
});

test("Standard Schema captures throwing validators and async Zod failures as defects", async () => {
  const cause = new TypeError("validator bug");
  const sync = z.string().transform(() => {
    throw cause;
  });
  const throwingSchema = {
    "~standard": {
      version: 1 as const,
      vendor: "probe",
      validate() {
        throw cause;
      },
    },
  };
  const rejectingSchema = {
    "~standard": {
      version: 1 as const,
      vendor: "probe",
      async validate() {
        throw cause;
      },
    },
  };
  const results = [
    fromSchema(throwingSchema)("x"),
    await fromSchemaAsync(sync)("x"),
    await fromSchemaAsync(rejectingSchema)("x"),
  ];
  for (const result of results) {
    expect(result.isDefect()).toBe(true);
    if (!result.isDefect()) throw new Error("Expected defect");
    expect(result.cause).toBe(cause);
  }
});

test("Zod async throwing transforms leak a rejection with and without the Standard Schema bridge", () => {
  for (const bridge of [false, true]) {
    const source = `import { z } from "zod";
      import { fromSchemaAsync } from "@unthrown/standard-schema";
      const schema = z.string().transform(async () => { throw new TypeError("probe-async-transform"); });
      ${
        bridge
          ? 'console.log((await fromSchemaAsync(schema)("x")).tag);'
          : 'try { await schema["~standard"].validate("x"); } catch { console.log("caught"); }'
      }
    `;
    const child = Bun.spawnSync([process.execPath, "--eval", source], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.stdout.toString().trim()).toBe(bridge ? "Defect" : "caught");
    expect(child.exitCode).toBe(1);
    expect(child.stderr.toString()).toContain("TypeError: probe-async-transform");
  }
});
