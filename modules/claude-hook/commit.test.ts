import { afterAll, describe, expect, test } from "bun:test";
// Bun has no temporary-directory or recursive removal API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { commitHasTrailer } from "./commit.ts";

const root = await mkdtemp(path.join(tmpdir(), "claude-hook-commit-"));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("a commit command with a Co-Authored-By trailer", () => {
  test.each([
    ['git commit -m "fix: x" -m "Co-Authored-By: Claude <noreply@anthropic.com>"'],
    ['git commit -m "fix: x\n\nco-authored-by: Claude <noreply@anthropic.com>"'],
    [
      "git commit -m \"$(cat <<'EOF'\nfix: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF\n)\"",
    ],
    ['git commit --amend -m "fix: x" -m "Co-Authored-By: A <a@b.c>"'],
    ['git commit --trailer "Co-authored-by=A <a@b.c>" -m "fix: x"'],
    ['git commit --trailer "Co-authored-by = A <a@b.c>" -m "fix: x"'],
    ['git -C repo -c user.name=A commit -m "Co-Authored-By: A <a@b.c>"'],
    ['git  -C  repo  commit -m "Co-Authored-By: A <a@b.c>"'],
    ['git --no-pager -P --work-tree=repo commit -m "Co-Authored-By: A <a@b.c>"'],
    ['cd repo && git add . && git commit -m "Co-Authored-By: A <a@b.c>"'],
    ["git commit -F - <<'EOF'\nfix: x\n\nCo-Authored-By: A <a@b.c>\nEOF"],
  ])("is refused: %s", async (command) => {
    expect(await commitHasTrailer(command, root)).toBe(true);
  });

  test("is refused when the trailer is in the message file", async () => {
    await Bun.write(`${root}/message.txt`, "fix: x\n\nCo-Authored-By: A <a@b.c>\n");
    expect(await commitHasTrailer("git commit -F message.txt", root)).toBe(true);
    expect(await commitHasTrailer(`git commit --file="${root}/message.txt"`, "/")).toBe(true);
    expect(await commitHasTrailer("git commit --amend --file message.txt", root)).toBe(true);
    expect(await commitHasTrailer("git commit --file  message.txt", root)).toBe(true);
    expect(await commitHasTrailer("git commit -Fmessage.txt", root)).toBe(true);
    await Bun.write(`${root}/my message.txt`, "fix: x\n\nCo-Authored-By: A <a@b.c>\n");
    expect(await commitHasTrailer("git commit -F 'my message.txt'", root)).toBe(true);
  });
});

describe("a command that is allowed", () => {
  test.each([
    ['git commit -m "fix: x"'],
    ['git commit -m "docs: explain the Co-Authored-By policy"'],
    ['git log --grep "Co-Authored-By: A"'],
    ['git commit-tree HEAD^{tree} -m "Co-Authored-By: A <a@b.c>"'],
    ['echo "Co-Authored-By: A" > notes.txt'],
    ['echo "Co-Authored-By: A" > notes.txt && git commit -m "fix: x"'],
    ["git commit --amend --no-edit"],
    ["git commit"],
  ])("%s", async (command) => {
    expect(await commitHasTrailer(command, root)).toBe(false);
  });

  test("a message file with no trailer, or one that cannot be read", async () => {
    await Bun.write(`${root}/clean.txt`, "fix: x\n");
    expect(await commitHasTrailer("git commit -F clean.txt", root)).toBe(false);
    expect(await commitHasTrailer("git commit -F missing.txt", root)).toBe(false);
    expect(await commitHasTrailer(`git commit -F ${root}`, root)).toBe(false);
  });

  test("a message on standard input is read from the command, not from a file named -", async () => {
    await Bun.write(`${root}/-`, "Co-Authored-By: A <a@b.c>\n");
    expect(await commitHasTrailer("git commit -F - <<'EOF'\nfix: x\nEOF", root)).toBe(false);
  });
});
