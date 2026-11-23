import { afterAll, expect, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { mutationUnitIdentity } from "./mutation-dependencies.ts";
import { mutationReuseDecision, saveMutationReuse } from "./mutation-reuse.ts";
import {
  runMutationUnits,
  mutationEventSchema,
  type MutationEvent,
  type MutationResult,
} from "./mutation-run.ts";
import { mutationEvidence } from "./mutation-evidence.ts";

const root = await mkdtemp("/tmp/opencode/mutation-reuse-evidence-");
afterAll(() => rm(root, { recursive: true, force: true }));
const killed: MutationResult = {
  id: "one",
  status: "Killed",
  mutatorName: "BooleanLiteral",
  location: { start: { line: 1, column: 22 }, end: { line: 1, column: 26 } },
  replacement: "false",
};

async function fixture(scenario: string) {
  const directory = `${root}/${scenario}`;
  const source =
    scenario === "uncertain" ? "export const value = Date.now();" : "export const value = true;";
  const unit = { name: "unit.ts", source, patterns: ["unit.ts"], tests: ["./unit.test.ts"] };
  await Bun.write(`${directory}/unit.ts`, source);
  await Bun.write(`${directory}/unit.test.ts`, 'import "./unit.ts";');
  await Bun.write(
    `${directory}/package.json`,
    JSON.stringify({
      scripts: {
        test: scenario === "watchdog" ? "bun tools/test-watchdog.ts" : "bun test --isolate",
      },
    }),
  );
  const identity = await mutationUnitIdentity(directory, unit, "controlled-engine");
  if (identity.eligible && scenario === "hit")
    await saveMutationReuse(directory, identity.identity, [killed]);
  if (identity.eligible && scenario === "unusable")
    await Bun.write(`${directory}/.mutation-reuse/${identity.identity}.json`, "{");
  const lookup = await mutationReuseDecision(
    directory,
    identity,
    scenario === "inputs-changed" ? "previous-inputs" : undefined,
  );
  return { directory, unit, lookup };
}

test.each(["miss", "hit", "unusable", "inputs-changed", "watchdog", "uncertain"] as const)(
  "%s has the same human and machine reuse decision before execution",
  async (scenario) => {
    const { directory, unit, lookup } = await fixture(scenario);
    const human: string[] = [];
    const machine: MutationEvent[] = [];
    const output = {
      log: (line: string) => machine.push(mutationEventSchema.parse(JSON.parse(line))),
      error: (line: string) => human.push(line),
    };
    let executions = 0;
    const code = await runMutationUnits(
      { units: [unit], skipped: 0 },
      async () => {
        executions++;
        expect(machine.at(-1)?.type).toBe("reuse-decision");
        expect(human.some((line) => line.includes("unit.ts: reuse "))).toBe(true);
        return [killed];
      },
      { log() {}, error() {} },
      {
        reuse: async () => lookup,
        event: (event) => mutationEvidence(directory, true, output, event),
      },
    );
    expect(code).toBe(0);
    expect(executions).toBe(scenario === "hit" ? 0 : 1);
    const decision = machine.find((event) => event.type === "reuse-decision");
    expect(decision?.state.units[0]?.reuse).toEqual(lookup.decision);
    const expected =
      scenario === "watchdog"
        ? "ineligible (unsupported-test-command), cache not-checked"
        : scenario === "uncertain"
          ? "ineligible (uncertain-inputs), cache not-checked"
          : `eligible, cache ${scenario}`;
    expect(human).toContain(`unit.ts: reuse ${expected}.`);
    expect(machine.at(-1)?.state.units[0]?.status).toBe(scenario === "hit" ? "reused" : "passed");
  },
);
