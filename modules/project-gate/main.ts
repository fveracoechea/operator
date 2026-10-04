import { z } from "zod";
import { ContentIdentity } from "../content-identity/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import {
  commandLine,
  describeIssue,
  GATE_PATH,
  type GateCommand,
  gateDeclarationSchema,
} from "./declaration.ts";

type Read =
  | { status: "declared"; commit: string; path: string; identity: string; commands: GateCommand[] }
  | { status: "missing"; commit: string; path: string }
  | { status: "invalid"; commit: string; path: string; issues: string[] }
  | { status: "unread"; commit: string; path: string; detail: string };

/** Where a gate text appears: a submit check, a dispatch refusal, or the readiness check at HEAD. */
type GateTextPlace = "submit" | "dispatch" | "readiness";

type Unusable = Exclude<Read, { status: "declared" }>;

const UNUSABLE_TEXTS: Record<
  GateTextPlace,
  { [S in Unusable["status"]]: (read: Extract<Unusable, { status: S }>) => string }
> = {
  submit: {
    missing: (read) => `${read.path} at ${read.commit} is missing.`,
    invalid: (read) => `${read.path} at ${read.commit} is invalid: ${read.issues.join("; ")}.`,
    unread: (read) => `${read.path} at ${read.commit} is unread: ${read.detail}.`,
  },
  dispatch: {
    missing: (read) => `Commit ${read.commit} holds no ${read.path}.`,
    invalid: (read) => `${read.path} at ${read.commit} is not valid: ${read.issues.join("; ")}.`,
    unread: (read) => `${read.path} could not be read at ${read.commit}: ${read.detail}`,
  },
  readiness: {
    missing: (read) =>
      `The commit ${read.commit} at HEAD holds no ${read.path}, so no code result can show that it passed the project gate.`,
    invalid: (read) =>
      `${read.path} at ${read.commit} is not a valid project gate: ${read.issues.join("; ")}.`,
    unread: (read) => `${read.path} could not be read at HEAD: ${read.detail}`,
  },
};

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

  jsonSchemaText(): string {
    return `${JSON.stringify(z.toJSONSchema(gateDeclarationSchema, { io: "input" }), null, 2)}\n`;
  },

  /** Reads and validates the declaration that one commit holds, and names every wrong field. */
  async read(request: { repository: string; commit: string }): Promise<Read> {
    const resolved = await ToolInvocation.git({
      repoRoot: request.repository,
      args: ["rev-parse", "--verify", "--quiet", `${request.commit}^{commit}`],
      failed: (failure) =>
        failure.kind === "exit"
          ? `Git names no commit ${request.commit}.`
          : ToolInvocation.gitFailure(failure),
    });
    if (resolved.status !== "read") {
      return { status: "unread", commit: request.commit, path: GATE_PATH, detail: resolved.detail };
    }

    const commit = resolved.value;
    const blob = await ToolInvocation.git({
      repoRoot: request.repository,
      args: ["cat-file", "blob", `${commit}:${GATE_PATH}`],
      raw: true,
      answers: "any",
    });
    if (blob.status !== "read") {
      return { status: "unread", commit, path: GATE_PATH, detail: blob.detail };
    }
    if (blob.exitCode !== 0) {
      return { status: "missing", commit, path: GATE_PATH };
    }

    let value: unknown;
    try {
      value = JSON.parse(blob.value);
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

  /**
   * One read of the gate as the text of one place. Each place keeps its own words, and this table
   * is the one owner of all of them.
   */
  describe(read: Read, place: GateTextPlace): string {
    switch (read.status) {
      case "declared":
        return `${read.path} at ${read.commit} declares ${read.commands.map((one) => one.name).join(", ")}.`;
      case "missing":
        return UNUSABLE_TEXTS[place].missing(read);
      case "invalid":
        return UNUSABLE_TEXTS[place].invalid(read);
      case "unread":
        return UNUSABLE_TEXTS[place].unread(read);
    }
  },

  /** One command as one line of text, for a brief and for a host permission. */
  commandLine(argv: string[]): string {
    return commandLine(argv);
  },
};
