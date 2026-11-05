import { OkAsync, fromPromise } from "unthrown";
import type { OperatorHome } from "../operator-home/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { commitHasTrailer } from "./commit.ts";

/**
 * The decisions that Operator's agent host hooks share. Each host adapter reads its own event,
 * asks here, and writes the answer in its own format. A null reason has no opinion.
 */
export const AgentGuards = {
  /** The reason to refuse a shell command whose git commit carries a Co-Authored-By trailer. */
  commit(input: { command: string; cwd: string }) {
    return fromPromise(
      async () =>
        (await commitHasTrailer(input.command, input.cwd))
          ? "Commit messages carry no Co-Authored-By trailer. Remove every Co-Authored-By line from the message, then commit again."
          : null,
      // Stryker disable next-line ArrowFunction: equivalent: commitHasTrailer reads a message file with a fallback, so it never rejects
      (cause, defect) => defect(cause),
    );
  },
  /**
   * The reason to keep a SuperAgent's turn going in a Herdr pane. It answers a reason while the
   * pane's sources have running work and no wait from that pane covers them. The host bounds how
   * often it acts on a reason, so a SuperAgent that the person told to stop can still stop.
   * State that is missing, blocked, or unreadable lets the turn end, because the guard is a nudge.
   */
  turnEnd(input: { paths: ReturnType<typeof OperatorHome.resolve>; cwd: string; paneId: string }) {
    const unwatched = WorkSources.unwatched(input);
    if (unwatched.tag === "Err") return OkAsync(null);
    return unwatched
      .map((sources) =>
        sources.length > 0
          ? `This pane supervises running work in ${sources.join(", ")}, and no coordination wait runs from it. Start operator next --wait --json as a background command from the project checkout. Worker events then reach you as a new turn, so end your turn after you start it.`
          : null,
      )
      .toAsync();
  },
};
