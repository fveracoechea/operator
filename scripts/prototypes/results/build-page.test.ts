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
  ]) {
    expect(html).toContain(`id="${name}"`);
  }
  expect(html).toContain("No option is selected.");
  expect(html).toContain("My recommendation");
  expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=|<iframe/i);
});
