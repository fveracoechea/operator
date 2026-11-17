import { stackGit } from "./stack-git.ts";

/** Only recorded branch history can attest an old cut; a new merge-base can resurrect replaced parent code. */
export async function parentCut(input: {
  cwd: string;
  branch: string;
  remote: string;
  parentHead: string;
  childHead: string;
  requested?: string;
}) {
  const candidates = new Set([input.parentHead]);
  for (const ref of [
    `refs/heads/${input.branch}`,
    `refs/remotes/${input.remote}/${input.branch}`,
  ]) {
    const history = await stackGit(input.cwd, ["reflog", "show", "--format=%H", ref]);
    if (history.ok)
      for (const head of history.out.split("\n")) if (head !== "") candidates.add(head);
  }
  const inherited: string[] = [];
  for (const head of candidates) {
    if ((await stackGit(input.cwd, ["merge-base", "--is-ancestor", head, input.childHead])).ok)
      inherited.push(head);
  }
  const maximal = await maximalHeads(input.cwd, inherited);
  if (input.requested !== undefined && input.requested !== maximal[0])
    return {
      ok: false,
      out: "",
      detail: "The requested cut is not the unique most recent proven prerequisite cut.",
    };
  return maximal.length === 1
    ? { ok: true, out: maximal[0] ?? "", detail: "" }
    : {
        ok: false,
        out: "",
        detail:
          "No unique inherited prerequisite head is proven. Preserve the work and inspect its provenance.",
      };
}

async function maximalHeads(cwd: string, inherited: string[]) {
  const maximal: string[] = [];
  for (const head of inherited) {
    let superseded = false;
    for (const other of inherited) {
      if (
        other !== head &&
        (await stackGit(cwd, ["merge-base", "--is-ancestor", head, other])).ok
      ) {
        superseded = true;
        break;
      }
    }
    if (!superseded) maximal.push(head);
  }
  return maximal;
}
