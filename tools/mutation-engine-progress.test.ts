import { expect, test } from "bun:test";
import { reportMutationProgress, strykerPlugins } from "./mutation-engine-progress.ts";

test("the engine reporter exposes measured totals, completed results, and reused verdicts", async () => {
  const observed: unknown[] = [];
  expect(
    await reportMutationProgress(
      (event) => observed.push(event),
      async () => {
        const reporter = strykerPlugins[0].factory();
        reporter.onMutationTestingPlanReady({
          mutantPlans: [
            { plan: "EarlyResult", mutant: { status: "Killed" } },
            { plan: "EarlyResult", mutant: { status: "Survived" } },
            { plan: "EarlyResult", mutant: { status: "Ignored" } },
            { plan: "Run", mutant: {} },
          ],
        });
        reporter.onMutantTested();
        reporter.onMutantTested();
        return "finished";
      },
    ),
  ).toBe("finished");
  expect(observed).toEqual([
    { completed: 0, total: 4, reused: 2 },
    { completed: 1, total: 4, reused: 2 },
    { completed: 2, total: 4, reused: 2 },
  ]);
  strykerPlugins[0].factory().onMutantTested();
  strykerPlugins[0].factory().onMutationTestingPlanReady({ mutantPlans: [] });
  expect(observed).toHaveLength(3);
});

test.each([
  { plan: "EarlyResult", status: "Killed", reused: 1 },
  { plan: "EarlyResult", status: "Survived", reused: 1 },
  { plan: "EarlyResult", status: "Ignored", reused: 0 },
  { plan: "Run", status: "Killed", reused: 0 },
])(
  "only a reused final $status verdict with plan $plan receives reuse credit",
  async ({ plan, status, reused }) => {
    const observed: unknown[] = [];
    await reportMutationProgress(
      (event) => observed.push(event),
      async () => {
        strykerPlugins[0].factory().onMutationTestingPlanReady({
          mutantPlans: [{ plan, mutant: { status } }],
        });
      },
    );
    expect(observed).toEqual([{ completed: 0, total: 1, reused }]);
  },
);
