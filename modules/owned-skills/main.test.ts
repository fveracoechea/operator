import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
// Bun has no temporary-directory, directory listing, or recursive removal API.
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Err } from "unthrown";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { contents, identity } from "./content.ts";
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

test("skill identities name every bundled skill with a stable content identity", async () => {
  const identities = await OwnedSkills.identities();
  expect(identities.map((skill) => skill.name)).toEqual(await OwnedSkills.names());
  expect(identities.every((skill) => /^[0-9a-f]{64}$/.test(skill.identity))).toBe(true);
  expect(await OwnedSkills.identities()).toEqual(identities);
});

const bundled = Bun.fileURLToPath(new URL("../../skills/", import.meta.url));

test("names every bundled skill folder with a SKILL.md, sorted", async () => {
  const expected = [];
  for (const entry of await readdir(bundled, { withFileTypes: true }))
    if (entry.isDirectory() && (await Bun.file(`${bundled}${entry.name}/SKILL.md`).exists()))
      expected.push(entry.name);
  expect(await OwnedSkills.names()).toEqual(expected.toSorted());
});

test("a skill identity hashes its content entries", async () => {
  const identities = await OwnedSkills.identities();
  for (const skill of identities)
    expect(skill.identity).toBe(identity((await contents(`${bundled}${skill.name}`)) ?? {}));
  expect(new Set(identities.map((skill) => skill.identity)).size).toBe(identities.length);
});

test("a check-only refusal is an error result without host writes", async () => {
  const input = { paths: paths(), hosts: ["opencode" as const], check: true };
  expect(await OwnedSkills.install(input)).toMatchObject({
    tag: "Err",
    error: { reason: "skill_copy_conflict" },
  });
  expect(await Bun.file(input.paths.ownedSkills).exists()).toBe(false);
});

test("a ledger with an unknown shape is an operational refusal", async () => {
  const input = { paths: paths(), hosts: ["opencode" as const], check: false };
  await Bun.write(input.paths.ownedSkills, '{"version":2,"entries":{}}', { createPath: true });
  expect(await OwnedSkills.install(input)).toMatchObject({
    tag: "Err",
    error: { reason: "skills_ledger_invalid" },
  });
});

test.each([
  "EACCES",
  "EPERM",
  "EROFS",
  "EIO",
  "ENOENT",
  "EISDIR",
  "ENOTDIR",
  "EEXIST",
  "ENOSPC",
  "ELOOP",
  "ENOTEMPTY",
  "SQLITE_BUSY",
  "SQLITE_CANTOPEN",
  "SQLITE_CORRUPT",
  "SQLITE_NOTADB",
])("a %s failure is a skills I/O refusal", async (code) => {
  const spy = spyOn(OperatorHome, "guardTemporaryTests").mockImplementation(() => {
    // oxlint-disable-next-line unthrown/no-throw -- Inject a coded failure at the public module boundary.
    throw Object.assign(new Error("failed"), { code });
  });
  try {
    expect(
      await OwnedSkills.install({ paths: paths(), hosts: ["opencode"], check: false }),
    ).toEqual(Err({ reason: "skills_io_failed", detail: "Error: failed" }));
  } finally {
    spy.mockRestore();
  }
});

test("other coded failures and non-errors remain defects", async () => {
  for (const cause of [Object.assign(new Error("reset"), { code: "ECONNRESET" }), null]) {
    const spy = spyOn(OperatorHome, "guardTemporaryTests").mockImplementation(() => {
      // oxlint-disable-next-line unthrown/no-throw -- Inject a defect at the public module boundary.
      throw cause;
    });
    try {
      expect(
        await OwnedSkills.install({ paths: paths(), hosts: ["opencode"], check: false }),
      ).toMatchObject({ tag: "Defect", cause });
    } finally {
      spy.mockRestore();
    }
  }
});
