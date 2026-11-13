import { expect, test } from "bun:test";
import { sha256 } from "./sha256.ts";

test("hashes text and exact bytes with SHA-256", () => {
  const expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  expect(sha256("abc")).toBe(expected);
  expect(sha256(new Uint8Array([97, 98, 99]))).toBe(expected);
  expect(sha256(new Uint8Array([97, 0, 98, 99]))).not.toBe(expected);
});
