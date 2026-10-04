import type { CrewState } from "../crew-state/main.ts";

type Status = Awaited<ReturnType<typeof CrewState.publishStatus>>["result"];
type Finish = Extract<Status, { status: "observed" }>["finish"];

/** The one line that says whether a source is finished and what became of its gate checkout. */
export function finishLine(finish: Finish): string {
  if (finish.status === "not-finished") {
    return `The source is not finished: ${finish.detail}`;
  }
  return finish.gateCheckout === "kept"
    ? `The source is finished. Its gate checkout stays: ${finish.detail ?? "Herdr did not remove it."}`
    : "The source is finished, and its gate checkout is removed. Every branch stays.";
}
