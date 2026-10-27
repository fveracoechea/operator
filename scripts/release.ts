#!/usr/bin/env bun
/**
 * Release tooling. It is not part of the user-facing CLI. The release workflow runs `publish`
 * after a version pull request merges and the commit passed its checks. See ADR 0007.
 *
 *   SOURCE_DATE_EPOCH=<commit time> bun scripts/release.ts build --out <dir> --commit <sha>
 *   bun scripts/release.ts launcher --root <dir> --bun <path>
 *   bun scripts/release.ts plan    --out <dir> --commit <sha> [--base main]
 *   bun scripts/release.ts publish --out <dir> --commit <sha> [--base main]
 */

import { GlobalLauncher } from "../modules/global-launcher/main.ts";
import { OperatorRelease } from "../modules/operator-release/main.ts";
import { ReleasePublish } from "../modules/release-publish/main.ts";
import { Environment } from "../modules/environment/main.ts";

const sourceRoot = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

// The official `jsr` client is pinned in the development dependencies, so the publication runs
// that exact version and never one this machine happens to have installed.
// Re-enter with a child-only PATH. The parent process environment is never changed.
const environment = Environment.read();
const clientPath = `${sourceRoot}/node_modules/.bin`;
if (!environment.PATH.split(":").includes(clientPath)) {
  const child = Bun.spawn([process.execPath, import.meta.path, ...Bun.argv.slice(2)], {
    env: Environment.child({ PATH: `${clientPath}:${environment.PATH}` }),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await child.exited);
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  const value = index === -1 ? undefined : args[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function fail(message: string): never {
  console.error(`release: ${message}`);
  process.exit(2);
}

function report(result: Record<string, unknown>): void {
  console.log(JSON.stringify(result, null, 2));
}

const [command, ...args] = Bun.argv.slice(2);
const artifactRoot = flag(args, "out") ?? `${sourceRoot}/dist`;
const journalPath = flag(args, "journal") ?? `${artifactRoot}.publication.json`;
const base = flag(args, "base") ?? "main";

if (command === "build") {
  // A release names one full commit, the same as a source install. A short, dirty, or unknown
  // revision cannot pass as a release.
  const commit = flag(args, "commit");
  if (commit === undefined || !/^[0-9a-f]{40}$/.test(commit)) {
    fail("build needs the full 40-character --commit it is built from, from a clean checkout");
  }

  // Every delivery path builds the same release.json from the same commit, so the build time is
  // the commit time and never the clock of the machine that builds it.
  const epoch = environment.SOURCE_DATE_EPOCH;
  const builtAt =
    epoch !== undefined && /^\d+$/.test(epoch) ? new Date(Number(epoch) * 1000) : null;
  if (builtAt === null || Number.isNaN(builtAt.getTime())) {
    fail(
      "build needs SOURCE_DATE_EPOCH, the commit time in seconds, for example $(git log -1 --format=%ct)",
    );
  }

  const now = builtAt.toISOString();
  const built = await OperatorRelease.build({ sourceRoot, artifactRoot, commit, now });
  if (built.status !== "built") {
    console.error(`release: the declarations could not be written:\n${built.detail}`);
    process.exit(1);
  }

  const inspection = await OperatorRelease.inspect({ artifactRoot });
  if (inspection.status === "incomplete") {
    console.error(`release: the artifact is missing ${inspection.missing.join(", ")}`);
    process.exit(1);
  }

  report({ ...built, required: inspection.required });
} else if (command === "launcher") {
  // The Nix package writes its command from the same rules that readiness reads it with.
  const installRoot = flag(args, "root");
  const bun = flag(args, "bun");
  if (installRoot?.startsWith("/") !== true || bun?.startsWith("/") !== true) {
    fail(
      "launcher needs the absolute --root that holds node_modules and the absolute --bun it runs",
    );
  }

  process.stdout.write(GlobalLauncher.nixText({ installRoot, bun }));
} else if (command === "plan" || command === "publish") {
  const commit = flag(args, "commit");
  if (commit === undefined) {
    fail(`${command} needs the --commit it acts on`);
  }

  if (command === "plan") {
    const plan = await ReleasePublish.plan({ artifactRoot, commit, base, journalPath });
    report(plan);
    process.exit(plan.blockers.length === 0 ? 0 : 3);
  }

  const result = await ReleasePublish.publish({ artifactRoot, commit, base, journalPath });
  report(result);
  // A partial publication is not a failure to repair by hand. It is retried from the same
  // commit, and only the missing path is sent again.
  const exitCode = { published: 0, released: 0, partial: 6, blocked: 3 } as const;
  process.exit(exitCode[result.status]);
} else {
  fail("the operations are `build`, `launcher`, `plan`, and `publish`");
}
