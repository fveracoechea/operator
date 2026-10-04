import { describe, expect, test } from "bun:test";
import { LiveProbe } from "./main.ts";
import { ProjectReadiness } from "../project-readiness/main.ts";
import { briefFor, readReport, type ProbeStep } from "./protocol.ts";
import { waitForFile } from "./scratch.ts";

describe("the live probe catalogue", () => {
  test("runs exactly the checks readiness declares", () => {
    const declared = ProjectReadiness.liveChecks().map((one) => one.name);

    expect(LiveProbe.supportedChecks().toSorted()).toEqual(declared.toSorted());
  });

  test("names every check readiness reads back, so none is silently unproven", () => {
    const declared = ProjectReadiness.liveChecks();

    expect(declared.every((one) => one.claims.includes("readiness"))).toBe(true);
    expect(declared.some((one) => one.claims.includes("release"))).toBe(true);
  });
});

test("a live probe brief gives the agent a report the reader accepts", () => {
  for (const step of ["loading", "question", "result", "review", "interruption"] as ProbeStep[]) {
    const brief = briefFor({
      probeId: "probe-1",
      step,
      reportPath: `/tmp/probe/.operator/probe/${step}.json`,
      worktreePath: "/tmp/probe",
      instructions: [],
      instructionFiles: ["AGENTS.md"],
      skillNames: ["operator", "operative"],
      host: "opencode",
    });
    const example = brief
      .split(
        "Use exactly this JSON shape. Replace example values with what you observed, including actual timestamps for review axes:\n",
      )[1]
      ?.split("\nWrite your report as JSON to ")[0];
    expect(example).toBeDefined();
    expect(readReport(step, example ?? "").status).toBe("read");
    if (step === "loading") {
      expect(brief).toContain(
        "Read SKILL.md for each of these installed skills: operator, operative.",
      );
    }
    if (step === "interruption") {
      expect(brief).toContain("Write a partial.txt file at /tmp/probe/partial.txt");
      expect(brief).toContain("Stop without starting a wait or a child process.");
    }
  }
});

test("reads a report written after observation starts", async () => {
  const path = `/tmp/opencode/operator-live-report-${crypto.randomUUID()}.json`;
  try {
    const pending = waitForFile({ path, windowMs: 500 });
    await Bun.sleep(40);
    await Bun.write(path, '{"step":"loading"}');
    expect(await pending).toMatchObject({ status: "read", text: '{"step":"loading"}' });
  } finally {
    const { rm } = await import("node:fs/promises");
    await rm(path, { force: true });
  }
});

describe("the probe cleanup machine", () => {
  const approve = { directories: 1, approvedCleanupId: "cleanup-1", cleanupId: "cleanup-1" };

  test("refuses an approval in the order nothing, required, stale", () => {
    expect(
      LiveProbe.decideCleanup("inspected", "approve", {
        directories: 0,
        approvedCleanupId: undefined,
        cleanupId: "cleanup-1",
      }),
    ).toEqual({ refused: "nothing" });
    expect(
      LiveProbe.decideCleanup("inspected", "approve", { ...approve, approvedCleanupId: undefined }),
    ).toEqual({ refused: "approval-required" });
    expect(
      LiveProbe.decideCleanup("inspected", "approve", { ...approve, approvedCleanupId: "old" }),
    ).toEqual({ refused: "approval-stale" });
    expect(LiveProbe.decideCleanup("inspected", "approve", approve)).toEqual({ next: "approved" });
  });

  test("blocks a cancel or a disposal that names a blocker", () => {
    expect(LiveProbe.decideCleanup("approved", "cancel", { blocker: "occupied" })).toEqual({
      refused: "blocked",
    });
    expect(LiveProbe.decideCleanup("approved", "cancel", { blocker: null })).toEqual({
      next: "checked",
    });
    expect(LiveProbe.decideCleanup("checked", "dispose", { blocker: "still live" })).toEqual({
      refused: "blocked",
    });
    expect(LiveProbe.decideCleanup("checked", "dispose", { blocker: null })).toEqual({
      next: "disposed",
    });
  });

  test("keeps a run with an unresolved fixture pending after disposal", () => {
    expect(LiveProbe.decideCleanup("disposed", "inspect", { remaining: 1 })).toEqual({
      refused: "pending-fixture",
    });
    expect(LiveProbe.decideCleanup("disposed", "inspect", { remaining: 0 })).toEqual({
      next: "removed",
    });
  });

  test("never disposes of a resource before the cancel checked every one", () => {
    expect(() => LiveProbe.decideCleanup("approved", "dispose", { blocker: null })).toThrow();
  });
});
