import { afterEach, expect, jest, test } from "bun:test";
import { CommitDelivery } from "./main.ts";
import { commitFixture } from "../../../tools/commit-delivery-fixture.ts";

let fixture: Awaited<ReturnType<typeof commitFixture>> | undefined;
afterEach(async () => {
  await fixture?.dispose();
  fixture = undefined;
  jest.restoreAllMocks();
});

test("each controlling-checkout lock or sequencer marker refuses before index or ref changes", async () => {
  fixture = await commitFixture();
  await fixture.change();
  await fixture.review();
  expect((await CommitDelivery.round({ ...fixture.input, text: "## Findings" })).tag).toBe("Ok");
  const candidate = fixture.data().data.candidate;
  for (const marker of [
    "index.lock",
    "HEAD.lock",
    "refs/heads/main.lock",
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
  ]) {
    const file = Bun.file(`${fixture.checkout}/.git/${marker}`);
    await Bun.write(file, "busy\n");
    expect(
      await CommitDelivery.deliver({ ...fixture.input, text: "## Dispositions" }),
    ).toMatchObject({
      tag: "Err",
      error: {
        reason: "commit_checkout_busy",
        detail: `The controlling checkout is busy at ${marker}. Nothing was overwritten.`,
      },
    });
    expect(await file.text()).toBe("busy\n");
    expect(fixture.data().data.candidate).toEqual(candidate);
    expect(fixture.data().data.journal.some((row) => row.effect === "checkout_index")).toBe(false);
    expect(fixture.git(fixture.checkout, "rev-parse", "main")).toBe(fixture.base);
    await file.delete();
  }
  expect(fixture.git(fixture.root, "--git-dir", fixture.origin, "rev-parse", "main")).toBe(
    fixture.base,
  );
});

test("concurrent origin advancement before admission refuses without rebasing or publishing the ticket", async () => {
  fixture = await commitFixture();
  await fixture.change();
  await fixture.review();
  expect((await CommitDelivery.round({ ...fixture.input, text: "## Findings" })).tag).toBe("Ok");
  const candidate = fixture.data().data.candidate;
  const other = fixture.git(
    fixture.checkout,
    "commit-tree",
    `${fixture.base}^{tree}`,
    "-p",
    fixture.base,
    "-m",
    "concurrent origin work",
  );
  fixture.git(fixture.checkout, "push", fixture.origin, `${other}:main`);
  expect(await CommitDelivery.deliver({ ...fixture.input, text: "## Dispositions" })).toMatchObject(
    {
      tag: "Err",
      error: {
        reason: "commit_remote_advanced",
        detail:
          "origin/main advanced since the recorded base. No automatic rebase or forced publication is authorized.",
      },
    },
  );
  expect(fixture.git(fixture.checkout, "rev-parse", "main")).toBe(fixture.base);
  expect(fixture.git(fixture.root, "--git-dir", fixture.origin, "rev-parse", "main")).toBe(other);
  expect(fixture.data().data.candidate).toEqual(candidate);
  expect(fixture.data().data.stage).toBe("review");
});

test("concurrent local advancement before checkout transition retains the other person's commit and the candidate", async () => {
  fixture = await commitFixture();
  await fixture.change();
  await fixture.review();
  expect((await CommitDelivery.round({ ...fixture.input, text: "## Findings" })).tag).toBe("Ok");
  const candidate = fixture.data().data.candidate;
  const other = fixture.git(
    fixture.checkout,
    "commit-tree",
    `${fixture.base}^{tree}`,
    "-p",
    fixture.base,
    "-m",
    "concurrent local work",
  );
  fixture.git(fixture.checkout, "update-ref", "refs/heads/main", other, fixture.base);
  expect(await CommitDelivery.deliver({ ...fixture.input, text: "## Dispositions" })).toMatchObject(
    {
      tag: "Err",
      error: {
        reason: "commit_local_advanced",
        detail: "Local main advanced concurrently. The pinned candidate and partial effects stay.",
      },
    },
  );
  expect(fixture.git(fixture.checkout, "rev-parse", "main")).toBe(other);
  expect(fixture.git(fixture.root, "--git-dir", fixture.origin, "rev-parse", "main")).toBe(
    fixture.base,
  );
  expect(fixture.data().data.candidate).toEqual(candidate);
  expect(fixture.data().data.journal.some((row) => row.effect === "checkout_index")).toBe(false);
});
