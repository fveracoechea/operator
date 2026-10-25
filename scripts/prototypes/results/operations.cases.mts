import { expect, test } from "bun:test";
import { designs, type Execute, type Wire } from "./model.mts";
import { Result, ResultAsync, err as neverthrowErr, ok as neverthrowOk, safeTry } from "neverthrow";
import * as EffectResult from "effect/Result";

const good: Wire = {
  exitCode: 0,
  stdout: JSON.stringify({ status: "applied", reference: "merge:42" }),
  stderr: "",
};

test("synchronous library constructors translate foreign throws into closed values", () => {
  const failure = {
    type: "invalid-response",
    evidence: "unknown",
    detail: "controlled parse failure",
  } as const;
  function foreign(): never {
    throw new SyntaxError("controlled parse failure");
  }
  expect(Result.fromThrowable(foreign, () => failure)()).toEqual(neverthrowErr(failure));
  expect(EffectResult.try({ try: foreign, catch: () => failure })).toEqual(
    EffectResult.fail(failure),
  );
  expect(
    safeTry(function* () {
      const value = yield* neverthrowOk(42);
      return neverthrowOk(value + 1);
    }),
  ).toEqual(neverthrowOk(43));
});

test("neverthrow fromPromise cannot catch argument evaluation, while fromThrowable can", async () => {
  function foreign(): Promise<never> {
    throw new Error("synchronous before Promise");
  }
  expect(() => ResultAsync.fromPromise(foreign(), () => ({ type: "transport" }))).toThrow(
    "synchronous before Promise",
  );
  expect(await ResultAsync.fromThrowable(foreign, () => ({ type: "transport" }))()).toEqual(
    neverthrowErr({ type: "transport" }),
  );
});

for (const design of designs) {
  const { execute }: { execute: Execute } = await import(`./${design}.mts`);
  test(`${design} composes and narrows a valid result`, async () => {
    const result = await execute({
      invoke: () => Promise.resolve(good),
      signal: new AbortController().signal,
      project: (receipt) => ({ ...receipt, reference: `${receipt.reference}:projected` }),
    });
    expect(result).toEqual({
      ok: true,
      value: { evidence: "applied", reference: "merge:42:projected" },
    });
  });
  for (const mode of ["throw", "reject", "invalid", "tool", "rejected"] as const) {
    test(`${design} translates ${mode} at the operation boundary`, async () => {
      const result = await execute({
        invoke() {
          if (mode === "throw") throw new Error("foreign synchronous throw");
          if (mode === "reject") return Promise.reject(new Error("foreign rejected promise"));
          if (mode === "invalid") return Promise.resolve({ ...good, stdout: "{}" });
          if (mode === "tool")
            return Promise.resolve({ ...good, exitCode: 7, stderr: "permission denied" });
          return Promise.resolve({
            ...good,
            stdout: JSON.stringify({
              status: "rejected",
              terminal: true,
              detail: "controlled non-application",
            }),
          });
        },
        signal: new AbortController().signal,
        project: (receipt) => receipt,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.type).toBe(
        mode === "throw" || mode === "reject"
          ? "transport"
          : mode === "invalid"
            ? "invalid-response"
            : mode,
      );
      expect(result.error.evidence).toBe(mode === "rejected" ? "not-applied" : "unknown");
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    });
  }
  test(`${design} does not turn a programming defect into an expected failure`, async () => {
    await expect(
      execute({
        invoke: () => Promise.resolve(good),
        signal: new AbortController().signal,
        project() {
          throw new TypeError("broken projection");
        },
      }),
    ).rejects.toThrow();
  });
  test(`${design} does not hide a defect when cancellation occurs in the callback`, async () => {
    const controller = new AbortController();
    await expect(
      execute({
        invoke: () => Promise.resolve(good),
        signal: controller.signal,
        project() {
          controller.abort();
          throw new TypeError("defect during cancellation");
        },
      }),
    ).rejects.toThrow();
  });
}
