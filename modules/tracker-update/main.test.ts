import { describe, expect, test } from "bun:test";
import { TrackerUpdate } from "./main.ts";

type Observation = Awaited<ReturnType<typeof TrackerUpdate.observe>>;

const OPERATION = "8f1d0c2a-0000-4000-8000-000000000001";

function scan(
  overrides: Partial<Extract<Observation, { kind: "comment" }>> = {},
): Extract<Observation, { kind: "comment" }> {
  return {
    kind: "comment",
    lookup: "scan",
    coverage: { complete: true, pages: 1, count: 0, detail: null },
    exactMatches: [],
    editedMatches: [],
    actorMismatches: [],
    observedAt: "2026-09-21T00:00:00Z",
    ...overrides,
  };
}

const mark = {
  commentId: "1",
  url: "https://github.com/owner/repo/issues/1#issuecomment-1",
  actor: "operator-bot",
  createdAt: "2026-09-21T00:00:00Z",
  updatedAt: "2026-09-21T00:00:00Z",
  contentIdentity: "a".repeat(64),
};

describe("TrackerUpdate.capabilities", () => {
  test("records what GitHub cannot guarantee instead of assuming it can", () => {
    const github = TrackerUpdate.capabilities({ provider: "github" });

    expect(github?.comments).toBe(true);
    expect(github?.completion).toBe(true);
    // This is why a lost answer is settled by reading and never by writing again.
    expect(github?.exactlyOnceWrites).toBe(false);
  });

  test("gives an unimplemented tracker no capabilities at all", () => {
    expect(TrackerUpdate.capabilities({ provider: "jira" })).toBeNull();
    expect(TrackerUpdate.capabilities({ provider: "linear" })).toBeNull();
  });
});

describe("TrackerUpdate.judge", () => {
  test("keeps a step pending while nothing has been written", () => {
    const verdict = TrackerUpdate.judge({
      step: "resolution",
      observation: scan(),
      intendedReason: "",
      writes: [],
    });

    expect(verdict.state).toBe("pending");
    expect(verdict.reason).toBe("tracker.pending");
  });

  test("verifies one exact match by the expected actor", () => {
    const verdict = TrackerUpdate.judge({
      step: "resolution",
      observation: scan({ exactMatches: [mark] }),
      intendedReason: "",
      writes: ["succeeded"],
    });

    expect(verdict.state).toBe("verified");
    expect(verdict.reason).toBe("tracker.completed");
    expect(verdict.problems).toEqual([]);
  });

  test("ranks an unproven write above every other problem and keeps them all", () => {
    const verdict = TrackerUpdate.judge({
      step: "map_amendment",
      observation: scan({
        coverage: { complete: false, pages: 1, count: 3, detail: "page two failed" },
        actorMismatches: [{ ...mark, actor: "someone-else" }],
      }),
      intendedReason: "",
      writes: ["uncertain"],
    });

    expect(verdict.reason).toBe("tracker.map_outcome_unknown");
    // Every lower-ranked problem is still reported, never discarded by the ranking.
    expect(verdict.problems.map((one) => one.reason)).toEqual([
      "tracker.map_conflict",
      "tracker.evidence_incomplete",
      "tracker.map_outcome_unknown",
    ]);
  });

  test("calls a refused write a definite failure only when nothing matches it", () => {
    const verdict = TrackerUpdate.judge({
      step: "resolution",
      observation: scan(),
      intendedReason: "",
      writes: ["failed"],
    });

    expect(verdict.state).toBe("failed");
    expect(verdict.reason).toBe("tracker.write_rejected");
  });

  test("never lets a failed read settle a step as a definite failure", () => {
    const verdict = TrackerUpdate.judge({
      step: "resolution",
      observation: scan({
        coverage: { complete: false, pages: 0, count: 0, detail: "the scan failed" },
      }),
      intendedReason: "",
      writes: ["failed"],
    });

    // The refusal is established, but the reading is not, and a missing condition outranks a
    // definite failure. Both stay recorded.
    expect(verdict.reason).toBe("tracker.evidence_incomplete");
    expect(verdict.problems.map((one) => one.reason)).toEqual([
      "tracker.evidence_incomplete",
      "tracker.write_rejected",
    ]);
  });

  test("keeps a step that was never sent out of the unproven-effect answer", () => {
    // An unreadable state with nothing sent has no effect that may still apply.
    const verdict = TrackerUpdate.judge({
      step: "completion",
      observation: {
        kind: "closure",
        read: "unknown",
        detail: "the read failed",
        state: null,
        stateReason: null,
        closedBy: null,
        closedAt: null,
        updatedAt: null,
        events: [],
        eventCoverage: { complete: true, pages: 1, count: 0, detail: null },
        reopened: "no",
        observedAt: "2026-09-21T00:00:00Z",
      },
      intendedReason: "completed",
      writes: [],
    });

    expect(verdict.reason).toBe("tracker.evidence_incomplete");
    expect(verdict.problems.map((one) => one.reason)).toEqual([
      "tracker.evidence_incomplete",
      "tracker.pending",
    ]);
  });

  test("reads an intended close reason as completion and another one as a conflict", () => {
    const closed: Extract<Observation, { kind: "closure" }> = {
      kind: "closure",
      read: "found",
      detail: null,
      state: "closed",
      stateReason: "completed",
      closedBy: "someone-else",
      closedAt: "2026-09-21T00:00:00Z",
      updatedAt: "2026-09-21T00:00:00Z",
      events: [],
      eventCoverage: { complete: true, pages: 1, count: 0, detail: null },
      reopened: "no",
      observedAt: "2026-09-21T00:00:00Z",
    };

    // The state satisfies the step even though another account caused it.
    expect(
      TrackerUpdate.judge({
        step: "completion",
        observation: closed,
        intendedReason: "completed",
        writes: [],
      }).state,
    ).toBe("verified");

    expect(
      TrackerUpdate.judge({
        step: "completion",
        observation: { ...closed, stateReason: "not_planned" },
        intendedReason: "completed",
        writes: [],
      }).reason,
    ).toBe("tracker.completion_conflict");
  });

  test("refuses to read an unread history as no reopen", () => {
    const verdict = TrackerUpdate.judge({
      step: "completion",
      observation: {
        kind: "closure",
        read: "found",
        detail: null,
        state: "closed",
        stateReason: "completed",
        closedBy: "operator-bot",
        closedAt: "2026-09-21T00:00:00Z",
        updatedAt: "2026-09-21T00:00:00Z",
        events: [],
        eventCoverage: { complete: false, pages: 0, count: 0, detail: "the history read failed" },
        reopened: "unknown",
        observedAt: "2026-09-21T00:00:00Z",
      },
      intendedReason: "completed",
      writes: ["succeeded"],
    });

    // The state looks right, and the evidence that nothing reopened it is missing.
    expect(verdict.state).not.toBe("verified");
    expect(verdict.reason).toBe("tracker.evidence_incomplete");
  });

  test("stops on a reopen that followed the close", () => {
    const verdict = TrackerUpdate.judge({
      step: "completion",
      observation: {
        kind: "closure",
        read: "found",
        detail: null,
        state: "open",
        stateReason: "reopened",
        closedBy: null,
        closedAt: null,
        updatedAt: "2026-09-21T00:00:00Z",
        events: [],
        eventCoverage: { complete: true, pages: 1, count: 0, detail: null },
        reopened: "yes",
        observedAt: "2026-09-21T00:00:00Z",
      },
      intendedReason: "completed",
      writes: ["succeeded"],
    });

    expect(verdict.reason).toBe("tracker.completion_conflict");
  });
});

describe("TrackerUpdate.plan", () => {
  test("refuses a tracker this release does not implement", async () => {
    const planned = await TrackerUpdate.plan({
      provider: "jira",
      operationId: OPERATION,
      intent: {
        step: "completion",
        target: { repository: "owner/repo", issue: 1 },
        reason: "done",
      },
    });

    expect(planned.status).toBe("unsupported-provider");
  });
});
