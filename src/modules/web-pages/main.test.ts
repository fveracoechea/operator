import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Environment } from "../environment/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { WebPages } from "./main.ts";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

beforeEach(() => {
  spyOn(Environment, "read").mockReturnValue({
    HOME: "/tmp/opencode/web-pages",
    PATH: "",
    DISPLAY: ":0",
  });
  Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
  spyOn(ToolInvocation, "run").mockResolvedValue({
    status: "completed",
    exitCode: 0,
    stdout: "",
    stderr: "",
  });
});
afterEach(() => {
  mock.restore();
  if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
});

test.each([
  [
    { status: "unavailable", tool: "xdg-open", detail: "missing" },
    "web_page_opener_unavailable",
    "The local opener is unavailable. No opener was invoked.",
  ],
  [
    { status: "completed", exitCode: 3, stdout: "", stderr: "failed" },
    "web_page_opener_failed",
    "The local opener did not confirm acceptance. The page may or may not have opened.",
  ],
  [
    { status: "no-answer", detail: "timed out" },
    "web_page_opener_no_answer",
    "The local opener did not confirm acceptance. The page may or may not have opened.",
  ],
] as const)("never claims acceptance for %j", async (invocation, reason, detail) => {
  spyOn(ToolInvocation, "run").mockResolvedValue(invocation);
  const result = await WebPages.open({ url: "https://example.com/", personRequested: true });
  expect(result).toMatchObject({
    tag: "Err",
    error: {
      reason,
      detail,
      next: {
        decider: "person",
        question:
          "Can you check your browser for the requested page and open the URL yourself if needed? Do not automatically retry an uncertain request.",
      },
    },
  });
  expect(ToolInvocation.run).toHaveBeenCalledTimes(1);
});

test("preserves an unexpected invocation failure as a defect", async () => {
  const cause = new Error("unexpected");
  spyOn(ToolInvocation, "run").mockRejectedValue(cause);
  const result = await WebPages.open({ url: "https://example.com/", personRequested: true });
  expect(result.tag === "Defect" && result.cause).toBe(cause);
});

test.each([
  { SSH_CONNECTION: "remote" },
  { SSH_CLIENT: "remote" },
  { SSH_TTY: "/dev/pts/1" },
  { CI: "true" },
  { BROWSER: "sh -c bad" },
  { DISPLAY: undefined },
  { DISPLAY: "" },
  { DISPLAY: "localhost:10.0" },
  { DISPLAY: ":0suffix" },
  { DISPLAY: ":0.x" },
  { DISPLAY: undefined, WAYLAND_DISPLAY: "prefixwayland-1" },
  { DISPLAY: undefined, WAYLAND_DISPLAY: "wayland-1suffix" },
])("refuses unsupported local context %j without an opener", async (environment) => {
  spyOn(Environment, "read").mockReturnValue({
    HOME: "/tmp/opencode/web-pages",
    PATH: "",
    DISPLAY: ":0",
    ...environment,
  });
  expect(await WebPages.open({ url: "https://example.com/", personRequested: true })).toMatchObject(
    {
      tag: "Err",
      error: {
        reason: "web_page_capability_limited",
        detail:
          "This environment has no supported local desktop opener context. No opener was invoked.",
        next: {
          decider: "person",
          question:
            "Can you open the requested URL in your own browser, or run this request from a supported local desktop session without SSH, CI, or BROWSER overrides?",
        },
      },
    },
  );
  expect(ToolInvocation.run).not.toHaveBeenCalled();
});

test.each([
  ["linux", { WAYLAND_DISPLAY: "wayland-0" }, "xdg-open"],
  ["linux", { DISPLAY: ":12.34" }, "xdg-open"],
  ["linux", { WAYLAND_DISPLAY: "wayland-12" }, "xdg-open"],
  ["darwin", { TERM_PROGRAM: "Apple_Terminal" }, "open"],
  ["darwin", { TERM_PROGRAM: "iTerm.app" }, "open"],
] as const)("uses a local %s opener with markers %j", async (platform, environment, opener) => {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  spyOn(Environment, "read").mockReturnValue({
    HOME: "/tmp/opencode/web-pages",
    PATH: "",
    ...environment,
  });
  expect(await WebPages.open({ url: "http://example.com/", personRequested: true })).toMatchObject({
    tag: "Ok",
    value: { data: { opener } },
  });
  expect(ToolInvocation.run).toHaveBeenCalledWith({
    tool: opener,
    args: ["http://example.com/"],
    timeoutMs: 5000,
  });
});

test.each(["win32", "freebsd", "darwin"] as const)(
  "refuses %s without supported desktop markers",
  async (platform) => {
    Object.defineProperty(process, "platform", { configurable: true, value: platform });
    expect(
      await WebPages.open({ url: "https://example.com/", personRequested: true }),
    ).toMatchObject({ tag: "Err", error: { reason: "web_page_capability_limited" } });
    expect(ToolInvocation.run).not.toHaveBeenCalled();
  },
);

test("a recognized macOS terminal does not authorize another platform", async () => {
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  spyOn(Environment, "read").mockReturnValue({
    HOME: "/tmp/opencode/web-pages",
    PATH: "",
    TERM_PROGRAM: "Apple_Terminal",
  });
  expect(await WebPages.open({ url: "https://example.com/", personRequested: true })).toMatchObject(
    { tag: "Err", error: { reason: "web_page_capability_limited" } },
  );
  expect(ToolInvocation.run).not.toHaveBeenCalled();
});

test.each([
  "",
  "example.com",
  "//example.com",
  "https:example.com",
  "https:///example.com",
  "https://",
  "https://[bad]",
  "file:///etc/passwd",
  // oxlint-disable-next-line no-script-url -- A dangerous scheme is a refusal fixture, never executed.
  "javascript:alert(1)",
  "data:text/html,hello",
  "ftp://example.com",
  "ftp://https://example.com/",
  "--help",
  "https://user:secret@example.com/",
  "https://user@example.com/",
  "https://@example.com/",
  "https://example.com/\nnext",
  "https://example.com/\t",
  "https://example.com/\u007f",
  "https://example.com/\u0085",
  "https://example.com/%00",
  "https://example.com/%0a",
  "https://example.com/%1F",
  "https://example.com/%7f",
  " https://example.com/",
  "https://example.com/a b",
  "https://example.com\\@other.test/",
])("rejects unsafe or ambiguous URL %j without an opener", async (url) => {
  expect(await WebPages.open({ url, personRequested: true })).toMatchObject({
    tag: "Err",
    error: {
      reason: "web_page_url_invalid",
      detail:
        "Only absolute HTTP or HTTPS URLs without credentials, control characters, spaces, or backslashes can be opened. No opener was invoked.",
      next: {
        decider: "person",
        question:
          "Which absolute http:// or https:// URL, without credentials or control characters, should be opened?",
      },
    },
  });
  expect(ToolInvocation.run).not.toHaveBeenCalled();
});

test("passes one URL argv to xdg-open and reports only opener acceptance", async () => {
  const url = "https://example.com/?q=$(touch%20nope);&x='quoted'#section";
  expect(await WebPages.open({ url, personRequested: true })).toMatchObject({
    tag: "Ok",
    value: {
      reason: "web_page_opener_accepted",
      data: {
        url,
        opener: "xdg-open",
        detail:
          "The local opener accepted the request. This does not prove that the person's browser opened the page.",
      },
      next: {
        why: "No further automatic action remains. The person can confirm the page in their browser.",
      },
    },
  });
  expect(ToolInvocation.run).toHaveBeenCalledTimes(1);
  expect(ToolInvocation.run).toHaveBeenCalledWith({
    tool: "xdg-open",
    args: [url],
    timeoutMs: 5000,
  });
});

test("requires the person's explicit request before invoking any opener", async () => {
  expect(
    await WebPages.open({ url: "https://example.com/", personRequested: false }),
  ).toMatchObject({
    tag: "Err",
    error: {
      reason: "web_page_not_requested",
      detail:
        "Opening a web page requires an explicit request from the person. No opener was invoked.",
      next: { decider: "person", question: "Do you want this web page opened on this device?" },
    },
  });
  expect(ToolInvocation.run).not.toHaveBeenCalled();
});
