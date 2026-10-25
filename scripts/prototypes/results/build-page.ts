const selections: Record<string, { file: string; start?: string; end?: string }> = {
  "plain.mts": { file: "plain.mts" },
  "neverthrow-promise.mts": { file: "neverthrow-promise.mts" },
  "neverthrow-async.mts": { file: "neverthrow-async.mts" },
  "effect-value.mts": { file: "effect-value.mts" },
  "effect-runtime.mts": { file: "effect-runtime.mts" },
  "unthrown.mts": { file: "unthrown.mts" },
  "assignment.mts": { file: "assignment.mts" },
  "review.mts": { file: "review.mts" },
  command: {
    file: "cli.mts",
    start: "async function runAssignment",
    end: "async function runReview",
  },
  transaction: { file: "store.mts", start: "// SQLite commits" },
  errors: { file: "model.mts", start: "export type OperationError", end: "export type Wire" },
};

export async function renderPage(): Promise<string> {
  let html = await Bun.file(`${import.meta.dir}/comparison.template.html`).text();
  for (const [name, selection] of Object.entries(selections)) {
    let code = await Bun.file(`${import.meta.dir}/${selection.file}`).text();
    if (selection.start) code = code.slice(code.indexOf(selection.start));
    if (selection.end) code = code.slice(0, code.indexOf(selection.end));
    const escaped = code
      .trim()
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
    html = html.replace(`<!-- code:${name} -->`, `<pre><code>${escaped}</code></pre>`);
  }
  if (html.includes("<!-- code:")) throw new Error("Unresolved comparison code snippet");
  const formatted = Bun.spawnSync(
    ["bunx", "--bun", "--no-install", "oxfmt", "--stdin-filepath", "comparison.html"],
    {
      cwd: new URL("../../../", import.meta.url).pathname,
      stdin: new TextEncoder().encode(html),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (formatted.exitCode !== 0) throw new Error(formatted.stderr.toString());
  return formatted.stdout.toString();
}
if (import.meta.main) await Bun.write(`${import.meta.dir}/comparison.html`, await renderPage());
