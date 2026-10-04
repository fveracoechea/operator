import { describe, expect, test } from "bun:test";
import { identityOf } from "./identity.ts";
import type { IntegrationBranchRow } from "./integration.ts";
import { landingIntentInput, type PlannedMove } from "./landing.ts";
import { takeOutIntentInput } from "./take-out.ts";

/*
 * The request input of an intent is recorded as its identity, so a repeat of an open intent that
 * an earlier release recorded must hash to the same value. Each constant below is the identity
 * that the code at 53d8157 recorded for the same input.
 */

const commit = (digit: string) => digit.repeat(40);

const row: IntegrationBranchRow = {
  sourceId: "source-1",
  name: "operator/integration/source-1",
  baseCommit: commit("a"),
  recordedTip: commit("a"),
  gateIdentity: "gate-1",
  gateCommands: "[]",
  fixedAt: "2026-10-03T00:00:00.000Z",
  updatedAt: "2026-10-03T00:00:00.000Z",
};

describe("the request identity of a branch move intent stays the one earlier releases recorded", () => {
  test("a landing intent hashes its plan with the tree of the planned commit", () => {
    const landing: PlannedMove = {
      row,
      plan: {
        status: "ready",
        name: row.name,
        from: commit("a"),
        to: commit("b"),
        landed: commit("b"),
        landedParent: commit("a"),
        kind: "fast-forward",
        patch: "patch-1",
        rewrite: null,
      },
      tree: commit("c"),
    };

    const input = landingIntentInput({
      assignmentId: "assignment-1",
      submissionId: "submission-1",
      landing,
    });

    expect(identityOf(input)).toBe(
      "fed3a644090e6044622d4d88476784597b90b28469bdcd2c6f12e8a12bf2fe76",
    );
  });

  test("a take-out intent hashes its plan with the tree of its last gated commit", () => {
    const landing: PlannedMove = {
      row,
      plan: {
        status: "ready",
        name: row.name,
        from: commit("e"),
        to: commit("f"),
        landed: commit("d"),
        landedParent: commit("a"),
        kind: "take-out",
        patch: "patch-2",
        rewrite: {
          replaces: "landing-1",
          replacedCommit: commit("d"),
          relanded: [
            {
              landingId: "landing-2",
              assignmentId: "assignment-2",
              from: commit("e"),
              to: commit("f"),
              parent: commit("a"),
            },
          ],
          takenOut: [],
          takeOut: { planRevision: "revision-1", removed: [] },
        },
      },
      tree: commit("9"),
    };

    const input = takeOutIntentInput({ sourceId: "source-1", planRevision: "revision-1" }, landing);

    expect(identityOf(input)).toBe(
      "b4ea23e409a569fa401b9e51e75d392cc66d3f3c1cf6e0dd22a5c858349824ad",
    );
  });
});
