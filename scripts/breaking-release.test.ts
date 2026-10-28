import { expect, test } from "bun:test";
import { z } from "zod";

const root = new URL("../", import.meta.url).pathname;

const instructions = [
  "finish all old crews and their work with the old release",
  "does not migrate, repair, or delete legacy checkout-local `.operator` state",
];

/** The pending major changesets, which the version pull request turns into the 1.0.0 notes. */
async function pendingMajor() {
  const names = await Array.fromAsync(new Bun.Glob("*.md").scan({ cwd: `${root}.changeset` }));
  const texts = await Promise.all(
    names
      .filter((name) => name !== "README.md")
      .map((name) => Bun.file(`${root}.changeset/${name}`).text()),
  );
  return texts.filter((text) => text.includes('"@fveracoechea/operator": major')).join("\n");
}

/** The notes of one released version, which the release workflow publishes. */
async function released(version: string) {
  const changelog = await Bun.file(`${root}CHANGELOG.md`).text();
  const start = changelog.indexOf(`\n## ${version}\n`);
  expect(start, `CHANGELOG.md has no ${version} section`).toBeGreaterThan(-1);
  const end = changelog.indexOf("\n## ", start + 1);
  return changelog.slice(start, end === -1 ? undefined : end);
}

// The device-level replacement is the breaking 1.0.0 release. Before its version pull request,
// a pending major changeset carries the update instructions. After it, the 1.0.0 notes do.
test("the breaking release tells consumers how to update, before and after its version change", async () => {
  const { version } = z
    .looseObject({ version: z.string() })
    .parse(await Bun.file(`${root}package.json`).json());
  const notes = version.startsWith("0.") ? await pendingMajor() : await released("1.0.0");

  for (const instruction of instructions) expect(notes).toContain(instruction);
});
