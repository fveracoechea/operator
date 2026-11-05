// Bun has no directory creation, lstat, or file mode API.
import { lstat, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isCodedError, type CodedError } from "../../lib/coded-error.ts";
import { writeFile } from "../../lib/write-file.ts";

const command = "operator claude hook";

/**
 * The groups that Operator adds, one for each hook event. The `if` rule keeps the commit check
 * off other commands, and the Stop group is the turn-end guard.
 */
export const hookEntries = {
  PreToolUse: { matcher: "Bash", hooks: [{ type: "command", if: "Bash(git *)", command }] },
  Stop: { hooks: [{ type: "command", command }] },
};

const events = ["PreToolUse", "Stop"] as const;

const groupsSchema = z
  .array(z.looseObject({ hooks: z.array(z.looseObject({})).optional() }))
  .optional();

const settingsSchema = z.looseObject({
  hooks: z.looseObject({ PreToolUse: groupsSchema, Stop: groupsSchema }).optional(),
});

type Outcome =
  | { reason: "installed" | "already_installed" }
  | {
      reason: "claude_hook_missing" | "claude_settings_external" | "claude_settings_invalid";
      detail: string;
    };

async function linked(file: string) {
  // A path that cannot be read is no link, and the write that follows reports its failure.
  return lstat(file).then(
    (entry) => entry.isSymbolicLink(),
    // Stryker disable next-line ArrowFunction: equivalent: no answer and false both mean no link
    () => false,
  );
}

/** A write that the file system refuses: the settings file belongs to someone else. */
export function refusedWrite(cause: CodedError) {
  return ["EACCES", "EPERM", "EROFS"].includes(cause.code);
}

/** The parsed settings, or null when the file is not a settings object. */
async function readSettings(file: string) {
  // Text that is not JSON parses as null, which is no settings object.
  const raw: unknown = (await Bun.file(file).exists())
    ? await Bun.file(file)
        .text()
        .then((text) => JSON.parse(text) as unknown)
        .catch((cause: Error) => {
          if (cause instanceof SyntaxError) return null;
          // oxlint-disable-next-line unthrown/no-throw -- The module boundary qualifies filesystem failures.
          throw cause;
        })
    : {};
  const settings = settingsSchema.safeParse(raw);
  return settings.success && !Array.isArray(raw) ? settings.data : null;
}

/**
 * Adds each missing hook group to Claude Code user settings, after every group the person has.
 * A linked or read-only file belongs to its owner, such as a dotfiles repository, so Operator
 * names the entry and leaves the file unchanged.
 */
export async function installHook(input: { file: string; check: boolean }): Promise<Outcome> {
  const settings = await readSettings(input.file);
  if (settings === null)
    return {
      reason: "claude_settings_invalid",
      detail: `${input.file} is not a Claude Code settings object. Repair it, then install again.`,
    };
  const missing = events.filter(
    (event) =>
      !(settings.hooks?.[event] ?? []).some((group) =>
        group.hooks?.some((hook) => hook.command === command),
      ),
  );
  if (missing.length === 0) return { reason: "already_installed" };
  const entry = missing
    .map(
      (event) => `add this ${event} group to ${input.file}: ${JSON.stringify(hookEntries[event])}`,
    )
    .join(", and ");
  if (input.check)
    return {
      reason: "claude_hook_missing",
      detail: `Claude Code does not run the Operator hook on ${missing.join(" and ")}. Run operator install --claude, or ${entry}`,
    };
  const external = {
    reason: "claude_settings_external" as const,
    detail: `Operator does not change a linked or read-only Claude Code settings file. To keep commits free of Co-Authored-By trailers and guard the SuperAgent's turn end, ${entry}`,
  };
  if ((await linked(input.file)) || (await linked(path.dirname(input.file)))) return external;
  // Loose objects keep every field that the schema does not name.
  const hooks = { ...settings.hooks };
  for (const event of missing) hooks[event] = [...(hooks[event] ?? []), hookEntries[event]];
  const next = { ...settings, hooks };
  try {
    await mkdir(path.dirname(input.file), { recursive: true });
    await writeFile(
      input.file,
      new TextEncoder().encode(`${JSON.stringify(next, null, 2)}\n`),
      // Stryker disable next-line ArrowFunction: equivalent: no answer and null both give the default mode
      ((await stat(input.file).catch(() => null))?.mode ?? 0o600) % 0o1000,
    );
  } catch (cause) {
    if (isCodedError(cause) && refusedWrite(cause)) return external;
    // oxlint-disable-next-line unthrown/no-throw -- The module boundary qualifies filesystem failures.
    throw cause;
  }
  return { reason: "installed" };
}
