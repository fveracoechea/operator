import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no temporary-directory, directory listing, recursive copy, chmod, real-path, symlink, stat, or recursive removal API.
import { chmod, cp, mkdir, mkdtemp, readdir, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { Environment } from "../environment/main.ts";
import { OperatorRelease } from "../operator-release/main.ts";
import { GlobalLauncher } from "./main.ts";

// Root ignores file modes, so a test of a denied access cannot run as root.
const asRoot = process.getuid?.() === 0;

const sourceRoot = Bun.fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const alias = "@fveracoechea/operator";
const pinned = "npm:@jsr/fveracoechea__operator@1.2.3";
let root = "";

beforeEach(async () => {
  // Bun reports real paths, such as /private/var for /var on macOS.
  root = await realpath(await mkdtemp(path.join(tmpdir(), "global-launcher-")));
});
afterEach(async () => {
  mock.restore();
  await rm(root, { recursive: true, force: true });
});

/** The launcher text for one global folder, worked out by hand from the shell rules. */
function launcher(globalRoot: string) {
  return `#!/bin/sh
# Operator launcher written by operator install launcher.
# It runs the global JSR package in place, so it names no release and survives updates.
exec bun '${globalRoot}/node_modules/@fveracoechea/operator/cli.js' "$@"
`;
}

/** A controlled Bun that reports the given global folders and fails every other request. */
async function controlledBun(answers: { bin?: string; listing?: string; exit?: number }) {
  await Bun.write(
    `${root}/tools/bun`,
    `#!${process.execPath}
const a = process.argv.slice(2).join(" ");
if (${answers.exit ?? 0} !== 0) process.exit(${answers.exit ?? 0});
if (a === "pm bin -g") console.log(${JSON.stringify(answers.bin ?? `${root}/bun/bin`)});
else if (a === "pm ls -g") console.log(${JSON.stringify(answers.listing ?? `${root}/bun/install/global node_modules (1 installed)`)});
else process.exit(9);`,
    { createPath: true },
  );
  await chmod(`${root}/tools/bun`, 0o755);
}

function onPath(...folders: string[]) {
  spyOn(Environment, "read").mockReturnValue({ ...Environment.read(), PATH: folders.join(":") });
}

async function command(folder: string, text: string) {
  await Bun.write(`${root}/${folder}/operator`, text, { createPath: true });
  await chmod(`${root}/${folder}/operator`, 0o755);
}

test("the Nix launcher runs the package release with the pinned Bun last on PATH", () => {
  expect(
    GlobalLauncher.nixText({ installRoot: "/nix/store/x-op", bun: "/nix/store/y-bun/bin/bun" }),
  ).toBe(`#!/bin/sh
# Operator launcher written by the Nix package.
# It runs the release in this package with the package's pinned Bun.
PATH=\${PATH:+$PATH:}'/nix/store/y-bun/bin' exec '/nix/store/y-bun/bin/bun' '/nix/store/x-op/node_modules/@fveracoechea/operator/cli.js' "$@"
`);
});

test("a command that appears during the write is kept and reported as a conflict", async () => {
  await installedRelease();
  await globalManifest(JSON.stringify({ dependencies: { [alias]: pinned } }));
  await controlledBun({});
  await mkdir(`${root}/bun/bin`, { recursive: true });
  const result = await installed("install", { race: `${root}/bun/bin/operator` });
  expect(result.error).toEqual({
    reason: "launcher_conflict",
    detail: `${root}/bun/bin/operator appeared while the launcher was written. It was not changed.`,
  });
  expect(await Bun.file(`${root}/bun/bin/operator`).text()).toBe("raced");
  expect(await binFiles()).toEqual(["operator"]);
});

test.skipIf(asRoot)("install reports an I/O failure and leaves no partial file", async () => {
  await installedRelease();
  await globalManifest(JSON.stringify({ dependencies: { [alias]: pinned } }));
  await mkdir(`${root}/bun/bin`, { recursive: true });
  await chmod(`${root}/bun/bin`, 0o555);
  await controlledBun({});
  try {
    expect((await installed("install")).error?.reason).toBe("launcher_io_failed");
    expect(await binFiles()).toEqual([]);
  } finally {
    await chmod(`${root}/bun/bin`, 0o755);
  }
  await rm(`${root}/bun/bin`, { recursive: true });
  await Bun.write(`${root}/bun/bin`, "a file");
  expect((await installed("install")).error?.reason).toBe("launcher_io_failed");
});

test("no operator on PATH is one missing executable blocker", async () => {
  await mkdir(`${root}/empty`);
  onPath(`${root}/empty`);
  const result = await GlobalLauncher.check();
  expect(result).toMatchObject({
    tag: "Ok",
    value: [{ reason: "executable_missing", tool: "operator" }],
  });
  expect(result.tag === "Ok" && result.value[0]?.detail).toContain("operator install launcher");
});

/** A launcher on PATH whose package entry links to the running entry point. */
async function runningCommand() {
  await mkdir(`${root}/global/node_modules/${alias}`, { recursive: true });
  await symlink(`${sourceRoot}/cli.ts`, `${root}/global/node_modules/${alias}/cli.js`);
  await command("bin", launcher(`${root}/global`));
  onPath(`${root}/bin`);
}

test("a launcher whose package path reaches the running entry point has no blockers", async () => {
  await runningCommand();
  expect(await GlobalLauncher.check()).toMatchObject({ tag: "Ok", value: [] });
});

test("a command that reaches another release is a mismatch that names both paths", async () => {
  const running = await Bun.file(`${sourceRoot}/cli.ts`).exists();
  expect(running).toBe(true);
  for (const text of ["#!/bin/sh\nexec other-operator\n", launcher(`${root}/missing`)]) {
    await command("bin", text);
    onPath(`${root}/bin`);
    const result = await GlobalLauncher.check();
    expect(result).toMatchObject({
      tag: "Ok",
      value: [{ reason: "executable_mismatch", tool: "operator" }],
    });
    const detail = result.tag === "Ok" ? (result.value[0]?.detail ?? "") : "";
    expect(detail).toContain(`${root}/bin/operator on PATH`);
    expect(detail).toContain(sourceRoot);
    mock.restore();
  }
});

test.skipIf(asRoot)(
  "a command on PATH is read before an unreadable command gives an I/O failure",
  async () => {
    await command("bin", "#!/bin/sh\n");
    await chmod(`${root}/bin/operator`, 0o111);
    onPath(`${root}/bin`);
    expect(await GlobalLauncher.check()).toMatchObject({
      tag: "Err",
      error: { reason: "launcher_io_failed" },
    });
  },
);

test("check qualifies each modeled I/O code and leaves other failures as defects", async () => {
  await runningCommand();
  const manifest = spyOn(OperatorRelease, "manifest");
  for (const code of ["EACCES", "EPERM", "EIO", "ENOSPC", "EROFS", "ENOTDIR", "ELOOP"]) {
    manifest.mockRejectedValueOnce(Object.assign(new Error(`${code}: refused`), { code }));
    expect(await GlobalLauncher.check()).toMatchObject({
      tag: "Err",
      error: { reason: "launcher_io_failed", detail: `Error: ${code}: refused` },
    });
  }
  manifest.mockRejectedValueOnce(new SyntaxError("bad JSON"));
  expect(await GlobalLauncher.check()).toMatchObject({
    tag: "Err",
    error: { reason: "launcher_global_manifest_invalid", detail: "SyntaxError: bad JSON" },
  });
  const invalid = z.string().safeParse(1).error;
  manifest.mockRejectedValueOnce(invalid);
  expect(await GlobalLauncher.check()).toMatchObject({
    tag: "Err",
    error: { reason: "launcher_global_manifest_invalid", detail: String(invalid) },
  });
  for (const cause of [
    Object.assign(new Error("gone"), { code: "ENOENT" }),
    new Error("plain"),
    "not an error",
  ]) {
    manifest.mockRejectedValueOnce(cause);
    const result = await GlobalLauncher.check();
    expect(result.tag === "Defect" && result.cause).toBe(cause);
  }
});

test("install reports a Bun failure when Bun is absent, fails, or names no folders", async () => {
  await mkdir(`${root}/tools`);
  onPath(`${root}/tools`);
  const failed = {
    tag: "Err",
    error: {
      reason: "launcher_bun_failed",
      detail: "bun pm could not report its global folders. No launcher was written.",
    },
  };
  expect(await GlobalLauncher.install()).toMatchObject(failed);
  for (const answers of [{ exit: 1 }, { bin: "  " }, { listing: "" }]) {
    await controlledBun(answers);
    if (answers.listing === "")
      await Bun.write(
        `${root}/tools/bun`,
        `#!${process.execPath}
if (process.argv.slice(2).join(" ") === "pm bin -g") console.log(${JSON.stringify(`${root}/bun/bin`)});
else process.exit(1);`,
      );
    expect(await GlobalLauncher.install()).toMatchObject(failed);
  }
  expect(await Bun.file(`${root}/bun/bin/operator`).exists()).toBe(false);
});

test("install never touches a global folder outside the temporary root in a test", async () => {
  onPath(`${root}/tools`);
  for (const answers of [
    { bin: "/usr/local/operator-test-bin" },
    { listing: "/usr/local/operator-test-global node_modules (1 installed)" },
  ]) {
    await controlledBun(answers);
    const result = await GlobalLauncher.install();
    expect(result.tag).toBe("Defect");
    expect(result.tag === "Defect" && String(result.cause)).toContain(
      "Tests cannot access non-temporary install roots: /usr/local/operator-test-",
    );
  }
});

test("install refuses a running checkout that is not a built release", async () => {
  await controlledBun({});
  onPath(`${root}/tools`);
  const built = { ...(await OperatorRelease.manifest()), artifactIdentity: "built" };
  for (const manifest of [null, built]) {
    if (manifest !== null) spyOn(OperatorRelease, "manifest").mockResolvedValue(manifest);
    const result = await GlobalLauncher.install();
    expect(result).toMatchObject({ tag: "Err", error: { reason: "launcher_unsupported" } });
    expect(result.tag === "Err" && result.error.detail).toContain(
      `The running Operator at ${sourceRoot} is not a built release.`,
    );
  }
  expect(await Bun.file(`${root}/bun/bin/operator`).exists()).toBe(false);
});

/**
 * A copy of this checkout placed where Bun installs the global package, with a release record,
 * so the copy runs as an installed release.
 */
function globalPackage() {
  return `${root}/bun/install/global/node_modules/${alias}`;
}

async function installedRelease(record: Record<string, string> = {}, pkg = globalPackage()) {
  await mkdir(pkg, { recursive: true });
  await cp(`${sourceRoot}/modules`, `${pkg}/modules`, { recursive: true });
  await cp(`${sourceRoot}/lib`, `${pkg}/lib`, { recursive: true });
  await symlink(`${sourceRoot}/node_modules`, `${pkg}/node_modules`);
  await Bun.write(`${pkg}/cli.js`, "");
  await chmod(`${pkg}/cli.js`, 0o755);
  await Bun.write(
    `${pkg}/release.json`,
    JSON.stringify({ version: "1.2.3", artifactIdentity: "built", ...record }),
  );
  await Bun.write(
    `${pkg}/driver.ts`,
    `import { writeFileSync } from "node:fs";
import { GlobalLauncher } from "./modules/global-launcher/main.ts";
const race = process.env.LAUNCHER_RACE;
if (race) {
  // The launcher names its temporary file just before it writes, so the command appears then.
  const name = crypto.randomUUID.bind(crypto);
  crypto.randomUUID = () => {
    writeFileSync(race, "raced");
    return name();
  };
}
const result = process.argv[2] === "check" ? await GlobalLauncher.check() : await GlobalLauncher.install();
console.log(JSON.stringify(result.tag === "Defect" ? { tag: "Defect", cause: String(result.cause) } : result));
`,
  );
  return pkg;
}

async function globalManifest(text: string) {
  await Bun.write(`${root}/bun/install/global/package.json`, text, { createPath: true });
}

const resultSchema = z.object({
  tag: z.string(),
  value: z.unknown().optional(),
  error: z.object({ reason: z.string(), detail: z.string() }).optional(),
  cause: z.string().optional(),
});

async function installed(
  action: "install" | "check",
  options: { path?: string; race?: string; pkg?: string } = {},
) {
  const pkg = options.pkg ?? globalPackage();
  const child = Bun.spawn([process.execPath, `${pkg}/driver.ts`, action], {
    cwd: root,
    env: Environment.child({
      PATH: options.path ?? `${root}/tools`,
      LAUNCHER_RACE: options.race,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(await child.exited, stderr).toBe(0);
  return resultSchema.parse(JSON.parse(stdout));
}

async function binFiles(folder = `${root}/bun/bin`) {
  return (await readdir(folder)).sort();
}

test("an exact global install gets an executable launcher that check then accepts", async () => {
  const pkg = await installedRelease();
  await globalManifest(JSON.stringify({ dependencies: { [alias]: pinned } }));
  await controlledBun({ bin: `${root}/bun/deep/bin` });
  const data = {
    command: `${root}/bun/deep/bin/operator`,
    runs: `${root}/bun/install/global/node_modules/${alias}/cli.js`,
  };
  expect(await installed("install")).toEqual({
    tag: "Ok",
    value: { reason: "launcher_installed", data },
  });
  expect(await Bun.file(data.command).text()).toBe(launcher(`${root}/bun/install/global`));
  expect((await stat(data.command)).mode.toString(8).slice(-3)).toBe("755");
  expect(await binFiles(`${root}/bun/deep/bin`)).toEqual(["operator"]);
  expect(await installed("install")).toEqual({
    tag: "Ok",
    value: { reason: "launcher_current", data },
  });
  expect(await installed("check", { path: `${root}/bun/deep/bin` })).toEqual({
    tag: "Ok",
    value: [],
  });
  expect(await Bun.file(`${pkg}/cli.js`).exists()).toBe(true);
});

test("check reports an installation whose manifest names a moving version", async () => {
  const pkg = await installedRelease();
  await symlink(`${pkg}/cli.js`, `${root}/operator`);
  for (const [manifest, expected] of [
    [`{"dependencies":{"${alias}":"npm:@jsr/fveracoechea__operator@^1.2.3"}}`, "unpinned"],
    [`{"dependencies":{"${alias}":"${pinned}"}}`, "none"],
    [`{"dependencies":{"${alias}":"github:a/b#${"a".repeat(40)}"}}`, "none"],
    [`{"dependencies":{"other":"1.0.0"}}`, "none"],
    ["{}", "none"],
    [`{"dependencies":5}`, "invalid"],
    ["{bad", "invalid"],
  ] as const) {
    await globalManifest(manifest);
    const result = await installed("check", { path: root });
    if (expected === "none") expect(result).toEqual({ tag: "Ok", value: [] });
    if (expected === "invalid")
      expect(result.error?.reason).toBe("launcher_global_manifest_invalid");
    if (expected === "unpinned") {
      expect(result).toMatchObject({
        tag: "Ok",
        value: [{ reason: "installation_unpinned", tool: "operator" }],
      });
      expect(JSON.stringify(result.value)).toContain(
        `beside ${pkg} names npm:@jsr/fveracoechea__operator@^1.2.3`,
      );
    }
  }
  await rm(`${root}/bun/install/global/package.json`);
  expect(await installed("check", { path: root })).toEqual({ tag: "Ok", value: [] });
});

test("install refuses a global package that is not the exact running release", async () => {
  await installedRelease();
  await controlledBun({});
  for (const [manifest, reason, detail] of [
    [
      `{"dependencies":{"${alias}":"npm:@jsr/fveracoechea__operator@^1.2.3"}}`,
      "launcher_version_unpinned",
      `names npm:@jsr/fveracoechea__operator@^1.2.3 for ${alias}`,
    ],
    [
      `{"dependencies":{"other":"1.0.0"}}`,
      "launcher_version_unpinned",
      `names no specifier for ${alias}`,
    ],
    ["{}", "launcher_version_unpinned", `names no specifier for ${alias}`],
    [null, "launcher_version_unpinned", `names no specifier for ${alias}`],
  ] as const) {
    await (manifest === null
      ? rm(`${root}/bun/install/global/package.json`)
      : globalManifest(manifest));
    const result = await installed("install");
    expect(result.error?.reason).toBe(reason);
    expect(result.error?.detail).toContain(detail);
  }
  expect(await Bun.file(`${root}/bun/bin/operator`).exists()).toBe(false);
});

test("install refuses when Bun's reported global folder does not hold the running release", async () => {
  const pkg = await installedRelease();
  await globalManifest(JSON.stringify({ dependencies: { [alias]: pinned } }));
  await mkdir(`${root}/elsewhere`);
  for (const folder of [`${root}/absent`, `${root}/elsewhere`]) {
    await controlledBun({ listing: `${folder} node_modules (1 installed)` });
    const result = await installed("install");
    expect(result.error?.reason).toBe("launcher_unsupported");
    expect(result.error?.detail).toContain(
      folder === `${root}/absent`
        ? `The running Operator at ${pkg} is not Bun's global package. Run`
        : `The running Operator at ${pkg} is not Bun's global package at ${root}/elsewhere/node_modules/${alias}. Run`,
    );
  }
  await controlledBun({
    listing: `no folder here\n${root}/bun/install/global node_modules (1 installed)`,
  });
  expect((await installed("install")).error?.reason).toBe("launcher_unsupported");
  expect(await Bun.file(`${root}/bun/bin/operator`).exists()).toBe(false);
});

test("install refuses a release with no built entry point", async () => {
  const pkg = await installedRelease({ artifactIdentity: "" });
  await globalManifest(JSON.stringify({ dependencies: { [alias]: pinned } }));
  await controlledBun({});
  expect((await installed("install")).error?.detail).toContain("is not a built release");
  await Bun.write(
    `${pkg}/release.json`,
    JSON.stringify({ version: "1.2.3", artifactIdentity: "x" }),
  );
  await rm(`${pkg}/cli.js`);
  expect((await installed("install")).error?.detail).toContain("is not a built release");
  expect(await Bun.file(`${root}/bun/bin/operator`).exists()).toBe(false);
});

test("install never replaces an existing command", async () => {
  await installedRelease();
  await globalManifest(JSON.stringify({ dependencies: { [alias]: pinned } }));
  await controlledBun({});
  await command("bun/bin", "#!/bin/sh\necho mine\n");
  const result = await installed("install");
  expect(result.error?.reason).toBe("launcher_conflict");
  expect(result.error?.detail).toContain(`${root}/bun/bin/operator already exists`);
  expect(await Bun.file(`${root}/bun/bin/operator`).text()).toBe("#!/bin/sh\necho mine\n");
  await rm(`${root}/bun/bin/operator`);
  await mkdir(`${root}/bun/bin/operator`);
  expect((await installed("install")).error?.reason).toBe("launcher_conflict");
  expect(await binFiles()).toEqual(["operator"]);
});

test("a listing with no global folder reads no manifest from a relative path", async () => {
  await installedRelease();
  await Bun.write(`${root}/null/package.json`, "{bad", { createPath: true });
  await controlledBun({ listing: "no folder here" });
  expect((await installed("install")).error?.reason).toBe("launcher_unsupported");
  expect(await Bun.file(`${root}/bun/bin/operator`).exists()).toBe(false);
});

test("check reads no manifest beside a package that Bun did not install globally", async () => {
  // The package folder name is as long as the global suffix, so a cut of it names the folder above.
  const pkg = `${root}/a/${"b".repeat(`/node_modules/${alias}`.length - 1)}`;
  await installedRelease({}, pkg);
  await Bun.write(
    `${root}/a/package.json`,
    JSON.stringify({ dependencies: { [alias]: "npm:@jsr/fveracoechea__operator@^1.2.3" } }),
  );
  await symlink(`${pkg}/cli.js`, `${root}/operator`);
  expect(await installed("check", { path: root, pkg })).toEqual({ tag: "Ok", value: [] });
});
