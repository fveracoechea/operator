import { slug } from "../../lib/slug.ts";

/** Herdr agent names allow 32 characters, so the base leaves room for a collision suffix. */
export function launchBase(input: { completion: string; trackerKey: string; key: string }) {
  const tracker = slug(input.trackerKey.split("/").at(-1) ?? "");
  const base = [input.completion, tracker, slug(input.key)].filter((part) => part !== "").join("-");
  return base.slice(0, 28).replace(/-+$/, "");
}

/**
 * Choose the first free name and branch. A suffix never adopts an unrecorded resource,
 * so every taken name or branch from Herdr, Git, or earlier launches is skipped.
 */
export function chooseNames(input: {
  base: string;
  branch: string | null;
  takenNames: ReadonlySet<string>;
  takenBranches: ReadonlySet<string>;
}) {
  for (let index = 1; index < 1000; index++) {
    const suffix = index === 1 ? "" : `-${index}`;
    const name = `${input.base}${suffix}`;
    const branch = input.branch === null ? null : `${input.branch}${suffix}`;
    if (!input.takenNames.has(name) && (branch === null || !input.takenBranches.has(branch)))
      return { name, branch };
  }
  return null;
}
