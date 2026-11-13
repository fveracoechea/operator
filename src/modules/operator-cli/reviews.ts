import type { Result } from "unthrown";
import { ReviewRequests } from "../review-requests/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { respond } from "./output.ts";

const reviewCommands = ["add", "start", "post", "skip", "cleanup", "next", "wait"] as const;
const deviceCommands: readonly string[] = ["next", "wait"];
const valueFlags = new Map([
  ["--profile", { commands: ["start"], valid: (value: string) => !value.startsWith("--") }],
  ["--timeout", { commands: ["wait"], valid: (value: string) => /^\d{1,5}$/.test(value) }],
  [
    "--slack-thread",
    {
      commands: ["add"],
      valid: (value: string) =>
        /^https:\/\/[a-z\d-]+\.slack\.com\/archives\/[A-Z\d]+\/p\d+(?:\?[^\s]*)?$/.test(value),
    },
  ],
]);

// `--all` makes a wait return every request rather than only the changed ones and the actions.
const switchFlags = new Map([
  ["--json", null],
  ["--all", ["wait"]],
]);

function acceptsSwitch(command: string, flag: string, switches: Set<string>) {
  const commands = switchFlags.get(flag);
  return (
    commands !== undefined &&
    !switches.has(flag) &&
    (commands === null || commands.includes(command))
  );
}

function acceptsValue(
  command: string,
  flag: string,
  value: string | undefined,
  values: Map<string, string>,
): value is string {
  const rule = valueFlags.get(flag);
  return (
    rule !== undefined &&
    rule.commands.includes(command) &&
    !values.has(flag) &&
    value !== undefined &&
    rule.valid(value)
  );
}

function reviewFlags(command: string, flags: string[]) {
  const switches = new Set<string>();
  const values = new Map<string, string>();
  const rest = flags.values();
  for (const flag of rest) {
    if (acceptsSwitch(command, flag, switches)) {
      switches.add(flag);
      continue;
    }
    const value = rest.next().value;
    if (!acceptsValue(command, flag, value, values)) return null;
    values.set(flag, value);
  }
  const timeout = values.get("--timeout");
  return {
    profile: values.get("--profile"),
    timeout: timeout === undefined ? undefined : Number(timeout),
    slackThread: values.get("--slack-thread"),
    all: switches.has("--all"),
  };
}

/** A PR URL is the only request selector, so every review command runs from any folder. */
export function reviewArgs(args: string[]) {
  const [group, name, ...rest] = args;
  const command = reviewCommands.find((known) => known === name);
  if (group !== "review" || command === undefined) return null;
  const url = deviceCommands.includes(command) ? "" : (rest.shift() ?? "");
  if (!deviceCommands.includes(command) && (url === "" || url.startsWith("--"))) return null;
  const flags = reviewFlags(command, rest);
  return flags === null
    ? null
    : {
        command,
        url,
        profile: flags.profile,
        timeout: flags.timeout ?? 300,
        slackThread: flags.slackThread,
        all: flags.all,
      };
}

const reviewExitCodes = {
  review_url_invalid: 2,
  review_author_excluded: 2,
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
  review_reviewer_moving: 4,
  review_request_open: 4,
  review_cleanup_in_progress: 4,
  reviewer_work_kept: 4,
  review_lease_lost: 4,
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
  const operation = `review_${parsed.command.replace("-", "_")}`;
  const input = { paths, url: parsed.url };
  const operations: Record<
    (typeof reviewCommands)[number],
    () => PromiseLike<Result<{ reason: string; data: unknown }, { reason: string; detail: string }>>
  > = {
    add: () => ReviewRequests.add({ ...input, slackThread: parsed.slackThread }),
    start: () => ReviewRequests.start({ ...input, profile: parsed.profile }),
    post: () => ReviewRequests.post(input),
    skip: () => ReviewRequests.skip(input),
    cleanup: () => ReviewRequests.cleanup(input),
    wait: () =>
      ReviewRequests.wait({
        paths,
        timeoutSeconds: parsed.timeout,
        all: parsed.all,
      }),
    next: () => ReviewRequests.next(paths),
  };
  const result = await operations[parsed.command]();
  respond({ operation, result, exitCodes: reviewExitCodes, defect: "review_defect", json });
  return true;
}
