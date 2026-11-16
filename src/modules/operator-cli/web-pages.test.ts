import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { ErrAsync, fromSafePromise, OkAsync } from "unthrown";
import { WebPages } from "../web-pages/main.ts";
import { runWebPages } from "./web-pages.ts";

afterEach(() => {
  mock.restore();
  process.exitCode = 0;
});

test.each([
  ["web_page_not_requested", 4],
  ["web_page_url_invalid", 2],
  ["web_page_capability_limited", 3],
  ["web_page_opener_unavailable", 3],
  ["web_page_opener_failed", 1],
  ["web_page_opener_no_answer", 5],
] as const)("prints structured %s refusal with exit %d", async (reason, code) => {
  const next = { decider: "person" as const, question: "Open it yourself?" };
  const open = spyOn(WebPages, "open").mockReturnValue(
    ErrAsync({ reason, detail: "Not confirmed.", next }),
  );
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  expect(await runWebPages(["web", "open", "--url", "https://example.com/"], true)).toBe(true);
  expect(open).toHaveBeenCalledWith({ url: "https://example.com/", personRequested: false });
  expect(log).toHaveBeenCalledWith(
    JSON.stringify({
      schemaVersion: 1,
      operation: "web_open",
      outcome: code === 2 ? "invalid" : "refused",
      reason,
      blockers: [{ reason, detail: "Not confirmed." }],
      next,
    }),
  );
  expect(error).toHaveBeenCalledWith("next: person decides: Open it yourself?");
  expect(process.exitCode).toBe(code);
});

test("prints text mode and preserves unexpected defects as exit 1", async () => {
  spyOn(WebPages, "open").mockReturnValue(
    fromSafePromise(() => Promise.reject(new Error("unexpected"))),
  );
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  expect(
    await runWebPages(
      ["web", "open", "--url", "https://example.com/", "--person-requested"],
      false,
    ),
  ).toBe(true);
  expect(log).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith("operator: Error: unexpected");
  expect(process.exitCode).toBe(1);
});

test("names a defect in JSON output", async () => {
  spyOn(WebPages, "open").mockReturnValue(
    fromSafePromise(() => Promise.reject(new Error("unexpected"))),
  );
  const log = spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
  expect(await runWebPages(["web", "open", "--url", "https://example.com/"], true)).toBe(true);
  expect(log).toHaveBeenCalledWith(
    JSON.stringify({
      schemaVersion: 1,
      operation: "web_open",
      outcome: "refused",
      reason: "web_page_defect",
      blockers: [{ reason: "web_page_defect", detail: "Error: unexpected" }],
    }),
  );
});

test("runs only an explicit web open command with one URL", async () => {
  const open = spyOn(WebPages, "open");
  for (const args of [
    ["other", "open", "--url", "https://example.com/"],
    ["web", "other", "--url", "https://example.com/"],
    ["web", "open", "--wat", "https://example.com/"],
    [],
    ["web"],
    ["web", "other"],
    ["web", "open"],
    ["web", "open", "--url"],
    ["web", "open", "https://example.com/"],
    ["web", "open", "--url", "https://example.com/", "--automatic"],
    ["web", "open", "--url", "https://example.com/", "--url", "https://other.test/"],
    ["web", "open", "--url", "https://example.com/", "--person-requested", "--person-requested"],
    ["web", "open", "--url", "--person-requested"],
    ["web", "open", "--url", "https://example.com/", "--json", "--json"],
  ]) {
    expect(await runWebPages(args, true)).toBe(false);
  }
  expect(open).not.toHaveBeenCalled();
});

test("forwards the attestation and URL and prints only opener acceptance", async () => {
  const data = {
    url: "https://example.com/",
    opener: "xdg-open",
    detail: "The opener accepted the request.",
  };
  const next = { why: "The person can confirm the page." };
  const open = spyOn(WebPages, "open").mockReturnValue(
    OkAsync({ reason: "web_page_opener_accepted", data, next }),
  );
  const log = spyOn(console, "log").mockImplementation(() => {});
  expect(
    await runWebPages(["web", "open", "--person-requested", "--url", data.url, "--json"], true),
  ).toBe(true);
  expect(open).toHaveBeenCalledWith({ url: data.url, personRequested: true });
  expect(log).toHaveBeenCalledWith(
    JSON.stringify({
      schemaVersion: 1,
      operation: "web_open",
      outcome: "completed",
      reason: "web_page_opener_accepted",
      blockers: [],
      data,
      next,
    }),
  );
  expect(process.exitCode).toBe(0);
});
