// Operator's OpenCode plugin. operator install --opencode writes this file, and readiness checks the
// version below. Raise the version whenever the hooks or the events this file sends change.
// OPERATOR_PLUGIN_VERSION=1
//
// OpenCode loads this file as written, so it imports nothing and holds no Operator logic. It asks
// `operator opencode hook` about each event and fails open: a failed or slow answer has no opinion,
// because a throw from a hook would fail the tool call or the session's execution.

/** The parts of the OpenCode 2 plugin context that this plugin uses. */
interface Context {
  readonly location: { readonly directory: string };
  readonly session: {
    hook(name: "prompt", callback: (event: { readonly sessionID: string }) => void): Promise<void>;
    hook(name: "experimental.idle", callback: (event: Idle) => Promise<void>): Promise<void>;
    synthetic(input: { sessionID: string; text: string }): Promise<void>;
  };
  readonly tool: {
    hook(
      name: "execute.before",
      callback: (event: { readonly tool: string; readonly input: unknown }) => Promise<void>,
    ): Promise<void>;
  };
}

interface Idle {
  readonly sessionID: string;
  readonly background?: ReadonlyArray<{
    readonly kind: string;
    readonly sessionID: string;
    readonly command?: string;
  }>;
}

const commit = /\bgit\b[\s\S]*\bcommit\b/;
const wait = /\boperator\s+next\b[^\n]*--wait\b/;

/** The reason that `operator opencode hook` prints for one event, or empty text for none. */
async function ask(event: string) {
  try {
    const child = Bun.spawn(["operator", "opencode", "hook"], {
      stdin: new TextEncoder().encode(event),
      stdout: "pipe",
      stderr: "ignore",
      timeout: 10000,
    });
    const [code, text] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    return code === 0 ? text.trim() : "";
  } catch {
    // An operator command that does not start has no opinion.
    return "";
  }
}

export default {
  id: "operator",
  async setup(ctx: Context) {
    // Sessions that got a continuation since the person's last prompt or since a background wait
    // was seen running. Synthetic messages and background notices do not run the prompt hook, so
    // a session continues at most once in a row, as OpenCode bounds no loop of its own: another
    // continuation needs a person prompt or a wait that ran in between.
    const continued = new Set<string>();
    await ctx.session.hook("prompt", (event) => {
      continued.delete(event.sessionID);
    });
    await ctx.tool.hook("execute.before", async (event) => {
      // Operator reads the shell input. A test of all its text keeps other commands from starting
      // it, and a false match costs only one Operator run.
      if (event.tool !== "shell" || !commit.test(JSON.stringify(event.input) ?? "")) return;
      const reason = await ask(
        JSON.stringify({
          event: "tool.execute.before",
          directory: ctx.location.directory,
          input: event.input,
        }),
      );
      // OpenCode fails this one tool call and shows the model the reason.
      // oxlint-disable-next-line unthrown/no-throw -- OpenCode refuses a tool call only when execute.before rejects.
      if (reason !== "") throw new Error(reason);
    });
    await ctx.session.hook("experimental.idle", async (event) => {
      // A wait that this session runs in the background wakes it when the wait returns.
      const waiting = (event.background ?? []).some(
        (work) =>
          work.kind === "shell" &&
          work.sessionID === event.sessionID &&
          wait.test(work.command ?? ""),
      );
      if (waiting) {
        continued.delete(event.sessionID);
        return;
      }
      if (continued.has(event.sessionID)) return;
      const reason = await ask(
        JSON.stringify({
          event: "session.idle",
          directory: ctx.location.directory,
          sessionID: event.sessionID,
        }),
      );
      if (reason === "") return;
      continued.add(event.sessionID);
      // The session goes idle as it would without the plugin when OpenCode refuses the message.
      await ctx.session.synthetic({ sessionID: event.sessionID, text: reason }).catch(() => {});
    });
  },
};
