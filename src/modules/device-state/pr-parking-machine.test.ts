import { expect, test } from "bun:test";
import { decideParking, type ParkingFacts } from "./pr-parking-machine.ts";

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
