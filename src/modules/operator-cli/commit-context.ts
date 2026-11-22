import { DeviceState } from "../device-state/main.ts";
import type { WorkerKinds } from "../worker-kinds/main.ts";

type Facts = Parameters<typeof WorkerKinds.decidePhase>[0];
type Event = NonNullable<Parameters<typeof WorkerKinds.decidePhase>[1]>;
type Source = Extract<ReturnType<typeof DeviceState.readSources>, { tag: "Ok" }>["value"][number];

export function commitEvent(args: string[]): Event | undefined {
  if (args[0] !== "commit") return undefined;
  if (args[1] === "review") return "commit-review";
  if (args[1] === "round") return "commit-round";
  if (args[1] === "deliver") return "commit-deliver";
  return undefined;
}

export function commitPhase(
  source: Pick<Source, "commitDeliveries">,
  key: string,
): Facts["commit"] {
  const row = source.commitDeliveries?.find((item) => item.assignment === key);
  if (row === undefined) return undefined;
  const data = DeviceState.commitDeliverySchema().parse(JSON.parse(row.data));
  return {
    reviewing: data.implementer !== null,
    rounds: data.rounds.length,
    delivered: data.stage === "complete",
  };
}

export function worktreeEvent(event: Event | undefined) {
  return (
    event !== undefined && event !== "submit" && event !== "resume" && !event.startsWith("commit-")
  );
}
