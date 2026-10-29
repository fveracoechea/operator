import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no temporary-directory, chmod, symlink, or recursive removal API.
import { chmod, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Err, Ok } from "unthrown";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { OwnedSkills } from "../owned-skills/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { UpstreamSkills } from "./main.ts";

// Root ignores file modes, so a test of a denied access cannot run as root.
const asRoot = process.getuid?.() === 0;

let root = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "upstream-skills-api-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function paths() {
  return OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
}

test("presence follows independently revised links without an Operator content ledger", async () => {
  const input = paths();
  expect(await UpstreamSkills.check(input, "opencode")).toMatchObject({
    tag: "Ok",
    value: [`${root}/.agents/skills/code-review/SKILL.md`],
  });
  await Bun.write(`${root}/shared/SKILL.md`, "independent upstream revision\n", {
    createPath: true,
  });
  await Bun.write(`${root}/.agents/skills/placeholder`, "", { createPath: true });
  await symlink(`${root}/shared`, `${root}/.agents/skills/code-review`);
  expect(await UpstreamSkills.check(input, "opencode")).toMatchObject({ tag: "Ok", value: [] });
  await Bun.write(`${root}/shared/SKILL.md`, " \n");
  expect(await UpstreamSkills.check(input, "opencode")).toMatchObject({
    tag: "Ok",
    value: [`${root}/.agents/skills/code-review/SKILL.md`],
  });
});

test.each(["no-answer", "failed"] as const)(
  "an installer %s is not silently retried or called complete",
  async (status) => {
    const calls: string[] = [];
    const spy = spyOn(ToolInvocation, "run").mockImplementation(async (input) => {
      calls.push(input.tool);
      if (input.args[0] === "clone") {
        await Bun.write(
          `${input.args.at(-1)}/code-review/SKILL.md`,
          "---\nname: code-review\n---\n",
          { createPath: true },
        );
        return { status: "completed", exitCode: 0, stdout: "", stderr: "" };
      }
      if (input.tool === "git")
        return { status: "completed", exitCode: 0, stdout: "a".repeat(40), stderr: "" };
      return status === "no-answer"
        ? { status: "no-answer", detail: "interrupted" }
        : { status: "completed", exitCode: 1, stdout: "", stderr: "failed" };
    });
    try {
      expect(await UpstreamSkills.install(["opencode"], paths())).toMatchObject({
        tag: "Err",
        error: {
          reason:
            status === "no-answer" ? "upstream_install_unconfirmed" : "upstream_install_failed",
        },
      });
      expect(calls).toEqual(["git", "git", "bun"]);
    } finally {
      spy.mockRestore();
    }
  },
);

test("unexpected programming defects remain defects", async () => {
  const spy = spyOn(ToolInvocation, "run").mockImplementation(() => {
    // oxlint-disable-next-line unthrown/no-throw -- Inject a defect at the public external-tool boundary.
    throw new TypeError("programming defect");
  });
  try {
    const result = await UpstreamSkills.install(["claude-code"], paths());
    expect(result.tag).toBe("Defect");
    if (result.tag === "Defect") expect(result.cause).toBeInstanceOf(TypeError);
  } finally {
    spy.mockRestore();
  }
});

const commit = "0123456789abcdef0123456789abcdef01234567";
const policy =
  "The upstream installer owns replacement and its lock. It can replace local edits without an Operator preview. Inspect a failed or interrupted install before trying again.";
type Answer = Awaited<ReturnType<typeof ToolInvocation.run>>;
function done(stdout: string): Answer {
  return { status: "completed", exitCode: 0, stdout, stderr: "" };
}

// An unfinished answer is refused even when it carries an exit code.
const unfinished = { status: "no-answer" as const, detail: "interrupted", exitCode: 0 };

function upstream(answers: { clone?: Answer; revision?: Answer; installer?: Answer }) {
  const calls: Parameters<typeof ToolInvocation.run>[0][] = [];
  const spy = spyOn(ToolInvocation, "run").mockImplementation(async (input) => {
    calls.push(input);
    if (input.args[0] === "clone") {
      for (const name of ["code-review", "bun", "tdd"])
        await Bun.write(
          `${input.args.at(-1)}/skills/${name}/SKILL.md`,
          `---\nname: ${name}\n---\n`,
          { createPath: true },
        );
      return answers.clone ?? done("");
    }
    if (input.tool === "git") return answers.revision ?? done(`${commit}\n`);
    return (
      answers.installer ??
      done('[{"name":"code-review","status":"installed"},{"name":"tdd","status":"installed"}]')
    );
  });
  return { calls, spy };
}

test("installs the non-owned upstream roster at the resolved commit and removes its clone", async () => {
  const { calls, spy } = upstream({});
  try {
    expect(await UpstreamSkills.install(["opencode", "claude-code"], paths())).toEqual(
      Ok({
        reason: "upstream_installed",
        data: {
          installerVersion: "1.7.4",
          commit,
          hosts: ["opencode", "claude-code"],
          skills: ["code-review", "tdd"],
          replacementPolicy: policy,
        },
      }),
    );
    const directory = calls[0]?.cwd ?? "";
    expect(directory.startsWith(path.join(tmpdir(), "operator-matt-"))).toBe(true);
    expect(calls).toEqual([
      {
        tool: "git",
        args: [
          "clone",
          "--depth",
          "1",
          "--",
          "https://github.com/mattpocock/skills.git",
          `${directory}/repository`,
        ],
        cwd: directory,
        timeoutMs: 60000,
      },
      {
        tool: "git",
        args: ["rev-parse", "HEAD"],
        cwd: `${directory}/repository`,
        timeoutMs: 10000,
      },
      {
        tool: "bun",
        args: [
          "x",
          "--bun",
          "skills@1.7.4",
          "add",
          `mattpocock/skills#${commit}`,
          "--global",
          "--agent",
          "opencode",
          "claude-code",
          "--skill",
          "code-review",
          "tdd",
          "--yes",
          "--json",
        ],
        cwd: directory,
        timeoutMs: 120000,
      },
    ]);
    expect(await Bun.file(`${directory}/repository/skills/tdd/SKILL.md`).exists()).toBe(false);
    expect(UpstreamSkills.replacementPolicy()).toBe(policy);
  } finally {
    spy.mockRestore();
  }
});

test.each([
  [
    "clone unavailable",
    { clone: { status: "unavailable", tool: "git", detail: "absent" } },
    "Cannot read the current Matt skills revision. No installer was invoked.",
    1,
  ],
  [
    "clone failed",
    { clone: { status: "completed", exitCode: 128, stdout: "", stderr: "denied" } },
    "Cannot read the current Matt skills revision. No installer was invoked.",
    1,
  ],
  [
    "clone unfinished",
    { clone: unfinished },
    "Cannot read the current Matt skills revision. No installer was invoked.",
    1,
  ],
  [
    "revision unfinished",
    { revision: unfinished },
    "Cannot resolve a full Matt skills commit. No installer was invoked.",
    2,
  ],
  [
    "revision unavailable",
    { revision: { status: "no-answer", detail: "interrupted" } },
    "Cannot resolve a full Matt skills commit. No installer was invoked.",
    2,
  ],
  [
    "revision failed",
    { revision: { status: "completed", exitCode: 1, stdout: commit, stderr: "" } },
    "Cannot resolve a full Matt skills commit. No installer was invoked.",
    2,
  ],
] as const)("a %s resolution stops before the installer", async (_name, answers, detail, count) => {
  const { calls, spy } = upstream(answers);
  try {
    expect(await UpstreamSkills.install(["opencode"], paths())).toEqual(
      Err({ reason: "upstream_resolution_failed", detail }),
    );
    expect(calls).toHaveLength(count);
  } finally {
    spy.mockRestore();
  }
});

test.each([
  [
    { status: "unavailable", tool: "bun", detail: "bun is not on the path." },
    { reason: "upstream_installer_unavailable", detail: "bun is not on the path." },
  ],
  [
    { status: "no-answer", detail: "bun x ended on SIGTERM." },
    { reason: "upstream_install_unconfirmed", detail: `bun x ended on SIGTERM. ${policy}` },
  ],
  [
    { status: "completed", exitCode: 1, stdout: "", stderr: "lock held" },
    { reason: "upstream_install_failed", detail: `lock held ${policy}` },
  ],
  [
    done('[{"name":"code-review","status":"installed"}]'),
    {
      reason: "upstream_install_unconfirmed",
      detail: `The installer did not confirm every selected skill. ${policy}`,
    },
  ],
] as const)("an installer answer %j is a refusal", async (installer, error) => {
  const { spy } = upstream({ installer });
  try {
    expect(await UpstreamSkills.install(["opencode"], paths())).toEqual(Err(error));
  } finally {
    spy.mockRestore();
  }
});

test("an invalid commit, an empty owned catalog, or an owned-only roster is an invalid catalog", async () => {
  const { calls, spy } = upstream({ revision: done("main") });
  try {
    expect(await UpstreamSkills.install(["opencode"], paths())).toMatchObject({
      tag: "Err",
      error: { reason: "upstream_catalog_invalid" },
    });
    expect(calls).toHaveLength(2);
    spy.mockRestore();
    const invalid = Err({
      reason: "upstream_catalog_invalid" as const,
      detail:
        "A complete owned catalog and a nonempty upstream roster are required. No installer was invoked.",
    });
    const owned = spyOn(OwnedSkills, "names").mockResolvedValue([]);
    const empty = upstream({});
    expect(await UpstreamSkills.install(["opencode"], paths())).toEqual(invalid);
    expect(empty.calls).toHaveLength(2);
    owned.mockResolvedValue(["code-review", "bun", "tdd"]);
    expect(await UpstreamSkills.install(["opencode"], paths())).toEqual(invalid);
    expect(empty.calls).toHaveLength(4);
  } finally {
    mock.restore();
  }
});

test.each(["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EIO", "ENOSPC", "EROFS", "ELOOP"])(
  "a %s failure is an upstream I/O refusal",
  async (code) => {
    const spy = spyOn(ToolInvocation, "run").mockRejectedValue(
      Object.assign(new Error("io"), { code }),
    );
    try {
      expect(await UpstreamSkills.install(["opencode"], paths())).toEqual(
        Err({ reason: "upstream_io_failed", detail: "Error: io" }),
      );
    } finally {
      spy.mockRestore();
    }
  },
);

test("a syntax error is an invalid catalog and other failures stay defects", async () => {
  const spy = spyOn(ToolInvocation, "run").mockRejectedValue(new SyntaxError("bad"));
  try {
    expect(await UpstreamSkills.install(["opencode"], paths())).toEqual(
      Err({ reason: "upstream_catalog_invalid", detail: "SyntaxError: bad" }),
    );
    for (const cause of [Object.assign(new Error("reset"), { code: "ECONNRESET" }), null]) {
      spy.mockRejectedValue(cause);
      expect(await UpstreamSkills.install(["opencode"], paths())).toMatchObject({
        tag: "Defect",
        cause,
      });
    }
  } finally {
    spy.mockRestore();
  }
});

test.skipIf(asRoot)(
  "presence counts directories, file parents, and loops as missing and stops on other errors",
  async () => {
    const input = paths();
    const skills = `${root}/.agents/skills`;
    const missing = Ok([`${skills}/code-review/SKILL.md`]);
    await Bun.write(`${skills}/code-review/SKILL.md/inner`, "", { createPath: true });
    expect(await UpstreamSkills.check(input, "opencode")).toEqual(missing);
    await rm(`${skills}/code-review`, { recursive: true });
    await Bun.write(`${skills}/code-review`, "a file\n");
    expect(await UpstreamSkills.check(input, "opencode")).toEqual(missing);
    await rm(`${skills}/code-review`);
    await symlink(`${skills}/code-review`, `${skills}/code-review`);
    expect(await UpstreamSkills.check(input, "opencode")).toEqual(missing);
    await rm(`${skills}/code-review`);
    await Bun.write(`${skills}/code-review/SKILL.md`, "present\n", { createPath: true });
    expect(await UpstreamSkills.check(input, "opencode")).toEqual(Ok([]));
    await chmod(`${skills}/code-review`, 0o000);
    try {
      expect(await UpstreamSkills.check(input, "opencode")).toMatchObject({
        tag: "Err",
        error: { reason: "upstream_io_failed" },
      });
    } finally {
      await chmod(`${skills}/code-review`, 0o755);
    }
    expect(await UpstreamSkills.check(input, "claude-code")).toEqual(
      Ok([`${root}/.claude/skills/code-review/SKILL.md`]),
    );
  },
);

test("presence checks refuse a host root outside the temporary test root", async () => {
  const input = paths();
  const outside = {
    ...input,
    upstreamSkills: { ...input.upstreamSkills, opencode: "/operator-absent-host/skills" },
  };
  expect(await UpstreamSkills.check(outside, "opencode")).toMatchObject({ tag: "Defect" });
});
