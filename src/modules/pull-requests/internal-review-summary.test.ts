import { afterAll, expect, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSummary } from "./internal-review-summary.ts";

const root = await mkdtemp(path.join(tmpdir(), "operator-review-summary-"));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function parse(text: string) {
  const file = `${root}/summary.md`;
  await Bun.write(file, text);
  return readSummary(file);
}

test("the summary preserves paragraphs and each disposition's identifiers and reason", async () => {
  expect(
    await parse(
      "\r\n## Overview\r\n  The review checked the guard.\r\n\r\nIt retained the interface.  \r\n\r\n## Dispositions\r\n- 1.12 applied\r\n- 2.3 declined:   The public name matches the glossary.  \r\n",
    ),
  ).toMatchObject({
    tag: "Ok",
    value: {
      overview: "The review checked the guard.\n\nIt retained the interface.",
      dispositions: [
        { round: 1, finding: 12, disposition: "applied" },
        {
          round: 2,
          finding: 3,
          disposition: "declined",
          reason: "The public name matches the glossary.",
        },
      ],
    },
  });
  expect(await parse("## Overview\nfine\n## Dispositions\n\n")).toMatchObject({
    tag: "Ok",
    value: { overview: "fine", dispositions: [] },
  });
  expect(
    await parse("  ## Overview  \n  Fine.  \n  ## Dispositions  \n  - 12.2 applied  \n"),
  ).toMatchObject({
    tag: "Ok",
    value: { overview: "Fine.", dispositions: [{ round: 12, finding: 2, disposition: "applied" }] },
  });
});

test.each<[string, number]>([
  ['{"overview":"fine","dispositions":[]}', 1],
  ["", 1],
  ["## Overview\nfine\n", 1],
  ["## Overview\n\n## Dispositions\n", 3],
  ["## Overview\n\n\n## Dispositions\n", 4],
  ["## Dispositions\n## Overview\nfine", 1],
  ["## Overview\nfine\n## Unknown\n", 3],
  ["## Overview\nfine\n## Overview\n", 3],
  ["## Overview\nfine\n## Dispositions\n## Dispositions\n", 4],
  ["## Overview\nfine\n## Dispositions\n- 0.1 applied\n", 4],
  ["## Overview\nfine\n## Dispositions\n- 1.0 applied\n", 4],
  ["## Overview\nfine\n## Dispositions\n- 9007199254740992.1 applied\n", 4],
  ["## Overview\nfine\n## Dispositions\n- 1.9007199254740992 applied\n", 4],
  ["## Overview\nfine\n## Dispositions\n- 1.1 declined:   \n", 4],
  ["## Overview\nfine\n## Dispositions\n- 1.1 applied: extra\n", 4],
  ["## Overview\nfine\n## Dispositions\n- 1.1 ignored\n", 4],
  ["## Overview\nfine\n## Dispositions\nextra - 1.1 applied\n", 4],
  ["## Overview\nfine\n## Dispositions\nextra\n", 4],
  ["## Overview\nfine\n## Dispositions\n- 1.1 applied\n- 2.1 invalid\n", 5],
])("invalid summaries report the original line (%s)", async (text, line) => {
  const result = await parse(text);
  expect(result).toMatchObject({
    tag: "Err",
    error: {
      reason: "internal_review_summary_invalid",
      next: { command: "operator pr ready --file <path|->" },
    },
  });
  if (result.tag !== "Err") return expect.unreachable("malformed summary accepted");
  expect(result.error.detail).toStartWith(`Line ${line}:`);
  if (!("next" in result.error)) return expect.unreachable("missing next command");
  expect(result.error.next.why).toMatch(/\S/);
});

test("the reader accepts real stdin and qualifies missing files", async () => {
  const module = new URL("./internal-review-summary.ts", import.meta.url).href;
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { readSummary } from ${JSON.stringify(module)}; console.log(JSON.stringify(await readSummary("-")));`,
    ],
    {
      cwd: root,
      stdin: new Blob(["## Overview\nThe stdin review.\n## Dispositions\n- 2.1 applied\n"]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code, stderr).toBe(0);
  expect(JSON.parse(stdout) as unknown).toMatchObject({
    tag: "Ok",
    value: {
      overview: "The stdin review.",
      dispositions: [{ round: 2, finding: 1, disposition: "applied" }],
    },
  });
  expect(await readSummary(`${root}/missing`)).toMatchObject({
    tag: "Err",
    error: { reason: "pr_io_failed" },
  });
});
