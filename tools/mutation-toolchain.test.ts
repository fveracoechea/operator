import { afterAll, expect, test } from "bun:test";
// Bun has no temporary-directory, file mode, copy, rename or link API.
import { chmod, cp, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import path from "node:path";

const root = await mkdtemp("/tmp/opencode/mutation-toolchain-");
afterAll(() => rm(root, { recursive: true, force: true }));

async function identity(tools: string, runtime: string): Promise<string> {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import {mutationToolchainIdentity} from ${JSON.stringify(path.join(import.meta.dir, "mutation-toolchain.ts"))}; try { console.log(await mutationToolchainIdentity(${JSON.stringify(tools)}, ${JSON.stringify(runtime)})); } catch(error) { console.error(error.message); process.exitCode = 1; }`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => child.kill(), 500);
  try {
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) return await Promise.reject(new Error(`${code}: ${error}`));
    return output.trim();
  } finally {
    clearTimeout(timer);
  }
}

test("installed engine, runner and runtime bytes participate in toolchain identity", async () => {
  const directory = path.join(root, crypto.randomUUID());
  const tools = `${directory}/tools`;
  const runtime = `${directory}/runtime`;
  await Bun.write(`${tools}/mutate.ts`, "runner one");
  await Bun.write(runtime, "runtime one");
  await Bun.write(
    `${directory}/node_modules/@stryker-mutator/core/package.json`,
    '{"dependencies":{"engine-helper":"1"}}',
  );
  await Bun.write(`${directory}/node_modules/@stryker-mutator/core/engine.js`, "engine one");
  await Bun.write(`${directory}/node_modules/engine-helper/package.json`, "{}");
  await Bun.write(`${directory}/node_modules/engine-helper/helper.js`, "helper one");
  for (const name of ["@babel/parser", "@babel/types", "zod"])
    await Bun.write(`${directory}/node_modules/${name}/package.json`, "{}");
  const first = await identity(tools, runtime);
  expect(first).toMatch(/^[a-f\d]{64}$/);
  expect(await identity(tools, runtime)).toBe(first);
  for (const file of [
    `${tools}/mutate.ts`,
    runtime,
    `${directory}/node_modules/@stryker-mutator/core/engine.js`,
    `${directory}/node_modules/engine-helper/helper.js`,
  ]) {
    const previous = await identity(tools, runtime);
    await Bun.write(file, "changed bytes");
    expect(await identity(tools, runtime)).not.toBe(previous);
  }
  const afterEdits = await identity(tools, runtime);
  await Bun.write(`${tools}/noise.ts`, "irrelevant");
  await Bun.write(`${tools}/mutation-helper.test.ts`, "irrelevant");
  await Bun.write(`${directory}/node_modules/engine-helper/node_modules/ignored`, "irrelevant");
  expect(await identity(tools, runtime)).toBe(afterEdits);
  await Bun.write(`${tools}/mutation-helper.ts`, "behavior");
  const newRunner = await identity(tools, runtime);
  expect(newRunner).not.toBe(afterEdits);
  await cp(tools, `${directory}/copied-tools`, { recursive: true });
  expect(await identity(`${directory}/copied-tools`, runtime)).toBe(newRunner);
  await chmod(runtime, 0o755);
  const executable = await identity(tools, runtime);
  expect(executable).not.toBe(newRunner);
  await rename(
    `${directory}/node_modules/engine-helper/helper.js`,
    `${directory}/node_modules/engine-helper/renamed.js`,
  );
  expect(await identity(tools, runtime)).not.toBe(executable);
  await Bun.write(
    `${directory}/node_modules/engine-helper/package.json`,
    '{"optionalDependencies":{"optional-engine-helper":"1"}}',
  );
  const absent = await identity(tools, runtime);
  await Bun.write(`${directory}/node_modules/optional-engine-helper/package.json`, "{}");
  await Bun.write(
    `${directory}/node_modules/optional-engine-helper/deep/nested.js`,
    "optional behavior",
  );
  expect(await identity(tools, runtime)).not.toBe(absent);
  await Bun.write(
    `${directory}/node_modules/optional-engine-helper/package.json`,
    '{"dependencies":{"required-but-missing-engine-helper":"1"}}',
  );
  await expect(identity(tools, runtime)).rejects.toThrow(
    "Unresolved installed dependency: required-but-missing-engine-helper",
  );
  await Bun.write(`${directory}/node_modules/optional-engine-helper/package.json`, "{}");
  await symlink(
    `${directory}/node_modules/optional-engine-helper/deep`,
    `${directory}/node_modules/engine-helper/unsupported-link`,
  );
  await expect(identity(tools, runtime)).rejects.toThrow("Unsupported installed input:");
  const missing = `missing-${crypto.randomUUID()}`;
  await Bun.write(
    `${directory}/node_modules/@stryker-mutator/core/package.json`,
    JSON.stringify({ dependencies: { [missing]: "1" } }),
  );
  await expect(identity(tools, runtime)).rejects.toThrow(
    `Unresolved installed dependency: ${missing}`,
  );
  await Bun.write(
    `${directory}/node_modules/@stryker-mutator/core/package.json`,
    '{"dependencies":{"engine-helper":"1"}}',
  );
  await rm(`${directory}/node_modules/engine-helper/unsupported-link`);
  await Bun.write(
    `${directory}/node_modules/engine-helper/package.json`,
    '{"dependencies":{"@stryker-mutator/core":"1"}}',
  );
  expect(await identity(tools, runtime)).toMatch(/^[a-f\d]{64}$/);
  const beforeNested = await identity(tools, runtime);
  await Bun.write(`${tools}/node_modules/@stryker-mutator/core/package.json`, "{}");
  await Bun.write(`${tools}/node_modules/@stryker-mutator/core/engine.js`, "nested engine");
  expect(await identity(tools, runtime)).not.toBe(beforeNested);
});
