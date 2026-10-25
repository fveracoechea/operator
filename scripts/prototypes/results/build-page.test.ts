import { expect, test } from "bun:test";
import { renderPage } from "./build-page.ts";

test("the offline comparison page embeds the current executable sources", async () => {
  const html = await Bun.file(`${import.meta.dir}/comparison.html`).text();
  expect(html).toBe(await renderPage());
  expect(html).not.toContain("<!-- code:");
  for (const name of [
    "plain",
    "neverthrow-promise",
    "neverthrow-async",
    "effect-value",
    "effect-runtime",
    "unthrown",
  ]) {
    expect(html).toContain(`id="${name}"`);
  }
  expect(html).toContain("Selected by the person. Unthrown core and all nine Oxlint rules.");
  expect(html).toContain("Approved decision");
  expect(html).not.toContain("No option is selected.");
  expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=|<iframe/i);
});
