import { Environment } from "../modules/environment/main.ts";
import { descendants } from "./process-tree.ts";

// bun test has no whole-run deadline. A deadlocked --parallel worker (oven-sh/bun#39987) keeps
// the run silent forever, and per-test timeouts cannot fire in a blocked worker. The dots
// reporter writes one byte per test. Module load and hooks with their own timeouts also count
// toward silence, so the default stays far above the slowest file in test-timings.json.
const flags = ["--isolate", "--parallel=4", "--timeout=30000", "--timings=test-timings.json"];
const silenceFlag = "--watchdog-silence=";
const args = process.argv.slice(2);
const silenceSeconds = Number(
  args.find((arg) => arg.startsWith(silenceFlag))?.slice(silenceFlag.length) ?? 120,
);
if (!Number.isInteger(silenceSeconds) || silenceSeconds < 1) {
  console.error(`test-watchdog: ${silenceFlag}<seconds> must be a positive integer.`);
  process.exit(2);
}

const started = Date.now();
let progressAt = started;
const child = Bun.spawn(
  [
    process.execPath,
    "test",
    ...flags,
    "--dots",
    // Stryker disable next-line MethodExpression: no rule: bun test ignores an unknown flag, so a passed-through silence flag changes no result
    ...args.filter((arg) => !arg.startsWith(silenceFlag)),
  ],
  {
    // Stryker disable next-line StringLiteral: equivalent: Bun forces color when FORCE_COLOR is set, even to an empty value
    env: Environment.child({ FORCE_COLOR: process.stdout.isTTY ? "1" : undefined }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  },
);

async function relay(stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream) {
  for await (const chunk of stream) {
    progressAt = Date.now();
    sink.write(chunk);
  }
}

/** Only processes under this run's own child, so a concurrent run in another worktree is never touched. */
function tree(root: number) {
  return descendants(root, Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid="]).stdout.toString());
}

function report(pids: number[]) {
  const list = pids.join(",");
  const processes = Bun.spawnSync(["ps", "-o", "pid,ppid,stat,%cpu,etime,command", "-p", list]);
  // lsof exits 1 when one listed process already exited, so its output counts and its status does not.
  const resources = Bun.which("lsof")
    ? Bun.spawnSync(["lsof", "-nP", "-p", list])
        .stdout.toString()
        .split("\n")
        .filter((line) => / (cwd|IPv4|IPv6|unix|FIFO|PIPE) /.test(line))
        .join("\n")
    : "lsof is not available.";
  const now = Date.now();
  console.error(
    [
      // Stryker disable next-line StringLiteral: no rule: the blank line only separates the report from the dots
      "",
      `test-watchdog: no test progress for ${Math.round((now - progressAt) / 1000)}s after ${Math.round((now - started) / 1000)}s. Stopping bun test.`,
      "test-watchdog: a silent worker at 0% CPU matches the open Bun worker deadlock oven-sh/bun#39987.",
      "test-watchdog: processes of this run:",
      processes.stdout.toString().trimEnd(),
      "test-watchdog: working directories, sockets, and pipes of this run:",
      resources,
    ].join("\n"),
  );
}

let stalled = false;
const signalNumbers = { SIGINT: 2, SIGTERM: 15 } as const;
let received: keyof typeof signalNumbers | undefined;
function stop() {
  for (const pid of tree(child.pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process already exited.
    }
  }
}
const watchdog = setInterval(() => {
  // Stryker disable next-line EqualityOperator: equivalent: the check runs once a second on a millisecond clock, so no run lands on the exact limit
  if (Date.now() - progressAt < silenceSeconds * 1000) return;
  stalled = true;
  // Stryker disable next-line CallExpression: equivalent: stop kills the child, and the process exits before the next one-second check
  clearInterval(watchdog);
  report(tree(child.pid));
  stop();
}, 1000);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    received = signal;
    stop();
  });

await Promise.all([relay(child.stdout, process.stdout), relay(child.stderr, process.stderr)]);
const code = await child.exited;
// A caller sees the signal it sent, not the SIGKILL that cleaned up the run.
const finished = received ? 128 + signalNumbers[received] : code;
process.exit(stalled ? 124 : finished);
