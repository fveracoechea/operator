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
[entry-file-lint.md](entry-file-lint.md) makes lint reject an import that skips an entry file.

### Let `$functions.ts` be the interface when every caller crosses the RPC

In a full-stack app, a module that only the browser calls, through its server functions, has no `main.ts` or `main.server.ts`.
Its interface is `$functions.ts` and its wire schemas.
The server-side code behind the server functions is private, and its file is named after what it does, such as `invoices.server.ts`, so the name does not read as an entry file.

Add `main.server.ts` when another module's server code must call the module, such as the `Auth.requireSession()` that every other module's server code calls.
Add `main.ts` when a route places the module's UI or calls it in the browser.

### Pick the entry file by where the object runs

This applies to a full-stack app, where one module holds code for both sides.

- `main.server.ts` holds a server-only interface object: `Auth`, `Cache`, `Http`.
- `main.ts` holds an isomorphic interface object, or the one the browser uses. TanStack Start renders every component in the route tree on the server, even under `ssr: 'data-only'`, so a `.client.ts` file on that path fails the SSR build.
- A module with an object for each side has two entry files, each with one object.

The file name tells where code runs.
`.server.ts` and `.client.ts` mark a file that belongs to one environment, and a plain `.ts` file runs on both.
A `$` prefix marks a server function or middleware.
A `.generated.ts` suffix marks generated output, which nobody edits by hand.

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
Before you add the method, ask why the caller needs it, and ship the finished use case that [interface-design.md](interface-design.md) describes.

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
Keep the module's `.tsx` files under its `ui/` folder.
The internal compound, its provider and its parts, follows the `react-composition` skill.

## Point every import downward

- A feature module uses infrastructure modules, such as `Http`, `Cache` and `Auth`.
- An infrastructure module never imports a feature module.
- A module imports the shared library (`src/lib`) and the app's shared components (`src/components`).
- A module never imports a route or a handler. Routes and handlers are the callers.

`import/no-cycle` catches a cycle between files, not a cycle between two modules whose files form no loop.
Check the direction yourself before you add an import from another module.
