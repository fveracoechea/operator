import { afterAll, expect, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Environment } from "../environment/main.ts";
import { OperatorHome } from "../operator-home/main.ts";
import { settingsSchema } from "./schema.ts";
import { validateGuides } from "./validation.ts";

const root = await mkdtemp(path.join(tmpdir(), "pr424-guide-validation-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const definition = {
  completion: "report",
  resources: "pane",
  guide: "audit-guide/SKILL.md",
  workPhases: [{ name: "audit", goal: "Check evidence." }],
};

test.each(["owned", "upstream", "claude"])(
  "accepts a guide installed only at the %s root",
  async (location) => {
    const paths = OperatorHome.resolve(
      Environment.parse({ HOME: `${root}/${location}`, NODE_ENV: "test" }),
    );
    const roots = {
      owned: paths.skillHosts.opencode,
      upstream: paths.upstreamSkills.opencode,
      claude: paths.skillHosts["claude-code"],
    };
    await Bun.write(`${roots[location as keyof typeof roots]}/audit-guide/SKILL.md`, "Audit.\n", {
      createPath: true,
    });
    await expect(
      validateGuides(settingsSchema.parse({ kinds: { audit: definition } }), paths),
    ).resolves.toBeUndefined();
  },
);

test("no custom kinds need no guides, but every configured kind must have an installed guide", async () => {
  const paths = OperatorHome.resolve(
    Environment.parse({ HOME: `${root}/missing`, NODE_ENV: "test" }),
  );
  await expect(validateGuides(settingsSchema.parse({}), paths)).resolves.toBeUndefined();
  await Bun.write(`${paths.skillHosts.opencode}/audit-guide/SKILL.md`, "Audit.", {
    createPath: true,
  });
  await expect(
    validateGuides(
      settingsSchema.parse({
        kinds: {
          audit: definition,
          other: { ...definition, guide: "missing-guide/SKILL.md" },
        },
      }),
      paths,
    ),
  ).rejects.toThrow("Kind other: No installed guide skill: missing-guide/SKILL.md.");
});
