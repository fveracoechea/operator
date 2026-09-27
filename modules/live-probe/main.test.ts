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
      reportPath: `/tmp/probe/${step}.json`,
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
