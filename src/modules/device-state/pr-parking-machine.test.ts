import { expect, test } from "bun:test";
import { decideParking, historicalOwnerIsIdle, type ParkingFacts } from "./pr-parking-machine.ts";

const allowed: ParkingFacts = {
  event: "complete",
  state: "parking",
  ready: true,
  feedbackOwner: true,
  repositoryMatches: true,
  sourceOpen: true,
  assignmentOpen: true,
  launchMatches: true,
  launchFinished: true,
  leaseOwned: true,
  outgoingMatches: true,
  hasEvents: true,
  migrationOrigin: false,
  historicalOwnerIdle: false,
  historicalLaunchState: "finished",
};

test.each([
  ["park", null, "parking"],
  ["park", "active", "parking"],
  ["complete", "parking", "parked"],
  ["resume", "parked", "resuming"],
  ["activate", "resuming", "active"],
  ["close", "parked", "closed"],
] as const)("parking accepts %s from %s as %s", (event, state, next) => {
  expect(decideParking({ ...allowed, event, state })).toEqual({
    result: "transition",
    state: next,
  });
});

test.each([
  "repositoryMatches",
  "sourceOpen",
  "assignmentOpen",
  "launchMatches",
  "launchFinished",
  "leaseOwned",
  "outgoingMatches",
] as const)("parking completion refuses missing %s", (fact) => {
  expect(decideParking({ ...allowed, [fact]: false })).toEqual({ result: "refused" });
});

test.each([
  { event: "park", ready: false },
  { event: "park", feedbackOwner: false },
  { event: "park", state: "parking" },
  { event: "resume", state: "parked", hasEvents: false },
  { event: "resume", state: "active" },
  { event: "activate", state: "resuming", launchMatches: false },
] as const)("parking refuses an invalid transition %j", (change) => {
  expect(decideParking({ ...allowed, ...change })).toEqual({ result: "refused" });
});

test("repeated parking completion and unrelated launch activation do nothing", () => {
  expect(decideParking({ ...allowed, state: "parked" })).toEqual({ result: "unchanged" });
  expect(decideParking({ ...allowed, event: "activate", state: null })).toEqual({
    result: "unchanged",
  });
});

test("migration resume requires its own idle-owner witness, not a nullable head or finished state", () => {
  const migration = {
    ...allowed,
    event: "resume" as const,
    state: "parked" as const,
    migrationOrigin: true,
    launchFinished: false,
    historicalOwnerIdle: true,
  };
  expect(decideParking(migration)).toEqual({ result: "transition", state: "resuming" });
  expect(decideParking({ ...migration, historicalOwnerIdle: false })).toEqual({
    result: "refused",
  });
  expect(decideParking({ ...migration, historicalOwnerIdle: false, launchFinished: true })).toEqual(
    { result: "refused" },
  );
  expect(decideParking({ ...migration, migrationOrigin: false })).toEqual({ result: "refused" });
  expect(decideParking({ ...migration, feedbackOwner: false })).toEqual({ result: "refused" });
  expect(decideParking({ ...migration, launchMatches: false })).toEqual({ result: "refused" });
  expect(decideParking({ ...migration, hasEvents: false })).toEqual({ result: "refused" });
});

const migration: ParkingFacts = {
  ...allowed,
  event: "reserve",
  state: "resuming",
  migrationOrigin: true,
  launchFinished: false,
  historicalOwnerIdle: true,
};

test.each([
  ["resume", "parked", { result: "transition", state: "resuming" }],
  ["reserve", "resuming", { result: "transition", state: "active" }],
  ["reserve", "parked", { result: "refused" }],
  ["resume", "resuming", { result: "refused" }],
  ["reserve", "active", { result: "unchanged" }],
  ["resume", "active", { result: "refused" }],
  ["reserve", "parking", { result: "refused" }],
  ["reserve", "closed", { result: "refused" }],
  ["reserve", null, { result: "refused" }],
] as const)("migration %s from %s observes the reservation frontier", (event, state, expected) => {
  expect(decideParking({ ...migration, event, state })).toEqual(expected);
});

test.each(["resume", "reserve"] as const)("migration %s requires every ownership fact", (event) => {
  const facts = { ...migration, event, state: event === "resume" ? "parked" : "resuming" } as const;
  for (const fact of [
    "repositoryMatches",
    "sourceOpen",
    "assignmentOpen",
    "hasEvents",
    "launchMatches",
    "feedbackOwner",
    "historicalOwnerIdle",
  ] as const) {
    expect(decideParking({ ...facts, [fact]: false })).toEqual({ result: "refused" });
  }
});

test("reservation leaves ordinary receipts and an already active migration receipt unchanged", () => {
  expect(decideParking({ ...migration, migrationOrigin: false })).toEqual({ result: "unchanged" });
  expect(
    decideParking({ ...migration, state: "active", historicalOwnerIdle: false, hasEvents: false }),
  ).toEqual({ result: "unchanged" });
});

test.each(["finished", "failed", "interrupted"] as const)(
  "historical %s ownership permits migration resume and reserve only while idle",
  (historicalLaunchState) => {
    expect(historicalOwnerIsIdle({ historicalLaunchState, historicalOwnerIdle: true })).toBe(true);
    expect(historicalOwnerIsIdle({ historicalLaunchState, historicalOwnerIdle: false })).toBe(
      false,
    );
    expect(decideParking({ ...migration, historicalLaunchState })).toEqual({
      result: "transition",
      state: "active",
    });
    expect(
      decideParking({ ...migration, event: "resume", state: "parked", historicalLaunchState }),
    ).toEqual({ result: "transition", state: "resuming" });
  },
);

test.each([null, "starting", "running", "idle", "waiting", "unknown"])(
  "historical %s ownership cannot authorize migration even with an idle-owner witness",
  (historicalLaunchState) => {
    expect(historicalOwnerIsIdle({ historicalLaunchState, historicalOwnerIdle: true })).toBe(false);
    expect(decideParking({ ...migration, historicalLaunchState })).toEqual({ result: "refused" });
    expect(
      decideParking({ ...migration, event: "resume", state: "parked", historicalLaunchState }),
    ).toEqual({ result: "refused" });
  },
);
