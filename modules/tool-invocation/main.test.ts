import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { ToolInvocation } from "./main.ts";

const root = `${Bun.env.TMPDIR ?? "/tmp"}/operator-tool-invocation-${crypto.randomUUID()}`;
const repo = `${root}/repo`;
const log = `${root}/git.log`;
const inheritedPath = process.env.PATH ?? "";

// Git runs through a wrapper that logs each call, so a test reads every option a call used. When
// the fault file names `<subcommand>:term` or `<subcommand>:exit`, the wrapper ends that one call
// on SIGTERM, as a timeout does, or with exit 3, after it writes the text of the stderr file. A
// file carries the fault, because a child does not see a change to process.env.
beforeAll(async () => {
  const realGit = Bun.which("git");
  await Bun.$`mkdir -p ${root}/bin ${repo}`.quiet();
  await Bun.write(
    `${root}/bin/git`,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${log}`,
      // The guard and `-C <repo>` come before the subcommand.
      `fault=$(cat ${root}/fault 2>/dev/null)`,
      'if [ -n "$fault" ] && [ "$6" = "${fault%%:*}" ]; then',
      `  cat ${root}/stderr >&2`,
      '  case "$fault" in *:term) kill -TERM $$ ;; *) exit 3 ;; esac',
      "fi",
      `exec ${realGit} "$@"`,
      "",
    ].join("\n"),
  );
  await Bun.$`chmod +x ${root}/bin/git`.quiet();
  await Bun.$`git init -q -b main ${repo}`.quiet();
  await Bun.write(`${repo}/data.bin`, new Uint8Array([0xff, 0x00, 0xfe, 0x0a]));
  await Bun.$`git -C ${repo} add -A`.quiet();
  await Bun.$`git -C ${repo} -c user.email=t@example.com -c user.name=Test commit -q -m first`.quiet();
  process.env.PATH = `${root}/bin:${inheritedPath}`;
});

/** Runs one call while the wrapper fails one subcommand. */
async function withFault<Value>(fault: string, stderr: string, run: () => Promise<Value>) {
  await Bun.write(`${root}/fault`, fault);
  await Bun.write(`${root}/stderr`, stderr);
  try {
    return await run();
  } finally {
    await rm(`${root}/fault`, { force: true });
  }
}

afterAll(async () => {
  process.env.PATH = inheritedPath;
  await rm(root, { force: true, recursive: true });
});

describe("ToolInvocation.git", () => {
  test("runs every call with the file system monitor off and no optional lock (ADR 0018)", async () => {
    await rm(log, { force: true });
    await ToolInvocation.git({ repoRoot: repo, args: ["rev-parse", "HEAD"] });
    await ToolInvocation.git({ repoRoot: repo, args: ["no-such-command"] });

    const calls = (await Bun.file(log).text()).trim().split("\n");
    expect(calls).toEqual([
      `--no-optional-locks -c core.fsmonitor=false -C ${repo} rev-parse HEAD`,
      `--no-optional-locks -c core.fsmonitor=false -C ${repo} no-such-command`,
    ]);
  });

  test("reads the output trimmed, or byte for byte when raw", async () => {
    const trimmed = await ToolInvocation.git({
      repoRoot: repo,
      args: ["log", "-1", "--format=%s"],
    });
    const raw = await ToolInvocation.git({
      repoRoot: repo,
      args: ["log", "-1", "--format=%s"],
      raw: true,
    });

    expect(trimmed).toMatchObject({ status: "read", value: "first", exitCode: 0 });
    expect(raw).toMatchObject({ status: "read", value: "first\n" });
  });

  test("keeps the exact bytes of a committed file", async () => {
    const read = await ToolInvocation.git({
      repoRoot: repo,
      args: ["cat-file", "blob", "HEAD:data.bin"],
    });

    expect(read.status === "read" ? [...read.bytes] : null).toEqual([0xff, 0x00, 0xfe, 0x0a]);
  });

  test("reads an exit that is no answer as unread, with the exit and the error text", async () => {
    const read = await ToolInvocation.git({
      repoRoot: repo,
      args: ["merge-base", "--is-ancestor", "HEAD", "nope"],
    });

    expect(read.status).toBe("unread");
    expect(read.status === "unread" ? read.detail : "").toStartWith("git merge-base exited 128: ");
    expect(Object.keys(read)).toEqual(["status", "detail"]);
  });

  test("reads an exit that the caller names as an answer, with its exit code", async () => {
    const empty = await ToolInvocation.git({
      repoRoot: repo,
      args: ["config", "--get-regexp", "^remote\\..*\\.url$"],
      answers: [0, 1],
    });
    const any = await ToolInvocation.git({
      repoRoot: repo,
      args: ["rev-parse", "--verify", "--quiet", "refs/heads/absent"],
      answers: "any",
    });

    expect(empty).toMatchObject({ status: "read", value: "", exitCode: 1 });
    expect(any).toMatchObject({ status: "read", exitCode: 1 });
  });

  test("gives the caller a structured failure to word, for a timeout and for an exit", async () => {
    const failures: unknown[] = [];
    const failed = (failure: unknown) => {
      failures.push(failure);
      return "worded";
    };
    const timedOut = await withFault("status:term", "stuck", () =>
      ToolInvocation.git({ repoRoot: repo, args: ["status"], failed }),
    );
    const exited = await withFault("status:exit", "boom", () =>
      ToolInvocation.git({ repoRoot: repo, args: ["status"], failed }),
    );

    expect([timedOut, exited]).toEqual([
      { status: "unread", detail: "worded" },
      { status: "unread", detail: "worded" },
    ]);
    expect(failures).toEqual([
      { kind: "no-answer", args: ["status"], signal: "SIGTERM", exitCode: 143, stderr: "stuck" },
      { kind: "exit", args: ["status"], exitCode: 3, stderr: "boom" },
    ]);
  });

  test("words a timeout and an exit as every Git call that started with -C did", async () => {
    const timedOut = await withFault("status:term", "stuck", () =>
      ToolInvocation.git({ repoRoot: repo, args: ["status"] }),
    );
    const exited = await withFault("status:exit", "boom\n", () =>
      ToolInvocation.git({ repoRoot: repo, args: ["status"] }),
    );

    expect(timedOut).toEqual({
      status: "unread",
      detail: "git -C ended on SIGTERM with no answer.",
    });
    expect(exited).toEqual({ status: "unread", detail: "git status exited 3: boom" });
  });

  test("names a Git that is not on the path, and requests nothing", async () => {
    process.env.PATH = `${root}/empty`;
    try {
      const read = await ToolInvocation.git({ repoRoot: repo, args: ["status"] });
      expect(read).toEqual({
        status: "unread",
        detail: "git is not on the path, so nothing was requested.",
      });
    } finally {
      process.env.PATH = `${root}/bin:${inheritedPath}`;
    }
  });
});
