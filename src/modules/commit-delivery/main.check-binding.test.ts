import { afterEach, expect, jest, test } from "bun:test";
import { CommitDelivery } from "./main.ts";
import { commitFixture } from "../../../tools/commit-delivery-fixture.ts";
// Bun has no assertion error constructor.
import { AssertionError } from "node:assert";

let fixture: Awaited<ReturnType<typeof commitFixture>> | undefined;
afterEach(async () => {
  await fixture?.dispose();
  fixture = undefined;
  jest.restoreAllMocks();
});

test("a fixer, passing test and cleanup cannot certify the original broken tree", async () => {
  fixture = await commitFixture([
    [process.execPath, "-e", "await Bun.write('feature', 'repaired\\n')"],
    [
      process.execPath,
      "-e",
      "if ((await Bun.file('feature').text()) !== 'repaired\\n') process.exit(1); await Bun.write('../later-check', 'ran')",
    ],
    ["git", "restore", "--worktree", "."],
  ]);
  await fixture.change("broken\n");
  await fixture.review();
  expect((await CommitDelivery.round({ ...fixture.input, text: "## Findings" })).tag).toBe("Ok");
  const before = fixture.data().data;
  const candidate = before.candidate ?? expect.unreachable();
  const index = fixture.git(candidate.path, "ls-files", "--stage");
  const result = await CommitDelivery.deliver({ ...fixture.input, text: "## Dispositions" });
  expect(result).toMatchObject({ tag: "Err", error: { reason: "commit_worktree_unclean" } });
  expect(await Bun.file(`${candidate.path}/../later-check`).exists()).toBe(false);
  expect(await Bun.file(`${candidate.path}/feature`).text()).toBe("repaired\n");
  expect(fixture.git(candidate.path, "ls-files", "--stage")).toBe(index);
  expect(fixture.git(candidate.path, "rev-parse", "HEAD")).toBe(candidate.head ?? "");
  expect(fixture.data().data).toMatchObject({
    stage: "review",
    checks: null,
    publishedHead: null,
    history: before.history,
  });
  expect(fixture.data().data.journal.slice(0, before.journal.length)).toEqual(before.journal);
  expect(fixture.git(fixture.checkout, "rev-parse", "main")).toBe(fixture.base);
  expect(fixture.git(fixture.root, "--git-dir", fixture.origin, "rev-parse", "main")).toBe(
    fixture.base,
  );
});

test.each(["worktree", "index", "untracked", "head"])(
  "checks do not start on a changed candidate %s",
  async (kind) => {
    fixture = await commitFixture([
      [process.execPath, "-e", "await Bun.write('../later-check', 'ran')"],
    ]);
    await fixture.change();
    await fixture.review();
    expect((await CommitDelivery.round({ ...fixture.input, text: "## Findings" })).tag).toBe("Ok");
    const before = fixture.data().data;
    const candidate = before.candidate ?? expect.unreachable();
    if (kind === "head") {
      fixture.git(
        candidate.path,
        "commit",
        "--amend",
        "-m",
        "Ticket #411\n\nOperator-Ticket: source/ticket\n\nUnreviewed message.",
      );
    } else {
      await Bun.write(
        `${candidate.path}/${kind === "untracked" ? "personal" : "feature"}`,
        "personal changed input\n",
      );
      if (kind === "index") {
        fixture.git(candidate.path, "add", "feature");
        await Bun.write(`${candidate.path}/feature`, "feature\n");
      }
    }
    const head = fixture.git(candidate.path, "rev-parse", "HEAD");
    const index = fixture.git(candidate.path, "ls-files", "--stage");
    expect(
      await CommitDelivery.deliver({ ...fixture.input, text: "## Dispositions" }),
    ).toMatchObject({
      tag: "Err",
      error: { reason: kind === "head" ? "commit_candidate_changed" : "commit_worktree_unclean" },
    });
    expect(await Bun.file(`${candidate.path}/../later-check`).exists()).toBe(false);
    expect(fixture.git(candidate.path, "rev-parse", "HEAD")).toBe(head);
    expect(fixture.git(candidate.path, "ls-files", "--stage")).toBe(index);
    expect(fixture.data().data.checks).toBeNull();
    expect(fixture.git(fixture.checkout, "rev-parse", "main")).toBe(fixture.base);
    expect(fixture.git(fixture.root, "--git-dir", fixture.origin, "rev-parse", "main")).toBe(
      fixture.base,
    );
  },
);

test.each(["index", "head"])(
  "a check that changes the candidate %s stops subsequent commands and retains its changes",
  async (kind) => {
    fixture = await commitFixture([
      kind === "index"
        ? [
            process.execPath,
            "-e",
            "await Bun.write('feature', 'changed by check\\n'); if (await Bun.spawn(['git', 'add', 'feature']).exited) process.exit(1); await Bun.write('feature', 'feature\\n')",
          ]
        : [
            "git",
            "commit",
            "--amend",
            "-m",
            "Ticket #411\n\nOperator-Ticket: source/ticket\n\nChanged by check.",
          ],
      [process.execPath, "-e", "await Bun.write('../later-check', 'ran')"],
    ]);
    await fixture.change();
    await fixture.review();
    expect((await CommitDelivery.round({ ...fixture.input, text: "## Findings" })).tag).toBe("Ok");
    const before = fixture.data().data;
    const candidate = before.candidate ?? expect.unreachable();
    expect(
      await CommitDelivery.deliver({ ...fixture.input, text: "## Dispositions" }),
    ).toMatchObject({
      tag: "Err",
      error: { reason: kind === "head" ? "commit_candidate_changed" : "commit_worktree_unclean" },
    });
    expect(await Bun.file(`${candidate.path}/../later-check`).exists()).toBe(false);
    if (kind === "index") {
      expect(fixture.git(candidate.path, "show", ":feature")).toBe("changed by check");
      expect(await Bun.file(`${candidate.path}/feature`).text()).toBe("feature\n");
      expect(fixture.git(candidate.path, "rev-parse", "HEAD")).toBe(candidate.head ?? "");
    } else {
      expect(fixture.git(candidate.path, "log", "-1", "--format=%B")).toContain(
        "Changed by check.",
      );
      expect(fixture.git(candidate.path, "rev-parse", "HEAD")).not.toBe(candidate.head ?? "");
    }
    expect(fixture.data().data.history).toEqual(before.history);
    expect(fixture.data().data.checks).toBeNull();
    expect(fixture.data().data.publishedHead).toBeNull();
    expect(fixture.git(fixture.checkout, "rev-parse", "main")).toBe(fixture.base);
    expect(fixture.git(fixture.root, "--git-dir", fixture.origin, "rev-parse", "main")).toBe(
      fixture.base,
    );
  },
);

test("each command rechecks its inputs after the previous post-check observation", async () => {
  fixture = await commitFixture([
    [process.execPath, "-e", "await Bun.write('../first-check', 'ran')"],
    [process.execPath, "-e", "await Bun.write('../later-check', 'ran')"],
  ]);
  await fixture.change();
  await fixture.review();
  expect((await CommitDelivery.round({ ...fixture.input, text: "## Findings" })).tag).toBe("Ok");
  const current = fixture;
  const candidate = current.data().data.candidate ?? expect.unreachable();
  const transport = current.transport.getMockImplementation() ?? expect.unreachable();
  const index = current.git(candidate.path, "ls-files", "--stage");
  let observations = 0;
  current.transport.mockImplementation(async (input) => {
    const result = await transport(input);
    if (input.tool === "git" && input.args[0] === "ls-files" && input.cwd === candidate.path) {
      observations++;
      if (observations === 2)
        await Bun.write(`${candidate.path}/feature`, "intervening personal work\n");
    }
    return result;
  });
  expect(await CommitDelivery.deliver({ ...current.input, text: "## Dispositions" })).toMatchObject(
    {
      tag: "Err",
      error: { reason: "commit_worktree_unclean" },
    },
  );
  expect(await Bun.file(`${candidate.path}/../first-check`).text()).toBe("ran");
  expect(await Bun.file(`${candidate.path}/../later-check`).exists()).toBe(false);
  expect(await Bun.file(`${candidate.path}/feature`).text()).toBe("intervening personal work\n");
  expect(current.git(candidate.path, "ls-files", "--stage")).toBe(index);
  expect(current.data().data.checks).toBeNull();
  expect(current.git(current.checkout, "rev-parse", "main")).toBe(current.base);
});

test("a coded check defect cannot be replaced by its changed-tree refusal", async () => {
  fixture = await commitFixture([
    [process.execPath, "-e", "await Bun.write('feature', 'changed by failed check\\n')"],
    [process.execPath, "-e", "await Bun.write('../later-check', 'ran')"],
  ]);
  await fixture.change();
  await fixture.review();
  expect((await CommitDelivery.round({ ...fixture.input, text: "## Findings" })).tag).toBe("Ok");
  const current = fixture;
  const candidate = current.data().data.candidate ?? expect.unreachable();
  const transport = current.transport.getMockImplementation() ?? expect.unreachable();
  current.transport.mockImplementation(async (input) => {
    const result = await transport(input);
    if (input.tool === process.execPath) {
      // oxlint-disable-next-line unthrown/no-throw -- Inject a coded defect after a real configured check's partial effect.
      throw new AssertionError({ message: "Configured check invariant failed." });
    }
    return result;
  });
  expect((await CommitDelivery.deliver({ ...current.input, text: "## Dispositions" })).tag).toBe(
    "Defect",
  );
  expect(await Bun.file(`${candidate.path}/feature`).text()).toBe("changed by failed check\n");
  expect(await Bun.file(`${candidate.path}/../later-check`).exists()).toBe(false);
  expect(current.data().data.checks).toBeNull();
  expect(current.data().data.publishedHead).toBeNull();
  expect(current.git(current.checkout, "rev-parse", "main")).toBe(current.base);
});
