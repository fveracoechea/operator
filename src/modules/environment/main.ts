// Bun has no path normalization API.
import path from "node:path";
import { z } from "zod";

const absolute = z.string().refine((value) => path.isAbsolute(value), "Must be an absolute path.");
const schema = z.object({
  HOME: absolute,
  XDG_CONFIG_HOME: absolute.optional(),
  XDG_STATE_HOME: absolute.optional(),
  PATH: z.string().default(""),
  TMPDIR: absolute.optional(),
  NODE_ENV: z.string().optional(),
  // Only release tooling reads the reproducible-builds time, so the CLI never refuses a bad value.
  SOURCE_DATE_EPOCH: z.string().optional(),
  npm_config_user_agent: z.string().optional(),
  HERDR_SOCKET_PATH: z.string().min(1).optional(),
  HERDR_PANE_ID: z.string().min(1).optional(),
  HERDR_PLUGIN_EVENT: z.string().min(1).optional(),
  HERDR_PLUGIN_EVENT_JSON: z.string().min(1).optional(),
  // The agent hosts name the session that runs a shell command. Empty text names none, and the
  // CLI never refuses to start over a session value.
  OPENCODE_SESSION_ID: z.string().min(1).optional().catch(undefined),
  CLAUDE_CODE_SESSION_ID: z.string().min(1).optional().catch(undefined),
});
type EnvironmentValues = z.infer<typeof schema>;
let snapshot: Record<string, string | undefined> | undefined;
let validated: EnvironmentValues | undefined;

/** The only process-environment reader. Unknown variables pass to children, not to application code. */
export const Environment = {
  parse(input: Record<string, string | undefined>) {
    return schema.parse(input);
  },
  read(): EnvironmentValues {
    snapshot ??= { ...process.env };
    validated ??= schema.parse(snapshot);
    return validated;
  },
  /**
   * The Herdr pane and the agent session that run this command, when the hosts name them.
   * OpenCode names its session for each shell command, so it wins over a Claude Code session that
   * a shared OpenCode server inherited from the pane that started it.
   */
  caller(values: EnvironmentValues = Environment.read()) {
    return {
      pane: values.HERDR_PANE_ID ?? null,
      session: values.OPENCODE_SESSION_ID ?? values.CLAUDE_CODE_SESSION_ID ?? null,
    };
  },
  child(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
    const values = Environment.read();
    return { ...snapshot, ...values, ...overrides };
  },
};
