import { ReviewRequests } from "../review-requests/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { failure } from "./output.ts";

function reviewFlags(command: string, flags: string[]) {
  let json = false;
  let profile: string | undefined;
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (flag === "--json" && !json) json = true;
    else if (flag === "--profile" && command === "start" && profile === undefined) {
      profile = flags[++index];
      if (profile === undefined || profile.startsWith("--")) return null;
    } else return null;
  }
  return { profile };
}

/** A PR URL is the only request selector, so every review command runs from any folder. */
export function reviewArgs(args: string[]) {
  const [group, command = "", ...rest] = args;
  if (group !== "review" || !["add", "start", "post", "next"].includes(command)) return null;
  const url = command === "next" ? "" : (rest.shift() ?? "");
  if (command !== "next" && (url === "" || url.startsWith("--"))) return null;
  const flags = reviewFlags(command, rest);
  return flags === null ? null : { command, url, profile: flags.profile };
}

const exitCodes: Record<string, number> = {
  review_url_invalid: 2,
  review_start_in_progress: 4,
  review_post_in_progress: 4,
  review_reviewer_started: 4,
  review_already_posted: 4,
  review_head_moved: 4,
  review_start_interrupted: 4,
  review_post_interrupted: 4,
  review_approval_blocked: 4,
  review_ci_pending: 4,
  review_worktree_changed: 4,
  state_busy: 1,
  state_io_failed: 1,
  review_io_failed: 1,
  review_post_failed: 1,
  review_fetch_failed: 1,
  launch_failed: 1,
  github_failed: 1,
  github_uncertain: 1,
  github_invalid_response: 1,
};

export async function runReviews(
  args: string[],
  paths: ReturnType<typeof OperatorHome.resolve>,
  json: boolean,
) {
  const parsed = reviewArgs(args);
  if (parsed === null) return false;
  const operation = `review_${parsed.command}`;
  const input = { paths, url: parsed.url };
  const result = await (parsed.command === "add"
    ? ReviewRequests.add(input)
    : parsed.command === "start"
      ? ReviewRequests.start({ ...input, profile: parsed.profile })
      : parsed.command === "post"
        ? ReviewRequests.post(input)
        : ReviewRequests.next(paths));
  if (result.tag === "Ok") {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          operation,
          outcome: "completed",
          reason: result.value.reason,
          blockers: [],
          data: result.value.data,
        },
        null,
        json ? undefined : 2,
      ),
    );
    process.exitCode = 0;
  } else if (result.tag === "Err")
    failure(
      operation,
      result.error.reason,
      result.error.detail,
      exitCodes[result.error.reason] ?? 3,
      json,
    );
  else failure(operation, "review_defect", String(result.cause), 1, json);
  return true;
}
