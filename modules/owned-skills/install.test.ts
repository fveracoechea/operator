import { afterEach, beforeEach, expect, test } from "bun:test";
// Bun has no temporary-directory, copy, or recursive removal API.
import { chmod, cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
