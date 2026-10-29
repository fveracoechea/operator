export function repositoryIdentity(value: string) {
  const match = /^([a-z\d](?:[a-z\d-]{0,38}))\/([a-z\d._-]+)$/i.exec(value);
  if (!match || match[2] === "." || match[2] === "..") return null;
  return value.toLowerCase();
}

export function githubIdentity(remote: string) {
  const scp = /^(?:[^/@:\s]+@)?github\.com:([^\s]+)$/i.exec(remote);
  if (scp?.[1]) return repositoryIdentity(scp[1].replace(/\.git$/i, ""));
  try {
    const url = new URL(remote);
    if (
      !["https:", "http:", "ssh:", "git:"].includes(url.protocol) ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.search ||
      url.hash
    )
      return null;
    return repositoryIdentity(
      url.pathname
        .slice(1)
        .replace(/\/$/, "")
        .replace(/\.git$/i, ""),
    );
  } catch {
    return null;
  }
}

export function selectRepository(
  repositories: string[],
  choice?: string,
):
  | { repository: string }
  | {
      reason: "github_remote_missing" | "repository_choice_invalid" | "repository_choice_required";
      detail: string;
    } {
  const [first, ...rest] = repositories;
  if (first === undefined)
    return {
      reason: "github_remote_missing" as const,
      detail: "This checkout has no github.com remote. Add a matching remote before registration.",
    };
  if (choice !== undefined) {
    const identity = repositoryIdentity(choice);
    // Stryker disable next-line ConditionalExpression: equivalent: the list holds only strings, so includes(null) is false and the right side refuses a null identity too
    if (identity === null || !repositories.includes(identity))
      return {
        reason: "repository_choice_invalid" as const,
        detail:
          "--repository must name owner/repository and match a github.com remote in this checkout.",
      };
    return { repository: identity };
  }
  if (rest.length > 0)
    return {
      reason: "repository_choice_required" as const,
      detail: `Several GitHub identities match. Repeat with --repository owner/repository. Choices: ${repositories.join(", ")}. Remote names have no authority.`,
    };
  return { repository: first };
}
