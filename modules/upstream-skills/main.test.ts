import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
// Bun has no temporary-directory, symlink, or recursive removal API.
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { UpstreamSkills } from "./main.ts";

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
