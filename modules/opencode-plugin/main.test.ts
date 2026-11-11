import { afterAll, afterEach, beforeEach, expect, expectTypeOf, mock, spyOn, test } from "bun:test";
// Bun has no temporary-directory, chmod, or recursive removal API.
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Ok } from "unthrown";
import { Environment } from "../environment/main.ts";
import { Herdr } from "../herdr/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { WorkSources } from "../work-sources/main.ts";
import { OpenCodePlugin } from "./main.ts";

const root = await mkdtemp(path.join(tmpdir(), "opencode-plugin-api-"));
const paths = OperatorHome.resolve(Environment.parse({ HOME: root, NODE_ENV: "test" }));
const file = `${root}/.config/opencode/plugins/operator.ts`;
const shipped = await Bun.file(new URL("./plugin.ts", import.meta.url)).text();
beforeEach(async () => {
  await rm(`${root}/.config`, { recursive: true, force: true });
});
afterEach(() => {
  mock.restore();
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function commit(command: string | string[], workdir?: string) {
  return JSON.stringify({
    event: "tool.execute.before",
    directory: root,
    input: { command, workdir, description: "Commit" },
  });
}

function idle(sessionID = "ses_1") {
  return JSON.stringify({ event: "session.idle", directory: "/checkout", sessionID });
}

test("the public failure reasons form a closed union", () => {
  type Failure =
    | Extract<Awaited<ReturnType<typeof OpenCodePlugin.answer>>, { tag: "Err" }>["error"]
    | Extract<Awaited<ReturnType<typeof OpenCodePlugin.install>>, { tag: "Err" }>["error"];
  expectTypeOf<Failure["reason"]>().not.toEqualTypeOf<string>();
});

test("a shell commit with a Co-Authored-By trailer gets the reason that refuses it", async () => {
  expect(
    await OpenCodePlugin.answer({
      event: commit('git commit -m "fix: x" -m "Co-Authored-By: Claude <noreply@anthropic.com>"'),
      paths,
    }),
  ).toMatchObject({
    tag: "Ok",
    value: expect.stringMatching(/Co-Authored-By.*commit again/s) as string,
  });
});

test("a -F message file is read from the shell's working folder", async () => {
  await Bun.write(`${root}/sub/message.txt`, "fix: x\n\nCo-Authored-By: A <a@b.c>\n");
  for (const [workdir, refused] of [
    ["sub", true],
    [`${root}/sub`, true],
    [undefined, false],
  ] as const)
    expect(
      await OpenCodePlugin.answer({ event: commit("git commit -F message.txt", workdir), paths }),
    ).toMatchObject({ tag: "Ok", value: refused ? (expect.any(String) as string) : "" });
});

test("a commit without the trailer, or shell input with no command, has no opinion", async () => {
  for (const event of [
    commit('git commit -m "fix: x"'),
    commit(['git commit -m "Co-Authored-By: A"']),
    JSON.stringify({ event: "tool.execute.before", directory: root, input: null }),
  ])
    expect(await OpenCodePlugin.answer({ event, paths })).toMatchObject({ tag: "Ok", value: "" });
});

test("an idle session with unwatched running work gets the reason to continue", async () => {
  const listed = spyOn(Herdr, "panes");
  const unwatched = spyOn(WorkSources, "unwatched").mockReturnValue(Ok(["one"]));
  expect(await OpenCodePlugin.answer({ event: idle(), paths })).toMatchObject({
    tag: "Ok",
    value: expect.stringContaining("running work in one") as string,
  });
  // The guard asks for the idle session itself. Herdr's pane plays no part.
  expect(unwatched).toHaveBeenCalledWith({ paths, cwd: "/checkout", session: "ses_1" });
  expect(listed).not.toHaveBeenCalled();
});

test("an idle session that supervises nothing has no opinion", async () => {
  spyOn(WorkSources, "unwatched").mockReturnValue(Ok([]));
  expect(await OpenCodePlugin.answer({ event: idle("ses_other"), paths })).toMatchObject({
    tag: "Ok",
    value: "",
  });
});

test("an idle session on a device with no state has no opinion", async () => {
  expect(await OpenCodePlugin.answer({ event: idle(), paths })).toMatchObject({
    tag: "Ok",
    value: "",
  });
});

test("an event that is not the plugin's JSON is refused", async () => {
  for (const event of [
    "",
    "{broken",
    "[]",
    JSON.stringify({ event: "session.idle", directory: root }),
    JSON.stringify({ event: "tool.execute.after", directory: root, input: {} }),
  ])
    expect(await OpenCodePlugin.answer({ event, paths })).toMatchObject({
      tag: "Err",
      error: { reason: "opencode_hook_event_invalid" },
    });
});

test("install writes the shipped plugin, and check mode then passes", async () => {
  expect(await OpenCodePlugin.install({ paths, check: true })).toMatchObject({
    tag: "Err",
    error: { reason: "opencode_plugin_missing" },
  });
  expect(await Bun.file(file).exists()).toBe(false);
  expect(await OpenCodePlugin.install({ paths, check: false })).toMatchObject({
    tag: "Ok",
    value: "installed",
  });
  expect(await Bun.file(file).text()).toBe(shipped);
  for (const check of [true, false])
    expect(await OpenCodePlugin.install({ paths, check })).toMatchObject({
      tag: "Ok",
      value: "already_installed",
    });
});

test("an unreadable plugin file is a filesystem failure, not a defect", async () => {
  await Bun.write(file, "// OPERATOR_PLUGIN_VERSION=1\n");
  await chmod(file, 0o000);
  expect(await OpenCodePlugin.install({ paths, check: true })).toMatchObject({
    tag: "Err",
    error: { reason: "opencode_plugin_io_failed" },
  });
});

test("tests cannot reach a plugin folder outside a temporary root", async () => {
  const real = OperatorHome.resolve(Environment.parse({ HOME: "/Users/nobody", NODE_ENV: "test" }));
  expect(await OpenCodePlugin.install({ paths: real, check: true })).toMatchObject({
    tag: "Defect",
  });
});

test("other coded failures remain defects", async () => {
  spyOn(OperatorHome, "guardTemporaryTests").mockImplementation(() => {
    // oxlint-disable-next-line unthrown/no-throw -- Inject a coded failure at the public module boundary.
    throw Object.assign(new Error("busy"), { code: "EBUSY" });
  });
  expect(await OpenCodePlugin.install({ paths, check: false })).toMatchObject({ tag: "Defect" });
});
