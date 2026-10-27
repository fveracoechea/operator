import { expect, test } from "bun:test";
import {
  decideLauncher,
  exactInstall,
  launcherTarget,
  launcherText,
  nixLauncherText,
  pinnedSpecifier,
  type LauncherFacts,
} from "./plan.ts";

const global = { reported: "/home/person/.bun/install/global", real: "/real/global" };
const facts: LauncherFacts = {
  packageRoot: "/real/global/node_modules/@fveracoechea/operator",
  version: "1.2.3",
  built: true,
  globalRoot: global,
  specifier: "npm:@jsr/fveracoechea__operator@1.2.3",
  command: "/home/person/.bun/bin/operator",
  destination: { kind: "absent" },
};

test("an exact global JSR install gets a launcher that names Bun's folder and no release", () => {
  const decision = decideLauncher(facts);
  expect(decision).toEqual({
    action: "write",
    command: "/home/person/.bun/bin/operator",
    runs: "/home/person/.bun/install/global/node_modules/@fveracoechea/operator/cli.js",
    text: launcherText(global.reported),
  });
  expect(launcherText(global.reported)).toBe(`#!/bin/sh
# Operator launcher written by operator install launcher.
# It runs the global JSR package in place, so it names no release and survives updates.
exec bun '/home/person/.bun/install/global/node_modules/@fveracoechea/operator/cli.js' "$@"
`);
  expect(launcherText(global.reported)).not.toContain("1.2.3");
});

test("the launcher quotes a global folder that contains shell syntax", () => {
  expect(launcherText("/tmp/it's $HOME `x`")).toContain(
    `exec bun '/tmp/it'\\''s $HOME \`x\`/node_modules/@fveracoechea/operator/cli.js' "$@"`,
  );
});

test("matching content needs no write, and other content is a conflict", () => {
  const text = launcherText(global.reported);
  expect(decideLauncher({ ...facts, destination: { kind: "file", text } })).toMatchObject({
    action: "unchanged",
  });
  for (const destination of [
    { kind: "file", text: `${text}\n` },
    { kind: "file", text: "" },
    { kind: "other" },
  ] as const)
    expect(decideLauncher({ ...facts, destination })).toEqual({
      action: "refuse",
      reason: "launcher_conflict",
      detail:
        "/home/person/.bun/bin/operator already exists with other content. It was not changed. Remove it yourself if it is not needed, then install the launcher again.",
    });
});

test("only the built release that Bun installed globally at the exact version gets a launcher", () => {
  expect(decideLauncher({ ...facts, built: false })).toMatchObject({
    action: "refuse",
    reason: "launcher_unsupported",
  });
  for (const changed of [
    { globalRoot: null },
    { packageRoot: "/tmp/staging/node_modules/@fveracoechea/operator" },
    { globalRoot: { ...global, real: "/other/global" } },
  ])
    expect(decideLauncher({ ...facts, ...changed })).toMatchObject({
      action: "refuse",
      reason: "launcher_unsupported",
    });
  for (const specifier of [
    null,
    "npm:@jsr/fveracoechea__operator@^1.2.3",
    "npm:@jsr/fveracoechea__operator@1.2.4",
    "npm:@jsr/other__operator@1.2.3",
    "git+https://github.com/fveracoechea/operator.git#abc",
  ])
    expect(decideLauncher({ ...facts, specifier })).toMatchObject({
      action: "refuse",
      reason: "launcher_version_unpinned",
    });
});

test("refusals check the release before the destination and name the exact install command", () => {
  const occupied = { destination: { kind: "other" } } as const;
  const install = 'bun add -g "@fveracoechea/operator@npm:@jsr/fveracoechea__operator@1.2.3"';
  expect(exactInstall("1.2.3")).toBe(install);
  expect(decideLauncher({ ...facts, ...occupied, built: false })).toMatchObject({
    reason: "launcher_unsupported",
  });
  const elsewhere = decideLauncher({ ...facts, ...occupied, packageRoot: "/tmp/copy" });
  expect(elsewhere).toEqual({
    action: "refuse",
    reason: "launcher_unsupported",
    detail: `The running Operator at /tmp/copy is not Bun's global package at /real/global/node_modules/@fveracoechea/operator. Run ${install}, then run this command from that package.`,
  });
  expect(decideLauncher({ ...facts, ...occupied, specifier: "^1.2.3" })).toEqual({
    action: "refuse",
    reason: "launcher_version_unpinned",
    detail: `Bun's global manifest names ^1.2.3 for @fveracoechea/operator, not the exact running version. Run ${install}.`,
  });
});

test("only the exact launcher text names a target", () => {
  const text = launcherText("/tmp/it's global");
  expect(launcherTarget(text)).toBe("/tmp/it's global/node_modules/@fveracoechea/operator/cli.js");
  for (const changed of [
    text.replace("# Operator", "# Other"),
    `${text}echo extra\n`,
    text.replace("/cli.js", "/other.js"),
    "#!/bin/sh\nexec bun '/x/node_modules/@fveracoechea/operator/cli.js' \"$@\"\n",
  ])
    expect(launcherTarget(changed)).toBeNull();
});

test("the Nix launcher runs the package's own Bun and keeps it last on PATH", () => {
  const text = nixLauncherText("/nix/store/it's-operator/lib/operator", "/nix/store/b-bun/bin/bun");
  expect(text).toBe(`#!/bin/sh
# Operator launcher written by the Nix package.
# It runs the release in this package with the package's pinned Bun.
PATH=\${PATH:+$PATH:}'/nix/store/b-bun/bin' exec '/nix/store/b-bun/bin/bun' '/nix/store/it'\\''s-operator/lib/operator/node_modules/@fveracoechea/operator/cli.js' "$@"
`);
  expect(launcherTarget(text)).toBe(
    "/nix/store/it's-operator/lib/operator/node_modules/@fveracoechea/operator/cli.js",
  );
  for (const changed of [
    text.replace("Nix package", "other package"),
    text.replace("'/nix/store/b-bun/bin' exec", "'/other/bin' exec"),
    text.replace(/^PATH=.* exec /m, "exec "),
    text.replace("/cli.js", "/other.js"),
    `${text}echo extra\n`,
  ])
    expect(launcherTarget(changed)).toBeNull();
});

test("only an exact JSR version or a full source commit is pinned", () => {
  const commit = "a".repeat(40);
  for (const pinned of [
    "npm:@jsr/fveracoechea__operator@1.2.3",
    `git+https://github.com/fveracoechea/operator.git#${commit}`,
    `git+file:///tmp/source#${commit}`,
    `github:fveracoechea/operator#${commit}`,
  ])
    expect(pinnedSpecifier(pinned, "1.2.3")).toBe(true);
  for (const loose of [
    "npm:@jsr/fveracoechea__operator@^1.2.3",
    "npm:@jsr/fveracoechea__operator@1.2.4",
    "git+https://github.com/fveracoechea/operator.git#main",
    `git+https://github.com/fveracoechea/operator.git#${commit.slice(1)}`,
    `git+https://github.com/fveracoechea/operator.git#${"A".repeat(40)}`,
    "git+https://github.com/fveracoechea/operator.git",
    "^1.2.3",
    "file:../operator",
    `file:../operator#${commit}`,
  ])
    expect(pinnedSpecifier(loose, "1.2.3")).toBe(false);
});
