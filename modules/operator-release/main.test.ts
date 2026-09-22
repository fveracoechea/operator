import { afterEach, describe, expect, test } from "bun:test";
// Bun has no recursive directory removal API.
import { rm, symlink } from "node:fs/promises";
import { OperatorRelease } from "./main.ts";

const sourceRoot = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const outputs: string[] = [];

afterEach(async () => {
  await Promise.all(outputs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function outputRoot(): string {
  const path = `${Bun.env.TMPDIR ?? "/tmp"}/operator-release-${crypto.randomUUID()}`;
  outputs.push(path);
  return path;
}

const commit = "b".repeat(40);

async function buildArtifact() {
  const artifactRoot = outputRoot();
  const result = await OperatorRelease.build({ sourceRoot, artifactRoot, commit });
  return { artifactRoot, result };
}

describe("the running release", () => {
  test("identifies itself from the checkout it runs in", async () => {
    const release = await OperatorRelease.identify();

    expect(release.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(release.artifact).toBe("checkout");
    expect(release.identity).toMatch(/^[0-9a-f]{64}$/);
    expect(release.skillsIdentity).toMatch(/^[0-9a-f]{64}$/);
    expect(release.supportedBun.length).toBeGreaterThan(0);
  });

  test("reads the lock data that governs its own installation", async () => {
    const release = await OperatorRelease.identify();

    expect(release.lock.state).toBe("present");
    expect(release.lock.name).toBe("bun.lock");
    expect(release.lock.identity).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the release artifact", () => {
  test("ships runnable ESM, declarations, skills, and the generated schema", async () => {
    const { artifactRoot, result } = await buildArtifact();

    expect(result.status).toBe("built");
    expect(await Bun.file(`${artifactRoot}/cli.js`).exists()).toBe(true);
    expect(await Bun.file(`${artifactRoot}/cli.d.ts`).exists()).toBe(true);
    expect(await Bun.file(`${artifactRoot}/modules/operator-cli/main.js`).exists()).toBe(true);
    expect(await Bun.file(`${artifactRoot}/modules/operator-cli/main.d.ts`).exists()).toBe(true);
    expect(await Bun.file(`${artifactRoot}/skills/operator/SKILL.md`).exists()).toBe(true);
    expect(await Bun.file(`${artifactRoot}/config.schema.json`).exists()).toBe(true);
    expect(await Bun.file(`${artifactRoot}/jsr.json`).exists()).toBe(true);
  });

  test("leaves no TypeScript source and no test file in the artifact", async () => {
    const { artifactRoot } = await buildArtifact();

    const paths = await Array.fromAsync(
      new Bun.Glob("**/*").scan({ cwd: artifactRoot, dot: true }),
    );

    expect(paths.filter((path) => path.endsWith(".ts") && !path.endsWith(".d.ts"))).toEqual([]);
    expect(paths.filter((path) => path.includes(".test."))).toEqual([]);
  });

  test("rewrites every relative TypeScript specifier so the shipped files resolve", async () => {
    const { artifactRoot } = await buildArtifact();

    const js = await Bun.file(`${artifactRoot}/cli.js`).text();
    const declaration = await Bun.file(
      `${artifactRoot}/modules/project-readiness/main.d.ts`,
    ).text();

    expect(js).toContain('from "./modules/operator-cli/main.js"');
    expect(js).not.toContain('.ts"');
    expect(declaration).not.toMatch(/from "\.[^"]*\.ts"/);
    expect(declaration).not.toMatch(/import\("\.[^"]*\.ts"\)/);
  });

  test("keeps the executable shebang on the command entry point", async () => {
    const { artifactRoot } = await buildArtifact();

    expect(await Bun.file(`${artifactRoot}/cli.js`).text()).toStartWith("#!/usr/bin/env bun\n");
  });

  test("declares no install-time script, so retrieval needs no lifecycle trust", async () => {
    const { artifactRoot } = await buildArtifact();

    const manifest = await Bun.file(`${artifactRoot}/package.json`).json();

    expect(manifest.scripts).toBeUndefined();
    expect(manifest.bin).toEqual({ operator: "./cli.js" });
    expect(manifest.exports["./cli"]).toEqual({ types: "./cli.d.ts", default: "./cli.js" });
    expect(manifest.private).toBeUndefined();
  });

  test("declares in the registry config every package the shipped code reaches", async () => {
    // The registry reads `jsr.json`, never the package manifest beside it. A dependency that is
    // named only there would be missing from a published copy, and the launcher would not resolve.
    const { artifactRoot } = await buildArtifact();
    const transpiler = new Bun.Transpiler({ loader: "js" });
    const reached = new Set<string>();

    for await (const path of new Bun.Glob("**/*.js").scan({ cwd: artifactRoot })) {
      const text = await Bun.file(`${artifactRoot}/${path}`).text();
      const body = text.startsWith("#!") ? text.slice(text.indexOf("\n") + 1) : text;
      for (const found of transpiler.scanImports(body)) {
        if (!found.path.startsWith(".") && !/^(node|bun):/.test(found.path)) {
          reached.add(found.path.split("/").slice(0, found.path.startsWith("@") ? 2 : 1).join("/"));
        }
      }
    }

    const config = await Bun.file(`${artifactRoot}/jsr.json`).json();
    expect(reached.size).toBeGreaterThan(0);
    expect([...reached].toSorted()).toEqual(Object.keys(config.imports ?? {}).toSorted());
    for (const [name, specifier] of Object.entries(config.imports ?? {})) {
      // The version is exact, so a reinstall never resolves a replacement the registry chose.
      expect(specifier, name).toMatch(/^npm:[^@]*@?[^@]*@\d+\.\d+\.\d+$/);
    }
  });

  test("records the exact commit and version the artifact was built from", async () => {
    const { artifactRoot, result } = await buildArtifact();

    const release = await Bun.file(`${artifactRoot}/release.json`).json();
    const manifest = await Bun.file(`${artifactRoot}/package.json`).json();

    expect(release.commit).toBe(commit);
    expect(release.version).toBe(manifest.version);
    expect(release.artifactIdentity).toBe(result.artifactIdentity);
  });

  test("identifies the artifact by its content, so changed content is a different release", async () => {
    const first = await buildArtifact();
    const second = await buildArtifact();
    expect(second.result.artifactIdentity).toBe(first.result.artifactIdentity);

    await Bun.write(`${second.artifactRoot}/skills/operator/SKILL.md`, "changed\n");
    const changed = await OperatorRelease.inspect({ artifactRoot: second.artifactRoot });

    expect(changed.artifactIdentity).not.toBe(first.result.artifactIdentity);
  });

  test("reports an artifact that is missing a required part", async () => {
    const { artifactRoot } = await buildArtifact();
    await rm(`${artifactRoot}/config.schema.json`);

    const inspection = await OperatorRelease.inspect({ artifactRoot });

    expect(inspection.status).toBe("incomplete");
    expect(inspection.missing).toContain("config.schema.json");
  });

  test("runs the built command through the same importable entry point", async () => {
    const { artifactRoot } = await buildArtifact();
    // A real installation keeps its dependencies beside the package, so the fixture does too.
    await symlink(`${sourceRoot}/node_modules`, `${artifactRoot}/node_modules`);

    const child = Bun.spawn(
      [
        "bun",
        "--no-install",
        "-e",
        `const { main } = await import(${JSON.stringify(`${artifactRoot}/cli.js`)}); await main(Bun.argv.slice(1));`,
        "--",
        "--version",
        "--json",
      ],
      { cwd: sourceRoot, stderr: "pipe", stdout: "pipe" },
    );
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).data.operatorVersion).toBe(
      (await Bun.file(`${artifactRoot}/release.json`).json()).version,
    );
  });
});

describe("an update run from a built release", () => {
  /** Runs one built CLI in a scratch project, the way a retrieved release is run. */
  async function runBuilt(artifactRoot: string, args: string[]) {
    const project = outputRoot();
    await Bun.$`mkdir -p ${project}`.quiet();
    const child = Bun.spawn(
      [
        "bun",
        "--no-install",
        "-e",
        `const { main } = await import(${JSON.stringify(`${artifactRoot}/cli.js`)}); await main(Bun.argv.slice(1));`,
        "--",
        ...args,
      ],
      { cwd: project, stderr: "pipe", stdout: "pipe" },
    );
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    return { exitCode, json: JSON.parse(stdout) };
  }

  test("refuses to record a commit the running release was not built from", async () => {
    const { artifactRoot } = await buildArtifact();
    await symlink(`${sourceRoot}/node_modules`, `${artifactRoot}/node_modules`);
    // A retrieved installation keeps its own lock data, so the fixture keeps it too.
    await Bun.write(`${artifactRoot}/bun.lock`, "{}\n");

    const result = await runBuilt(artifactRoot, [
      "update",
      "plan",
      "--claude",
      "--commit",
      "a".repeat(40),
      "--json",
    ]);

    expect(result.json.reason).toBe("update_blocked");
    expect(result.json.blockers.map((one: { reason: string }) => one.reason)).toContain(
      "release_commit_mismatch",
    );
  });

  test("records the commit the running release was built from", async () => {
    const { artifactRoot } = await buildArtifact();
    await symlink(`${sourceRoot}/node_modules`, `${artifactRoot}/node_modules`);
    // A retrieved installation keeps its own lock data, so the fixture keeps it too.
    await Bun.write(`${artifactRoot}/bun.lock`, "{}\n");

    const result = await runBuilt(artifactRoot, [
      "update",
      "plan",
      "--claude",
      "--commit",
      commit,
      "--json",
    ]);

    expect(result.json.reason).toBe("update_plan_ready");
    expect(result.json.data.to.commit).toBe(commit);
  });
});

describe("the release tooling", () => {
  test("builds a complete artifact through the command a maintainer runs", async () => {
    const artifactRoot = outputRoot();

    const child = Bun.spawn(
      ["bun", "scripts/release.ts", "build", "--out", artifactRoot, "--commit", commit],
      { cwd: sourceRoot, stderr: "pipe", stdout: "pipe" },
    );
    const [exitCode, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).status).toBe("built");
    expect((await OperatorRelease.inspect({ artifactRoot })).status).toBe("complete");
  }, 300_000);

  test("refuses to build without the commit it is built from", async () => {
    const child = Bun.spawn(["bun", "scripts/release.ts", "build", "--out", outputRoot()], {
      cwd: sourceRoot,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

    expect(exitCode).toBe(2);
    expect(stderr).toContain("--commit");
  });
});
