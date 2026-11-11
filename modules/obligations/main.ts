import { Err, Ok, fromPromise } from "unthrown";
import { z } from "zod";
import { DeviceState } from "../device-state/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { Projects } from "../projects/main.ts";
import { isCodedError } from "../../lib/coded-error.ts";
import { kinds, obligationSchema, states } from "./content.ts";
import { decideObligation, type ObligationCommand } from "./obligation-machine.ts";

type Paths = ReturnType<typeof OperatorHome.resolve>;
type Selector = { paths: Paths; cwd: string; sourceId: string };
type Facts = Parameters<Parameters<typeof DeviceState.changeObligation>[3]>[0];
type Row = NonNullable<Facts["obligation"]>;
type Target = Parameters<typeof DeviceState.readObligations>[1];

const stateSchema = z.enum(states);
const ioCodes = ["ENOENT", "EACCES", "EPERM", "EIO", "ENOTDIR", "EISDIR", "ELOOP"];

/** Invalid input and file system failures are refusals. Any other error stays a defect. */
function qualify<T>(cause: Error, defect: (cause: Error) => T) {
  if (cause instanceof SyntaxError || cause instanceof z.ZodError)
    return { reason: "invalid_obligation_input", detail: `${cause.message} Nothing changed.` };
  if (isCodedError(cause) && ioCodes.includes(cause.code))
    return { reason: "obligation_io_failed", detail: String(cause) };
  return defect(cause);
}

/** The SuperAgent names the source from the project's controlling checkout. */
function target(input: Selector) {
  return Projects.current(input).map(({ data }) => ({
    repository: data.repository,
    checkout: data.checkout,
    sourceId: input.sourceId,
  }));
}

function summary(row: Row) {
  return {
    sourceId: row.sourceId,
    key: row.key,
    kind: row.kind,
    summary: row.summary,
    reference: row.reference,
    state: row.state,
    openedAt: row.openedAt,
    closedAt: row.closedAt,
  };
}

function decide(facts: Facts, command: ObligationCommand) {
  return decideObligation({
    command,
    source: facts.source,
    obligation:
      facts.obligation === null
        ? null
        : { key: facts.obligation.key, state: stateSchema.parse(facts.obligation.state) },
  });
}

/** Read the recorded obligation back after a change. */
function recorded(input: Selector, selected: Target, key: string) {
  return DeviceState.readObligations(input.paths, selected).flatMap(({ obligations }) => {
    const row = obligations.find((item) => item.key === key);
    // Stryker disable next-line ConditionalExpression: equivalent: a successful change always leaves its obligation recorded
    return row === undefined
      ? Err({ reason: "obligation_defect", detail: "The obligation is not recorded." })
      : Ok(summary(row));
  });
}

function add(input: Selector & { file: string }) {
  return fromPromise(
    async () => obligationSchema.parse(JSON.parse(await Bun.file(input.file).text())),
    (cause, defect) => (cause instanceof Error ? qualify(cause, defect) : defect(cause)),
  ).flatMap((added) =>
    target(input).flatMap((selected) =>
      DeviceState.changeObligation(input.paths, selected, added.key, (facts) =>
        decide(facts, "add").map((state) => ({
          insert: {
            sourceId: facts.source.id,
            key: added.key,
            kind: added.kind,
            summary: added.summary,
            reference: added.reference ?? null,
            openedAt: new Date().toISOString(),
            state,
            closedAt: null,
          },
        })),
      )
        .flatMap(() => recorded(input, selected, added.key))
        .map((data) => ({ reason: "obligation_added" as const, data })),
    ),
  );
}

function close(input: Selector & { key: string }) {
  return target(input).flatMap((selected) =>
    DeviceState.changeObligation(input.paths, selected, input.key, (facts) =>
      decide(facts, "close").map((state) => ({
        update: { state, closedAt: new Date().toISOString() },
      })),
    )
      .flatMap(() => recorded(input, selected, input.key))
      .map((data) => ({ reason: "obligation_closed" as const, data })),
  );
}

function list(input: Selector) {
  return target(input).flatMap((selected) =>
    DeviceState.readObligations(input.paths, selected).map(({ source, obligations }) => ({
      reason: "obligations_listed" as const,
      data: { sourceId: source.id, obligations: obligations.map(summary) },
    })),
  );
}

/**
 * The ledger of what the SuperAgent owes the person in each source: a PR to share, a review
 * reply, a merge hold, a standing rule, or a person's decision that waits to be recorded. Next
 * actions show each open obligation until the SuperAgent closes it. ADR-0025.
 */
export const Obligations = {
  /** The closed set of kinds, which stored rows are decoded against. */
  kinds() {
    return kinds;
  },
  /** The states an obligation moves through, which stored rows are decoded against. */
  states() {
    return states;
  },
  add(input: Selector & { file: string }) {
    return add(input);
  },
  close(input: Selector & { key: string }) {
    return close(input);
  },
  list(input: Selector) {
    return list(input);
  },
};
