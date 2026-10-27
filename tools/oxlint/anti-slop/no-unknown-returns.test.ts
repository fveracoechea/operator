import { expect, test } from "bun:test";
import { lintProject } from "../check.ts";

const check = lintProject();
const code = "anti-slop(no-unknown-returns)";

test("rejects unknown return contracts, through promises and local aliases", async () => {
  const result = await check(
    [
      "type Later<T> = Promise<T>;",
      "type Loose = string | unknown;",
      "export function read(text: string): unknown { return JSON.parse(text); }",
      "export async function fetchBody(): Promise<unknown> { return null; }",
      "export function later(): Later<unknown> { return Promise.resolve(null); }",
      "export function loose(): Loose { return 1; }",
      "export type Reader = { read(): PromiseLike<unknown> };",
      "export type Make = () => unknown;",
    ].join("\n"),
  );
  expect(result.findings.filter((finding) => finding.endsWith(code))).toEqual(
    [3, 4, 5, 6, 7, 8].map((line) => `${line} ${code}`),
  );
});

test("accepts named results, unknown inside a container, and shadowing type parameters", async () => {
  const result = await check(
    [
      "type Draft = { id: string };",
      "type Later<T> = Promise<T>;",
      "export function read(text: string): Draft { return { id: text }; }",
      "export function later(): Later<Draft> { return Promise.resolve({ id: '' }); }",
      "export function list(): string[] { return []; }",
    ].join("\n"),
  );
  expect(result.findings.filter((finding) => finding.endsWith(code))).toEqual([]);
});
