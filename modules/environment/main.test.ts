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
