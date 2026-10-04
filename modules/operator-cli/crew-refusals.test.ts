import { describe, expect, test } from "bun:test";
import { type Answered, answerOf, refusalCases } from "./crew-refusals-fixture.ts";
import expected from "./crew-refusals.expected.json" with { type: "json" };

// The expected bytes were written from the CLI before its refusals moved into tables (#158), and
// the plan, apply, and finish words before one plan preview owned their shared tail (#161).
// Every printed line and exit code is behavior, so a change here is a change of the CLI output.
const answers: Record<string, Answered> = expected;

describe("crew-state refusals", () => {
  test("names each case once, and the expected bytes hold every case", () => {
    const names = refusalCases().map((one) => one.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.toSorted()).toEqual(Object.keys(answers).toSorted());
  });

  test.each(refusalCases().map((one) => [one.name, one] as const))(
    "%s prints the same lines and exit code",
    async (name, one) => {
      expect<Answered | undefined>(await answerOf(one)).toEqual(answers[name]);
    },
  );
});
