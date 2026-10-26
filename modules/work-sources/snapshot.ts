import { z } from "zod";
import type { DeviceState } from "../device-state/main.ts";
import { planSchema } from "./plan.ts";
import { assignmentStateSchema } from "./assignment-machine.ts";
import { decideSource } from "./source-machine.ts";

type StoredSource = Extract<
  ReturnType<typeof DeviceState.readSources>,
  { tag: "Ok" }
>["value"][number];

export function decodeSource(input: StoredSource) {
  const source = {
    ...input.source,
    state: z.enum(["open", "finished", "reset"]).parse(input.source.state),
    plan: planSchema.parse(JSON.parse(input.source.plan)),
    assignments: z.array(assignmentStateSchema).parse(input.assignments),
  };
  const consistent =
    source.trackerKey === source.plan.trackerKey &&
    source.assignments.length === source.plan.assignments.length &&
    source.plan.assignments.every((assignment) =>
      source.assignments.some(
        (row) => row.key === assignment.key && row.completion === assignment.completion,
      ),
    );
  const expected = decideSource({ state: "open", assignments: source.assignments });
  const validState =
    source.state === "reset"
      ? source.assignments.every((assignment) =>
          ["merged", "completed", "abandoned"].includes(assignment.state),
        )
      : source.state === expected;
  const validLifecycle =
    validState && (source.state === "open" ? source.endedAt === null : source.endedAt !== null);
  if (!consistent || !validLifecycle) {
    // oxlint-disable-next-line unthrown/no-throw -- The read boundary reports malformed persisted data as corruption without repair.
    throw new z.ZodError([
      { code: "custom", path: [], message: "Source rows do not match the supplied plan." },
    ]);
  }
  source.assignments = source.plan.assignments.map((assignment) =>
    assignmentStateSchema.parse(input.assignments.find((row) => row.key === assignment.key)),
  );
  return source;
}
