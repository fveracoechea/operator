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
type Rule = { from: readonly State[]; when?: (facts: Facts) => boolean; decision: Decision };
const any: readonly State[] = ["absent", "unreadable", "pending", "complete", "aborted"];

const rules: Record<Event, Rule[]> = {
  apply: [
    { from: ["unreadable"], decision: "recovery-required" },
    {
      from: ["pending", "complete"],
      when: (facts) =>
        facts.receipt?.planId === facts.planId &&
        facts.receipt?.editsIdentity === facts.editsIdentity &&
        facts.receipt?.nextIdentity === facts.identity,
      decision: "repeat",
    },
    { from: ["pending"], decision: "recovery-required" },
    { from: any, when: (facts) => facts.freshPlanId !== facts.planId, decision: "stale" },
    { from: any, when: (facts) => facts.changed === false, decision: "unchanged" },
    { from: any, decision: "write" },
  ],
  recover: [
    { from: ["unreadable"], decision: "recovery-required" },
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
    { from: any, decision: "recovery-required" },
  ],
};

/** Pending intent can only settle from the recorded before or after bytes. */
export function decideSettingsWrite(event: Event, facts: Facts): Decision {
  return (
    rules[event].find(
      (rule) => rule.from.includes(facts.state) && (rule.when === undefined || rule.when(facts)),
    )?.decision ?? "recovery-required"
  );
}
