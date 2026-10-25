import { expect, test } from "bun:test";
import { lintProject } from "./check.ts";

const check = lintProject();

test.each([
  {
    rule: "no-ambiguous-error-type",
    invalid: 'import type { Result } from "unthrown"; export type Value = Result<number, Error>;',
    valid:
      'import type { Result } from "unthrown"; export type Value = Result<number, { type: "refused" }>;',
  },
  {
    rule: "no-async-result-race",
    invalid:
      'import { OkAsync } from "unthrown"; const first = OkAsync(1); const second = OkAsync(2); export const result = first.flatMap(() => second);',
    valid:
      'import { OkAsync } from "unthrown"; export const result = OkAsync(1).flatMap(() => OkAsync(2));',
  },
  {
    rule: "no-catch-all-pattern",
    invalid:
      'import { Err, P } from "unthrown"; export const result = Err({ type: "refused" } as const).mapErrCases(m => m.with(P._, () => ({ type: "other" })));',
    valid:
      'import { Err } from "unthrown"; export const result = Err({ type: "refused" } as const).mapErrCases(m => m.with({ type: "refused" }, () => ({ type: "other" })));',
  },
  {
    rule: "no-unhandled-result",
    invalid: 'import { Ok as success } from "unthrown"; success(1);',
    valid: 'import { Ok as success } from "unthrown"; export const result = success(1);',
  },
  {
    rule: "no-unused-matcher",
    invalid:
      'import { Err, match } from "unthrown"; export const result = Err({ type: "refused" } as const).mapErrCases(_m => match({ type: "other" } as const).with({ type: "other" }, () => ({ type: "wrong" })));',
    valid:
      'import { Err } from "unthrown"; export const result = Err({ type: "refused" } as const).mapErrCases(m => m.with({ type: "refused" }, () => ({ type: "other" })));',
  },
  {
    rule: "prefer-async-result",
    invalid:
      'import type { Result } from "unthrown"; export type Value = Promise<Result<number, never>>;',
    valid:
      'import type { AsyncResult } from "unthrown"; export type Value = AsyncResult<number, never>;',
  },
  {
    rule: "no-get-or-throw",
    invalid: 'import { Ok } from "unthrown"; export const value = Ok(1).getOrThrow();',
    valid: 'import { Ok } from "unthrown"; export const value = Ok(1).get();',
  },
  {
    rule: "no-throw",
    invalid: 'export function fail() { throw new Error("failure"); }',
    valid:
      'import { Err } from "unthrown"; export function fail() { return Err({ type: "refused" } as const); }',
  },
  {
    rule: "prefer-pre-lifted",
    invalid: 'import { Ok } from "unthrown"; export const value = Ok(1).toAsync();',
    valid: 'import { OkAsync } from "unthrown"; export const value = OkAsync(1);',
  },
])("enforces unthrown/$rule with no blanket test exception", async ({ rule, invalid, valid }) => {
  for (const path of ["lib/lint-probe.ts", "lib/lint-probe.test.ts"]) {
    const bad = await check(invalid, { path });
    expect(bad.exitCode).toBe(1);
    expect(bad.codes).toContain(`unthrown(${rule})`);
    const good = await check(valid, { path });
    expect(good.codes).toEqual([]);
    expect(good.exitCode).toBe(0);
  }
});

test("the syntactic Result checks are not a complete must-use guarantee", async () => {
  const result = await check(`
import { Ok, type Result } from "unthrown";
export function produce(): Result<number, never> { return Ok(1); }
const result = Ok(1);
result.map(value => value + 1);
`);
  expect(result.codes).toEqual([]);
});
