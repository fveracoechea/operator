import { expect, test } from "bun:test";
import { classifyIgnored } from "./generated.ts";

const tracked = new Set(["bun.lock", "package.json", "packages/a/package.json", "README.md"]);

test("lockfile dependency folders beside a tracked manifest are preparation output", () => {
  expect(
    classifyIgnored({
      ignored: ["node_modules/", "packages/a/node_modules/", "packages/b/node_modules/"],
      tracked,
      copiedUnchanged: new Set(),
    }),
  ).toEqual({
    generated: ["node_modules/", "packages/a/node_modules/"],
    unknown: ["packages/b/node_modules/"],
  });
});

test("without a tracked Bun lockfile no dependency folder came from preparation", () => {
  expect(
    classifyIgnored({
      ignored: ["node_modules/"],
      tracked: new Set(["package.json"]),
      copiedUnchanged: new Set(),
    }),
  ).toEqual({ generated: [], unknown: ["node_modules/"] });
});

test("only unchanged copies of approved environment files are preparation output", () => {
  expect(
    classifyIgnored({
      ignored: [".env.local", "app/.env.test.local", ".env", "notes.local"],
      tracked,
      copiedUnchanged: new Set([".env.local", ".env", "notes.local"]),
    }),
  ).toEqual({
    generated: [".env.local"],
    unknown: ["app/.env.test.local", ".env", "notes.local"],
  });
});

test("children that a node_modules/* pattern lists belong to their dependency folder", () => {
  expect(
    classifyIgnored({
      ignored: [
        "node_modules/.yarn-state",
        "node_modules/a/",
        "node_modules/a/node_modules/b/",
        "packages/a/node_modules/c.js",
        "packages/b/node_modules/d/",
      ],
      tracked,
      copiedUnchanged: new Set(),
    }),
  ).toEqual({
    generated: [
      "node_modules/.yarn-state",
      "node_modules/a/",
      "node_modules/a/node_modules/b/",
      "packages/a/node_modules/c.js",
    ],
    unknown: ["packages/b/node_modules/d/"],
  });
});

test("other ignored content, a linked folder, or a folder named like one is unknown", () => {
  expect(
    classifyIgnored({
      ignored: [".cache/", "node_modules", "my_node_modules/", "dist/node_modules/", "build.log"],
      tracked,
      copiedUnchanged: new Set(),
    }),
  ).toEqual({
    generated: [],
    unknown: [".cache/", "node_modules", "my_node_modules/", "dist/node_modules/", "build.log"],
  });
});
