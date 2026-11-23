import { afterAll, expect, test } from "bun:test";
// Portable analysis uses real disposable consumer files.
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeProjectConfig } from "./configuration.ts";
import {
  contains,
  discoverOwners,
  excluded,
  ownerOf,
  privateImport,
  productionFile,
  resolveProjectImport,
} from "./project.ts";

const root = await mkdtemp(path.join(tmpdir(), "deep-module-project-"));
afterAll(() => rm(root, { recursive: true }));
const config = normalizeProjectConfig(
  {
    "deep-modules": {
      moduleRoots: ["features"],
      libraryRoots: ["features/movie/utils"],
      aliases: { "@app": "." },
      exclusions: ["features/movie/resources", "features/movie/generated"],
    },
  },
  root,
);
const files = [
  "features/movie/main.ts",
  "features/movie/private.ts",
  "features/movie/player/implementation.tsx",
  "features/movie/player/child/work.ts",
  "features/movie/selectors/main.ts",
  "features/movie/schemas.ts",
  "features/movie/resources/asset.ts",
  "features/movie/generated/client.ts",
  "features/movie/tests/setup.test.ts",
  "features/movie/types/types.d.ts",
  "features/movie/utils/math.ts",
];
for (const file of files) await Bun.write(path.join(root, file), "export {};");
await Bun.write(path.join(root, "package.json"), '{"name":"@studio/cinema"}');

test("discovers production owners without entries, omitting declarations, tests and excluded assets", () => {
  const owners = discoverOwners(config);
  expect([...owners].map((owner) => path.relative(root, owner)).sort()).toEqual([
    "features/movie",
    "features/movie/player",
    "features/movie/player/child",
    "features/movie/selectors",
  ]);
  expect(ownerOf(path.join(root, "features/movie/player/new.test.ts"), owners)).toBe(
    path.join(root, "features/movie/player"),
  );
  expect(ownerOf(path.join(root, "probe.config.ts"), owners)).toBeUndefined();
  expect(productionFile("types.d.ts")).toBe(false);
  expect(productionFile("main.scenario.test.ts")).toBe(false);
  expect(productionFile("main.tsx")).toBe(true);
  expect(contains("/app", "/application/file.ts")).toBe(false);
  expect(contains("/app", "/app")).toBe(true);
  expect(excluded(path.join(root, "features/movie/resources/image.ts"), config)).toBe(true);
});

test("relative, alias and package-self paths resolve the same explicit or omitted TS/TSX file", () => {
  const importer = path.join(root, "features/tv/main.ts");
  for (const specifier of [
    "../movie/player/implementation",
    "../movie/player/implementation.tsx",
    "../movie/player/implementation.jsx",
    "@app/features/movie/player/implementation",
    "@studio/cinema/features/movie/player/implementation.tsx",
  ]) {
    expect(resolveProjectImport(importer, specifier, config)).toBe(
      path.join(root, "features/movie/player/implementation.tsx"),
    );
  }
  expect(resolveProjectImport(importer, "external-package", config)).toBeUndefined();
});

test("privacy distinguishes parents, siblings, ancestors, outsiders and missing-entry children", () => {
  const owners = discoverOwners(config);
  function rejected(from: string, to: string) {
    return privateImport(path.join(root, from), path.join(root, to), config, owners);
  }

  expect(rejected("features/movie/private.ts", "features/movie/player/implementation.tsx")).toBe(
    true,
  );
  expect(rejected("features/movie/player/use.ts", "features/movie/player/implementation.tsx")).toBe(
    false,
  );
  expect(rejected("features/movie/player/use.ts", "features/movie/schemas.ts")).toBe(false);
  expect(rejected("features/movie/player/use.ts", "features/movie/main.ts")).toBe(true);
  expect(rejected("features/movie/player/use.ts", "features/movie/private.ts")).toBe(true);
  expect(rejected("features/movie/player/use.ts", "features/movie/selectors/main.ts")).toBe(false);
  expect(rejected("features/movie/player/child/use.ts", "features/movie/selectors/main.ts")).toBe(
    true,
  );
  expect(rejected("probe.config.ts", "features/movie/selectors/main.ts")).toBe(true);
  expect(rejected("probe.config.ts", "features/movie/main.ts")).toBe(false);
  expect(rejected("probe.config.ts", "features/movie/$functions.ts")).toBe(false);
  expect(rejected("probe.config.ts", "features/movie/schemas.ts")).toBe(false);
  expect(rejected("features/movie/player/use.ts", "features/movie/$functions.ts")).toBe(true);
  expect(rejected("probe.config.ts", "features/movie/resources/asset.ts")).toBe(false);
  expect(rejected("probe.config.ts", "features/movie/utils/math.ts")).toBe(false);
});

test("does not follow directory aliases or loop forever on cyclic file resolution", async () => {
  await symlink("cycle.ts", path.join(root, "features/movie/cycle.ts"));
  await symlink(".", path.join(root, "features/movie/loop"));
  expect(
    resolveProjectImport(path.join(root, "features/movie/main.ts"), "./cycle.ts", config),
  ).toBe(path.join(root, "features/movie/cycle.ts"));
  expect([...discoverOwners(config)]).not.toContain(path.join(root, "features/movie/loop"));
});
