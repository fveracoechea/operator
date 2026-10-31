import path from "node:path";

// A trailer token ends in a colon, or an equals sign in a --trailer value.
const trailer = /co-authored-by\s*[:=]/i;
// Global options such as -C path or -c key=value can stand between git and commit.
const commit = /\bgit(?:\s+(?:-[cC]\s+\S+|--?[\w.-]+(?:=\S+)?))*\s+commit(?![\w-])/;
const messageFile = /(?:^|\s)(?:-F\s*|--file[=\s]+)(?:"([^"]+)"|'([^']+)'|(\S+))/g;

async function fileText(file: string) {
  // A missing file, a folder, or an unreadable file holds no message that the hook can read.
  return Bun.file(file)
    .text()
    .catch(() => "");
}

/**
 * True when a git commit in the command carries a Co-Authored-By trailer.
 * The command text holds -m values, heredocs, and --trailer values. A -F file is read from cwd.
 * A message from an editor or a reused commit is not in the command, so it is allowed.
 */
export async function commitHasTrailer(command: string, cwd: string) {
  const found = commit.exec(command);
  if (found === null) return false;
  if (trailer.test(command)) return true;
  for (const match of command.slice(found.index).matchAll(messageFile)) {
    const name = match[1] ?? match[2] ?? match[3] ?? "-";
    if (name !== "-" && trailer.test(await fileText(path.resolve(cwd, name)))) return true;
  }
  return false;
}
