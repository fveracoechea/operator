import type { Receipt } from "./storage.ts";

type State = "absent" | "unreadable" | Receipt["state"];
type Event = "apply" | "recover";
type Decision =
  | "recovery-required"
  | "repeat"
  | "stale"
  | "unchanged"
  | "write"
  | "complete"
  | "aborted"
  | "nothing";
type Facts = {
  state: State;
  receipt: Receipt | null;
  identity: string;
  planId?: string;
  editsIdentity?: string;
  freshPlanId?: string;
  changed?: boolean;
};
type Rule = { from?: readonly State[]; when?: (facts: Facts) => boolean; decision: Decision };

/** The first matching rule decides. A rule without `from` matches every state. */
const machine: Record<Event, { rules: Rule[]; otherwise: Decision }> = {
  apply: {
    rules: [
      { from: ["unreadable"], decision: "recovery-required" },
      {
        from: ["pending", "complete"],
        when: (facts) =>
          facts.receipt !== null &&
          facts.receipt.planId === facts.planId &&
          facts.receipt.editsIdentity === facts.editsIdentity &&
          facts.receipt.nextIdentity === facts.identity,
        decision: "repeat",
      },
      { from: ["pending"], decision: "recovery-required" },
      { when: (facts) => facts.freshPlanId !== facts.planId, decision: "stale" },
      { when: (facts) => facts.changed === false, decision: "unchanged" },
    ],
    otherwise: "write",
  },
  recover: {
    rules: [
      { from: ["absent", "complete", "aborted"], decision: "nothing" },
      {
        from: ["pending"],
        when: (facts) => facts.receipt?.nextIdentity === facts.identity,
        decision: "complete",
      },
      {
        from: ["pending"],
        when: (facts) => facts.receipt?.previousIdentity === facts.identity,
        decision: "aborted",
      },
    ],
    otherwise: "recovery-required",
  },
};

/** Pending intent can only settle from the recorded before or after bytes. */
export function decideSettingsWrite(event: Event, facts: Facts): Decision {
  const { rules, otherwise } = machine[event];
  return (
    rules.find(
      (rule) =>
        (rule.from === undefined || rule.from.includes(facts.state)) &&
        (rule.when === undefined || rule.when(facts)),
    )?.decision ?? otherwise
  );
}
