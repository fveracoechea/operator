import { afterEach, expect, jest, spyOn, test } from "bun:test";
import { CommitDelivery } from "./main.ts";
import { DeviceState } from "../device-state/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { commitFixture } from "../../../tools/commit-delivery-fixture.ts";

let fixture: Awaited<ReturnType<typeof commitFixture>> | undefined;
afterEach(async () => {
  await fixture?.dispose();
  fixture = undefined;
  jest.restoreAllMocks();
});

test("known process I/O failures are operational only at the invocation boundary", async () => {
  fixture = await commitFixture();
  await fixture.change();
  const before = fixture.data();
  for (const code of [
    "EACCES",
    "ENOENT",
    "ENOTDIR",
    "EEXIST",
    "EPERM",
    "EROFS",
    "ENOSPC",
    "EIO",
    "EMFILE",
    "ENFILE",
    "EPIPE",
  ]) {
    fixture.transport.mockImplementation(async () => {
      // oxlint-disable-next-line unthrown/no-throw -- Inject a known system I/O failure at its actual process boundary.
      throw Object.assign(new Error(`modeled ${code}`), { code });
    });
    expect(await CommitDelivery.review(fixture.input)).toMatchObject({
      tag: "Err",
      error: {
        reason: "commit_io_failed",
        detail: `Error: modeled ${code}`,
        next: {
          decider: "person",
          question:
            "How should the filesystem failure be recovered without discarding partial effects?",
        },
      },
    });
    expect(fixture.data()).toEqual(before);
  }
});

test("uncoded, unknown-coded, nonstring-coded and non-Error failures remain defects", async () => {
  fixture = await commitFixture();
  await fixture.change();
  const before = fixture.data();
  for (const cause of [
    new Error("plain defect"),
    Object.assign(new Error("unknown defect"), { code: "ERR_ASSERTION" }),
    Object.assign(new Error("nonstring defect"), { code: 17 }),
    { code: "EACCES" },
  ]) {
    fixture.transport.mockImplementation(async () => {
      // oxlint-disable-next-line unthrown/no-throw -- Inject unmodeled failures, including code-shaped non-Errors.
      throw cause;
    });
    expect((await CommitDelivery.review(fixture.input)).tag).toBe("Defect");
    expect(fixture.data()).toEqual(before);
  }
});

test("a known-looking error outside the I/O boundary cannot become an operational refusal", async () => {
  fixture = await commitFixture();
  await fixture.change();
  const before = fixture.data();
  spyOn(DeviceState, "changeCommitDelivery").mockImplementation(() => {
    // oxlint-disable-next-line unthrown/no-throw -- A state-owner programming failure is not a process or filesystem I/O failure.
    throw Object.assign(new Error("state invariant failed"), { code: "EACCES" });
  });
  expect((await CommitDelivery.review(fixture.input)).tag).toBe("Defect");
  expect(fixture.data()).toEqual(before);
  expect(fixture.git(fixture.checkout, "rev-parse", "main")).toBe(fixture.base);
});

test("an actual filesystem obstruction is an operational refusal without replacing the obstruction", async () => {
  fixture = await commitFixture();
  await fixture.change();
  const root = OperatorHome.commitCandidateRoot(fixture.paths);
  await Bun.write(root, "personal obstruction\n");
  expect(await CommitDelivery.review(fixture.input)).toMatchObject({
    tag: "Err",
    error: { reason: "commit_io_failed" },
  });
  expect(await Bun.file(root).text()).toBe("personal obstruction\n");
  expect(fixture.data().data.candidate?.head).toBeNull();
  expect(fixture.data().data.history).toEqual([]);
  expect(fixture.git(fixture.checkout, "rev-parse", "main")).toBe(fixture.base);
});
