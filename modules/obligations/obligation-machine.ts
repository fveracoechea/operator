import { Err, Ok, type Result } from "unthrown";

export type ObligationCommand = "add" | "close";
export type ObligationState = "open" | "closed";
type Facts = {
  command: ObligationCommand;
  source: { id: string; state: string };
  /** The recorded obligation with the command's key, when one was added. */
  obligation: { key: string; state: ObligationState } | null;
};
type Refusal = { reason: string; detail: string };

function refuse(reason: string, detail: string) {
  return Err<Refusal>({ reason, detail: `${detail} Nothing changed.` });
}

const rules: Record<ObligationCommand, (facts: Facts) => Result<ObligationState, Refusal>> = {
  add({ source, obligation }) {
    // An ended source takes no new work, so it takes no new commitment either.
    if (source.state !== "open")
      return refuse("source_not_open", `Source ${source.id} is ${source.state}.`);
    // A key names one obligation for the whole source, also after it was closed.
    if (obligation !== null)
      return refuse(
        "obligation_exists",
        `Source ${source.id} already has obligation ${obligation.key}, and it is ${obligation.state}. Use a new key.`,
      );
    return Ok("open");
  },
  // What is still owed stays closable after its source ended.
  close({ source, obligation }) {
    if (obligation === null)
      return refuse("obligation_not_found", `Source ${source.id} has no obligation with this key.`);
    if (obligation.state !== "open")
      return refuse("obligation_not_open", `Obligation ${obligation.key} is ${obligation.state}.`);
    return Ok("closed");
  },
};

/** The state that a command leaves, or its refusal. It reads no state and no clock. */
export function decideObligation(facts: Facts) {
  return rules[facts.command](facts);
}
