# Shape a deep module

## Give the module a few named entry files, and keep every other file private

The rest of the app imports a module only through its entry files.
Every other file is private, and files inside the module import each other with relative paths.

| File                                   | Holds                                                                  | Environment                        |
| -------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------- |
| `main.ts`                              | one exported PascalCase interface object (`Invoices`, `Auth`, `Cache`) | a module that callers import       |
| `main.server.ts`, `main.client.ts`     | a second interface object, bound to one side of the boundary           | full-stack                         |
| `schemas.ts` or `schemas.generated.ts` | the wire shapes as Zod, and the types inferred from them               | a module whose data crosses a wire |
| `$functions.ts`                        | the server functions and server-function middleware                    | TanStack Start                     |

A module has only the entry files its callers need.
A server-only module is usually `main.ts` and `schemas.ts`, because the HTTP routes that call it live outside the module.
An SPA module is `main.ts`, plus `schemas.ts` for the responses it parses.

The wire schemas are an interface of their own, because routes, handlers and fixtures parse against them.
An entry file may also export the types a caller needs to name the object's inputs and results, such as `Session` beside `Auth`.

### Let `$functions.ts` be the interface when every caller crosses the RPC

In a full-stack app, a module that only the browser calls, through its server functions, has no `main.ts` or `main.server.ts`.
Its interface is `$functions.ts` and its wire schemas.
The server-side code behind the server functions is private, and its file is named after what it does, such as `invoices.server.ts`, so the name does not read as an entry file.

Add `main.server.ts` when another module's server code must call the module, such as the `Auth.requireSession()` that every other module's server code calls.
Add `main.ts` when a route places the module's UI or calls it in the browser.

### Pick the entry file by where the object runs

This applies to a full-stack app, where one module holds code for both sides.

- `main.server.ts` holds a server-only face: `Auth`, `Cache`, `Http`.
- `main.ts` holds an isomorphic face, or the face the browser uses. TanStack Start renders every component in the route tree on the server, even under `ssr: 'data-only'`, so a `.client.ts` file on that path fails the SSR build.
- A module with two faces has two entry files, each with one object.

The file name tells where code runs.
`.server.ts` and `.client.ts` mark a file that belongs to one environment, and a plain `.ts` file runs on both.
A `$` prefix marks a server function or middleware.
A `.generated.ts` suffix marks generated output, which nobody edits by hand.

## Enforce the entry files with a lint rule

A `no-restricted-imports` pattern, in oxlint or ESLint, rejects every import from outside that skips an entry file:

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
The pattern is done when a deliberate deep import fails lint, and lint passes again after you revert it.

## Declare the interface object directly

```ts
import {InvoicesUI} from './ui/main'

/** The invoices feature as the app sees it. */
export const Invoices = {
  UI: InvoicesUI,
}
```

The object imports its collaborators.
A `createInvoices(deps)` factory whose arguments are all static imports exists only for a test, and so does a wrapper around one call.
The test fakes the collaborator at its entry file instead, as [module-tests.md](module-tests.md) describes.

## Put what another module needs on the interface object

A caller that needs a behaviour gets it as a method on the interface object.
Before you add the method, ask why the caller needs it.
When the caller does work that the module should own, move that work into the module as one finished method.
Exporting the pieces the caller would assemble makes the module shallower.

## Expose the UI as finished use cases on a `UI` object

This applies to an SPA or a full-stack module that has a UI.

```ts
export const InvoicesUI = {
  /** What the overdue list renders: the empty state, then the rows. */
  OverdueList: OverdueListRoot,
}
```

The route places the member whole: `<Invoices.UI.OverdueList />`.
Each member decides what it shows from its own state.
The parts a member composes stay inside the module, because a caller that assembles parts holds the module's state switches.
Keep the module's `.tsx` files under its `ui/` folder.
The internal compound, its provider and its parts, follows the `react-composition` skill.

## Make a folder inside a module a sub-module with one entry file

A folder inside a module has its own `main.ts`, or `main.server.ts` in a full-stack app, and the rest of the module imports the folder only through it:

```ts
// invoices/pdf/main.ts
export type {PdfPage} from './render'

export const Pdf = {
  render: renderInvoicePdf,
  /** The file name the browser saves, built from the invoice number. */
  fileName: toFileName,
}
```

`invoices/ui/` imports `../pdf/main`, never `../pdf/layout`.
A relative path escapes the lint pattern above, so a reviewer looks for an import that reaches past a sibling folder's `main`.
Add the folder when a group of files hides something from the rest of the module, not to sort files by kind.

## Point every import downward

- A feature module uses infrastructure modules, such as `Http`, `Cache` and `Auth`.
- An infrastructure module never imports a feature module.
- A module imports the shared library (`src/lib`) and the app's shared components (`src/components`).
- A module never imports a route or a handler. Routes and handlers are the callers.

A second `no-restricted-imports` pattern on `src/modules/**` can reject `@/routes/**`.
`import/no-cycle` catches a cycle between files, not a cycle between two modules whose files form no loop.
Check the direction yourself before you add an import from another module.

## Read server configuration inside a method

Declare environment variables in validated files, `.server.ts` for server-only values and `.client.ts` for values the bundler may inline, and read `process.env` or `import.meta.env` nowhere else.
Validate them at startup, so a bad value fails the boot.

In a full-stack app, a module reads a server value inside the method that needs it, never at module load:

```ts
/** `baseURL` per call: `ServerEnv` is read at call time, never at module load. */
function billingRequest(session: Session) {
  return {
    baseURL: ServerEnv.BILLING_BASE_URL,
    headers: {authorization: `Bearer ${session.token}`},
  }
}
```

A client-side test imports the route tree, and a top-level read of a server value throws before the test starts.
A connection that is expensive to open is a lazy singleton, opened on the first call.

## Keep per-user state out of module scope

This applies on a server, full-stack or server-only.
A variable at module level is shared by every request in the process.
A visitor's state lives in the session, in the request's context, or in the request's query client.

In an SPA, the query cache holds server data and the URL holds what the URL owns.
A module-level store that copies either one is a second source of truth.
