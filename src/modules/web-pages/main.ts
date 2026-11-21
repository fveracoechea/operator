import { Err, Ok, ErrAsync, fromPromise, type AsyncResult } from "unthrown";
import type { ResultContext } from "../../lib/cli-result.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { Environment } from "../environment/main.ts";

type Opened = {
  reason: "web_page_opener_accepted";
  data: { url: string; opener: string; detail: string };
} & ResultContext;
type Failure = {
  reason:
    | "web_page_not_requested"
    | "web_page_url_invalid"
    | "web_page_capability_limited"
    | "web_page_opener_unavailable"
    | "web_page_opener_failed"
    | "web_page_opener_no_answer";
  detail: string;
} & ResultContext;

function localOpener() {
  const env = Environment.read();
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY || env.CI || env.BROWSER) return null;
  if (
    process.platform === "linux" &&
    (env.DISPLAY?.match(/^:\d+(?:\.\d+)?$/) || env.WAYLAND_DISPLAY?.match(/^wayland-\d+$/))
  )
    return "xdg-open";
  if (
    process.platform === "darwin" &&
    (env.TERM_PROGRAM === "Apple_Terminal" || env.TERM_PROGRAM === "iTerm.app")
  )
    return "open";
  return null;
}

function safeURL(text: string) {
  const authority = /^https?:\/\/([^/?#]+)/i.exec(text)?.[1];
  if (
    authority === undefined ||
    authority.includes("@") ||
    // oxlint-disable-next-line no-control-regex -- Reject literal controls before URL parsing can strip them.
    /[\u0000-\u0020\u007f-\u009f\\]/.test(text) ||
    /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(text)
  )
    return false;
  return URL.canParse(text);
}

export const WebPages = {
  open(input: { url: string; personRequested: boolean }): AsyncResult<Opened, Failure> {
    if (input.personRequested !== true)
      return ErrAsync({
        reason: "web_page_not_requested",
        detail:
          "Opening a web page requires an explicit request from the person. No opener was invoked.",
        next: { decider: "person", question: "Do you want this web page opened on this device?" },
      });
    if (!safeURL(input.url))
      return ErrAsync({
        reason: "web_page_url_invalid",
        detail:
          "Only absolute HTTP or HTTPS URLs without credentials, control characters, spaces, or backslashes can be opened. No opener was invoked.",
        next: {
          decider: "person",
          question:
            "Which absolute http:// or https:// URL, without credentials or control characters, should be opened?",
        },
      });
    const opener = localOpener();
    if (opener === null)
      return ErrAsync({
        reason: "web_page_capability_limited",
        detail:
          "This environment has no supported local desktop opener context. No opener was invoked.",
        next: {
          decider: "person",
          question:
            "Can you open the requested URL in your own browser, or run this request from a supported local desktop session without SSH, CI, or BROWSER overrides?",
        },
      });
    return fromPromise(
      async () => {
        const invocation: Awaited<ReturnType<typeof ToolInvocation.run>> & { exitCode?: number } =
          await ToolInvocation.run({
            tool: opener,
            args: [input.url],
            timeoutMs: 5000,
          });
        if (invocation.exitCode !== 0)
          return Err({
            reason:
              invocation.status === "unavailable"
                ? ("web_page_opener_unavailable" as const)
                : invocation.status === "no-answer"
                  ? ("web_page_opener_no_answer" as const)
                  : ("web_page_opener_failed" as const),
            detail:
              invocation.status === "unavailable"
                ? "The local opener is unavailable. No opener was invoked."
                : "The local opener did not confirm acceptance. The page may or may not have opened.",
            next: {
              decider: "person" as const,
              question:
                "Can you check your browser for the requested page and open the URL yourself if needed? Do not automatically retry an uncertain request.",
            },
          });
        return Ok({
          reason: "web_page_opener_accepted" as const,
          data: {
            url: input.url,
            opener,
            detail:
              "The local opener accepted the request. This does not prove that the person's browser opened the page.",
          },
          next: {
            why: "No further automatic action remains. The person can confirm the page in their browser.",
          },
        });
      },
      (cause, defect) => defect(cause),
    ).flatMap<Opened, Failure>((result) => result);
  },
};
