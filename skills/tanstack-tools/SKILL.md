---
name: tanstack-tools
description: 'Use when writing or changing code that uses a TanStack library: router, search params, loader, a query or mutation, form, a chart, or a server function.'
---

# TanStack tools

Read the topic file for the change in front of you.
A change that spans two libraries reads two files.

**Zod is the validation boundary.**
Untrusted data gets a Zod schema.
The schema is the runtime parse and, through `z.infer`, the type, so write no guard and no parallel `interface`.
TanStack Router and Form take the schema directly (Standard Schema), with no adapter; add `zod` (v4) when the project lacks it.

**Every read goes through `@tanstack/react-query`, and a loader warms it with `queryClient.query()` or `queryClient.infiniteQuery()`.**
Both arrived in `@tanstack/react-query` 5.102.
`fetchQuery`, `prefetchQuery`, `ensureQueryData` and their three infinite twins go in the next major; below 5.102 keep the name the project already uses.

## Load the package's own skills first

Each TanStack package ships its own skills, versioned with it, and `@tanstack/intent` lists them.
They cover the API; this skill covers the team's conventions.
Load one for a substantial change, and skip it for a rename or a fix inside a pattern the project already repeats.

From the workspace root:

- Pick the runner from the lockfile: `bunx` for `bun.lock` or `bun.lockb`, `pnpm dlx` for `pnpm-lock.yaml`, `npx` for `package-lock.json` or `npm-shrinkwrap.json`. With any other lockfile, or none, `bunx` when it is installed and `npx` otherwise.
- Run `<runner> @tanstack/intent@latest list`, load the closest match, and follow it. A second package earns a second load. For Start work, the core skill of `@tanstack/start-client-core` routes to the rest.
- Use the project's `intent` script when `package.json` has one. Another dependency can own `node_modules/.bin/intent` and crash the lookup; the script runs `node_modules/@tanstack/intent/dist/cli.mjs` directly.

`intent.skills` in `package.json` is the allowlist of packages that may contribute skills, and `intent.exclude` drops single skills after it resolves.
Only a package that ships a `skills/` directory is found, so add a package to the allowlist when its skills first appear upstream; added earlier, `list` reports it as undiscovered.

## Pick the task

### Router (`@tanstack/react-router`)

- **Creating or structuring a route**: [router-creating-a-route.md](router-creating-a-route.md).
- **Adding or changing a search param**: [router-query-params.md](router-query-params.md).

### Start (`@tanstack/react-start`)

- **A server function**: [start-server-functions.md](start-server-functions.md). The module that owns it follows the `deep-modules` skill.
- **A route's SSR mode or loader**: [start-routes-and-ssr.md](start-routes-and-ssr.md). The loader section applies without Start too.

### Query (`@tanstack/react-query`)

- **Writing or changing a mutation**: [query-mutations.md](query-mutations.md).

### Form (`@tanstack/react-form`)

- **Building or changing a form**: [form-validation.md](form-validation.md).

### Charts (`@tanstack/charts`)

- **Drawing or changing a chart, or choosing its colors**: [charts.md](charts.md).
