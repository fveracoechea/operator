import { expect, test } from "bun:test";
import { Environment } from "./main.ts";

test("validates explicit roots without treating an empty value as unset", () => {
  expect(
    Environment.parse({
      HOME: "/isolated/home",
      PATH: "/bin",
      XDG_CONFIG_HOME: "/isolated/config",
      XDG_STATE_HOME: "/isolated/state",
      TMPDIR: "/isolated/tmp",
    }),
  ).toEqual({
    HOME: "/isolated/home",
    PATH: "/bin",
    XDG_CONFIG_HOME: "/isolated/config",
    XDG_STATE_HOME: "/isolated/state",
    TMPDIR: "/isolated/tmp",
  });
  for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "TMPDIR"]) {
    for (const value of ["", "relative/path"]) {
      expect(() => Environment.parse({ HOME: "/isolated/home", [name]: value })).toThrow(name);
    }
  }
});

test("removes deleted workflow variables and returns one validated startup snapshot", () => {
  const values = Environment.parse({
    HOME: "/isolated/home",
    OPERATOR_HOME: "/wrong",
    OPERATOR_PROBE_OBSERVATION_MS: "bad",
    OPERATOR_MATT_SKILLS_API: "bad",
    XDG_CACHE_HOME: "ignored",
    XDG_RUNTIME_DIR: "ignored",
  });
  expect(values).toEqual({ HOME: "/isolated/home", PATH: "" });
  expect(Environment.read()).toBe(Environment.read());
});

test("child environment overrides do not change the parent snapshot", () => {
  const original = Environment.read();
  const child = Environment.child({ PATH: "/controlled/tools", XDG_CONFIG_HOME: undefined });
  expect(child.PATH).toBe("/controlled/tools");
  expect(child.XDG_CONFIG_HOME).toBeUndefined();
  expect(Environment.read()).toBe(original);
  expect(Environment.child().PATH).toBe(original.PATH);
});

test("keeps the release, package manager, and Herdr values and refuses empty Herdr values", () => {
  const values = {
    HOME: "/isolated/home",
    PATH: "/bin",
    NODE_ENV: "test",
    SOURCE_DATE_EPOCH: "not a number",
    npm_config_user_agent: "bun/1.4.4",
    HERDR_SOCKET_PATH: "/isolated/herdr.sock",
    HERDR_PANE_ID: "pane-1",
    HERDR_PLUGIN_EVENT: "event",
    HERDR_PLUGIN_EVENT_JSON: "{}",
  };
  expect(Environment.parse(values)).toEqual(values);
  for (const name of [
    "HERDR_SOCKET_PATH",
    "HERDR_PANE_ID",
    "HERDR_PLUGIN_EVENT",
    "HERDR_PLUGIN_EVENT_JSON",
  ])
    expect(() => Environment.parse({ HOME: "/isolated/home", [name]: "" })).toThrow(name);
  expect(() => Environment.parse({ HOME: "relative" })).toThrow("Must be an absolute path.");
});

test("passes unknown startup variables to a child but not to application values", async () => {
  const modulePath = new URL("./main.ts", import.meta.url).pathname;
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { Environment } = await import(${JSON.stringify(modulePath)});
Environment.read();
process.env.OPERATOR_CHILD_ONLY = "changed after startup";
console.log(JSON.stringify({ child: Environment.child().OPERATOR_CHILD_ONLY, override: Environment.child({ OPERATOR_CHILD_ONLY: "override" }).OPERATOR_CHILD_ONLY, read: Object.hasOwn(Environment.read(), "OPERATOR_CHILD_ONLY") }));`,
    ],
    { env: Environment.child({ OPERATOR_CHILD_ONLY: "passed" }), stdout: "pipe" },
  );
  expect(await new Response(child.stdout).json()).toEqual({
    child: "passed",
    override: "override",
    read: false,
  });
  expect(await child.exited).toBe(0);
});
