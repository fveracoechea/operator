# Guard the entry files with lint

## Reject an import that skips an entry file

A `no-restricted-imports` pattern, in oxlint or ESLint, rejects every import from outside a module that skips its entry files:

```jsonc
"no-restricted-imports": ["error", {"patterns": [{
  "group": [
    "@/modules/*/*", "@/modules/*/**", "**/modules/*/*", "**/modules/*/**",
    "!@/modules/*/main", "!@/modules/*/main.server", "!@/modules/*/main.client",
    "!@/modules/*/$functions", "!@/modules/*/schemas", "!@/modules/*/schemas.generated",
    "!**/modules/*/main", "!**/modules/*/main.server", "!**/modules/*/main.client",
    "!**/modules/*/$functions", "!**/modules/*/schemas", "!**/modules/*/schemas.generated"
  ],
  "message": "Import a module through its entry files, or put the helper on its interface object. Inside a module, use relative imports."
}]}]
```

Keep only the entry names the repo uses.
The pattern also rejects `@/modules/chat/turn/main`, so a sub-module stays private to its parent.
The pattern is done when a deliberate deep import fails lint, and lint passes again after you revert it.

## Reject a route import from a module

A second `no-restricted-imports` pattern on `src/modules/**` can reject `@/routes/**`, so a module never imports its callers.
Verify it the same way: a deliberate route import from a module fails lint.

## Know what the patterns miss

A relative import escapes both patterns.
Inside a module, a reviewer looks for an import that reaches past a sub-module's `main`, such as `../turn/turn-stream`.
