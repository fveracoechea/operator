import { expect, test } from "bun:test";
import { verify } from "./verify.ts";

test("disposable Result candidates pass identical CLI, operation, transaction, and type checks", async () => {
  const verified = await verify();
  expect(verified.results).toHaveLength(6);
}, 120000);
