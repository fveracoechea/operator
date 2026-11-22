import { CommitDelivery } from "../commit-delivery/main.ts";
import { PullRequests } from "../pull-requests/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { readTextInput } from "../../lib/read-text-input.ts";
import { fromPromise } from "unthrown";
import { respond } from "./output.ts";

export async function runCommitDelivery(
  args: string[],
  paths: ReturnType<typeof OperatorHome.resolve>,
  json: boolean,
) {
  if (args[0] !== "commit") return false;
  const flags = args.filter((flag) => flag !== "--json");
  const command = flags[1];
  if (command === "review" && flags.length === 2) {
    const result = await CommitDelivery.review({ paths, cwd: process.cwd() })
      .flatMap((target) => PullRequests.startKindHandoff(paths, target))
      .map((handoff) => ({ reason: "commit_review_started", data: { handoff } }));
    respond({ operation: "commit_review", result, exitCodes: {}, defect: "commit_defect", json });
    return true;
  }
  if ((command !== "round" && command !== "deliver") || flags.length !== 4 || flags[2] !== "--file")
    return false;
  const result = await fromPromise(
    () => readTextInput(flags[3] ?? ""),
    (cause) => ({
      reason: "commit_input_invalid",
      detail: String(cause),
      next: { command: "operator --help", why: "Supply a readable markdown file." },
    }),
  )
    .flatMap((text) =>
      command === "round"
        ? CommitDelivery.round({ paths, cwd: process.cwd(), text })
        : CommitDelivery.deliver({ paths, cwd: process.cwd(), text }),
    )
    .map((data) => ({
      reason: command === "round" ? "commit_round_recorded" : "commit_delivered",
      data,
    }));
  respond({ operation: `commit_${command}`, result, exitCodes: {}, defect: "commit_defect", json });
  return true;
}
