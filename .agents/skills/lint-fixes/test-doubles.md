# Test doubles

Replace a dependency where the caller meets it, and assert on what the code under test did.

## `anti-slop/no-module-mocking`

`mock.module` replaces a file by its path, so the test no longer runs the real module graph.
Use a scoped spy on the public interface, a function fake that the caller passes in, or a controlled external tool.
The `bun` skill and `.agents/skills/unit-testing/writing-tests.md` describe these doubles.

```ts
// Wrong
mock.module("./github.ts", () => ({ readPullRequest: async () => facts }));

// Right: run the real module against a controlled `gh` on PATH.
await Bun.write(`${bin}/gh`, fakeGh, { mode: 0o755 });
```

## `custom-tests/no-fixture-assertion`

An assertion that reads only its own fixture proves nothing about the code.
Call the code under test, then assert on its result or on its effects.

```ts
// Wrong
const draft = { id: "a" };
expect(draft.id).toBe("a");

// Right
expect(readDraft(file)).toEqual({ id: "a" });
```
