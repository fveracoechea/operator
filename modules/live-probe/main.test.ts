import { describe, expect, test } from "bun:test";
import { LiveProbe } from "./main.ts";
import { ProjectReadiness } from "../project-readiness/main.ts";

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
