import { afterAll, expect, test } from "bun:test";
// Temporary consumer directories exercise the portable parser and resolver without mock bindings.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeProjectConfig } from "./configuration.ts";
import { selectorValues } from "./selector-values.ts";

const root = await mkdtemp(path.join(tmpdir(), "selector-values-"));
afterAll(() => rm(root, { recursive: true }));
const config = normalizeProjectConfig(
  {
    "deep-modules": {
      aliases: { "@domain": "." },
      exclusions: ["excluded"],
    },
  },
  root,
);

test("portable selector resolution follows exports, lexical aliases and namespace properties", async () => {
  const file = path.join(root, "entry.ts");
  await Bun.write(
    file,
    `
import * as domain from "@domain/domain";
const alias = (domain.Rules as const);
export { alias as selectors };
`,
  );
  await Bun.write(
    path.join(root, "domain.ts"),
    `
const title = async () => true;
export const Rules = { title };
export function factory() {
  const title = () => false;
  return title;
}
`,
  );
  const values = selectorValues(undefined, "/not-the-consumer.ts", config);
  const program = values.load(file);
  expect(program?.type).toBe("Program");
  if (!program) return;
  const [entry] = values.exported({ node: program, filename: file }, "selectors");
  expect(entry?.node.type).toBe("Identifier");
  if (!entry) return;
  const [value] = values.resolve(entry);
  expect(value?.node.type).toBe("ObjectExpression");
  expect(value?.filename).toBe(path.join(root, "domain.ts"));
  if (value?.node.type !== "ObjectExpression") return;
  const property = value.node.properties[0];
  expect(property?.type).toBe("Property");
  if (property?.type !== "Property") return;
  const [title] = values.resolve({ ...value, node: property.value });
  expect(title?.node).toMatchObject({ type: "ArrowFunctionExpression", async: true });
  expect(values.annotations(value)).toEqual([]);
  expect(values.load(path.join(root, "missing.ts"))).toBeUndefined();
});

test("re-export and binding cycles terminate without inventing callable provenance", async () => {
  const file = path.join(root, "cycle.ts");
  await Bun.write(
    file,
    'export { title } from "./other"; const first = second; const second = first; export { first };',
  );
  await Bun.write(path.join(root, "other.ts"), 'export { title } from "./cycle";');
  const values = selectorValues(undefined, "/not-the-consumer.ts", config);
  const program = values.load(file);
  expect(program?.type).toBe("Program");
  if (!program) return;
  expect(values.exported({ node: program, filename: file }, "title")).toEqual([]);
  const [entry] = values.exported({ node: program, filename: file }, "first");
  expect(entry?.node.type).toBe("Identifier");
  if (!entry) return;
  expect(values.resolve(entry)).toEqual([]);
  await Bun.write(path.join(root, "excluded/main.ts"), "export const title = async () => true;");
  expect(values.load(path.join(root, "excluded/main.ts"))).toBeUndefined();
  await Bun.write(path.join(root, "opaque.ts"), "unsupported syntax !");
  expect(values.load(path.join(root, "opaque.ts"))).toBeUndefined();
  await Bun.write(
    path.join(root, "contract.d.ts"),
    "export declare function title(): Promise<string>;",
  );
  expect(values.load(path.join(root, "contract.d.ts"))).toBeUndefined();
});

test("namespace and star reexports resolve selected values without type-only exports or cycles", async () => {
  const file = path.join(root, "namespaces.ts");
  const implementation = path.join(root, "cast.ts");
  await Bun.write(
    file,
    `
export * as Cast from "./cast";
export * from "./cast";
export type * as Types from "./cast";
export * from "./namespaces";
`,
  );
  await Bun.write(implementation, "export async function byTitle() { return true; }");
  const values = selectorValues(undefined, "/not-the-consumer.ts", config);
  const program = values.load(file);
  expect(program?.type).toBe("Program");
  if (!program) return;
  const namespace = { node: program, filename: file };
  const cast = values.exported(namespace, "Cast");
  expect(cast.map((value) => [value.node.type, value.filename])).toEqual([
    ["Program", implementation],
  ]);
  const [group] = cast;
  if (!group) return;
  expect(values.exported(group, "byTitle").map((value) => value.node)).toMatchObject([
    { type: "FunctionDeclaration", async: true },
  ]);
  expect(values.exported(namespace, "byTitle").map((value) => value.filename)).toEqual([
    implementation,
  ]);
  expect(values.exported(namespace, "Types")).toEqual([]);
  expect(values.exported(namespace, "missing")).toEqual([]);
});
