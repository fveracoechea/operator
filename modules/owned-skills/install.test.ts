import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no temporary-directory, copy, file metadata, symlink, or recursive removal API.
import { chmod, cp, lstat, mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { checkOnly, install, type Request } from "./install.ts";
import { contents } from "./content.ts";

let root = "";
let request: Request;
test("Nix always checks consumer wiring while source and JSR can explicitly check", () => {
  expect(checkOnly("/nix/store/hash-operator/skills", false)).toBe(true);
  expect(checkOnly("/checkout/skills", false)).toBe(false);
  expect(checkOnly("/bun/cache/package/skills", true)).toBe(true);
  expect(checkOnly("/other/nix/store/package/skills", false)).toBe(false);
});
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "skill-install-"));
  request = {
    paths: OperatorHome.resolve(
      Environment.parse({
        HOME: `${root}/home`,
        XDG_CONFIG_HOME: `${root}/config`,
        XDG_STATE_HOME: `${root}/state`,
        NODE_ENV: "test",
      }),
    ),
    hosts: ["opencode", "claude-code"],
    check: false,
    source: `${root}/release`,
  };
  await Bun.write(`${request.source}/example/SKILL.md`, "version one\n", { createPath: true });
  await Bun.write(`${request.source}/example/assets/old.bin`, new Uint8Array([0, 255, 1]), {
    createPath: true,
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("updates unchanged managed content and removes obsolete supporting files for both hosts", async () => {
  expect((await install(request)).reason).toBe("skills_installed");
  await Bun.write(`${request.source}/example/SKILL.md`, "version two\n");
  await rm(`${request.source}/example/assets`, { recursive: true });
  await Bun.write(`${request.source}/example/new/asset`, "new asset\n", { createPath: true });
  expect((await install(request)).reason).toBe("skills_installed");
  for (const host of request.hosts) {
    const destination = `${request.paths.skillHosts[host]}/example`;
    expect(await Bun.file(`${destination}/SKILL.md`).text()).toBe("version two\n");
    expect(await Bun.file(`${destination}/assets/old.bin`).exists()).toBe(false);
    expect(await contents(destination, false)).toEqual(
      await contents(`${request.source}/example`, false),
    );
  }
});

test("the ledger preserves prototype-named assets for later updates and removal", async () => {
  await Bun.write(`${request.source}/example/__proto__`, "version one\n");
  expect((await install(request)).reason).toBe("skills_installed");
  await Bun.write(`${request.source}/example/__proto__`, "version two\n");
  expect((await install(request)).reason).toBe("skills_installed");
  for (const host of request.hosts)
    expect(await Bun.file(`${request.paths.skillHosts[host]}/example/__proto__`).text()).toBe(
      "version two\n",
    );
  await rm(`${request.source}/example/__proto__`);
  expect((await install(request)).reason).toBe("skills_installed");
  for (const host of request.hosts)
    expect(await Bun.file(`${request.paths.skillHosts[host]}/example/__proto__`).exists()).toBe(
      false,
    );
});

test("adopts exact unrelated contents without rewriting them", async () => {
  const destination = `${request.paths.skillHosts.opencode}/example`;
  await cp(`${request.source}/example`, destination, { recursive: true });
  const before = await Bun.file(`${destination}/SKILL.md`).stat();
  expect((await install(request)).reason).toBe("skills_installed");
  expect((await Bun.file(`${destination}/SKILL.md`).stat()).mtimeMs).toBe(before.mtimeMs);
});

test("removes old role copies only when the device ledger proves unchanged contents", async () => {
  const entries: Record<string, NonNullable<Awaited<ReturnType<typeof contents>>>> = {};
  for (const host of request.hosts) {
    for (const name of ["operator", "operative"]) {
      const destination = `${request.paths.skillHosts[host]}/${name}`;
      await cp(`${request.source}/example`, destination, { recursive: true });
      const identity = await contents(destination, false);
      expect(identity).not.toBeNull();
      if (identity !== null) entries[destination] = identity;
    }
  }
  await Bun.write(request.paths.ownedSkills, JSON.stringify({ version: 1, entries }), {
    createPath: true,
  });
  expect((await install(request)).reason).toBe("skills_installed");
  for (const host of request.hosts) {
    expect(await contents(`${request.paths.skillHosts[host]}/operator`, false)).toBeNull();
    expect(await contents(`${request.paths.skillHosts[host]}/operative`, false)).toBeNull();
  }
});

test("a modified recorded old-name copy blocks every change", async () => {
  const destination = `${request.paths.skillHosts.opencode}/operator`;
  await cp(`${request.source}/example`, destination, { recursive: true });
  await Bun.write(
    request.paths.ownedSkills,
    JSON.stringify({ version: 1, entries: { [destination]: await contents(destination, false) } }),
    { createPath: true },
  );
  await Bun.write(`${destination}/SKILL.md`, "person edit\n");
  expect((await install(request)).reason).toBe("skill_copy_conflict");
  expect(await Bun.file(`${destination}/SKILL.md`).text()).toBe("person edit\n");
  expect(await contents(`${request.paths.skillHosts["claude-code"]}/example`, false)).toBeNull();
});

test("a read-only supporting asset blocks all updates before either host changes", async () => {
  expect((await install(request)).reason).toBe("skills_installed");
  const destination = `${request.paths.skillHosts["claude-code"]}/example/assets/old.bin`;
  await chmod(destination, 0o444);
  await Bun.write(`${request.source}/example/SKILL.md`, "version two\n");
  await Bun.write(`${request.source}/example/assets/old.bin`, "new bytes\n");
  try {
    expect((await install(request)).reason).toBe("skill_copy_conflict");
    expect(await Bun.file(`${request.paths.skillHosts.opencode}/example/SKILL.md`).text()).toBe(
      "version one\n",
    );
  } finally {
    await chmod(destination, 0o644);
  }
});

test("updates a managed file to a directory and a managed directory to a file", async () => {
  await Bun.write(`${request.source}/example/moved`, "was a file\n");
  expect((await install(request)).reason).toBe("skills_installed");
  await rm(`${request.source}/example/assets`, { recursive: true });
  await rm(`${request.source}/example/moved`);
  await Bun.write(`${request.source}/example/assets`, "now a file\n");
  await Bun.write(`${request.source}/example/moved/topic`, "now a directory\n", {
    createPath: true,
  });
  expect((await install(request)).reason).toBe("skills_installed");
  expect(await Bun.file(`${request.paths.skillHosts.opencode}/example/assets`).text()).toBe(
    "now a file\n",
  );
  expect(await Bun.file(`${request.paths.skillHosts.opencode}/example/moved/topic`).text()).toBe(
    "now a directory\n",
  );
});

test.each([
  ["a string", { "/x": "hash" }],
  ["a null", { "/x": null }],
  ["an array", { "/x": ["hash"] }],
  ["a non-text hash", { "/x": { file: 1 } }],
  ["a partly non-text hash", { "/x": { file: "hash", other: 1 } }],
])("a ledger entry with %s identity is invalid", async (_name, entries) => {
  await Bun.write(request.paths.ownedSkills, JSON.stringify({ version: 1, entries }), {
    createPath: true,
  });
  await expect(install(request)).rejects.toBeInstanceOf(z.ZodError);
});

test("a ledger entry with text hashes is accepted", async () => {
  await Bun.write(
    request.paths.ownedSkills,
    JSON.stringify({ version: 1, entries: { "/elsewhere": { file: "hash" } } }),
    { createPath: true },
  );
  expect(await install(request)).toEqual({
    reason: "skills_installed",
    data: { hosts: ["opencode", "claude-code"], checkOnly: false },
  });
});

test("a release with no owned skills is invalid", async () => {
  await rm(`${request.source}/example`, { recursive: true });
  expect(await install(request)).toEqual({
    reason: "skills_release_invalid",
    detail: "The running release has no owned skills.",
  });
});

test("copies follow links in the release and keep file modes", async () => {
  await Bun.write(`${root}/outside`, "linked bytes\n");
  await symlink(`${root}/outside`, `${request.source}/example/linked`);
  await Bun.write(`${request.source}/example/run`, "#!/bin/sh\n");
  await chmod(`${request.source}/example/run`, 0o755);
  await chmod(`${request.source}/example/SKILL.md`, 0o600);
  expect((await install(request)).reason).toBe("skills_installed");
  const destination = `${request.paths.skillHosts.opencode}/example`;
  expect(await Bun.file(`${destination}/linked`).text()).toBe("linked bytes\n");
  expect((await lstat(`${destination}/linked`)).isFile()).toBe(true);
  expect((await stat(`${destination}/run`)).mode % 0o1000).toBe(0o755);
  expect((await stat(`${destination}/SKILL.md`)).mode % 0o1000).toBe(0o600);
});

test("a repeated install keeps unchanged files and the ledger in place", async () => {
  expect((await install(request)).reason).toBe("skills_installed");
  const destination = `${request.paths.skillHosts.opencode}/example`;
  const asset = (await stat(`${destination}/assets/old.bin`)).ino;
  const ledger = (await stat(request.paths.ownedSkills)).ino;
  expect(await install(request)).toEqual({
    reason: "skills_already_installed",
    data: { hosts: ["opencode", "claude-code"], checkOnly: false },
  });
  expect((await stat(request.paths.ownedSkills)).ino).toBe(ledger);
  await Bun.write(`${request.source}/example/SKILL.md`, "version two\n");
  expect((await install(request)).reason).toBe("skills_installed");
  expect((await stat(`${destination}/assets/old.bin`)).ino).toBe(asset);
  expect(await Bun.file(`${destination}/SKILL.md`).text()).toBe("version two\n");
});

test("check mode compares release contents and ignores retired names", async () => {
  const check = { ...request, check: true };
  const destinations = request.hosts.map((host) => `${request.paths.skillHosts[host]}/example`);
  expect(await install(check)).toEqual({
    reason: "skill_copy_conflict",
    detail: `Preserve these skill paths and resolve their contents or external wiring: ${destinations.join(", ")}`,
  });
  expect((await install(request)).reason).toBe("skills_installed");
  await Bun.write(`${request.paths.skillHosts.opencode}/operator/SKILL.md`, "old role\n", {
    createPath: true,
  });
  await chmod(request.paths.ownedSkills, 0o444);
  try {
    expect(await install(check)).toEqual({
      reason: "skills_checked",
      data: { hosts: ["opencode", "claude-code"], checkOnly: true },
    });
  } finally {
    await chmod(request.paths.ownedSkills, 0o644);
  }
});

test.each(["ownedSkills", "skillsLock"] as const)(
  "a read-only %s refuses copy mode before any host write",
  async (file) => {
    await Bun.write(request.paths[file], "", { createPath: true });
    await chmod(request.paths[file], 0o444);
    try {
      expect(await install(request)).toEqual({
        reason: "skill_copy_conflict",
        detail: "The device owned-content ledger or lock is externally managed.",
      });
      expect(await contents(`${request.paths.skillHosts.opencode}/example`)).toBeNull();
    } finally {
      await chmod(request.paths[file], 0o644);
    }
  },
);

test("a file at a skill path is a conflict, not a failure", async () => {
  const destination = `${request.paths.skillHosts.opencode}/example`;
  await Bun.write(destination, "person file\n", { createPath: true });
  expect((await install(request)).reason).toBe("skill_copy_conflict");
  expect(await Bun.file(destination).text()).toBe("person file\n");
});

test("a copy that changes after inspection stops the installation", async () => {
  await mkdir(`${root}/config/opencode`, { recursive: true });
  await mkdir(`${root}/home`, { recursive: true });
  await symlink(`${root}/config/opencode`, `${root}/home/.claude`);
  expect(await install(request)).toEqual({
    reason: "skill_copy_conflict",
    detail: `Skill contents changed during installation: ${request.paths.skillHosts["claude-code"]}/example`,
  });
  expect(await Bun.file(request.paths.ownedSkills).exists()).toBe(false);
});

test("a new folder that cannot take files stops the installation", async () => {
  expect((await install(request)).reason).toBe("skills_installed");
  await Bun.write(`${request.source}/example/added/file`, "new\n", { createPath: true });
  const previous = process.umask(0o222);
  try {
    expect(await install(request)).toEqual({
      reason: "skill_copy_conflict",
      detail: `Skill contents changed during installation: ${request.paths.skillHosts.opencode}/example`,
    });
  } finally {
    process.umask(previous);
  }
  expect(await Bun.file(`${request.paths.skillHosts.opencode}/example/added/file`).exists()).toBe(
    false,
  );
});
