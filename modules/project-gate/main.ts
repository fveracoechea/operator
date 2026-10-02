import { z } from "zod";
import { ContentIdentity } from "../content-identity/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import {
  commandLine,
  describeIssue,
  GATE_PATH,
  GATE_SCHEMA_REFERENCE,
  type GateCommand,
  gateDeclarationSchema,
} from "./declaration.ts";

type Read =
  | { status: "declared"; commit: string; path: string; identity: string; commands: GateCommand[] }
  | { status: "missing"; commit: string; path: string }
  | { status: "invalid"; commit: string; path: string; issues: string[] }
  | { status: "unread"; commit: string; path: string; detail: string };

async function git(repository: string, args: string[]) {
  return ToolInvocation.run({ tool: "git", args: ["-C", repository, ...args], timeoutMs: 30_000 });
}

/**
 * The project gate of ADR 0021: the one ordered list of commands that the project declares in a
 * committed file. It is read from a commit and never from a working tree, so an edit that is not
 * committed cannot change the gate that scores a result.
 */
export const ProjectGate = {
  /** The repository-relative path of the declaration. */
  path(): string {
    return GATE_PATH;
  },

  /** The `$schema` value that names the schema of the installed release. */
  schemaReference(): string {
    return GATE_SCHEMA_REFERENCE;
  },

  jsonSchemaText(): string {
    return `${JSON.stringify(z.toJSONSchema(gateDeclarationSchema, { io: "input" }), null, 2)}\n`;
  },

  /** Reads and validates the declaration that one commit holds, and names every wrong field. */
  async read(request: { repository: string; commit: string }): Promise<Read> {
    const resolved = await git(request.repository, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${request.commit}^{commit}`,
    ]);
    if (resolved.status !== "completed" || resolved.exitCode !== 0) {
      return {
        status: "unread",
        commit: request.commit,
        path: GATE_PATH,
        detail:
          resolved.status === "completed"
            ? `Git names no commit ${request.commit}.`
            : resolved.detail,
      };
    }

    const commit = resolved.stdout.trim();
    const blob = await git(request.repository, ["cat-file", "blob", `${commit}:${GATE_PATH}`]);
    if (blob.status !== "completed") {
      return { status: "unread", commit, path: GATE_PATH, detail: blob.detail };
    }
    if (blob.exitCode !== 0) {
      return { status: "missing", commit, path: GATE_PATH };
    }

    let value: unknown;
    try {
      value = JSON.parse(blob.stdout);
    } catch (error) {
      return {
        status: "invalid",
        commit,
        path: GATE_PATH,
        issues: [`the file is not JSON: ${error instanceof Error ? error.message : String(error)}`],
      };
    }

    const parsed = gateDeclarationSchema.safeParse(value);
    if (!parsed.success) {
      return {
        status: "invalid",
        commit,
        path: GATE_PATH,
        issues: parsed.error.issues.map(describeIssue),
      };
    }

    const { commands } = parsed.data;
    // The `$schema` value only helps an editor, so it is not part of what the gate is.
    return {
      status: "declared",
      commit,
      path: GATE_PATH,
      identity: ContentIdentity.of(commands),
      commands,
    };
  },

  /** One command as one line of text, for a brief and for a host permission. */
  commandLine(argv: string[]): string {
    return commandLine(argv);
  },
};
