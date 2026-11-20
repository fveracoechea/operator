export type ParkingState = "parking" | "parked" | "resuming" | "active" | "closed";
export type ParkingFacts = {
  event: "park" | "complete" | "resume" | "activate" | "close";
  state: ParkingState | null;
  ready: boolean;
  feedbackOwner: boolean;
  repositoryMatches: boolean;
  sourceOpen: boolean;
  assignmentOpen: boolean;
  launchMatches: boolean;
  launchFinished: boolean;
  leaseOwned: boolean;
  outgoingMatches: boolean;
  hasEvents: boolean;
};
type Decision =
  | { result: "transition"; state: ParkingState }
  | { result: "refused" }
  | { result: "unchanged" };
const rules: {
  when: (facts: ParkingFacts) => boolean;
  decide: (facts: ParkingFacts) => Decision;
}[] = [
  {
    when: (f) => f.event === "complete" && f.state !== "parking",
    decide: () => ({ result: "unchanged" }),
  },
  {
    when: (f) => f.event === "activate" && f.state !== "resuming",
    decide: () => ({ result: "unchanged" }),
  },
  {
    when: (f) => !f.repositoryMatches || !f.sourceOpen || !f.assignmentOpen,
    decide: () => ({ result: "refused" }),
  },
  {
    when: (f) =>
      f.event === "park" &&
      (f.state === null || f.state === "active") &&
      f.ready &&
      f.feedbackOwner,
    decide: () => ({ result: "transition", state: "parking" }),
  },
  {
    when: (f) =>
      f.event === "complete" &&
      f.launchMatches &&
      f.launchFinished &&
      f.leaseOwned &&
      f.outgoingMatches,
    decide: () => ({ result: "transition", state: "parked" }),
  },
  {
    when: (f) =>
      f.event === "resume" &&
      f.state === "parked" &&
      f.hasEvents &&
      f.launchMatches &&
      f.launchFinished,
    decide: () => ({ result: "transition", state: "resuming" }),
  },
  {
    when: (f) => f.event === "activate" && f.launchMatches,
    decide: () => ({ result: "transition", state: "active" }),
  },
  {
    when: (f) => f.event === "close" && f.state === "parked",
    decide: () => ({ result: "transition", state: "closed" }),
  },
];

/** Ordered parking lifecycle rules over facts gathered inside the owner's transaction. */
export function decideParking(facts: ParkingFacts): Decision {
  return rules.find((rule) => rule.when(facts))?.decide(facts) ?? { result: "refused" };
}
