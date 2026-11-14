import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
// Bun has no temporary-directory, realpath, symlink, or recursive removal API.
import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Err, Ok } from "unthrown";
import { sha256 } from "../../lib/sha256.ts";
import { DeviceState } from "../device-state/main.ts";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { WorktreePreparation } from "./main.ts";

const env = Environment.child({
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
});
const run = ToolInvocation.run;
const copiedDetail = "Copied 2 environment files, preserved 1, refused 1.";

let root = "";
let controller = "";
let worktree = "";
let paths: ReturnType<typeof OperatorHome.resolve>;

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, env, stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}

/** A checkout with committed files and a linked worktree. Its ignored inputs stay out of Git. */
async function repository(name: string) {
  const checkout = `${root}/${name}`;
  await Bun.write(`${checkout}/.gitignore`, ".env*\nnode_modules\nignored.txt\n", {
    createPath: true,
  });
  await Bun.write(`${checkout}/package.json`, "{}\n");
  git(checkout, "init", "-q", "-b", "main");
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "fixture");
  git(checkout, "worktree", "add", "-q", "-b", "task", `${checkout}-worktree`);
  return { checkout, worktree: `${checkout}-worktree` };
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "operator-prepare-")));
  paths = OperatorHome.resolve(Environment.parse({ HOME: `${root}/home`, NODE_ENV: "test" }));
  ({ checkout: controller, worktree } = await repository("controller"));
  for (const file of [
    ".env.local",
    ".env.development.local",
    "apps/web/.env.test.local",
    ".env",
    "ignored.txt",
    "node_modules/pkg/.env.local",
    "secret",
  ])
    await Bun.write(`${controller}/${file}`, `${file}\n`, { createPath: true });
  await symlink(`${controller}/secret`, `${controller}/.env.link.local`);
  await Bun.write(`${worktree}/apps/web/.env.test.local`, "C=worktree\n", { createPath: true });
  expect(
    DeviceState.registerProject(paths, {
      repository: "example/one",
      checkout: controller,
      registeredAt: "now",
    }).tag,
  ).toBe("Ok");
});

afterEach(async () => {
  mock.restore();
  await rm(root, { recursive: true, force: true });
});

/** Git runs for real. The Bun install answers as the test says and records its request. */
function install(answer: (input: Parameters<typeof run>[0]) => ReturnType<typeof run>) {
  const requests: Parameters<typeof run>[0][] = [];
  spyOn(ToolInvocation, "run").mockImplementation((input) => {
    if (input.tool !== process.execPath) return run(input);
    requests.push(input);
    return answer(input);
  });
  return requests;
}

function stateOf(file: string) {
  const read = DeviceState.readPreparation(paths, file);
  return read.tag === "Ok" ? { state: read.value?.state, detail: read.value?.detail } : read;
}

test("copies approved environment files and records the preparation without a lockfile", async () => {
  const requests = install(() => Promise.reject(new Error("not called")));
  expect(await WorktreePreparation.prepare({ paths, worktree })).toEqual(
    Ok({
      reason: "worktree_prepared",
      data: {
        worktree,
        repository: "example/one",
        detail: `${copiedDetail} No Bun lockfile, so no dependencies were installed.`,
      },
    }),
  );
  expect(await Bun.file(`${worktree}/.env.local`).text()).toBe(".env.local\n");
  expect(await Bun.file(`${worktree}/.env.development.local`).text()).toBe(
    ".env.development.local\n",
  );
  expect(await Bun.file(`${worktree}/apps/web/.env.test.local`).text()).toBe("C=worktree\n");
  for (const file of [".env", "ignored.txt", "node_modules/pkg/.env.local", ".env.link.local"])
    expect(await Bun.file(`${worktree}/${file}`).exists()).toBe(false);
  expect(requests).toEqual([]);
  expect(stateOf(worktree)).toEqual({
    state: "prepared",
    detail: `${copiedDetail} No Bun lockfile, so no dependencies were installed.`,
  });
});

test.each(["bun.lock", "bun.lockb"])(
  "a %s lockfile installs dependencies in the worktree",
  async (lockfile) => {
    await Bun.write(`${worktree}/${lockfile}`, "lock\n");
    const requests = install(() =>
      Promise.resolve({ status: "completed", exitCode: 0, stdout: "", stderr: "" }),
    );
    const detail = `${copiedDetail} Installed dependencies from the lockfile.`;
    expect(await WorktreePreparation.prepare({ paths, worktree })).toEqual(
      Ok({ reason: "worktree_prepared", data: { worktree, repository: "example/one", detail } }),
    );
    expect(requests).toEqual([
      {
        tool: process.execPath,
        args: ["install", "--frozen-lockfile"],
        cwd: worktree,
        timeoutMs: 600000,
      },
    ]);
    expect(stateOf(worktree)).toEqual({ state: "prepared", detail });
  },
);

test("the install records the ignored files that its lifecycle scripts wrote", async () => {
  await Bun.write(`${worktree}/bun.lock`, "lock\n");
  git(worktree, "add", "bun.lock");
  await Bun.write(`${worktree}/ignored.txt`, "before\n");
  install(async () => {
    await Bun.write(`${worktree}/.husky/_/.gitignore`, "*\n", { createPath: true });
    await Bun.write(`${worktree}/.husky/_/h`, "hook\n");
    await Bun.write(`${worktree}/node_modules/pkg/index.js`, "x\n", { createPath: true });
    return { status: "completed", exitCode: 0, stdout: "", stderr: "" };
  });
  expect((await WorktreePreparation.prepare({ paths, worktree })).tag).toBe("Ok");
  const read = DeviceState.readPreparation(paths, worktree);
  const installed = read.tag === "Ok" ? read.value?.installed : null;
  expect(JSON.parse(installed ?? "null")).toEqual([
    {
      path: ".husky/_/.gitignore",
      hash: sha256("*\n"),
    },
    { path: ".husky/_/h", hash: sha256("hook\n") },
  ]);
  const ignored = [".husky/_/.gitignore", ".husky/_/h", "ignored.txt", "node_modules/"];
  expect(
    await WorktreePreparation.classifyIgnored({ paths, worktree, controller, ignored }),
  ).toEqual(
    Ok({
      generated: [".husky/_/.gitignore", ".husky/_/h", "node_modules/"],
      unknown: ["ignored.txt"],
    }),
  );
});

test("an install whose ignored files Git cannot list records no install output", async () => {
  await Bun.write(`${worktree}/bun.lock`, "lock\n");
  spyOn(ToolInvocation, "run").mockImplementation(async (input) => {
    if (input.tool === process.execPath) {
      await Bun.write(`${worktree}/.husky/_/h`, "hook\n", { createPath: true });
      return { status: "completed", exitCode: 0, stdout: "", stderr: "" };
    }
    // Only the worktree listings fail. The controller still lists its environment files.
    return input.args.includes("ls-files") && input.args.includes(worktree)
      ? { status: "completed", exitCode: 128, stdout: "", stderr: "fatal" }
      : run(input);
  });
  expect((await WorktreePreparation.prepare({ paths, worktree })).tag).toBe("Ok");
  expect(DeviceState.readPreparation(paths, worktree)).toMatchObject({
    value: { state: "prepared", installed: null },
  });
});

test.each([
  {
    name: "its error output",
    answer: { status: "completed" as const, exitCode: 1, stdout: "out\n", stderr: " frozen\n" },
    reason: "frozen",
  },
  {
    name: "its standard output when it wrote no error",
    answer: { status: "completed" as const, exitCode: 1, stdout: " out\n", stderr: "" },
    reason: "out",
  },
  {
    name: "a failure even with exit 0 when it gave no answer",
    answer: { status: "no-answer" as const, detail: "bun install ended on SIGTERM." },
    reason: "bun install ended on SIGTERM.",
  },
])("a failed install records $name", async ({ answer, reason }) => {
  await Bun.write(`${worktree}/bun.lock`, "lock\n");
  install(() => Promise.resolve(answer));
  const detail = `${copiedDetail} bun install --frozen-lockfile failed: ${reason}`;
  expect(await WorktreePreparation.prepare({ paths, worktree })).toEqual(
    Err({ reason: "preparation_failed", detail }),
  );
  expect(stateOf(worktree)).toEqual({ state: "failed", detail });
});

test("a Git listing failure records a failed preparation and copies nothing", async () => {
  spyOn(ToolInvocation, "run").mockImplementation((input) =>
    input.args.includes("ls-files")
      ? Promise.resolve({ status: "completed", exitCode: 128, stdout: "", stderr: "fatal" })
      : run(input),
  );
  const detail = "Git could not list ignored environment files.";
  expect(await WorktreePreparation.prepare({ paths, worktree })).toEqual(
    Err({ reason: "preparation_failed", detail }),
  );
  expect(await Bun.file(`${worktree}/.env.local`).exists()).toBe(false);
  expect(stateOf(worktree)).toEqual({ state: "failed", detail });
});

test("a stopped preparation is recorded as failed and releases its lease", async () => {
  const hold = DeviceState.holdPreparation;
  const release = mock(() => {});
  const held = spyOn(DeviceState, "holdPreparation").mockImplementation((...args) => {
    const stop = hold(...args);
    return () => {
      stop();
      release();
    };
  });
  await Bun.write(`${worktree}/bun.lock`, "lock\n");
  install(() => Promise.reject(new Error("install crashed")));
  const detail = "Preparation stopped: Error: install crashed";
  expect(await WorktreePreparation.prepare({ paths, worktree })).toEqual(
    Err({ reason: "preparation_failed", detail }),
  );
  expect(held).toHaveBeenCalledWith(paths, worktree);
  expect(release).toHaveBeenCalledTimes(1);
  expect(stateOf(worktree)).toEqual({ state: "failed", detail });
});

test("a running preparation of the same worktree refuses a second one", async () => {
  expect(DeviceState.beginPreparation(paths, worktree, "example/one").tag).toBe("Ok");
  expect(await WorktreePreparation.prepare({ paths, worktree })).toMatchObject({
    tag: "Err",
    error: { reason: "preparation_running" },
  });
  expect(await Bun.file(`${worktree}/.env.local`).exists()).toBe(false);
});

test("a linked path is prepared at its real worktree for the project that owns it", async () => {
  const other = await repository("other");
  expect(
    DeviceState.registerProject(paths, {
      repository: "example/two",
      checkout: other.checkout,
      registeredAt: "now",
    }).tag,
  ).toBe("Ok");
  await symlink(worktree, `${root}/link`);
  for (const { input, real, repository } of [
    { input: `${root}/link`, real: worktree, repository: "example/one" },
    { input: other.worktree, real: other.worktree, repository: "example/two" },
  ])
    expect(await WorktreePreparation.prepare({ paths, worktree: input })).toMatchObject({
      tag: "Ok",
      value: { reason: "worktree_prepared", data: { worktree: real, repository } },
    });
});

test("a controller, an unregistered clone, or a plain folder is never prepared", async () => {
  const clone = await repository("clone");
  await mkdir(`${root}/plain`);
  // A project whose checkout is gone has no Git directory either, which is no match.
  expect(
    DeviceState.registerProject(paths, {
      repository: "example/gone",
      checkout: `${root}/gone`,
      registeredAt: "now",
    }).tag,
  ).toBe("Ok");
  for (const folder of [controller, clone.worktree, `${root}/plain`]) {
    expect(await WorktreePreparation.prepare({ paths, worktree: folder })).toEqual(
      Ok({ reason: "worktree_unregistered", data: { worktree: folder } }),
    );
    expect(DeviceState.readPreparation(paths, folder)).toEqual(Ok(null));
  }
  expect(await Bun.file(`${clone.worktree}/.env.local`).exists()).toBe(false);
});

test("a missing worktree is a filesystem failure", async () => {
  expect(await WorktreePreparation.prepare({ paths, worktree: `${root}/missing` })).toMatchObject({
    tag: "Err",
    error: { reason: "preparation_io_failed" },
  });
});

test.each(["ENOENT", "EACCES", "EPERM", "EIO", "EROFS", "ENOSPC", "ENOTDIR", "EEXIST", "ELOOP"])(
  "a %s failure is a filesystem failure, and other failures stay defects",
  async (code) => {
    const failure = Object.assign(new Error("git failed"), { code });
    const spy = spyOn(ToolInvocation, "run").mockRejectedValue(failure);
    expect(await WorktreePreparation.prepare({ paths, worktree })).toEqual(
      Err({ reason: "preparation_io_failed", detail: "Error: git failed" }),
    );
    spy.mockRejectedValue(Object.assign(new Error("git failed"), { code: "EBUSY" }));
    expect(await WorktreePreparation.prepare({ paths, worktree })).toMatchObject({
      tag: "Defect",
    });
    spy.mockRejectedValue({ code });
    expect(await WorktreePreparation.prepare({ paths, worktree })).toMatchObject({
      tag: "Defect",
    });
  },
);

test("a lease failure before preparation is a filesystem failure", async () => {
  spyOn(DeviceState, "holdPreparation").mockImplementation(() => {
    // oxlint-disable-next-line unthrown/no-throw -- The fake lease fails as the file system does.
    throw Object.assign(new Error("lease failed"), { code: "EIO" });
  });
  expect(await WorktreePreparation.prepare({ paths, worktree })).toEqual(
    Err({ reason: "preparation_io_failed", detail: "Error: lease failed" }),
  );
});

const ignored = [
  ".env.local",
  ".env.development.local",
  ".env.extra.local",
  ".env.gone.local",
  "notes.local",
  "node_modules/",
  "dist/",
];

async function prepared() {
  await Bun.write(`${worktree}/bun.lock`, "lock\n");
  git(worktree, "add", "bun.lock");
  install(() => Promise.resolve({ status: "completed", exitCode: 0, stdout: "", stderr: "" }));
  expect((await WorktreePreparation.prepare({ paths, worktree })).tag).toBe("Ok");
  await Bun.write(`${worktree}/.env.development.local`, "B=changed\n");
  await Bun.write(`${worktree}/.env.extra.local`, "X=1\n");
  await Bun.write(`${controller}/.env.gone.local`, "G=1\n");
  await Bun.write(`${controller}/notes.local`, "same\n");
  await Bun.write(`${worktree}/notes.local`, "same\n");
  await Bun.write(`${worktree}/node_modules/pkg/index.js`, "x\n", { createPath: true });
  await Bun.write(`${worktree}/dist/out.js`, "x\n", { createPath: true });
}

test("only unchanged copies and installed dependencies of a prepared worktree are output", async () => {
  await prepared();
  expect(
    await WorktreePreparation.classifyIgnored({ paths, worktree, controller, ignored }),
  ).toEqual(
    Ok({
      generated: [".env.local", "node_modules/"],
      unknown: [
        ".env.development.local",
        ".env.extra.local",
        ".env.gone.local",
        "notes.local",
        "dist/",
      ],
    }),
  );
});

test("an unprepared or still running worktree holds no preparation output", async () => {
  // Each entry would be output of a finished preparation.
  const entries = [".env.local", "node_modules/"];
  await Bun.write(`${worktree}/.env.local`, ".env.local\n");
  await Bun.write(`${worktree}/bun.lock`, "lock\n");
  git(worktree, "add", "bun.lock");
  const input = { paths, worktree, controller, ignored: entries };
  expect(await WorktreePreparation.classifyIgnored(input)).toEqual(
    Ok({ generated: [], unknown: entries }),
  );
  const row = DeviceState.beginPreparation(paths, worktree, "example/one");
  expect(await WorktreePreparation.classifyIgnored(input)).toEqual(
    Ok({ generated: [], unknown: entries }),
  );
  // A stopped hook can have written output before it ended.
  expect(row.tag).toBe("Ok");
  if (row.tag === "Ok")
    spyOn(DeviceState, "readPreparation").mockReturnValue(Ok({ ...row.value, abandoned: true }));
  expect(await WorktreePreparation.classifyIgnored(input)).toEqual(
    Ok({ generated: entries, unknown: [] }),
  );
});

test("a prepared folder that Git cannot list holds no preparation output", async () => {
  const plain = `${root}/plain`;
  await Bun.write(`${plain}/.env.local`, "A=1\n", { createPath: true });
  DeviceState.beginPreparation(paths, plain, "example/one");
  DeviceState.finishPreparation(paths, plain, { state: "prepared", detail: "done" });
  expect(
    await WorktreePreparation.classifyIgnored({
      paths,
      worktree: plain,
      controller,
      ignored: [".env.local"],
    }),
  ).toEqual(Ok({ generated: [], unknown: [".env.local"] }));
});

test("a filesystem failure while classifying is qualified", async () => {
  await prepared();
  spyOn(ToolInvocation, "run").mockRejectedValue(
    Object.assign(new Error("git failed"), { code: "EIO" }),
  );
  expect(
    await WorktreePreparation.classifyIgnored({ paths, worktree, controller, ignored }),
  ).toEqual(Err({ reason: "preparation_io_failed", detail: "Error: git failed" }));
});

test("ignored environment inspection compares all env forms and protects links without preparation records", async () => {
  await Bun.write(`${controller}/.git/info/exclude`, ".env*\n*.env*\nbuild/\ncache/\n");
  for (const file of [".env", ".env.production", "app.env.local", "build/.env.test"]) {
    await Bun.write(`${controller}/${file}`, "same\n", { createPath: true });
    await Bun.write(`${worktree}/${file}`, "same\n", { createPath: true });
  }
  await Bun.write(`${worktree}/.env.production`, "changed\n");
  await Bun.write(`${worktree}/build/.env.only-here`, "new\n");
  await Bun.write(`${worktree}/cache/output.log`, "ignored output\n", { createPath: true });
  await Bun.write(`${controller}/.env.link`, "same\n");
  await symlink(`${controller}/.env.link`, `${worktree}/.env.link`);
  expect(await WorktreePreparation.changedIgnoredEnvironment({ worktree, controller })).toEqual(
    Ok([".env.link", ".env.production", "apps/web/.env.test.local", "build/.env.only-here"]),
  );
  spyOn(ToolInvocation, "run").mockResolvedValue({
    status: "unavailable",
    tool: "git",
    detail: "unavailable",
  });
  expect(await WorktreePreparation.changedIgnoredEnvironment({ worktree, controller })).toEqual(
    Ok(null),
  );
});

test("an actual ignored-environment inspection I/O failure is qualified at the new capability", async () => {
  spyOn(ToolInvocation, "run").mockRejectedValue(
    Object.assign(new Error("environment inspection failed"), { code: "EIO" }),
  );
  expect(await WorktreePreparation.changedIgnoredEnvironment({ worktree, controller })).toEqual(
    Err({ reason: "preparation_io_failed", detail: "Error: environment inspection failed" }),
  );
});

test("ignored repositories contribute actual environment files, not directory placeholders or linked descendants", async () => {
  await Bun.write(`${controller}/.git/info/exclude`, "build/\n");
  await Bun.write(`${worktree}/build/output.js`, "generated\n", { createPath: true });
  git(`${worktree}/build`, "init", "-q");
  expect(await WorktreePreparation.changedIgnoredEnvironment({ worktree, controller })).toEqual(
    Ok(["apps/web/.env.test.local"]),
  );
  for (const file of [".env", ".env.production", "app.env", "app.env.local", "nested/.env.test"]) {
    await Bun.write(`${worktree}/build/${file}`, "changed\n", { createPath: true });
    await Bun.write(`${controller}/build/${file}`, "original\n", { createPath: true });
  }
  await Bun.write(`${worktree}/build/.env.same`, "same\n");
  await Bun.write(`${controller}/build/.env.same`, "same\n");
  await mkdir(`${worktree}/build/.env.directory`);
  await symlink(`${root}/missing`, `${worktree}/build/.env.broken`);
  await Bun.write(`${root}/outside/.env`, "outside\n", { createPath: true });
  await symlink(`${root}/outside`, `${worktree}/build/linked-directory`);
  const result = await WorktreePreparation.changedIgnoredEnvironment({ worktree, controller });
  expect(result.tag).toBe("Ok");
  expect(result.getOr([])?.toSorted()).toEqual([
    "apps/web/.env.test.local",
    "build/.env",
    "build/.env.broken",
    "build/.env.production",
    "build/app.env",
    "build/app.env.local",
    "build/nested/.env.test",
  ]);
});

test.skipIf(process.getuid?.() === 0)(
  "an unreadable ignored repository refuses environment inspection instead of treating it as generated-only",
  async () => {
    await Bun.write(`${controller}/.git/info/exclude`, "build/\n");
    await Bun.write(`${worktree}/build/.env`, "private\n", { createPath: true });
    git(`${worktree}/build`, "init", "-q");
    await chmod(`${worktree}/build`, 0);
    try {
      expect(
        await WorktreePreparation.changedIgnoredEnvironment({ worktree, controller }),
      ).toMatchObject({ tag: "Err", error: { reason: "preparation_io_failed" } });
    } finally {
      await chmod(`${worktree}/build`, 0o755);
    }
    expect(await Bun.file(`${worktree}/build/.env`).text()).toBe("private\n");
  },
);
