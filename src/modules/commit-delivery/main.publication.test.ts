import { afterEach, expect, jest, spyOn, test } from "bun:test";
import { Err } from "unthrown";
import { z } from "zod";
import { CommitDelivery } from "./main.ts";
import { DeviceState } from "../device-state/main.ts";
import { commitFixture } from "../../../tools/commit-delivery-fixture.ts";
// Bun has no assertion error constructor.
import { AssertionError } from "node:assert";

let fixture: Awaited<ReturnType<typeof commitFixture>> | undefined;
afterEach(async () => {
  await fixture?.dispose();
  fixture = undefined;
  jest.restoreAllMocks();
});

test.each(["ERR_ASSERTION", "EUNKNOWN"])(
  "an unknown coded %s error after publication remains a defect",
  async (code) => {
    fixture = await commitFixture();
    await fixture.change();
    await fixture.review();
    expect((await CommitDelivery.round({ ...fixture.input, text: "## Findings" })).tag).toBe("Ok");
    const current = fixture;
    const transport = current.transport.getMockImplementation() ?? expect.unreachable();
    current.transport.mockImplementation(async (input) => {
      const result = await transport(input);
      if (input.tool === "git" && input.args[0] === "push") {
        const cause =
          code === "ERR_ASSERTION"
            ? new AssertionError({ message: "Post-push invariant failed." })
            : Object.assign(new Error("Unknown coded defect"), { code });
        // oxlint-disable-next-line unthrown/no-throw -- Inject a coded programming defect after real disposable publication.
        throw cause;
      }
      return result;
    });
    expect((await CommitDelivery.deliver({ ...current.input, text: "## Dispositions" })).tag).toBe(
      "Defect",
    );
    const after = current.data().data;
    expect(after.stage).toBe("finalize");
    expect(after.publishedHead).toBe(after.candidate?.head ?? "");
    expect(after.journal.at(-1)).toMatchObject({ effect: "remote_publication", state: "verified" });
    expect(after.journal.some((row) => row.effect === "database_finalization")).toBe(false);
    expect(current.git(current.checkout, "rev-parse", "main")).toBe(after.candidate?.head ?? "");
    expect(current.git(current.root, "--git-dir", current.origin, "rev-parse", "main")).toBe(
      after.candidate?.head ?? "",
    );
  },
);

test.each(["not-applied", "unobservable", "receipt-failed"])(
  "a push defect remains a defect when reconciliation is %s",
  async (mode) => {
    fixture = await commitFixture();
    await fixture.change();
    await fixture.review();
    expect((await CommitDelivery.round({ ...fixture.input, text: "## Findings" })).tag).toBe("Ok");
    const current = fixture;
    const transport = current.transport.getMockImplementation() ?? expect.unreachable();
    let pushed = false;
    current.transport.mockImplementation(async (input) => {
      if (input.tool === "git" && input.args[0] === "push") {
        pushed = true;
        if (mode !== "not-applied") await transport(input);
        // oxlint-disable-next-line unthrown/no-throw -- Inject an unmodeled defect after a potentially applied external effect.
        throw new Error("Injected push defect");
      }
      if (pushed && mode === "unobservable" && input.args[0] === "ls-remote")
        return { status: "completed", exitCode: 1, stdout: "", stderr: "unavailable" };
      return transport(input);
    });
    if (mode === "receipt-failed") {
      const write = DeviceState.changeCommitDelivery.bind(DeviceState);
      spyOn(DeviceState, "changeCommitDelivery").mockImplementation((paths, target, change) => {
        if (
          DeviceState.commitDeliverySchema().parse(JSON.parse(change.data)).publishedHead !== null
        )
          return Err({
            reason: "state_busy",
            detail: "Injected publication receipt failure.",
            next: { command: "operator next", why: "Retry." },
          });
        return write(paths, target, change);
      });
    }
    expect((await CommitDelivery.deliver({ ...current.input, text: "## Dispositions" })).tag).toBe(
      "Defect",
    );
    const before = current.data().data;
    expect(before.stage).toBe("remote");
    expect(before.publishedHead).toBeNull();
    expect(before.journal.at(-1)).toMatchObject({ effect: "remote_publication", state: "intent" });
    expect(current.git(current.checkout, "rev-parse", "main")).toBe(before.candidate?.head ?? "");
    expect(current.git(current.root, "--git-dir", current.origin, "rev-parse", "main")).toBe(
      mode === "not-applied" ? current.base : (before.candidate?.head ?? ""),
    );
  },
);

test.each(["no-answer", "nonzero", "io-error"])(
  "an operational %s push response can reconcile verified publication",
  async (mode) => {
    fixture = await commitFixture();
    await fixture.change();
    await fixture.review();
    expect((await CommitDelivery.round({ ...fixture.input, text: "## Findings" })).tag).toBe("Ok");
    const current = fixture;
    const transport = current.transport.getMockImplementation() ?? expect.unreachable();
    current.transport.mockImplementation(async (input) => {
      const result = await transport(input);
      if (input.tool !== "git" || input.args[0] !== "push") return result;
      if (mode === "io-error") {
        // oxlint-disable-next-line unthrown/no-throw -- Inject a modeled I/O rejection at the invocation boundary.
        throw Object.assign(new Error("broken pipe"), { code: "EPIPE" });
      }
      return mode === "no-answer"
        ? { status: "no-answer", detail: "Response lost." }
        : { status: "completed", exitCode: 1, stdout: "", stderr: "Response lost." };
    });
    expect((await CommitDelivery.deliver({ ...current.input, text: "## Dispositions" })).tag).toBe(
      "Ok",
    );
    const after = current.data().data;
    expect(after.stage).toBe("complete");
    expect(after.publishedHead).toBe(after.candidate?.head ?? "");
    expect(after.history).toEqual([z.string().parse(after.candidate?.head)]);
  },
);
