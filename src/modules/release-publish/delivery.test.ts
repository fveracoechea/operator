import { expect, test } from "bun:test";
import { DeliveryPath } from "./delivery.ts";

const facts = {
  path: "github-source",
  released: false,
  observed: false,
  taggedCommit: null,
  commit: "commit",
} satisfies Parameters<typeof DeliveryPath.decide<"plan">>[2];
const outcome = { detail: "sent", reference: "url", at: "time" };

test("delivery plans refuse changed tags and unrecorded occupied registry versions", () => {
  expect(DeliveryPath.decide("absent", "plan", { ...facts, taggedCommit: "other" })).toEqual({
    refused: "tag_moved",
  });
  expect(DeliveryPath.decide("absent", "plan", { ...facts, path: "jsr", observed: true })).toEqual({
    refused: "version_published",
  });
  expect(DeliveryPath.decide("failed", "plan", { ...facts, path: "jsr", observed: true })).toEqual({
    next: "failed",
    effects: [{ kind: "deliver", observed: true }],
  });
  expect(DeliveryPath.decide("published", "plan", facts)).toEqual({
    next: "published",
    effects: [],
  });
});

test("delivery outcomes preserve published records and record failed or uncertain sends for recovery", () => {
  for (const [event, state] of [
    ["send-succeeded", "published"],
    ["send-failed", "failed"],
    ["send-uncertain", "uncertain"],
    ["observed-published", "published"],
  ] as const) {
    expect(DeliveryPath.decide("absent", event, outcome)).toEqual({
      next: state,
      effects: [{ kind: "record", record: { state, ...outcome } }],
    });
    expect(DeliveryPath.decide("published", event, outcome)).toEqual({
      refused: "already-published",
    });
  }
  expect(DeliveryPath.state(undefined)).toBe("absent");
  expect(DeliveryPath.state({ state: "failed", ...outcome })).toBe("failed");
});
