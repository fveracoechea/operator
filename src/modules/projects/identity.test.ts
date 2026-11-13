import { expect, test } from "bun:test";
import { githubIdentity, repositoryIdentity, selectRepository } from "./identity.ts";

test.each([
  ["git@github.com:Owner/Repository.git", "owner/repository"],
  ["github.com:owner/repository", "owner/repository"],
  ["https://github.com/OWNER/Repository.git", "owner/repository"],
  ["http://github.com/owner/repository", "owner/repository"],
  ["ssh://git@github.com/Owner/Repository.git", "owner/repository"],
  ["git://github.com/owner/repository", "owner/repository"],
  ["https://github.com/owner/repository/", "owner/repository"],
  ["git@github.com:owner/re.gitpo", "owner/re.gitpo"],
  ["https://github.com/owner/re.gitpo", "owner/re.gitpo"],
  ["https://github.com/0wner-9/repo_2", "0wner-9/repo_2"],
])("canonicalizes a GitHub remote %s", (remote, identity) => {
  expect(githubIdentity(remote)).toBe(identity);
});
test.each([
  "https://github.com.evil/owner/repo",
  "https://gitlab.com/owner/repo",
  "file://github.com/owner/repo",
  "git@github.com:owner/repo/extra",
  "git@github.com:owner/repo extra",
  "evil.github.com:owner/repo",
  "a/b@github.com:owner/repo",
  "https://github.com/owner/repo?other=value",
  "https://github.com/owner/repo#ref",
  "git://github.com",
  "owner/repo",
  "not a URL",
  "https://github.com/owner/..",
])("rejects a non-identity remote %s", (remote) => {
  expect(githubIdentity(remote)).toBeNull();
});
test("accepts only owner/repository identities", () => {
  for (const invalid of [
    "owner",
    "owner/repo/extra",
    "/repo",
    "-owner/repo",
    `${"a".repeat(40)}/repo`,
    "owner/..",
    "owner/.",
    "owner/r e p o",
    "x/owner/repo",
  ])
    expect(repositoryIdentity(invalid)).toBeNull();
  expect(repositoryIdentity("OWNER/Repo.Name")).toBe("owner/repo.name");
  expect(repositoryIdentity(`${"A".repeat(39)}/r`)).toBe(`${"a".repeat(39)}/r`);
  expect(repositoryIdentity("o-1/R2")).toBe("o-1/r2");
});
test("validates explicit identities and matching choices without changing the supplied list", () => {
  const remotes = ["fork/repo", "upstream/repo"];
  expect(selectRepository(remotes)).toEqual({
    reason: "repository_choice_required",
    detail:
      "Several GitHub identities match. Repeat with --repository owner/repository. Choices: fork/repo, upstream/repo. Remote names have no authority.",
  });
  expect(selectRepository(remotes, "UPSTREAM/REPO")).toEqual({ repository: "upstream/repo" });
  const invalid = {
    reason: "repository_choice_invalid",
    detail:
      "--repository must name owner/repository and match a github.com remote in this checkout.",
  } as const;
  expect(selectRepository(remotes, "other/repo")).toEqual(invalid);
  expect(selectRepository(remotes, "not an identity")).toEqual(invalid);
  expect(selectRepository(["upstream/repo"])).toEqual({ repository: "upstream/repo" });
  const missing = {
    reason: "github_remote_missing",
    detail: "This checkout has no github.com remote. Add a matching remote before registration.",
  } as const;
  expect(selectRepository([])).toEqual(missing);
  expect(selectRepository([], "upstream/repo")).toEqual(missing);
  expect(remotes).toEqual(["fork/repo", "upstream/repo"]);
});
