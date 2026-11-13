import { expect, test } from "bun:test";
import { decideObligation } from "./obligation-machine.ts";

const open = { id: "s1", state: "open" };

test("an open source takes a new key, and the obligation opens", () => {
  expect(decideObligation({ command: "add", source: open, obligation: null })).toMatchObject({
    tag: "Ok",
    value: "open",
  });
});

test.each(["finished", "reset"])("a %s source takes no new obligation", (state) => {
  expect(
    decideObligation({ command: "add", source: { id: "s1", state }, obligation: null }),
  ).toMatchObject({
    error: { reason: "source_not_open", detail: `Source s1 is ${state}. Nothing changed.` },
  });
});

test.each(["open", "closed"] as const)("a key that is %s cannot be added again", (state) => {
  expect(
    decideObligation({ command: "add", source: open, obligation: { key: "share", state } }),
  ).toMatchObject({
    error: {
      reason: "obligation_exists",
      detail: `Source s1 already has obligation share, and it is ${state}. Use a new key. Nothing changed.`,
    },
  });
});

test.each(["open", "finished"])("an open obligation closes in a %s source", (state) => {
  expect(
    decideObligation({
      command: "close",
      source: { id: "s1", state },
      obligation: { key: "share", state: "open" },
    }),
  ).toMatchObject({ tag: "Ok", value: "closed" });
});

test("only a recorded open obligation closes", () => {
  expect(decideObligation({ command: "close", source: open, obligation: null })).toMatchObject({
    error: {
      reason: "obligation_not_found",
      detail: "Source s1 has no obligation with this key. Nothing changed.",
    },
  });
  expect(
    decideObligation({
      command: "close",
      source: open,
      obligation: { key: "share", state: "closed" },
    }),
  ).toMatchObject({
    error: {
      reason: "obligation_not_open",
      detail: "Obligation share is closed. Nothing changed.",
    },
  });
});
