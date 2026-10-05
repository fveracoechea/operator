import { ContentIdentity } from "../content-identity/main.ts";
import { ToolInvocation } from "../tool-invocation/main.ts";
import { type BundledSkill, sameBytes } from "./assets.ts";

/** One skill copy a commit holds in place of the release copy. A null identity holds no file. */
export type CommittedCopy = { path: string; identity: string | null };

const NO_OBJECT = /^0+$/;
// Git answers a link it cannot follow with a second line that names it.
const TWO_LINE_ANSWERS = ["dangling ", "loop ", "notdir ", "symlink "];

/** The bytes of one file, null when the tree holds no file there, or undefined when unread. */
async function blob(repoRoot: string, sha: string): Promise<Uint8Array | null | undefined> {
  if (NO_OBJECT.test(sha)) return null;
  const read = await ToolInvocation.git({ repoRoot, args: ["cat-file", "blob", sha], raw: true });
  return read.status === "read" ? read.bytes : undefined;
}

/**
 * The tree each `<commit>:<path>` names, with links inside the tree followed, as a checkout
 * resolves them. A path that is not a directory, or that Git cannot read, names no tree.
 */
async function treesOf(repoRoot: string, specs: string[]): Promise<Array<string | null>> {
  const read = await ToolInvocation.git({
    repoRoot,
    args: ["cat-file", "--batch-check", "--follow-symlinks"],
    input: specs.map((spec) => `${spec}\n`).join(""),
  });
  if (read.status !== "read") return specs.map(() => null);

  const lines = read.value.split("\n");
  const trees: Array<string | null> = [];
  for (let index = 0; index < lines.length && trees.length < specs.length; index += 1) {
    const line = lines[index] ?? "";
    if (TWO_LINE_ANSWERS.some((answer) => line.startsWith(answer))) index += 1;
    const [sha, type] = line.split(" ");
    trees.push(type === "tree" && sha !== undefined ? sha : null);
  }
  return trees;
}

/** One file that differs between two trees of one skill directory. */
type Change = { path: string; modes: string[]; before: string; after: string };

async function changesOf(repoRoot: string, before: string, after: string): Promise<Change[]> {
  const read = await ToolInvocation.git({
    repoRoot,
    args: ["diff-tree", "-r", "-z", "--no-renames", before, after],
    raw: true,
  });
  if (read.status !== "read") return [];

  const fields = read.value.split("\0");
  const changes: Change[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [oldMode = "", newMode = "", oldSha = "", newSha = ""] = (fields[index] ?? "")
      .slice(1)
      .split(" ");
    changes.push({
      path: fields[index + 1] ?? "",
      modes: [oldMode, newMode],
      before: oldSha,
      after: newSha,
    });
  }
  return changes;
}

/**
 * The identity one changed file has at the later commit, or undefined when the copy is not kept:
 * the approved commit did not hold what the release writes there, or Git could not read it.
 * A link or a submodule inside a skill directory is never kept, because the copy step compares
 * files.
 */
async function keptIdentity(
  repoRoot: string,
  release: Uint8Array | null,
  change: Change,
): Promise<string | null | undefined> {
  if (!change.modes.every((mode) => mode === "000000" || mode.startsWith("100"))) return undefined;

  const approved = await blob(repoRoot, change.before);
  const held =
    release === null
      ? approved === null
      : approved !== null && approved !== undefined && sameBytes(approved, release);
  if (!held) return undefined;

  const committed = await blob(repoRoot, change.after);
  return committed === null || committed === undefined
    ? committed
    : ContentIdentity.ofBytes(committed);
}

/**
 * The skill copies one commit holds in place of the release copy, where the approved commit
 * still held what the release writes. Only work after the approved commit changed them.
 */
export async function committedCopies(request: {
  repoRoot: string;
  root: string;
  skills: BundledSkill[];
  approved: string;
  commit: string;
}): Promise<CommittedCopy[]> {
  const { repoRoot, root, skills } = request;
  const trees = await treesOf(
    repoRoot,
    skills.flatMap((skill) => [
      `${request.approved}:${root}/${skill.name}`,
      `${request.commit}:${root}/${skill.name}`,
    ]),
  );

  const copies: CommittedCopy[] = [];
  for (const [index, skill] of skills.entries()) {
    const before = trees[index * 2] ?? null;
    const after = trees[index * 2 + 1] ?? null;
    if (before === null || after === null || before === after) continue;

    for (const change of await changesOf(repoRoot, before, after)) {
      const release = skill.assets.find((asset) => asset.path === change.path)?.bytes ?? null;
      const identity = await keptIdentity(repoRoot, release, change);
      if (identity !== undefined) {
        copies.push({ path: `${root}/${skill.name}/${change.path}`, identity });
      }
    }
  }
  return copies.toSorted((left, right) => left.path.localeCompare(right.path));
}
