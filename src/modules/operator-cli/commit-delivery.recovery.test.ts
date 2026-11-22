import { afterEach, expect, jest, spyOn, test } from "bun:test";
// Bun has no assertion error constructor.
import { AssertionError } from "node:assert";
import { CommitDelivery } from "../commit-delivery/main.ts";
import { commitFixture } from "../../../tools/commit-delivery-fixture.ts";
import { runCommitDelivery } from "./commit-delivery.ts";

let fixture: Awaited<ReturnType<typeof commitFixture>> | undefined;
afterEach(async () => {
  await fixture?.dispose();
  fixture = undefined;
  jest.restoreAllMocks();
  process.exitCode = 0;
});

test("the CLI returns commit_defect after a coded assertion despite verified publication", async () => {
  fixture = await commitFixture();
  await fixture.change();
  await fixture.review();
  expect((await CommitDelivery.round({ ...fixture.input, text: "## Findings" })).tag).toBe("Ok");
  const current = fixture;
  const transport = current.transport.getMockImplementation() ?? expect.unreachable();
  current.transport.mockImplementation(async (input) => {
    const result = await transport(input);
    if (input.tool === "git" && input.args[0] === "push") {
      // oxlint-disable-next-line unthrown/no-throw -- Inject the actual coded assertion at the CLI's external invocation boundary.
      throw new AssertionError({ message: "Post-push invariant failed." });
    }
    return result;
  });
  const dispositions = `${current.root}/dispositions.md`;
  await Bun.write(dispositions, "## Dispositions");
  spyOn(process, "cwd").mockReturnValue(current.worktree);
  const log = spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
  expect(
    await runCommitDelivery(
      ["commit", "deliver", "--file", dispositions, "--json"],
      current.paths,
      true,
    ),
  ).toBe(true);
  expect(process.exitCode).toBe(1);
  expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
    operation: "commit_deliver",
    reason: "commit_defect",
  });
  const after = current.data().data;
  expect(after.stage).toBe("finalize");
  expect(after.publishedHead).toBe(after.candidate?.head ?? "");
  expect(after.journal.at(-1)).toMatchObject({ effect: "remote_publication", state: "verified" });
  expect(after.journal.some((row) => row.effect === "database_finalization")).toBe(false);
  expect(current.git(current.checkout, "rev-parse", "main")).toBe(after.candidate?.head ?? "");
  expect(current.git(current.root, "--git-dir", current.origin, "rev-parse", "main")).toBe(
    after.candidate?.head ?? "",
  );
});
