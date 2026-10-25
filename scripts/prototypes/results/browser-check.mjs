// Optional browser evidence. Supply a scratch Playwright module, never a root dependency.
const { chromium } = await import(Bun.argv[2]);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(new URL("./comparison.html", import.meta.url).href);
  async function text(id, expected) {
    const actual = await page.locator(`#${id}`).textContent();
    if (actual !== expected) throw new Error(`${id}: expected ${expected}, got ${actual}`);
  }
  for (const design of [
    "plain",
    "neverthrow-promise",
    "neverthrow-async",
    "effect-value",
    "effect-runtime",
  ]) {
    await page.selectOption("#option", design);
    if (!(await page.locator(`#${design}`).isVisible()))
      throw new Error(`Missing visible option ${design}`);
    if ((await page.locator("[data-option]:visible").count()) !== 1)
      throw new Error("Option selection did not isolate one implementation");
  }
  await page.selectOption("#option", "neverthrow-promise");
  await page.click("#plan");
  await page.click("#run");
  await text("operation-state", "Unknown");
  await page.click("#retry");
  await text("walkthrough-title", "Retry refused");
  await page.click("#observe");
  await text("workflow-state", "Merged");
  await text("action-count", "1");
  await page.selectOption("#scenario", "missing");
  await page.click("#plan");
  await page.click("#run");
  await page.click("#observe");
  await text("walkthrough-title", "Absence is not non-application");
  await text("action-count", "0");
  await page.screenshot({ path: "/tmp/opencode/operator-261-browser/desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth))
    throw new Error(
      `The mobile page overflows horizontally: ${JSON.stringify(
        await page.locator("body *").evaluateAll((elements) =>
          elements
            .filter((element) => element.getBoundingClientRect().right > window.innerWidth)
            .map((element) => ({
              tag: element.tagName,
              id: element.id,
              className: element.className,
              width: element.getBoundingClientRect().width,
            })),
        ),
      )}`,
    );
  await page.screenshot({ path: "/tmp/opencode/operator-261-browser/mobile.png", fullPage: true });
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    "Browser passed. All five choices, uncertain recovery, absent evidence, and mobile overflow checks passed. No page errors.",
  );
} finally {
  await browser.close();
}
