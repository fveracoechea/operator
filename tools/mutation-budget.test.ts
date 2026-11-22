import { expect, test } from "bun:test";
import { mutationBudget } from "./mutation-budget.ts";

test("one deadline includes earlier owned work and expires exactly at the limit", () => {
  let clock = 10;
  const budget = mutationBudget(100, () => clock);
  try {
    clock = 109;
    budget.check();
    expect(budget.signal.aborted).toBe(false);
    clock = 110;
    expect(() => budget.check()).toThrow("budget-exhausted");
    expect(budget.signal.aborted).toBe(true);
    expect(budget.signal.reason).toEqual(new Error("budget-exhausted"));
    clock = 200;
    expect(() => budget.check()).toThrow("budget-exhausted");
  } finally {
    budget.dispose();
  }
});

test("unbounded work has no implicit deadline and disposing prevents timer cancellation", async () => {
  let clock = 0;
  const unbounded = mutationBudget(undefined, () => clock);
  clock = Number.MAX_SAFE_INTEGER;
  await Bun.sleep(10);
  unbounded.check();
  expect(unbounded.signal.aborted).toBe(false);
  unbounded.dispose();
  const disposed = mutationBudget(1);
  disposed.dispose();
  await Bun.sleep(10);
  expect(disposed.signal.aborted).toBe(false);
  expect(() => disposed.check()).toThrow("budget-exhausted");
});

test("the deadline timer stops active work even without another cooperative check", async () => {
  const budget = mutationBudget(1);
  try {
    await Bun.sleep(10);
    expect(budget.signal.aborted).toBe(true);
    expect(budget.signal.reason).toEqual(new Error("budget-exhausted"));
  } finally {
    budget.dispose();
  }
});
