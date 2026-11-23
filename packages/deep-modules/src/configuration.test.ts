import { expect, test } from "bun:test";
import type { Context } from "@oxlint/plugins";
import { normalizeProjectConfig } from "./configuration.ts";

test("normalizes one consumer-relative contract including roots, aliases, entries and exclusions", () => {
  const config = normalizeProjectConfig(
    {
      "deep-modules": {
        projectRoot: "web",
        applicationRoots: ["app"],
        moduleRoots: ["app/features"],
        libraryRoots: ["shared"],
        aliases: { "@": "app" },
        objectEntries: ["interface.ts"],
        schemaEntries: ["wire.ts"],
        frameworkEntries: ["rpc.ts"],
        exclusions: ["app/features/movie/assets"],
        environmentEntries: ["app/environment.ts"],
        testScopes: { "test/setup.ts": "app/features/movie" },
      },
    },
    "/consumer",
  );
  expect(config).toEqual({
    allowedFiles: [],
    toolingRoots: ["/consumer/web/tools", "/consumer/web/packages"],
    projectRoot: "/consumer/web",
    applicationRoots: ["/consumer/web/app"],
    moduleRoots: ["/consumer/web/app/features"],
    libraryRoots: ["/consumer/web/shared"],
    aliases: { "@": "/consumer/web/app" },
    objectEntries: ["interface.ts"],
    schemaEntries: ["wire.ts"],
    frameworkEntries: ["rpc.ts"],
    exclusions: ["/consumer/web/app/features/movie/assets"],
    environmentEntries: ["/consumer/web/app/environment.ts"],
    testScopes: { "/consumer/web/test/setup.ts": "/consumer/web/app/features/movie" },
  });
});

test("defaults follow the canonical entries and invalid settings fail visibly", () => {
  const config = normalizeProjectConfig({}, "/consumer");
  expect(config.projectRoot).toBe("/consumer");
  expect(config.moduleRoots).toEqual(["/consumer/src/modules"]);
  expect(config.libraryRoots).toEqual(["/consumer/src/lib"]);
  expect(config.objectEntries).toEqual([
    "main.ts",
    "main.server.ts",
    "main.tsx",
    "main.server.tsx",
  ]);
  expect(config.schemaEntries).toEqual(["schemas.ts", "schemas.generated.ts"]);
  expect(config.frameworkEntries).toEqual(["$functions.ts"]);
  expect(config.exclusions).toEqual([]);
  expect(config.aliases).toEqual({});
  expect(config.environmentEntries).toEqual([]);
  expect(config.testScopes).toEqual({});
  const invalid: Context["settings"][string][] = [
    null,
    { typo: true },
    { projectRoot: "" },
    { moduleRoots: [] },
    { libraryRoots: [1] },
    { aliases: { "@": "" } },
    { objectEntries: ["nested/main.ts"] },
    { schemaEntries: ["../wire.ts"] },
    { frameworkEntries: ["rpc.js"] },
    { exclusions: [false] },
    { environmentEntries: [false] },
    { testScopes: { "setup.ts": "" } },
  ];
  for (const input of invalid)
    expect(() => normalizeProjectConfig({ "deep-modules": input }, "/consumer")).toThrow();
});
