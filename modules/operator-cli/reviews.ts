import { Err, fromPromise, type Result } from "unthrown";
import { ReviewRequests } from "../review-requests/main.ts";
import type { OperatorHome } from "../operator-home/main.ts";
import { respond } from "./output.ts";

const reviewCommands = [
  "add",
  "start",
  "post",
  "skip",
  "cleanup",
  "slack-done",
  "next",
  "wait",
  "ingest",
] as const;
const deviceCommands: readonly string[] = ["next", "wait", "ingest"];
// `ingest` and `slack-done` read the raw result of a Slack MCP tool from a file, or `-` for stdin.
const inputCommands = ["ingest", "slack-done"];
const valueFlags = new Map([
  ["--profile", { commands: ["start"], valid: (value: string) => !value.startsWith("--") }],
  ["--timeout", { commands: ["wait"], valid: (value: string) => /^\d{1,5}$/.test(value) }],
  [
    "--input",
    { commands: inputCommands, valid: (value: string) => value !== "" && !value.startsWith("--") },
  ],
]);

// `--slack` makes a wait the Slack transport loop of the slack-pr-review-workflow skill.
const switchFlags = new Map([
  ["--json", null],
  ["--slack", ["wait"]],
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
  if (inputCommands.includes(command) && !values.has("--input")) return null;
  const timeout = values.get("--timeout");
  return {
    profile: values.get("--profile"),
    timeout: timeout === undefined ? undefined : Number(timeout),
    input: values.get("--input"),
    slack: switches.has("--slack"),
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
        input: flags.input ?? "",
        slack: flags.slack,
      };
}

const reviewExitCodes = {
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
  review_reviewer_moving: 4,
  review_request_open: 4,
  review_cleanup_in_progress: 4,
  reviewer_work_kept: 4,
  review_lease_lost: 4,
  slack_cursor_moved: 4,
  slack_effect_failed: 1,
  slack_input_unreadable: 1,
  review_io_failed: 1,
  review_post_failed: 1,
  review_fetch_failed: 1,
  launch_failed: 1,
  github_failed: 1,
  github_uncertain: 1,
  github_invalid_response: 1,
};

/** The raw tool result, from a file or from stdin. An absent or unreadable file is a refusal. */
async function readInput(input: string) {
  const file = Bun.file(input);
  if (input !== "-" && !(await file.exists()))
    return Err({
      reason: "slack_input_missing",
      detail: `The input file ${input} does not exist. Nothing was recorded.`,
    });
  return fromPromise(
    () => (input === "-" ? Bun.stdin.text() : file.text()),
    (cause, defect) =>
      cause instanceof Error
        ? {
            reason: "slack_input_unreadable",
            detail: `The input ${input} could not be read: ${cause.message} Nothing was recorded.`,
          }
        : defect(cause),
  );
}

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
    add: () => ReviewRequests.add(input),
    start: () => ReviewRequests.start({ ...input, profile: parsed.profile }),
    post: () => ReviewRequests.post(input),
    skip: () => ReviewRequests.skip(input),
    cleanup: () => ReviewRequests.cleanup(input),
    wait: () => ReviewRequests.wait({ paths, timeoutSeconds: parsed.timeout, slack: parsed.slack }),
    next: () => ReviewRequests.next(paths),
    ingest: async () =>
      (await readInput(parsed.input))
        .toAsync()
        .flatMap((text) => ReviewRequests.ingest({ paths, text })),
    "slack-done": async () =>
      (await readInput(parsed.input))
        .toAsync()
        .flatMap((text) => ReviewRequests.acknowledge({ paths, id: parsed.url, text })),
  };
  const result = await operations[parsed.command]();
  respond({ operation, result, exitCodes: reviewExitCodes, defect: "review_defect", json });
  return true;
}
