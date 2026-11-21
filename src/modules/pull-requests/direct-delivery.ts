import { Err, Ok, fromPromise, type AsyncResult, type Result } from "unthrown";
import { DeviceState } from "../device-state/main.ts";
import type { Refusal } from "../../lib/cli-result.ts";
import { qualify, type Owner, type Paths } from "./owner.ts";
import {
  mergePullRequest,
  observePullRequest,
  readMergeRequest,
  type Observation,
  type MergeRequest,
} from "./github.ts";
import { followMergeRequest, mergeRequestReadMs, verifiedMerge } from "./merge-machine.ts";

type Delivery = NonNullable<
  Extract<ReturnType<typeof DeviceState.readDelivery>, { tag: "Ok" }>["value"]
>;
type Merged = { head: string; mergeCommit: string };
type Input = {
  paths: Paths;
  owner: Owner;
  number: number;
  delivery: Delivery;
  method?: Observation["mergeMethod"];
};
type Answer = Result<MergeRequest, Refusal> | null;
type Followed = { answer: Answer; terminal: boolean; refusal: Refusal | null };

function uncertain(): Refusal {
  return {
    reason: "pr_merge_unverified",
    detail:
      "The durable direct request remains unresolved. No new request was submitted. An OPEN PR or a lost answer does not prove non-application.",
    next: {
      command: "operator pr merge",
      why: "Read the original request and verify its exact-head outcome. Do not resubmit an unknown request.",
    },
  };
}

async function begin(input: Input): Promise<Answer> {
  const { owner, number, delivery } = input;
  if (input.method !== undefined)
    return mergePullRequest(owner.repository, {
      number,
      head: delivery.head,
      method: input.method,
    });
  return delivery.requestUuid === null
    ? null
    : readMergeRequest(owner.repository, number, delivery.requestUuid);
}

function follow(input: Input, initial: Answer): AsyncResult<Followed, Refusal> {
  return fromPromise(async () => {
    const { paths, owner, number, delivery } = input;
    let answer = initial;
    for (let reads = 0; answer?.tag === "Ok"; reads += 1) {
      if (answer.value.uuid !== null) {
        const saved = DeviceState.changeDelivery(paths, delivery.id, { uuid: answer.value.uuid });
        if (saved.tag !== "Ok") return saved.flatMap<Followed, Refusal>(() => Err(uncertain()));
      }
      const step = followMergeRequest(answer.value, reads);
      if (step.result === "verify")
        return Ok({ answer, terminal: answer.value.status === "failed", refusal: step.refusal });
      await Bun.sleep(mergeRequestReadMs);
      const renewed = DeviceState.changeDelivery(paths, delivery.id, {});
      if (renewed.tag !== "Ok") return renewed.flatMap<Followed, Refusal>(() => Err(uncertain()));
      answer = await readMergeRequest(owner.repository, number, step.uuid);
    }
    return Ok({ answer, terminal: false, refusal: null });
  }, qualify).flatMap<Followed, Refusal>((result) => result);
}

function verify(input: Input, state: Followed): AsyncResult<Merged, Refusal> {
  return fromPromise(async () => {
    const { paths, owner, number, delivery } = input;
    const observed = await observePullRequest(owner.repository, number);
    const merged = observed.tag === "Ok" ? verifiedMerge(observed.value, delivery.head) : null;
    const released = DeviceState.changeDelivery(
      paths,
      delivery.id,
      merged !== null || state.terminal ? { finish: true } : { suspend: true },
    );
    const primary =
      state.answer !== null && state.answer.tag !== "Ok"
        ? state.answer
        : observed.tag !== "Ok"
          ? observed
          : null;
    if (merged !== null && primary?.tag !== "Defect") return released.map(() => merged);
    if (primary !== null) {
      if (observed.tag !== "Ok" && primary !== observed)
        console.error("delivery_verification", { secondary: observed });
      if (released.tag !== "Ok") console.error("delivery_release", { secondary: released });
      // Keep the original Err or Defect rather than replacing it with a readback failure.
      return primary.flatMap<Merged, Refusal>(() => Err(uncertain()));
    }
    return released.flatMap(() => Err(state.refusal ?? uncertain()));
  }, qualify).flatMap<Merged, Refusal>((result) => result);
}

/** The persisted intent precedes submission. Recovery reads only that original request. */
export function directDelivery(input: Input): AsyncResult<Merged, Refusal> {
  return fromPromise(() => begin(input), qualify)
    .flatMap((answer) => follow(input, answer))
    .flatMap((state) => verify(input, state));
}
