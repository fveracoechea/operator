import { expect, test } from "bun:test";
import { githubIdentity, repositoryIdentity, selectRepository } from "./identity.ts";

test.each([
  "git@github.com:Owner/Repository.git",
  "https://github.com/OWNER/Repository.git",
  "ssh://git@github.com/Owner/Repository.git",
  "git://github.com/owner/repository",
  "https://github.com/owner/repository/",
])("canonicalizes a GitHub remote %s", (remote) => {
  expect(githubIdentity(remote)).toBe("owner/repository");
});
test.each([
  "https://github.com.evil/owner/repo",
  "https://gitlab.com/owner/repo",
  "file://github.com/owner/repo",
  "git@github.com:owner/repo/extra",
  "https://github.com/owner/repo?other=value",
  "https://github.com/owner/repo#ref",
  "owner/repo",
  "not a URL",
  "https://github.com/owner/..",
])("rejects a non-identity remote %s", (remote) => {
  expect(githubIdentity(remote)).toBeNull();
});
test("validates explicit identities and matching choices without changing the supplied list", () => {
  for (const invalid of [
    "owner",
    "owner/repo/extra",
    "/repo",
    "owner/..",
    "owner/.",
    "owner/r e p o",
  ])
    expect(repositoryIdentity(invalid)).toBeNull();
  expect(repositoryIdentity("OWNER/Repo.Name")).toBe("owner/repo.name");
  const remotes = ["fork/repo", "upstream/repo"];
  expect(selectRepository(remotes)).toMatchObject({ reason: "repository_choice_required" });
  expect(selectRepository(remotes, "UPSTREAM/REPO")).toEqual({ repository: "upstream/repo" });
  expect(selectRepository(remotes, "other/repo")).toMatchObject({
    reason: "repository_choice_invalid",
  });
  expect(selectRepository(["upstream/repo"])).toEqual({ repository: "upstream/repo" });
  expect(selectRepository([])).toMatchObject({ reason: "github_remote_missing" });
  expect(remotes).toEqual(["fork/repo", "upstream/repo"]);
});
