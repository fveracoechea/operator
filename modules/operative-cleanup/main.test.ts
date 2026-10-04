import { afterEach, expect, test } from "bun:test";
// Bun has no temporary folder API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperativeCleanup } from "./main.ts";

const folders: string[] = [];

afterEach(async () => {
  await Promise.all(folders.splice(0).map((one) => rm(one, { recursive: true, force: true })));
});

/**
 * Runs one call with a Git on the path that fails one subcommand. `term` ends it on SIGTERM, as
 * a timeout does, and `exit` ends it with exit 3. Each one writes `stderr` first.
 */
async function withFailingGit<Value>(
  folder: string,
  fault: { subcommand: string; end: "term" | "exit"; stderr: string },
  run: () => Promise<Value>,
): Promise<Value> {
  const real = Bun.which("git");
  const bin = `${folder}/failing-git`;
  await Bun.write(
    `${bin}/git`,
    [
      "#!/bin/sh",
      // The guard of ADR 0018 and `-C <repo>` come before the subcommand.
      `if [ "$6" = "${fault.subcommand}" ]; then`,
      `  printf '%s' '${fault.stderr}' >&2`,
      fault.end === "term" ? "  kill -TERM $$" : "  exit 3",
      "fi",
      `exec ${real} "$@"`,
      "",
    ].join("\n"),
  );
  await Bun.$`chmod +x ${bin}/git`.quiet();
  const inherited = process.env.PATH ?? "";
  process.env.PATH = `${bin}:${inherited}`;
  try {
    return await run();
  } finally {
    process.env.PATH = inherited;
  }
}

test("a checkout whose head Git cannot read before a timeout reads as absent, as before", async () => {
  const root = await mkdtemp(join(tmpdir(), "operator-cleanup-"));
  folders.push(root);
  const worktree = join(root, "operative");
  await Bun.write(join(worktree, "README.md"), "# Project\n");
  await Bun.$`git -C ${worktree} init -q -b main`.quiet();
  await Bun.$`git -C ${worktree} add -A`.quiet();
  await Bun.$`git -C ${worktree} -c user.email=t@example.com -c user.name=Test commit -q -m seed`.quiet();

  const inspected = await withFailingGit(
    root,
    { subcommand: "rev-parse", end: "term", stderr: "stuck" },
    () => OperativeCleanup.inspect({ worktreePath: worktree, allowedPrefixes: [] }),
  );

  expect(inspected).toMatchObject({ present: false, head: null, branch: null });
});
