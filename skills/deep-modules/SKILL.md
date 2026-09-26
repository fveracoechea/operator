---
name: deep-modules
description: 'Use when adding or changing a feature or capability in a TypeScript app: code for a domain concept, a screen and its data, where new or shared code goes, a module interface or sub-module, or a module test.'
---

# Deep modules

Sort code by feature and capability, never by technical layer or by page.
Each feature and each capability is one folder under `src/modules/<name>/`, and the rest of the app reaches it through one small interface.
The folder holds every file the feature needs, whatever layer or environment the file belongs to.

- A **feature** is a domain concept the product names, such as invoices, payments or customers. Its module owns the calls to the backend, the reads, the transforms, the cache rules and the UI.
- A **capability** is what features use and users never see, such as auth, the HTTP client for a backend, or a cache.
- A **page** is a route. It owns the URL, the loader and the layout, and places the `UI` members of the features it shows.
- A **layer** is a technical role, such as query options, selectors, hooks or an API client. A layer is never a module name.

Each module is a deep module in John Ousterhout's sense: a small interface in front of a large implementation.
The module pulls complexity down into itself, so each caller knows less.
The `codebase-design` skill holds the words for this: depth, seam, leverage, locality and the deletion test.
Use its words.

**Name the feature first.**
Before you write code, name the domain noun the change is about, and find the module that owns it.
When code for that noun is spread across routes and layers with no module, the feature is missing its module.
[finding-features.md](finding-features.md) is the procedure, and every task starts with it.

**The caller learns one object.**
A route, a handler or another module reaches the module through its interface object, such as `Invoices`, `Auth` or `Cache`.
A module that only the browser reaches through server functions has `$functions.ts` as its interface, and no object.
A second exported name is a second interface, and the module gets shallower with each one.

**Build from the call site down.**
Write the line the caller will contain first, such as `<Invoices.UI.OverdueList />` or `Auth.requireSession()`, then write the implementation behind it.
Code written from the bottom up produces helpers that no module owns.

## Know the environment

The rules hold in every environment.
The entry files differ, and [module-shape.md](module-shape.md) lists the set for each environment.

- **Full-stack**, such as TanStack Start: one module owns both sides of the server boundary and its UI. The framework draws that boundary per file.
- **SPA**: a module owns its UI, its reads and its client state rules. The server is another team's contract, reached through wire schemas.
- **Server only**, such as `Bun.serve` or a Node server: a module owns one capability or feature, and the HTTP routes are its callers.

## Pick the task

- **Deciding which module owns a change, or finding a feature that has no module**: [finding-features.md](finding-features.md).
- **Creating a module, adding a file to one, placing a helper, or enforcing the entry points**: [module-shape.md](module-shape.md).
- **Designing or reviewing an interface, or deciding whether a module earns its place**: [interface-design.md](interface-design.md).
- **Writing a test for a module, or for code that uses one**: [module-tests.md](module-tests.md).

A TanStack Start server function inside a module, with its `$` name, its validator and its envelope, is in the `tanstack-tools` skill, topic `start-server-functions.md`.
