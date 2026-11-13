import { fromPromise, Ok, OkAsync, type AsyncResult, type AsyncErrOf } from "unthrown";
import { Environment } from "../environment/main.ts";
import { Herdr } from "../herdr/main.ts";

type Worker = {
  id: string;
  name: string;
  state: string;
  paneId: string | null;
  herdrSocket: string | null;
};
type Identity = { id: string; name: string; paneId: string; herdrSocket: string; state: string };
type Failure = AsyncErrOf<ReturnType<typeof Herdr.pane>>;

async function observe(workers: Identity[], names: Set<string>) {
  const missing = new Map<string, Identity>();
  for (const worker of workers) {
    const pane = await Herdr.pane(worker.paneId);
    // Stryker disable next-line ArrowFunction: equivalent: a non-Ok result never calls its map callback
    if (pane.tag !== "Ok") return pane.map(() => missing);
    if (pane.value === null && !names.has(worker.name)) missing.set(worker.id, worker);
  }
  return Ok(missing);
}

/** Missing panes count only in their recorded Herdr session, and a moved named agent stays live. */
export function missingWorkers(
  workers: Worker[],
  includeEnded = false,
): AsyncResult<(worker: Worker) => boolean, Failure> {
  const socket = Environment.read().HERDR_SOCKET_PATH;
  const candidates: Identity[] = [];
  for (const worker of workers) {
    if (
      (worker.state !== "running" && (!includeEnded || worker.state === "starting")) ||
      !worker.name ||
      !worker.paneId ||
      !worker.herdrSocket ||
      worker.herdrSocket !== socket
    )
      continue;
    candidates.push({
      id: worker.id,
      name: worker.name,
      paneId: worker.paneId,
      herdrSocket: worker.herdrSocket,
      state: worker.state,
    });
  }
  const observed =
    candidates.length === 0
      ? OkAsync(new Map<string, Identity>())
      : Herdr.agentNames().flatMap((names) =>
          fromPromise(
            () => observe(candidates, new Set(names)),
            (cause, defect) => defect(cause),
          ).flatMap((result) => result),
        );
  return observed.map((byId) => {
    // Reset rechecks these identities under its writer reservation before retiring a launch.
    return (worker: Worker) => {
      const previous = byId.get(worker.id);
      return (
        previous !== undefined &&
        previous.state === worker.state &&
        previous.name === worker.name &&
        previous.paneId === worker.paneId &&
        previous.herdrSocket === worker.herdrSocket
      );
    };
  });
}
