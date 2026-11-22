import { afterEach, expect, jest, spyOn, test } from "bun:test";
import { Err } from "unthrown";
// Bun has no file permission API.
import { chmod, rename, rm } from "node:fs/promises";
import { DeviceState } from "../device-state/main.ts";
import { CommitDelivery } from "./main.ts";
import { commitFixture } from "../../../tools/commit-delivery-fixture.ts";
import { z } from "zod";
import { WorkSources } from "../work-sources/main.ts";

let fixture: Awaited<ReturnType<typeof commitFixture>> | undefined;
afterEach(async () => {
  await fixture?.dispose();
  fixture = undefined;
  jest.restoreAllMocks();
});

test("failed remote publication retains local success and retries the same candidate after remote advancement", async () => {
  fixture = await commitFixture();
  await fixture.change();
  await fixture.review();
  expect((await CommitDelivery.round({ ...fixture.input, text: "## Findings" })).tag).toBe("Ok");
  const candidate = z.string().parse(fixture.data().data.candidate?.head);
  const delivery = { ...fixture.input, text: "## Dispositions" };
  const real = fixture.runTool;
  const origin = fixture.origin;
  fixture.transport.mockImplementation((input) => {
    if (input.tool === "git" && input.args?.[0] === "push")
      return Promise.resolve({ status: "completed", exitCode: 1, stdout: "", stderr: "denied" });
    return real({
      ...input,
      args:
        input.tool === "git" && ["fetch", "ls-remote"].includes(input.args?.[0] ?? "")
          ? input.args?.map((arg) => (arg === "origin" ? origin : arg))
          : input.args,
    });
  });
  expect(await CommitDelivery.deliver(delivery)).toMatchObject({ tag: "Err" });
  expect(fixture.git(fixture.checkout, "rev-parse", "main")).toBe(candidate);
  expect(fixture.git(fixture.root, "--git-dir", origin, "rev-parse", "main")).toBe(fixture.base);
  expect(fixture.data().data).toMatchObject({ stage: "remote", candidate: { head: candidate } });
  expect(
    await WorkSources.abandon({ paths: fixture.paths, cwd: fixture.checkout, ...fixture.target }),
  ).toMatchObject({ tag: "Err", error: { reason: "commit_delivery_running" } });
  // A lost success response followed by another person's remote fast-forward is recoverable.
  fixture.git(fixture.checkout, "push", origin, "main");
  fixture.git(
    fixture.checkout,
    "worktree",
    "add",
    "-qb",
    "concurrent",
    `${fixture.root}/concurrent`,
    "main",
  );
  await Bun.write(`${fixture.root}/concurrent/other`, "someone else\n");
  fixture.git(`${fixture.root}/concurrent`, "add", ".");
  fixture.git(`${fixture.root}/concurrent`, "commit", "-qm", "concurrent");
  fixture.git(`${fixture.root}/concurrent`, "push", origin, "HEAD:main");
  const retried = await CommitDelivery.deliver(delivery);
  expect(retried.tag).toBe("Ok");
  expect(fixture.data().data.history).toEqual([candidate]);
});

test("two rounds do not waive review of final blocker fixes", async () => {
  fixture = await commitFixture();
  await fixture.change();
  await fixture.review();
  const blocker = "## Findings\n- blocker, Spec, feature: The behavior is incomplete.\n";
  expect((await CommitDelivery.round({ ...fixture.input, text: blocker })).tag).toBe("Ok");
  expect(
    await CommitDelivery.deliver({
      ...fixture.input,
      text: "## Dispositions\n- 1.1 applied",
    }),
  ).toMatchObject({
    error: {
      reason: "commit_blocker_requires_review",
      next: { command: "operator commit round --file <file>" },
    },
  });
  await fixture.change("corrected\n");
  expect((await CommitDelivery.round({ ...fixture.input, text: blocker })).tag).toBe("Ok");
  expect(
    await CommitDelivery.deliver({
      ...fixture.input,
      text: "## Dispositions\n- 1.1 applied\n- 2.1 applied",
    }),
  ).toMatchObject({ error: { reason: "commit_review_limit", next: { decider: "person" } } });
  expect(await CommitDelivery.round({ ...fixture.input, text: "## Findings" })).toMatchObject({
    error: { reason: "commit_review_limit" },
  });
  expect(fixture.git(fixture.checkout, "rev-parse", "main")).toBe(fixture.base);
  expect(fixture.git(fixture.root, "--git-dir", fixture.origin, "rev-parse", "main")).toBe(
    fixture.base,
  );
  expect(fixture.data().data.history).toHaveLength(2);
});

test.each([
  [process.execPath, "-e", "process.exit(1)"],
  [process.execPath, "-e", "await Bun.write('feature', 'unexpected check mutation\\n')"],
])("failed or mutating configured check %j cannot advance main", async (tool, flag, script) => {
  fixture = await commitFixture([[tool, flag, script]]);
  await fixture.change();
  await fixture.review();
  expect((await CommitDelivery.round({ ...fixture.input, text: "## Findings" })).tag).toBe("Ok");
  expect((await CommitDelivery.deliver({ ...fixture.input, text: "## Dispositions" })).tag).toBe(
    "Err",
  );
  expect(fixture.git(fixture.checkout, "rev-parse", "main")).toBe(fixture.base);
  expect(fixture.git(fixture.root, "--git-dir", fixture.origin, "rev-parse", "main")).toBe(
    fixture.base,
  );
  expect(fixture.data().data.stage).toBe("review");
});

test("an interrupted candidate receipt recovers the hook-created commit rather than creating another", async () => {
  fixture = await commitFixture();
  await fixture.change();
  const write = DeviceState.changeCommitDelivery.bind(DeviceState);
  let interrupted = false;
  const save = spyOn(DeviceState, "changeCommitDelivery").mockImplementation(
    (paths, target, change) => {
      const data = DeviceState.commitDeliverySchema().parse(JSON.parse(change.data));
      if (!interrupted && data.candidate?.head) {
        interrupted = true;
        return Err({
          reason: "state_busy",
          detail: "Injected interrupted candidate receipt.",
          next: { command: "operator next", why: "Retry." },
        });
      }
      return write(paths, target, change);
    },
  );
  expect((await CommitDelivery.review(fixture.input)).tag).toBe("Err");
  const candidate = fixture.data().data.candidate;
  const created = fixture.git(z.string().parse(candidate?.path), "rev-parse", "HEAD");
  expect(fixture.data().data.candidate?.head).toBeNull();
  save.mockRestore();
  await fixture.review();
  expect(fixture.data().data.candidate?.head).toBe(created);
  expect(fixture.data().data.history).toEqual([created]);
});

test.each(["local_ref", "remote_publication", "database_finalization"])(
  "a lost %s receipt retries the pinned candidate and finalizes only verified remote delivery",
  async (effect) => {
    fixture = await commitFixture();
    await fixture.change();
    await fixture.review();
    expect((await CommitDelivery.round({ ...fixture.input, text: "## Findings" })).tag).toBe("Ok");
    const write = DeviceState.changeCommitDelivery.bind(DeviceState);
    let interrupted = false;
    const save = spyOn(DeviceState, "changeCommitDelivery").mockImplementation(
      (paths, target, change) => {
        const data = DeviceState.commitDeliverySchema().parse(JSON.parse(change.data));
        const last = data.journal.at(-1);
        if (!interrupted && last?.effect === effect && last.state === "verified") {
          interrupted = true;
          return Err({
            reason: "state_busy",
            detail: "Injected interrupted receipt.",
            next: { command: "operator next", why: "Retry." },
          });
        }
        return write(paths, target, change);
      },
    );
    const delivery = { ...fixture.input, text: "## Dispositions" };
    expect((await CommitDelivery.deliver(delivery)).tag).toBe("Err");
    const pinned = z.string().parse(fixture.data().data.candidate?.head);
    expect(fixture.git(fixture.checkout, "rev-parse", "main")).toBe(pinned);
    save.mockRestore();
    expect((await CommitDelivery.deliver(delivery)).tag).toBe("Ok");
    expect(fixture.data().data.history).toEqual([pinned]);
    expect(fixture.git(fixture.root, "--git-dir", fixture.origin, "rev-parse", "main")).toBe(
      pinned,
    );
    expect(fixture.data().data.stage).toBe("complete");
  },
);

test.each(["untracked", "busy", "other-branch", "extra-main"])(
  "a %s controlling checkout refuses delivery and preserves both heads",
  async (scenario) => {
    fixture = await commitFixture();
    await fixture.change();
    await fixture.review();
    expect((await CommitDelivery.round({ ...fixture.input, text: "## Findings" })).tag).toBe("Ok");
    if (scenario === "untracked") await Bun.write(`${fixture.checkout}/personal`, "keep");
    if (scenario === "busy") await Bun.write(`${fixture.checkout}/.git/index.lock`, "held");
    if (scenario === "other-branch") fixture.git(fixture.checkout, "switch", "-qc", "personal");
    if (scenario === "extra-main")
      fixture.git(fixture.checkout, "worktree", "add", "--force", `${fixture.root}/extra`, "main");
    expect((await CommitDelivery.deliver({ ...fixture.input, text: "## Dispositions" })).tag).toBe(
      "Err",
    );
    expect(fixture.git(fixture.checkout, "rev-parse", "main")).toBe(fixture.base);
    expect(fixture.git(fixture.root, "--git-dir", fixture.origin, "rev-parse", "main")).toBe(
      fixture.base,
    );
    if (scenario === "untracked")
      expect(await Bun.file(`${fixture.checkout}/personal`).text()).toBe("keep");
    if (scenario === "busy")
      expect(await Bun.file(`${fixture.checkout}/.git/index.lock`).text()).toBe("held");
  },
);

test.each(["pre-commit", "commit-msg", "signing"])(
  "candidate creation preserves configured %s behavior without bypassing it",
  async (behavior) => {
    fixture = await commitFixture();
    await fixture.change();
    const script = `${fixture.root}/guard`;
    const marker = `${fixture.root}/invoked`;
    await Bun.write(
      script,
      `#!${process.execPath}\nawait Bun.write(${JSON.stringify(marker)}, process.argv.slice(2).join(" "));\nprocess.exit(1);\n`,
    );
    await chmod(script, 0o755);
    if (behavior === "signing") {
      fixture.git(fixture.checkout, "config", "commit.gpgsign", "true");
      fixture.git(fixture.checkout, "config", "gpg.program", script);
    } else {
      await Bun.write(`${fixture.checkout}/.git/hooks/${behavior}`, await Bun.file(script).text());
      await chmod(`${fixture.checkout}/.git/hooks/${behavior}`, 0o755);
    }
    expect((await CommitDelivery.review(fixture.input)).tag).toBe("Err");
    expect(await Bun.file(marker).exists()).toBe(true);
    expect(fixture.git(fixture.checkout, "rev-parse", "main")).toBe(fixture.base);
    expect(fixture.data().data.candidate?.head).toBeNull();
  },
);

test("a concurrent local ref change rejects the CAS instead of overwriting the other commit", async () => {
  fixture = await commitFixture();
  await fixture.change();
  await fixture.review();
  expect((await CommitDelivery.round({ ...fixture.input, text: "## Findings" })).tag).toBe("Ok");
  const own = fixture;
  const real = own.runTool;
  let concurrent = "";
  own.transport.mockImplementation((input) => {
    if (input.tool === "git" && input.args?.[0] === "update-ref") {
      concurrent = own.git(
        own.checkout,
        "commit-tree",
        `${own.base}^{tree}`,
        "-p",
        own.base,
        "-m",
        "other person's work",
      );
      own.git(own.checkout, "update-ref", "refs/heads/main", concurrent, own.base);
    }
    return real({
      ...input,
      args:
        input.tool === "git" && ["fetch", "ls-remote", "push"].includes(input.args?.[0] ?? "")
          ? input.args?.map((arg) => (arg === "origin" ? own.origin : arg))
          : input.args,
    });
  });
  expect((await CommitDelivery.deliver({ ...own.input, text: "## Dispositions" })).tag).toBe("Err");
  expect(own.git(own.checkout, "rev-parse", "main")).toBe(concurrent);
  expect(own.git(own.root, "--git-dir", own.origin, "rev-parse", "main")).toBe(own.base);
  expect(own.data().data.stage).toBe("local");
});

test("a replacement foreign repository at the controlling path cannot receive the ticket commit", async () => {
  fixture = await commitFixture();
  await fixture.change();
  await fixture.review();
  expect((await CommitDelivery.round({ ...fixture.input, text: "## Findings" })).tag).toBe("Ok");
  fixture.git(fixture.root, "clone", "-q", fixture.checkout, `${fixture.root}/foreign`);
  fixture.git(
    `${fixture.root}/foreign`,
    "remote",
    "set-url",
    "origin",
    "https://github.com/example/one.git",
  );
  await rename(fixture.checkout, `${fixture.root}/retained`);
  fixture.git(`${fixture.root}/retained`, "worktree", "repair", fixture.worktree);
  await rename(`${fixture.root}/foreign`, fixture.checkout);
  expect(await CommitDelivery.deliver({ ...fixture.input, text: "## Dispositions" })).toMatchObject(
    { error: { reason: "commit_foreign_checkout" } },
  );
  expect(fixture.git(fixture.checkout, "rev-parse", "main")).toBe(fixture.base);
});

test.each(["review", "remote"])(
  "loss of the candidate checkout at %s never creates a second ticket commit",
  async (stage) => {
    fixture = await commitFixture();
    await fixture.change();
    await fixture.review();
    expect((await CommitDelivery.round({ ...fixture.input, text: "## Findings" })).tag).toBe("Ok");
    const own = fixture;
    const real = own.runTool;
    const delivery = { ...own.input, text: "## Dispositions" };
    if (stage === "remote") {
      own.transport.mockImplementation((input) =>
        input.tool === "git" && input.args?.[0] === "push"
          ? Promise.resolve({ status: "completed", exitCode: 1, stdout: "", stderr: "denied" })
          : real({
              ...input,
              args:
                input.tool === "git" && ["fetch", "ls-remote"].includes(input.args?.[0] ?? "")
                  ? input.args?.map((arg) => (arg === "origin" ? own.origin : arg))
                  : input.args,
            }),
      );
      expect((await CommitDelivery.deliver(delivery)).tag).toBe("Err");
    }
    const candidate = own.data().data.candidate ?? expect.unreachable("No pinned candidate");
    const pinned = z.string().parse(candidate.head);
    await rm(candidate.path, { recursive: true, force: true });
    own.transport.mockImplementation((input) =>
      real({
        ...input,
        args:
          input.tool === "git" && ["fetch", "ls-remote", "push"].includes(input.args?.[0] ?? "")
            ? input.args?.map((arg) => (arg === "origin" ? own.origin : arg))
            : input.args,
      }),
    );
    expect((await CommitDelivery.deliver(delivery)).tag).toBe(stage === "remote" ? "Ok" : "Err");
    expect(own.data().data.history).toEqual([pinned]);
    expect(own.git(own.checkout, "rev-parse", "main")).toBe(stage === "remote" ? pinned : own.base);
    expect(own.git(own.checkout, "show", "ticket/411:feature")).toBe("feature");
  },
);
