---
name: deep-modules
description: 'Use when adding or changing a feature in a TypeScript app: a screen and its data, where new or shared code goes, a sub-module, or a module test.'
---

# Deep modules

Sort code by feature and capability, never by technical layer or by page.
Each feature and each capability is one folder under `src/modules/<name>/` that holds every file it needs, whatever layer or environment the file belongs to.

- A **feature** is a domain concept the product names, such as invoices, payments or customers. Its module owns the calls to the backend, the reads, the transforms, the cache rules and the UI.
- A **capability** is what features use and users never see, such as auth, the HTTP client for a backend, or a cache.
- A **page** is a route. It owns the URL, the loader and the layout, and places the `UI` members of the features it shows.
- A **layer** is a technical role, such as query options, selectors, hooks or an API client. A layer is never a module name.

Each module is a deep module: it pulls complexity down into itself, so each caller knows less.
The `codebase-design` skill holds the words for this: depth, seam, leverage, locality and the deletion test.

## Name the feature first

Do this before you write code, on every task.

1. Name the domain noun the change is about. Take it from the ticket, the glossary (`CONTEXT.md`), the wire schemas or the words on the screen. A page or a backend service is not a feature.
2. Search `src/` for the noun in file names, types, functions and strings, and list each place it appears.
3. The step is done when you can name the module that owns the change, or when you have a proposal for a new module with its interface object.

When the noun is spread across routes and layers with no module, the feature is missing its module.
[finding-features.md](finding-features.md) has the signs of a missing module, a worked example, and what to do with the old code.

## The caller learns one object per entry file

A route, a handler or another module reaches a module through its entry files, and each entry file exports one PascalCase interface object, such as `Invoices`, `Auth` or `Cache`.
Beside the object, an entry file may export the types a caller needs to name its inputs and results, such as `Session` beside `Auth`.
Two other entry files carry no object: `schemas.ts` holds the wire schemas, and `$functions.ts` holds a TanStack Start module's server functions.
Any other exported name is a second interface, and the module gets shallower with each one.

A sub-module follows the same rule one level down.
In `chat/turn/`, `main.ts` exports one object, `Turn`, and the rest of `chat/` reaches the turn only through it.
Routes see only `Chat`.
Each level hides its parts from the level above, so a sub-module makes the module deeper ([sub-modules.md](sub-modules.md)).

## Build from the call site down

Write the line the caller will contain first, such as `<Invoices.UI.OverdueList />` or `Auth.requireSession()`, then write the implementation behind it.
Code written from the bottom up produces helpers that no module owns.

## Know the environment

The entry files differ, and [module-shape.md](module-shape.md) lists the set for each environment.

- **Full-stack**, such as TanStack Start: one module owns both sides of the server boundary and its UI. The framework draws that boundary per file.
- **SPA**: a module owns its UI, its reads and its client state rules. The server is another team's contract, reached through wire schemas.
- **Server only**, such as `Bun.serve` or a Node server: a module owns one capability or feature, and the HTTP routes are its callers.

## Pick the task

- **Creating a module, adding a file to one, placing a helper, or checking import direction**: [module-shape.md](module-shape.md).
- **Splitting a module into sub-modules, or adding a folder inside one**: [sub-modules.md](sub-modules.md).
- **Setting up the lint rule that guards the entry files**: [entry-file-lint.md](entry-file-lint.md).
- **Reading environment variables or keeping per-request state in a module**: [server-state.md](server-state.md).
- **Designing or reviewing an interface, or deciding whether a module earns its place**: [interface-design.md](interface-design.md).
- **Writing a test for a module, or for code that uses one**: [module-tests.md](module-tests.md).

A TanStack Start server function inside a module, with its `$` name, its validator and its envelope, is in the `tanstack-tools` skill, topic `start-server-functions.md`.
