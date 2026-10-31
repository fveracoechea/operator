import path from "node:path";

// A trailer token ends in a colon, or an equals sign in a --trailer value.
const trailer = /co-authored-by\s*[:=]/i;
// Global options such as -C path or -c key=value can stand between git and commit.
const commit = /\bgit(?:\s+(?:-[cC]\s+\S+|--?[\w.-]+(?:=\S+)?))*\s+commit(?![\w-])/;
const messageFile = /\s(?:-F\s*|--file[=\s]+)(?:"([^"]+)"|'([^']+)'|(\S+))/g;

// A missing file, a folder, an unreadable file, or a path with a null byte holds no message that
// the hook can read.
// Stryker disable next-line BlockStatement: equivalent: any text with no trailer reads as no trailer
function noMessage() {
  // Stryker disable next-line StringLiteral: equivalent: any text with no trailer reads as no trailer
  return "";
}

async function fileText(file: string) {
  // Bun.file throws at once on a null byte, so Promise.try turns that into a rejection.
  return Promise.try(() => Bun.file(file).text()).catch(noMessage);
}

/**
 * True when a git commit in the command carries a Co-Authored-By trailer.
 * The command text holds -m values, heredocs, and --trailer values. A -F file is read from cwd.
 * A message from an editor or a reused commit is not in the command, so it is allowed.
 */
export async function commitHasTrailer(command: string, cwd: string) {
  const found = commit.exec(command);
  if (found === null) return false;
  // The whole command counts, because an earlier part can write the message that the commit reads.
  if (trailer.test(command)) return true;
  // A -F before the commit belongs to another command.
  for (const match of command.slice(found.index).matchAll(messageFile)) {
    // Stryker disable next-line StringLiteral: equivalent: the last group matches whenever the quoted groups do not
    const name = match[1] ?? match[2] ?? match[3] ?? "-";
    if (name !== "-" && trailer.test(await fileText(path.resolve(cwd, name)))) return true;
  }
  return false;
}
