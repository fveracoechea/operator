import { OkAsync } from "unthrown";
import { Environment } from "../environment/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { WorkSources } from "../work-sources/main.ts";

function block(sources: string[]) {
  return JSON.stringify({
    decision: "block",
    reason: `This pane supervises running work in ${sources.join(", ")}, and no coordination wait runs from it. Start operator next --wait --json as a background command from the project checkout, so worker events reach you as a new turn, then end your turn.`,
  });
}

/**
 * The turn-end guard of a SuperAgent's pane. It blocks the end of a turn while the pane's sources
 * have running work and no wait from that pane covers them. It blocks at most once in a row, so
 * a SuperAgent that the person told to stop can still stop. State that is missing, blocked, or
 * unreadable allows the stop, because the guard is only a nudge.
 */
export function turnEnd(input: {
  paths: ReturnType<typeof OperatorHome.resolve>;
  cwd: string;
  stop_hook_active: boolean;
}) {
  const paneId = Environment.read().HERDR_PANE_ID;
  if (input.stop_hook_active || paneId === undefined) return OkAsync("");
  const unwatched = WorkSources.unwatched({ paths: input.paths, cwd: input.cwd, paneId });
  if (unwatched.tag === "Err") return OkAsync("");
  return unwatched.map((sources) => (sources.length > 0 ? block(sources) : "")).toAsync();
}
