// Bun has no directory creation or lstat API.
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { isCodedError } from "../../lib/coded-error.ts";
import { writeFile } from "../../lib/write-file.ts";

/**
 * The running release's plugin file. The release build ships it at the same path beside this
 * module, so a source checkout, a source install, a Nix package, and the JSR artifact all install
 * the bytes they run.
 */
export const pluginFile = Bun.fileURLToPath(new URL("./plugin.ts", import.meta.url));

const marker = /^\/\/ OPERATOR_PLUGIN_VERSION=(\d+)$/m;

type Outcome =
  | { reason: "installed" | "already_installed" }
  | {
      reason: "opencode_plugin_missing" | "opencode_plugin_outdated" | "opencode_plugin_external";
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

/** False when the file system refuses the write: the folder belongs to someone else. */
async function written(file: string, text: string) {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, new TextEncoder().encode(text), 0o644);
    return true;
  } catch (cause) {
    if (isCodedError(cause) && ["EACCES", "EPERM", "EROFS"].includes(cause.code)) return false;
    // oxlint-disable-next-line unthrown/no-throw -- The module boundary qualifies filesystem failures.
    throw cause;
  }
}

/**
 * Writes Operator's plugin into OpenCode's global plugins folder. A file whose version marker
 * matches the running release is installed, whatever its other bytes, so a consumer's copy of
 * the same version passes. A linked file or folder, or a file with no marker, belongs to someone
 * else, such as a dotfiles repository or the person, so Operator names the file to link and
 * leaves it unchanged.
 */
export async function installPlugin(input: { file: string; check: boolean }): Promise<Outcome> {
  const text = await Bun.file(pluginFile).text();
  const current = (await Bun.file(input.file).exists()) ? await Bun.file(input.file).text() : null;
  const installed = current === null ? undefined : marker.exec(current)?.[1];
  if (installed !== undefined && installed === marker.exec(text)?.[1])
    return { reason: "already_installed" };
  const entry = `link or copy ${pluginFile} to ${input.file}`;
  if (input.check)
    return installed === undefined
      ? {
          reason: "opencode_plugin_missing",
          detail: `OpenCode does not load the Operator plugin. Run operator install --opencode, or ${entry}`,
        }
      : {
          reason: "opencode_plugin_outdated",
          detail: `${input.file} is an older Operator plugin. Run operator install --opencode, or ${entry}`,
        };
  const external = {
    reason: "opencode_plugin_external" as const,
    detail: `Operator does not change a linked, read-only, or unmanaged OpenCode plugin file. To keep commits free of Co-Authored-By trailers and guard the SuperAgent's turn end, ${entry}`,
  };
  if (
    (current !== null && installed === undefined) ||
    (await linked(input.file)) ||
    (await linked(path.dirname(input.file)))
  )
    return external;
  return (await written(input.file, text)) ? { reason: "installed" } : external;
}
