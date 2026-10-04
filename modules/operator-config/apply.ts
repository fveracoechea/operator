import { z } from "zod";

export const receiptSchema = z.strictObject({
  planId: z.string(),
  generation: z.string().nullable(),
  editsIdentity: z.string(),
  previousIdentity: z.string(),
  nextIdentity: z.string(),
  state: z.enum(["pending", "complete", "aborted"]),
});

export type Receipt = z.infer<typeof receiptSchema>;

/** No apply record is `absent`. The other states are the recorded `state` values, or `unreadable`. */
export type ConfigApplyState = "absent" | Receipt["state"] | "unreadable";

type ApplyEvent = { kind: "apply"; approvedPlanId: string; editsIdentity: string };
type WriteEvent = { kind: "write-verified" | "write-mismatch" | "config-stale" };
type RecoverEvent = { kind: "recover" };

export type ConfigApplyEvent = ApplyEvent | WriteEvent | RecoverEvent;

/**
 * What the interpreter read under the write lock. `identity` is null when the configuration
 * cannot be read. `plan` is the fresh plan for the apply edits, or null when it is not valid.
 */
export type ConfigApplyFacts = {
  receipt: Receipt | null;
  identity: string | null;
  plan: { planId: string; changed: boolean } | null;
};

export type ConfigApplyRefusal =
  | "receipt-unreadable"
  | "config-unreadable"
  | "unconfirmed-write"
  | "plan-invalid"
  | "approval-stale"
  | "unproven-write";

/** `write` asks the interpreter to write the approved file. The others name the result. */
export type ConfigApplyOutcome =
  | "repeated"
  | "unchanged"
  | "write"
  | "applied"
  | "write-failed"
  | "approval-stale"
  | "settled"
  | "nothing";

/** `record` asks the interpreter to write the apply record with the `next` state. */
type Move =
  | { next: ConfigApplyState; record: false; outcome: ConfigApplyOutcome }
  | { next: Receipt["state"]; record: true; outcome: ConfigApplyOutcome };

export type ConfigApplyDecision = Move | { refused: ConfigApplyRefusal };

/** A rule without `next` keeps the state. The first rule that matches decides. */
type Rule<Event> = {
  from: readonly ConfigApplyState[];
  when?: (facts: ConfigApplyFacts, event: Event) => boolean;
} & (
  | { refused: ConfigApplyRefusal }
  | { next?: ConfigApplyState; record: false; outcome: ConfigApplyOutcome }
  | { next: Receipt["state"]; record: true; outcome: ConfigApplyOutcome }
);

const ANY: readonly ConfigApplyState[] = ["absent", "pending", "complete", "aborted", "unreadable"];

/** The approved plan already wrote the file that is there now. */
function repeats({ receipt, identity }: ConfigApplyFacts, event: ApplyEvent): boolean {
  return (
    receipt?.planId === event.approvedPlanId &&
    receipt.editsIdentity === event.editsIdentity &&
    receipt.nextIdentity === identity
  );
}

const applyRules: Rule<ApplyEvent>[] = [
  { from: ["unreadable"], refused: "receipt-unreadable" },
  { from: ANY, when: ({ identity }) => identity === null, refused: "config-unreadable" },
  { from: ["pending"], when: repeats, next: "complete", record: true, outcome: "repeated" },
  { from: ["complete"], when: repeats, record: false, outcome: "repeated" },
  {
    from: ["pending"],
    when: ({ receipt }, event) => receipt?.planId !== event.approvedPlanId,
    refused: "unconfirmed-write",
  },
  { from: ANY, when: ({ plan }) => plan === null, refused: "plan-invalid" },
  {
    from: ANY,
    when: ({ plan }, event) => plan?.planId !== event.approvedPlanId,
    refused: "approval-stale",
  },
  { from: ANY, when: ({ plan }) => plan?.changed === false, record: false, outcome: "unchanged" },
  { from: ANY, next: "pending", record: true, outcome: "write" },
];

const writeRules: Rule<WriteEvent>[] = [
  {
    from: ["pending"],
    when: (_, event) => event.kind === "write-verified",
    next: "complete",
    record: true,
    outcome: "applied",
  },
  {
    from: ["pending"],
    when: (_, event) => event.kind === "write-mismatch",
    next: "aborted",
    record: true,
    outcome: "write-failed",
  },
  {
    from: ["pending"],
    when: (_, event) => event.kind === "config-stale",
    next: "aborted",
    record: true,
    outcome: "approval-stale",
  },
];

const recoverRules: Rule<RecoverEvent>[] = [
  { from: ["unreadable"], refused: "receipt-unreadable" },
  { from: ["absent", "complete", "aborted"], record: false, outcome: "nothing" },
  { from: ["pending"], when: ({ identity }) => identity === null, refused: "config-unreadable" },
  {
    from: ["pending"],
    when: ({ receipt, identity }) => identity === receipt?.nextIdentity,
    next: "complete",
    record: true,
    outcome: "settled",
  },
  {
    from: ["pending"],
    when: ({ receipt, identity }) => identity === receipt?.previousIdentity,
    next: "aborted",
    record: true,
    outcome: "settled",
  },
  { from: ["pending"], refused: "unproven-write" },
];

function first<Event>(
  rules: Rule<Event>[],
  state: ConfigApplyState,
  event: Event,
  facts: ConfigApplyFacts,
): ConfigApplyDecision {
  const rule = rules.find(
    (one) => one.from.includes(state) && (one.when === undefined || one.when(facts, event)),
  );
  if (rule === undefined) throw new Error(`No config apply rule from ${state}`);
  if ("refused" in rule) return { refused: rule.refused };
  if (rule.record) return { next: rule.next, record: true, outcome: rule.outcome };
  return { next: rule.next ?? state, record: false, outcome: rule.outcome };
}

export const ConfigApply = {
  /**
   * Pure. The config apply machine over the apply record. A write that is not confirmed stays
   * `pending` until an apply of the same plan or a recovery proves which file is there.
   */
  decide(
    state: ConfigApplyState,
    event: ConfigApplyEvent,
    facts: ConfigApplyFacts,
  ): ConfigApplyDecision {
    switch (event.kind) {
      case "apply":
        return first(applyRules, state, event, facts);
      case "recover":
        return first(recoverRules, state, event, facts);
      default:
        return first(writeRules, state, event, facts);
    }
  },
};
