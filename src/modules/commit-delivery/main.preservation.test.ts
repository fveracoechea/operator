import { afterEach, expect, jest, spyOn, test } from "bun:test";
import { Err } from "unthrown";
import { CommitDelivery } from "./main.ts";
import { commitFixture } from "../../../tools/commit-delivery-fixture.ts";
// Bun has no file permission API.
import { chmod } from "node:fs/promises";
import { z } from "zod";
import { DeviceState } from "../device-state/main.ts";

let fixture: Awaited<ReturnType<typeof commitFixture>> | undefined;
afterEach(async () => {
  await fixture?.dispose();
  fixture = undefined;
  jest.restoreAllMocks();
});

test("candidate recovery preserves unrelated staged work after a failing hook", async () => {
  fixture = await commitFixture();
  await fixture.change();
  const hook = `${fixture.checkout}/.git/hooks/pre-commit`;
  await Bun.write(hook, "#!/bin/sh\nexit 1\n");
  await chmod(hook, 0o755);
  expect((await CommitDelivery.review(fixture.input)).tag).toBe("Err");
  const before = fixture.data().data;
  const path = z.string().parse(before.candidate?.path);
  await Bun.write(`${path}/base`, "personal staged work\n");
  fixture.git(path, "add", "base");
  const index = fixture.git(path, "ls-files", "--stage");
  await Bun.file(hook).delete();
  const result = await CommitDelivery.review(fixture.input);
  expect(await Bun.file(`${path}/base`).text()).toBe("personal staged work\n");
  expect(result).toMatchObject({ tag: "Err", error: { reason: "commit_worktree_unclean" } });
  expect(fixture.git(path, "ls-files", "--stage")).toBe(index);
  expect(fixture.git(path, "rev-parse", "HEAD")).toBe(fixture.base);
  expect(fixture.git(fixture.checkout, "rev-parse", "main")).toBe(fixture.base);
  expect(fixture.git(fixture.root, "--git-dir", fixture.origin, "rev-parse", "main")).toBe(
    fixture.base,
  );
  expect(fixture.data().data).toMatchObject({
    candidate: before.candidate,
    history: before.history,
    publishedHead: null,
    stage: "build",
  });
  expect(fixture.data().data.journal.slice(0, before.journal.length)).toEqual(before.journal);
});

test("delivery refuses an ignored obstruction without changing personal files, index or refs", async () => {
  fixture = await commitFixture();
  await fixture.change();
  await fixture.review();
  expect((await CommitDelivery.round({ ...fixture.input, text: "## Findings" })).tag).toBe("Ok");
  await Bun.write(`${fixture.checkout}/.git/info/exclude`, "\nfeature\n");
  await Bun.write(`${fixture.checkout}/feature`, "personal ignored work\n");
  const index = fixture.git(fixture.checkout, "ls-files", "--stage");
  const before = fixture.data().data;
  const result = await CommitDelivery.deliver({ ...fixture.input, text: "## Dispositions" });
  expect(await Bun.file(`${fixture.checkout}/feature`).text()).toBe("personal ignored work\n");
  expect(result).toMatchObject({ tag: "Err", error: { reason: "commit_git_failed" } });
  expect(fixture.git(fixture.checkout, "ls-files", "--stage")).toBe(index);
  expect(fixture.git(fixture.checkout, "rev-parse", "main")).toBe(fixture.base);
  expect(fixture.git(fixture.root, "--git-dir", fixture.origin, "rev-parse", "main")).toBe(
    fixture.base,
  );
  const after = fixture.data().data;
  expect(after.history).toEqual(before.history);
  expect(after.candidate).toEqual(before.candidate);
  expect(after.journal.slice(0, before.journal.length)).toEqual(before.journal);
  expect(after.journal.at(-1)).toMatchObject({ effect: "checkout_index", state: "intent" });
  expect(after.publishedHead).toBeNull();
  expect((await CommitDelivery.deliver({ ...fixture.input, text: "## Dispositions" })).tag).toBe(
    "Err",
  );
  expect(await Bun.file(`${fixture.checkout}/feature`).text()).toBe("personal ignored work\n");
  await Bun.file(`${fixture.checkout}/feature`).delete();
  expect((await CommitDelivery.deliver({ ...fixture.input, text: "## Dispositions" })).tag).toBe(
    "Ok",
  );
  expect(fixture.data().data.history).toEqual(before.history);
  expect(fixture.git(fixture.checkout, "rev-parse", "main")).toBe(
    z.string().parse(before.candidate?.head),
  );
  expect(fixture.data().data.journal.slice(0, after.journal.length)).toEqual(after.journal);
});

test("a candidate install refuses an intervening unrelated index entry instead of committing it", async () => {
  fixture = await commitFixture();
  await fixture.change();
  const transport = fixture.transport.getMockImplementation() ?? expect.unreachable();
  let index = "";
  let path = "";
  fixture.transport.mockImplementation(async (input) => {
    if (input.tool === "git" && input.args[0] === "apply") {
      path = z.string().parse(input.cwd);
      await Bun.write(`${path}/base`, "intervening staged work\n");
      fixture?.git(path, "add", "base");
      index = fixture?.git(path, "ls-files", "--stage", "base") ?? "";
    }
    return transport(input);
  });
  const result = await CommitDelivery.review(fixture.input);
  expect(result).toMatchObject({ tag: "Err", error: { reason: "commit_checkout_changed" } });
  expect(await Bun.file(`${path}/base`).text()).toBe("intervening staged work\n");
  expect(fixture.git(path, "ls-files", "--stage", "base")).toBe(index);
  expect(fixture.git(path, "rev-parse", "HEAD")).toBe(fixture.base);
  expect(fixture.data().data.candidate?.head).toBeNull();
  expect(fixture.data().data.history).toEqual([]);
});

test.each(["unstaged", "untracked", "ignored"])(
  "candidate recovery preserves %s work after an interrupted commit",
  async (kind) => {
    fixture = await commitFixture();
    await fixture.change();
    const hook = `${fixture.checkout}/.git/hooks/pre-commit`;
    await Bun.write(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);
    expect((await CommitDelivery.review(fixture.input)).tag).toBe("Err");
    const before = fixture.data().data;
    const path = z.string().parse(before.candidate?.path);
    let file = "base";
    if (kind === "untracked") file = "personal";
    if (kind === "ignored") {
      fixture.git(path, "restore", "--source", "HEAD", "--staged", "--worktree", "feature");
      await Bun.write(`${fixture.checkout}/.git/info/exclude`, "\nfeature\n");
      file = "feature";
    }
    await Bun.write(`${path}/${file}`, "personal work\n");
    const index = fixture.git(path, "ls-files", "--stage");
    await Bun.file(hook).delete();
    expect(await CommitDelivery.review(fixture.input)).toMatchObject({
      tag: "Err",
      error: { reason: kind === "ignored" ? "commit_git_failed" : "commit_worktree_unclean" },
    });
    expect(await Bun.file(`${path}/${file}`).text()).toBe("personal work\n");
    expect(fixture.git(path, "ls-files", "--stage")).toBe(index);
    expect(fixture.git(path, "rev-parse", "HEAD")).toBe(fixture.base);
    expect(fixture.data().data.candidate).toEqual(before.candidate);
    expect(fixture.data().data.history).toEqual([]);
    expect(fixture.data().data.publishedHead).toBeNull();
    expect(fixture.data().data.journal.slice(0, before.journal.length)).toEqual(before.journal);
  },
);

test("candidate recovery requires its own durable tree-installation intent", async () => {
  fixture = await commitFixture();
  await fixture.change();
  const write = DeviceState.changeCommitDelivery.bind(DeviceState);
  const save = spyOn(DeviceState, "changeCommitDelivery").mockImplementation(
    (paths, target, change) => {
      const data = DeviceState.commitDeliverySchema().parse(JSON.parse(change.data));
      if (data.journal.at(-1)?.effect.startsWith("candidate_index:"))
        return Err({
          reason: "state_busy",
          detail: "Interrupted before candidate installation intent.",
          next: { command: "operator next", why: "Retry." },
        });
      return write(paths, target, change);
    },
  );
  expect((await CommitDelivery.review(fixture.input)).tag).toBe("Err");
  save.mockRestore();
  const before = fixture.data().data;
  const candidate = before.candidate ?? expect.unreachable();
  fixture.git(candidate.path, "restore", "--source", candidate.tree, "--staged", "--worktree", ".");
  const index = fixture.git(candidate.path, "ls-files", "--stage");
  expect(await CommitDelivery.review(fixture.input)).toMatchObject({
    tag: "Err",
    error: { reason: "commit_worktree_unclean" },
  });
  expect(fixture.git(candidate.path, "ls-files", "--stage")).toBe(index);
  expect(fixture.git(candidate.path, "rev-parse", "HEAD")).toBe(fixture.base);
  expect(fixture.data().data.history).toEqual([]);
  expect(fixture.data().data.candidate).toEqual(candidate);
});

test("an interrupted candidate tree-installation receipt recovers the exact pending tree once", async () => {
  fixture = await commitFixture();
  await fixture.change();
  const write = DeviceState.changeCommitDelivery.bind(DeviceState);
  const save = spyOn(DeviceState, "changeCommitDelivery").mockImplementation(
    (paths, target, change) => {
      const last = DeviceState.commitDeliverySchema().parse(JSON.parse(change.data)).journal.at(-1);
      if (last?.effect.startsWith("candidate_index:") && last.state === "verified")
        return Err({
          reason: "state_busy",
          detail: "Interrupted candidate installation receipt.",
          next: { command: "operator next", why: "Retry." },
        });
      return write(paths, target, change);
    },
  );
  expect((await CommitDelivery.review(fixture.input)).tag).toBe("Err");
  save.mockRestore();
  const before = fixture.data().data;
  await fixture.review();
  const after = fixture.data().data;
  expect(after.candidate).toMatchObject({
    path: before.candidate?.path,
    branch: before.candidate?.branch,
    tree: before.candidate?.tree,
  });
  expect(after.history).toEqual([z.string().parse(after.candidate?.head)]);
  expect(
    fixture.git(
      z.string().parse(after.candidate?.path),
      "rev-list",
      "--count",
      `${fixture.base}..HEAD`,
    ),
  ).toBe("1");
  expect(after.journal.slice(0, before.journal.length)).toEqual(before.journal);
});

test("an ignored obstruction created after the clean observation is not overwritten", async () => {
  fixture = await commitFixture();
  await fixture.change();
  await fixture.review();
  expect((await CommitDelivery.round({ ...fixture.input, text: "## Findings" })).tag).toBe("Ok");
  const current = fixture;
  const transport = current.transport.getMockImplementation() ?? expect.unreachable();
  const index = current.git(current.checkout, "ls-files", "--stage");
  current.transport.mockImplementation(async (input) => {
    if (input.tool === "git" && input.args[0] === "apply" && input.cwd === current.checkout) {
      await Bun.write(`${current.checkout}/.git/info/exclude`, "\nfeature\n");
      await Bun.write(`${current.checkout}/feature`, "intervening ignored work\n");
    }
    return transport(input);
  });
  expect(await CommitDelivery.deliver({ ...current.input, text: "## Dispositions" })).toMatchObject(
    {
      tag: "Err",
      error: { reason: "commit_git_failed" },
    },
  );
  expect(await Bun.file(`${current.checkout}/feature`).text()).toBe("intervening ignored work\n");
  expect(current.git(current.checkout, "ls-files", "--stage")).toBe(index);
  expect(current.git(current.checkout, "rev-parse", "main")).toBe(current.base);
  expect(current.git(current.root, "--git-dir", current.origin, "rev-parse", "main")).toBe(
    current.base,
  );
  expect(current.data().data.publishedHead).toBeNull();
});

test("checkout recovery refuses unrelated staged work without rewriting either index entry", async () => {
  fixture = await commitFixture();
  await fixture.change();
  await fixture.review();
  expect((await CommitDelivery.round({ ...fixture.input, text: "## Findings" })).tag).toBe("Ok");
  const write = DeviceState.changeCommitDelivery.bind(DeviceState);
  const save = spyOn(DeviceState, "changeCommitDelivery").mockImplementation(
    (paths, target, change) => {
      const last = DeviceState.commitDeliverySchema().parse(JSON.parse(change.data)).journal.at(-1);
      if (last?.effect === "checkout_index" && last.state === "verified")
        return Err({
          reason: "state_busy",
          detail: "Interrupted checkout receipt.",
          next: { command: "operator next", why: "Retry." },
        });
      return write(paths, target, change);
    },
  );
  const delivery = { ...fixture.input, text: "## Dispositions" };
  expect((await CommitDelivery.deliver(delivery)).tag).toBe("Err");
  save.mockRestore();
  const before = fixture.data().data;
  await Bun.write(`${fixture.checkout}/base`, "personal staged work\n");
  fixture.git(fixture.checkout, "add", "base");
  const index = fixture.git(fixture.checkout, "ls-files", "--stage");
  expect(await CommitDelivery.deliver(delivery)).toMatchObject({
    tag: "Err",
    error: { reason: "commit_worktree_unclean" },
  });
  expect(await Bun.file(`${fixture.checkout}/base`).text()).toBe("personal staged work\n");
  expect(await Bun.file(`${fixture.checkout}/feature`).text()).toBe("feature\n");
  expect(fixture.git(fixture.checkout, "ls-files", "--stage")).toBe(index);
  expect(fixture.git(fixture.checkout, "rev-parse", "main")).toBe(fixture.base);
  expect(fixture.data().data.history).toEqual(before.history);
  expect(fixture.data().data.journal.slice(0, before.journal.length)).toEqual(before.journal);
  expect(fixture.data().data.publishedHead).toBeNull();
  fixture.git(fixture.checkout, "restore", "--source", "HEAD", "--staged", "--worktree", "base");
  expect((await CommitDelivery.deliver(delivery)).tag).toBe("Ok");
  expect(fixture.data().data.history).toEqual(before.history);
});

test("the state owner rejects a backward transition that erases local delivery evidence", async () => {
  fixture = await commitFixture();
  await fixture.change();
  await fixture.review();
  expect((await CommitDelivery.round({ ...fixture.input, text: "## Findings" })).tag).toBe("Ok");
  const real = fixture.runTool;
  const origin = fixture.origin;
  fixture.transport.mockImplementation((input) => {
    if (input.tool === "git" && input.args[0] === "push")
      return Promise.resolve({ status: "completed", exitCode: 1, stdout: "", stderr: "denied" });
    return real({
      ...input,
      args:
        input.tool === "git" && ["fetch", "ls-remote"].includes(input.args[0] ?? "")
          ? input.args.map((arg) => (arg === "origin" ? origin : arg))
          : input.args,
    });
  });
  expect((await CommitDelivery.deliver({ ...fixture.input, text: "## Dispositions" })).tag).toBe(
    "Err",
  );
  const before = fixture.data();
  const index = fixture.git(fixture.checkout, "ls-files", "--stage");
  expect(before.data.stage).toBe("remote");
  expect(fixture.git(fixture.checkout, "rev-parse", "main")).toBe(
    z.string().parse(before.data.candidate?.head),
  );
  const changed = DeviceState.changeCommitDelivery(fixture.paths, fixture.target, {
    revision: before.revision,
    launchId: "reviewer",
    data: JSON.stringify({
      ...before.data,
      stage: "build",
      candidate: null,
      history: [],
      implementer: null,
      rounds: [],
      dispositions: [],
      checks: null,
      journal: [],
    }),
  });
  expect(changed).toMatchObject({ tag: "Err", error: { reason: "commit_transition_invalid" } });
  expect(fixture.data()).toEqual(before);
  expect(fixture.git(fixture.checkout, "ls-files", "--stage")).toBe(index);
  expect(fixture.git(fixture.checkout, "rev-parse", "main")).toBe(
    z.string().parse(before.data.candidate?.head),
  );
  expect(fixture.git(fixture.root, "--git-dir", fixture.origin, "rev-parse", "main")).toBe(
    fixture.base,
  );
});

test("a post-push programming defect propagates while retaining verified publication", async () => {
  fixture = await commitFixture();
  await fixture.change();
  await fixture.review();
  expect((await CommitDelivery.round({ ...fixture.input, text: "## Findings" })).tag).toBe("Ok");
  const real = fixture.runTool;
  const origin = fixture.origin;
  fixture.transport.mockImplementation(async (input) => {
    const result = await real({
      ...input,
      args:
        input.tool === "git" && ["fetch", "ls-remote", "push"].includes(input.args[0] ?? "")
          ? input.args.map((arg) => (arg === "origin" ? origin : arg))
          : input.args,
    });
    if (input.tool === "git" && input.args[0] === "push")
      // oxlint-disable-next-line unthrown/no-throw -- Inject a programming defect at the external invocation boundary.
      throw new Error("Injected post-push programming defect");
    return result;
  });
  const result = await CommitDelivery.deliver({ ...fixture.input, text: "## Dispositions" });
  expect(result.tag).toBe("Defect");
  const data = fixture.data().data;
  expect(data.stage).toBe("finalize");
  expect(data.publishedHead).toBe(z.string().parse(data.candidate?.head));
  expect(data.journal.at(-1)).toMatchObject({ effect: "remote_publication", state: "verified" });
  expect(fixture.git(fixture.root, "--git-dir", fixture.origin, "rev-parse", "main")).toBe(
    z.string().parse(data.candidate?.head),
  );
  expect((await CommitDelivery.deliver({ ...fixture.input, text: "## Dispositions" })).tag).toBe(
    "Ok",
  );
  const recovered = fixture.data().data;
  expect(recovered.history).toEqual(data.history);
  expect(recovered.publishedHead).toBe(data.publishedHead);
  expect(recovered.journal.slice(0, data.journal.length)).toEqual(data.journal);
  expect(fixture.transport.mock.calls.filter(([input]) => input.args[0] === "push")).toHaveLength(
    1,
  );
});
