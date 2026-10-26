import { afterAll, expect, spyOn, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
