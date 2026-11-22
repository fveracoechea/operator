import { ToolInvocation } from "../tool-invocation/main.ts";

/** Git graph preparation writes objects, never another owner's branch or worktree. */
export async function stackGit(cwd: string, args: string[], input?: string) {
  const answer = await ToolInvocation.run({ tool: "git", cwd, args, input, timeoutMs: 120000 });
  return answer.status === "completed"
    ? { ok: answer.exitCode === 0, out: answer.stdout.trim(), detail: answer.stderr.trim() }
    : { ok: false, out: "", detail: answer.detail };
}

/** A stable dependency/child commit identity permits exact recovery after a lost response. */
export function stackCommit(cwd: string, tree: string, parents: string[], message: string) {
  const text = [
    `tree ${tree}`,
    ...parents.map((parent) => `parent ${parent}`),
    "author Operator stack <operator-stack@localhost> 1 +0000",
    "committer Operator stack <operator-stack@localhost> 1 +0000",
    "",
    message,
    "",
  ].join("\n");
  return stackGit(cwd, ["hash-object", "-t", "commit", "-w", "--stdin"], text);
}

/** Apply only the child's delta since its pinned old cut, including deleted parent changes. */
export async function stackCandidate(cwd: string, cut: string, base: string, head: string) {
  const merged = await stackGit(cwd, [
    "merge-tree",
    "--write-tree",
    `--merge-base=${cut}`,
    base,
    head,
  ]);
  if (!merged.ok) return merged;
  return stackCommit(
    cwd,
    merged.out.split("\n")[0] ?? "",
    [base],
    `Preserve child changes from ${head}\n\nOriginal stack cut: ${cut}`,
  );
}
