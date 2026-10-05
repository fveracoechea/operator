import { expect, test } from "bun:test";
import { ContentIdentity } from "../content-identity/main.ts";
import { ARTIFACT_RULES } from "./submission-store.ts";

test("the artifact identity rule names the digest that the store compares", () => {
  const rule = ARTIFACT_RULES.find((one) => one.refusal === "artifact_identity_changed")?.rule;

  // An Operative computes the identity with its own tool, so the rule must name the algorithm
  // the store uses. The expected digest is the FIPS 180-2 SHA-256 test vector for "abc".
  expect(rule).toContain("the SHA-256 hex digest of its bytes");
  expect(ContentIdentity.ofBytes(new TextEncoder().encode("abc"))).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
