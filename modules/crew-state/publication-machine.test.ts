import { expect, test } from "bun:test";
import {
  type PartRead,
  Publication,
  type PublicationFacts,
  type RetargetDue,
} from "./publication-machine.ts";
import type { RecallPlanned } from "./recall.ts";
import type { Fault } from "./stack-parts.ts";
import type { PublicationRow } from "./stack-records.ts";

const APPROVAL = {
  action: "publish",
  targets: ["operator/s-2", "main"],
  scope: "source-1",
  requestRevision: "revision-1",
};

function fault(overrides: Partial<Fault> = {}): Fault {
  return {
    part: 1,
    number: 11,
    fault: "closed_unmerged",
    detail: "Closed with no merge.",
    settlement: { ...APPROVAL, action: "stack-fault" },
    settled: false,
    ...overrides,
  };
}

function parts(...statuses: PartRead["status"][]): PartRead[] {
  return statuses.map((status, index) => ({ part: index + 1, number: 11 + index, status }));
}

function due(overrides: Partial<RetargetDue> = {}): RetargetDue {
  return {
    publicationId: "publication-1",
    part: 2,
    number: 12,
    from: "operator/s-1",
    target: "main",
    approval: APPROVAL,
    approved: true,
    ...overrides,
  };
}

function retarget(
  overrides: Partial<PublicationFacts["retarget"]> = {},
): PublicationFacts["retarget"] {
  return {
    sourceId: "source-1",
    part: 2,
    known: true,
    stack: { state: "open", publication: 1, open: [12] },
    due: due(),
    lowest: Number.POSITIVE_INFINITY,
    ...overrides,
  };
}

test("the state of the last publication is derived from its parts and faults", () => {
  expect(Publication.stateOf({ last: "none" })).toEqual({ state: "none" });
  expect(Publication.stateOf({ last: "unwritten", publication: 2 })).toEqual({
    state: "unwritten",
    publication: 2,
  });
  const written = { last: "written" as const, publication: 1 };
  expect(Publication.stateOf({ ...written, parts: parts("open", "open"), faults: [] })).toEqual({
    state: "open",
    publication: 1,
    open: [11, 12],
  });
  // A fault no person settled holds the stack, and it stops each open part above it.
  expect(
    Publication.stateOf({ ...written, parts: parts("closed", "open"), faults: [fault()] }),
  ).toEqual({ state: "faulted", publication: 1, faults: [fault()], stopped: [2] });
  expect(
    Publication.stateOf({
      ...written,
      parts: parts("closed", "open"),
      faults: [fault({ settled: true })],
    }),
  ).toEqual({ state: "ended", publication: 1, ended: [fault({ settled: true })], stopped: [2] });
  // A settled merge by another method counts as landed.
  const landed = fault({ fault: "not_merge_commit", settled: true });
  expect(
    Publication.stateOf({ ...written, parts: parts("merged", "merged"), faults: [landed] }),
  ).toEqual({ state: "merged", publication: 1 });
  expect(
    Publication.stateOf({ ...written, parts: parts("merged", "recalled"), faults: [] }),
  ).toEqual({ state: "recalled", publication: 1, recalled: [12], closed: false });
  expect(Publication.stateOf({ ...written, parts: parts("closed", "closed"), faults: [] })).toEqual(
    {
      state: "recalled",
      publication: 1,
      recalled: [11, 12],
      closed: true,
    },
  );
});

test("an apply settles the open publication of its own revision and refuses another", () => {
  const open = { id: "publication-1", planRevision: "revision-1" };
  expect(Publication.decide("apply", { stated: "revision-1", open })).toEqual({
    next: { kind: "settle", publicationId: "publication-1" },
  });
  expect(Publication.decide("apply", { stated: "revision-2", open })).toEqual({
    refused: {
      status: "plan-revision-changed",
      stated: "revision-2",
      planned: "revision-1",
      planPath: null,
    },
  });
  expect(Publication.decide("apply", { stated: "revision-2", open: null })).toEqual({
    next: { kind: "record" },
  });
});

test("an observe refuses in the recorded order and reads only a written publication", () => {
  const publication: PublicationRow = {
    id: "publication-1",
    sourceId: "source-1",
    number: 1,
    planRevision: "revision-1",
    approvalId: "approval-1",
    remote: "origin",
    target: "main",
    baseCommit: "base-1",
    headCommit: "head-1",
    createdAt: "2026-10-04T00:00:00.000Z",
    trackerSteps: "[]",
  };
  const written = { publication, pulls: [] };
  const facts: PublicationFacts["observe"] = {
    sourceId: "source-1",
    known: true,
    stack: { state: "open", publication: 1, open: [11] },
    written,
    repository: "acme/app",
  };
  expect(
    Publication.decide("observe", { ...facts, known: false, stack: { state: "none" } }),
  ).toEqual({ refused: { status: "unknown-source", sourceId: "source-1" } });
  expect(Publication.decide("observe", { ...facts, stack: { state: "none" } })).toEqual({
    refused: { status: "nothing-published", sourceId: "source-1" },
  });
  expect(
    Publication.decide("observe", {
      ...facts,
      stack: { state: "unwritten", publication: 1 },
      written: null,
    }),
  ).toEqual({ refused: { status: "publish-unsettled", sourceId: "source-1", publication: 1 } });
  expect(Publication.decide("observe", { ...facts, repository: null })).toEqual({
    refused: { status: "publish-unsettled", sourceId: "source-1", publication: 1 },
  });
  expect(Publication.decide("observe", facts)).toEqual({
    next: { kind: "read", ...written, repository: "acme/app" },
  });
});

test("a recall settles its open writes before any guard", () => {
  const planned: RecallPlanned = {
    publicationId: "publication-1",
    repository: "acme/app",
    preview: {
      status: "planned",
      sourceId: "source-1",
      publication: 1,
      planRevision: "recall-1",
      parts: [],
      replaced: true,
      approval: { ...APPROVAL, action: "stack-recall" },
    },
  };
  const facts = { sourceId: "source-1", known: true, open: null, planned };
  expect(
    Publication.decide("recall", { ...facts, known: false, open: "publication-1", planned: null }),
  ).toEqual({ next: { kind: "settle", publicationId: "publication-1" } });
  expect(Publication.decide("recall", { ...facts, known: false, planned: null })).toEqual({
    refused: { status: "unknown-source", sourceId: "source-1" },
  });
  expect(Publication.decide("recall", { ...facts, planned: null })).toEqual({
    refused: { status: "nothing-to-recall", sourceId: "source-1" },
  });
  expect(Publication.decide("recall", facts)).toEqual({ next: { kind: "plan", planned } });
});

test("a retarget refuses a fault at or below its part before a part that is not due", () => {
  expect(Publication.decide("retarget", retarget({ known: false }))).toEqual({
    refused: { status: "unknown-source", sourceId: "source-1" },
  });
  expect(
    Publication.decide("retarget", retarget({ stack: { state: "unwritten", publication: 1 } })),
  ).toEqual({ refused: { status: "publish-unsettled", sourceId: "source-1" } });
  expect(Publication.decide("retarget", retarget({ due: null, lowest: 2 }))).toEqual({
    refused: {
      status: "stack-fault",
      part: 2,
      detail: "Part 2 holds a stack fault, so it is stopped and keeps its base.",
    },
  });
  expect(Publication.decide("retarget", retarget({ due: null, lowest: 1 }))).toEqual({
    refused: {
      status: "stack-fault",
      part: 2,
      detail: "Part 1 holds a stack fault, so part 2 is stopped and keeps its base.",
    },
  });
  expect(Publication.decide("retarget", retarget({ due: null }))).toEqual({
    refused: {
      status: "not-due",
      part: 2,
      detail:
        "Part 2 has no retarget due: the part below has no recorded merge by a merge commit, or its retarget is recorded.",
    },
  });
  expect(Publication.decide("retarget", retarget({ due: due({ approved: false }) }))).toEqual({
    refused: { status: "approval-required", approval: APPROVAL },
  });
  expect(Publication.decide("retarget", retarget())).toEqual({
    next: { kind: "write", due: due() },
  });
});

test("only a stack-fault approval settles a fault", () => {
  expect(Publication.decide("settle-fault", { action: "stack-fault" })).toEqual({
    next: { kind: "settled", effects: ["close-merged-invalidations"] },
  });
  expect(Publication.decide("settle-fault", { action: "publish" })).toEqual({
    refused: { status: "not-stack-fault" },
  });
});
