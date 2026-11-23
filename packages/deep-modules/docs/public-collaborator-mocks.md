# deep-modules/public-collaborator-mocks

Mock an external collaborator at its declared public entry. Keep the tested owner and all its descendants real.
Another top-level module's public entry and external packages are valid collaborators.
A sub-module test can mock a sibling through its entry, never a sibling's private file.
Private project files, the tested owner's entry, ancestor entries and descendant entries are rejected.
Ordinary function injection and scoped public-interface spies remain valid.

The rule resolves actual `bun:test` imports, renamed imports, namespaces, static string members and immutable aliases.
It checks `mock.module`, `jest.mock`, `jest.doMock`, `vi.mock` and `vi.doMock` from Bun.
Unrelated shadowed objects do not receive findings.
Targets must be string literals or immutable aliases to string literals.
Opaque targets fail with an unsupported-target diagnostic. Use a static target or inject a function instead.
Mutable aliases and opaque factories are not traced. Vitest runtime imports are outside this Bun release's contract.

## Scope and environment entries

Files named `*.test.*` or `*.spec.*` are test scope.
Shared setup requires an explicit owner association in the shared project settings.
Paths below resolve against `projectRoot`. Scope keys name exact files or directory trees, not globs.
The longest matching setup scope wins. An association applies the owner's privacy restrictions to setup.

```json
{
  "settings": {
    "deep-modules": {
      "environmentEntries": ["src/environment.ts"],
      "testScopes": { "test/movie-setup.ts": "src/modules/movie" }
    }
  }
}
```

`environmentEntries` declares environment collaborators outside normal module entry conventions.
It does not permit a test to replace its own owner or descendants.
Exclusions do not grant a mock-privacy bypass.

## Register before importing

In `src/modules/movie/main.test.ts`, register the collaborator before dynamically importing the tested module.

```ts
import { expect, mock, test } from "bun:test";

await mock.module("../catalog/main.ts", () => ({
  Catalog: { title: () => "A known title" },
}));

const { Movie } = await import("./main.ts");

test("reads the collaborator's title", () => {
  expect(Movie.title()).toBe("A known title");
});
```

Run files through `bun test --isolate` so module replacements cannot leak between files.
`mock.restore()` restores spies, not `mock.module` replacements. Do not claim it cleans module replacements.
Keep module replacements file-scoped and isolate files. Restore scoped spies after each test.
Never replace `./main.ts`, `./player/main.ts` or `../catalog/private.ts` from the parent test above.
