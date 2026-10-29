import { afterAll, expect, spyOn, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Err, Ok } from "unthrown";
import path from "node:path";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { DeviceState } from "../device-state/main.ts";
import { Projects } from "./main.ts";

const root = await realpath(await mkdtemp(path.join(tmpdir(), "operator-project-module-")));
const paths = OperatorHome.resolve(Environment.parse({ HOME: `${root}/home`, NODE_ENV: "test" }));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("registers through the interface, preserves repeat identity, and refuses an alternate clone", async () => {
  for (const name of ["one", "other"]) {
    await mkdir(`${root}/${name}`);
    for (const args of [
      ["init", "-q"],
      ["remote", "add", "name", "git@github.com:owner/repo.git"],
    ]) {
      const child = Bun.spawn(["git", ...args], {
        cwd: `${root}/${name}`,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await child.exited).toBe(0);
    }
  }
  const input = { paths, cwd: `${root}/one` };
  expect(await Projects.current(input)).toMatchObject({
    tag: "Err",
    error: { reason: "state_missing" },
  });
  const registered = await Projects.register(input);
  expect(registered).toMatchObject({
    tag: "Ok",
    value: {
      reason: "project_registered",
      data: { repository: "owner/repo", checkout: input.cwd },
    },
  });
  expect(await Projects.register(input)).toMatchObject({
    tag: "Ok",
    value: { reason: "project_unchanged" },
  });
  expect(await Projects.current(input)).toMatchObject({
    tag: "Ok",
    value: { reason: "project_resolved" },
  });
  expect(await Projects.current({ paths, cwd: `${root}/other` })).toMatchObject({
    tag: "Err",
    error: { reason: "controller_mismatch" },
  });
  expect(await Projects.list(paths)).toMatchObject({
    tag: "Ok",
    value: {
      reason: "projects_listed",
      data: { projects: [{ repository: "owner/repo", controller: { status: "available" } }] },
    },
  });
  expect(await Projects.move({ paths, cwd: `${root}/other` })).toMatchObject({
    tag: "Ok",
    value: { data: { checkout: `${root}/other` } },
  });
  expect(Projects.remove({ paths, repository: "../unsafe", personInstructed: true })).toMatchObject(
    { tag: "Err", error: { reason: "repository_choice_invalid" } },
  );
  expect(
    Projects.remove({ paths, repository: "owner/repo", personInstructed: false }),
  ).toMatchObject({ tag: "Err", error: { reason: "person_instruction_required" } });
  expect(
    Projects.remove({ paths, repository: "owner/repo", personInstructed: true }),
  ).toMatchObject({ tag: "Ok", value: { reason: "project_removed" } });
});

test("preserves operational failures and separates unexpected defects", async () => {
  expect(
    DeviceState.registerProject(paths, {
      repository: "owner/listed",
      checkout: root,
      registeredAt: "now",
    }).tag,
  ).toBe("Ok");
  const spy = spyOn(ToolInvocation, "run");
  try {
    spy.mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
    expect(await Projects.register({ paths, cwd: root })).toMatchObject({
      tag: "Err",
      error: { reason: "project_io_failed" },
    });
    expect(await Projects.list(paths)).toMatchObject({
      tag: "Ok",
      value: {
        data: {
          projects: [
            {
              repository: "owner/listed",
              controller: { status: "blocked", reason: "project_io_failed" },
            },
          ],
        },
      },
    });
    spy.mockRejectedValue(new TypeError("implementation defect"));
    expect(await Projects.current({ paths, cwd: root })).toMatchObject({ tag: "Defect" });
    expect(await Projects.list(paths)).toMatchObject({ tag: "Defect" });
  } finally {
    spy.mockRestore();
  }
});

async function clone(directory: string, remote?: string) {
  await mkdir(directory, { recursive: true });
  const steps =
    remote === undefined
      ? [["init", "-q"]]
      : [
          ["init", "-q"],
          ["remote", "add", "name", remote],
        ];
  for (const args of steps) {
    const child = Bun.spawn(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
  }
}

function freshPaths(name: string) {
  return OperatorHome.resolve(Environment.parse({ HOME: `${root}/${name}`, NODE_ENV: "test" }));
}

test("current names identity changes, other clones, and unregistered checkouts", async () => {
  const device = freshPaths("current-home");
  const base = `${root}/current`;
  await clone(`${base}/controller`, "git@github.com:owner/current.git");
  await clone(`${base}/alternate`, "https://github.com/owner/current");
  await clone(`${base}/unrelated`, "https://github.com/owner/unrelated");
  expect(await Projects.register({ paths: device, cwd: `${base}/controller` })).toMatchObject({
    tag: "Ok",
    value: {
      reason: "project_registered",
      data: { repository: "owner/current", checkout: `${base}/controller` },
    },
  });
  expect(await Projects.current({ paths: device, cwd: `${base}/alternate` })).toEqual(
    Err({
      reason: "controller_mismatch",
      detail: `Use the recorded controlling checkout at ${base}/controller. To change it, run operator project move from a matching main clone when no source is open.`,
    }),
  );
  await clone(`${base}/second`, "https://github.com/owner/second");
  expect((await Projects.register({ paths: device, cwd: `${base}/second` })).tag).toBe("Ok");
  await clone(`${base}/both`, "https://github.com/owner/current");
  const add = Bun.spawn(["git", "remote", "add", "extra", "https://github.com/owner/second"], {
    cwd: `${base}/both`,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await add.exited).toBe(0);
  expect(await Projects.current({ paths: device, cwd: `${base}/both` })).toEqual(
    Err({
      reason: "controller_mismatch",
      detail: `Use the recorded controlling checkout at ${base}/controller, ${base}/second. To change it, run operator project move from a matching main clone when no source is open.`,
    }),
  );
  await mkdir(`${base}/outside`);
  expect(await Projects.current({ paths: device, cwd: `${base}/outside` })).toMatchObject({
    tag: "Err",
    error: { reason: "git_checkout_invalid" },
  });
  expect(await Projects.current({ paths: device, cwd: `${base}/unrelated` })).toEqual(
    Err({
      reason: "project_not_registered",
      detail: "This checkout is not registered. Run operator project register explicitly.",
    }),
  );
  const child = Bun.spawn(
    ["git", "remote", "set-url", "name", "https://github.com/owner/renamed"],
    { cwd: `${base}/controller`, stdout: "pipe", stderr: "pipe" },
  );
  expect(await child.exited).toBe(0);
  expect(await Projects.current({ paths: device, cwd: `${base}/controller` })).toEqual(
    Err({
      reason: "controller_identity_mismatch",
      detail:
        "The controlling checkout no longer has the recorded owner/current remote. Restore it before use.",
    }),
  );
  expect(
    await Projects.githubRemote({ checkout: `${base}/alternate`, repository: "owner/current" }),
  ).toEqual(Ok("name"));
  expect(
    await Projects.githubRemote({ checkout: `${base}/alternate`, repository: "owner/other" }),
  ).toEqual(Ok(null));
});

test("register and move refuse checkout and repository choice failures without writes", async () => {
  const device = freshPaths("refusal-home");
  const base = `${root}/refusal`;
  await clone(`${base}/plain`);
  await clone(`${base}/github`, "https://github.com/owner/refusal");
  await mkdir(`${base}/outside`, { recursive: true });
  const missing = Err({
    reason: "github_remote_missing" as const,
    detail: "This checkout has no github.com remote. Add a matching remote before registration.",
  });
  expect(await Projects.register({ paths: device, cwd: `${base}/plain` })).toEqual(missing);
  expect(await Projects.move({ paths: device, cwd: `${base}/plain` })).toEqual(missing);
  for (const action of [Projects.register, Projects.move]) {
    expect(await action({ paths: device, cwd: `${base}/outside` })).toMatchObject({
      tag: "Err",
      error: { reason: "git_checkout_invalid" },
    });
    expect(
      await action({ paths: device, cwd: `${base}/github`, repository: "owner/other" }),
    ).toMatchObject({ tag: "Err", error: { reason: "repository_choice_invalid" } });
  }
  expect(await Bun.file(device.database).exists()).toBe(false);
  expect(
    Projects.remove({ paths: device, repository: "../unsafe", personInstructed: true }),
  ).toEqual(
    Err({
      reason: "repository_choice_invalid",
      detail: "Removal requires an explicit owner/repository identity.",
    }),
  );
  expect(
    Projects.remove({ paths: device, repository: "owner/refusal", personInstructed: false }),
  ).toEqual(
    Err({
      reason: "person_instruction_required",
      detail:
        "Remove a project only on the person's explicit instruction. --person-instructed attests that instruction, it does not grant authority.",
    }),
  );
});

test("lists available, missing, mismatched, and blocked controllers", async () => {
  const device = freshPaths("list-home");
  const base = `${root}/list`;
  await clone(`${base}/available`, "https://github.com/owner/available");
  await clone(`${base}/renamed`, "https://github.com/owner/renamed");
  await clone(`${base}/parent`, "https://github.com/owner/nested");
  await mkdir(`${base}/parent/nested`);
  await mkdir(`${base}/plain`);
  expect((await Projects.register({ paths: device, cwd: `${base}/available` })).tag).toBe("Ok");
  for (const [repository, checkout] of [
    ["owner/blocked", `${base}/plain`],
    ["owner/gone", `${base}/gone`],
    ["owner/moved", `${base}/renamed`],
    ["owner/nested", `${base}/parent/nested`],
  ] as const)
    expect(
      DeviceState.registerProject(device, { repository, checkout, registeredAt: "now" }).tag,
    ).toBe("Ok");
  const result = await Projects.list(device);
  expect(result).toMatchObject({
    tag: "Ok",
    value: {
      reason: "projects_listed",
      data: {
        projects: [
          { repository: "owner/available", controller: { status: "available" } },
          {
            repository: "owner/blocked",
            controller: { status: "blocked", reason: "git_checkout_invalid" },
          },
          { repository: "owner/gone", controller: { status: "missing" } },
          { repository: "owner/moved", controller: { status: "mismatched" } },
          { repository: "owner/nested", controller: { status: "mismatched" } },
        ],
        pendingRemovals: [],
      },
    },
  });
});

function interfaceCalls() {
  return {
    register: () => Projects.register({ paths, cwd: root }),
    move: () => Projects.move({ paths, cwd: root }),
    current: () => Projects.current({ paths, cwd: root }),
    githubRemote: () => Projects.githubRemote({ checkout: root, repository: "owner/repo" }),
    list: () => Projects.list(paths),
  };
}

test.each(["ENOENT", "EACCES", "EPERM", "EIO", "EROFS", "ENOSPC", "ENOTDIR", "EEXIST"])(
  "a %s observation failure is a project I/O refusal",
  async (code) => {
    const cause = Object.assign(new Error("observation failed"), { code });
    const tools = spyOn(ToolInvocation, "run").mockRejectedValue(cause);
    const state = spyOn(DeviceState, "listProjects").mockImplementation(() => {
      // oxlint-disable-next-line unthrown/no-throw -- Inject a filesystem failure at the state interface.
      throw cause;
    });
    try {
      for (const call of Object.values(interfaceCalls()))
        expect(await call()).toEqual(
          Err({ reason: "project_io_failed", detail: "Error: observation failed" }),
        );
    } finally {
      tools.mockRestore();
      state.mockRestore();
    }
  },
);

test("other rejections remain defects with their original cause", async () => {
  const spy = spyOn(ToolInvocation, "run");
  try {
    for (const cause of [
      Object.assign(new Error("reset"), { code: "ECONNRESET" }),
      new TypeError("defect"),
      null,
    ]) {
      spy.mockRejectedValue(cause);
      for (const [name, call] of Object.entries(interfaceCalls())) {
        const result = await call();
        expect({ name, tag: result.tag }).toEqual({ name, tag: "Defect" });
        if (result.tag === "Defect") expect(result.cause).toBe(cause);
      }
    }
  } finally {
    spy.mockRestore();
  }
});

test("a state read that throws a non-error remains a defect", async () => {
  const spy = spyOn(DeviceState, "listProjects").mockImplementation(() => {
    // oxlint-disable-next-line unthrown/no-throw -- Inject a non-error throw at the state interface.
    throw null;
  });
  try {
    expect(await Projects.list(paths)).toMatchObject({ tag: "Defect", cause: null });
  } finally {
    spy.mockRestore();
  }
});
