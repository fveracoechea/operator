#!/usr/bin/env bun
/**
 * Release tooling. It is not part of the user-facing CLI. The release workflow runs `publish`
 * after a version pull request merges and the commit passed its checks. See ADR 0013.
 *
 *   bun scripts/release.ts build   --out <dir> --commit <sha>
 *   bun scripts/release.ts plan    --out <dir> --commit <sha> [--base main]
 *   bun scripts/release.ts publish --out <dir> --commit <sha> [--base main]
 */

import { OperatorRelease } from "../modules/operator-release/main.ts";
import { ReleasePublish } from "../modules/release-publish/main.ts";

const sourceRoot = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

// The official `jsr` client is pinned in the development dependencies, so the publication runs
// that exact version and never one this machine happens to have installed.
process.env.PATH = `${sourceRoot}/node_modules/.bin:${process.env.PATH ?? ""}`;

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  const value = index === -1 ? undefined : args[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function fail(message: string): never {
  console.error(`release: ${message}`);
  process.exit(2);
}

function report(result: unknown): void {
  console.log(JSON.stringify(result, null, 2));
}

const [command, ...args] = Bun.argv.slice(2);
const artifactRoot = flag(args, "out") ?? `${sourceRoot}/dist`;
const journalPath = flag(args, "journal") ?? `${artifactRoot}.publication.json`;
const base = flag(args, "base") ?? "main";

if (command === "build") {
  const commit = flag(args, "commit");
  if (commit === undefined) {
    fail("build needs the --commit it is built from");
  }

  const built = await OperatorRelease.build({ sourceRoot, artifactRoot, commit });
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
  fail("the operations are `build`, `plan`, and `publish`");
}
