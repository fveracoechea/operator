import { expect, test } from "bun:test";
import { ContentIdentity } from "./main.ts";

// Crew-wake runner keys and project-readiness fingerprints are recorded with these bytes.
test("names one text with its SHA-256 hex digest", () => {
  expect(ContentIdentity.ofText("abc")).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
