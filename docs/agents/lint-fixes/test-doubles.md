# Test doubles

Replace a dependency where the caller meets it, and assert on what the code under test did.

## `anti-slop/no-module-mocking`

The blanket ban remains outside `*.test.ts` files.
In those governed tests, `deep-modules/public-collaborator-mocks` permits public external collaborators and protects the tested owner's internals.
Read `packages/deep-modules/docs/public-collaborator-mocks.md` for registration order, setup ownership and file isolation.
Use a scoped public-interface spy, function injection or a controlled external tool when a module replacement is unnecessary.
`docs/agents/testing/writing-tests.md` describes these doubles.

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
