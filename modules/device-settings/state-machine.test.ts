import { expect, test } from "bun:test";
import { decideSettingsWrite } from "./state-machine.ts";
import type { Receipt } from "./storage.ts";

const receipt: Receipt = {
  planId: "approved",
  generation: null,
  editsIdentity: "edits",
  previousIdentity: "before",
  nextIdentity: "after",
  state: "pending",
};

test.each([
  ["pending", "after", "complete"],
  ["pending", "before", "aborted"],
  ["pending", "other", "recovery-required"],
  ["unreadable", "before", "recovery-required"],
  ["absent", "before", "nothing"],
  ["complete", "other", "nothing"],
  ["aborted", "other", "nothing"],
] as const)("recovery from %s with %s returns %s", (state, identity, expected) => {
  expect(decideSettingsWrite("recover", { state, receipt, identity })).toBe(expected);
});

test("repeats only the same intent whose exact after bytes are present", () => {
  const facts = {
    state: "pending" as const,
    receipt,
    identity: "after",
    planId: "approved",
    editsIdentity: "edits",
    freshPlanId: "different",
    changed: true,
  };
  expect(decideSettingsWrite("apply", facts)).toBe("repeat");
  expect(decideSettingsWrite("apply", { ...facts, state: "complete" })).toBe("repeat");
  for (const changed of [{ identity: "before" }, { editsIdentity: "other" }, { planId: "other" }]) {
    expect(decideSettingsWrite("apply", { ...facts, ...changed })).toBe("recovery-required");
  }
  expect(decideSettingsWrite("apply", { ...facts, state: "unreadable" })).toBe("recovery-required");
  expect(decideSettingsWrite("apply", { ...facts, state: "aborted" })).toBe("stale");
});

test("requires the inspected plan and distinguishes a no-op from a write", () => {
  const facts = {
    state: "absent" as const,
    receipt: null,
    identity: "before",
    planId: "approved",
    freshPlanId: "approved",
    changed: true,
  };
  expect(decideSettingsWrite("apply", facts)).toBe("write");
  expect(decideSettingsWrite("apply", { ...facts, changed: false })).toBe("unchanged");
  expect(decideSettingsWrite("apply", { ...facts, freshPlanId: "stale" })).toBe("stale");
});
