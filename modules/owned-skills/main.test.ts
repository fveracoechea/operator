import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { OwnedSkills } from "./main.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "owned-skills-api-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function paths() {
  return OperatorHome.resolve(
    Environment.parse({
      HOME: root,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
      NODE_ENV: "test",
    }),
  );
}

test("returns installed and checked outcomes through one interface", async () => {
  expect(await OwnedSkills.names()).toContain("super-agent");
  const input = { paths: paths(), hosts: ["opencode" as const], check: false };
  expect(await OwnedSkills.install(input)).toMatchObject({
    tag: "Ok",
    value: { reason: "skills_installed" },
  });
  expect(await OwnedSkills.install({ ...input, check: true })).toMatchObject({
    tag: "Ok",
    value: { reason: "skills_checked" },
  });
});

test("an unreadable ledger is an operational refusal without host writes", async () => {
  const input = { paths: paths(), hosts: ["opencode" as const], check: false };
  await Bun.write(input.paths.ownedSkills, "{broken", { createPath: true });
  expect(await OwnedSkills.install(input)).toMatchObject({
    tag: "Err",
    error: { reason: "skills_ledger_invalid" },
  });
  expect(await Bun.file(`${input.paths.skillHosts.opencode}/bun/SKILL.md`).exists()).toBe(false);
  expect(await Bun.file(input.paths.ownedSkills).text()).toBe("{broken");
});

test("preserves programming defects rather than classifying them as I/O failures", async () => {
  const spy = spyOn(OperatorHome, "guardTemporaryTests").mockImplementation(() => {
    // oxlint-disable-next-line unthrown/no-throw -- Inject a programming defect at the public module boundary.
    throw new TypeError("defect");
  });
  try {
    const result = await OwnedSkills.install({ paths: paths(), hosts: ["opencode"], check: false });
    expect(result.tag).toBe("Defect");
    if (result.tag === "Defect") expect(result.cause).toBeInstanceOf(TypeError);
  } finally {
    spy.mockRestore();
  }
});
