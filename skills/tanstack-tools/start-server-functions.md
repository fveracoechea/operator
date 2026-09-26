# Cross to the server with a server function

Start draws the server boundary per file, with the compiler and `.server.ts` / `.client.ts` import protection.
A `src/server/` folder enforces nothing and splits a feature in two, so a feature keeps both halves in one module and exposes the server half as `$functions.ts`.

Each module is a deep module (`codebase-design`), and here depth also keeps secrets: the base URL, the token and the retry policy stay behind the interface and never reach the browser.
Two tests tell a deep one: a component reaches data through the query-options builder and knows nothing about tokens, breakers or Redis, and a handler is a few lines against one interface object.

## Give a module three importable files, and keep the rest private

A folder under `src/modules/<name>` exposes:

| File                                          | Holds                                                              |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `main.ts`, `main.server.ts`, `main.client.ts` | one exported PascalCase interface object (`Auth`, `Redis`, `Chat`) |
| `$functions.ts`                               | the module's server functions and server-function middleware       |
| `schemas.ts`                                  | the module's wire shapes as Zod, plus the types inferred from them |

Every other file is private to the module.
What a route or another module needs becomes a method on the interface object, and a `no-restricted-imports` pattern over `src/modules/*/` enforces it.

### Declare the interface object directly, with no factory

Write `export const Auth = {...}` and import the collaborators.
A `createAuth(deps)` factory over static imports exists only for a test, which can mock the collaborator instead.

### Let a feature use infrastructure, and never the reverse

A feature module uses `Upstream`, `Redis`, `Auth`.
An infrastructure module never imports a feature.

## Name a server function with `$`, and export each one from `$functions.ts`

`$` marks an RPC at the call site; interface objects stay PascalCase.
`$functions.ts` exports each server function and middleware at top level, because the compiler extracts each `createServerFn` into its own stub, so any file may import it.

Give each operation its own named server function, whose handler calls one method on the interface object:

```ts
export const $threads = createServerFn({method: 'GET'})
  .middleware([$sessionMiddleware])
  .validator(ConversationListQuery)
  .handler(async ({data, context}) =>
    Upstream.envelope(async () => Conversations.threads(data, context))
  )
```

Types flow from handler to call site.
One operation-keyed dispatcher over a table is for a table **generated** from a contract, where a new endpoint is a regenerate; kept by hand it needs a client cast and re-parses what the fetch library already parsed.

## Make the `.validator()` the browser's allowlist

The browser sends the arguments.
The base URL, the credentials and the output schema stay on the server.
One schema in `schemas.ts` is both the browser's argument type and the server's parse.

## Read env inside the method, at call time

Declare env in two files, `.server.ts` for server-only variables and `.client.ts` for the ones the bundler may inline, and read `process.env` or `import.meta.env` nowhere else.
Read a server value inside the method, not at module load: a client-side test imports the route tree, and a top-level read throws before the test starts.

### Keep a browser face the route tree imports in `main.ts`

The route tree loads on the server for the document request even under `ssr: 'data-only'`, so a `.client.ts` on that path fails the SSR build.

## Return a service envelope instead of throwing across the RPC

A throw crosses the RPC as an opaque transport error.
Return the failure as data:

```ts
type ServiceEnvelope<T> =
  | {ok: true; data: T}
  | {ok: false; status: number; statusText: string; body: Json | undefined}
  | {ok: false; invalid: WireSchemaIssue[]}
```

`Upstream.envelope(() => ...)` wraps the handler and maps every fault to one status: the upstream's when it answered, the transport's otherwise.
The data layer unwraps it and rethrows an error shaped like the fetch library's, so the existing retry predicates and error copy still apply.

## Put the session on a middleware

```ts
export const $sessionMiddleware = createMiddleware({type: 'function'}).server(
  async ({next}) => {
    const {principal, accessToken} = await Auth.requireSession()
    return next({context: {principal, accessToken}})
  }
)
```

Every relay lists it and reads the identity from `context`.
A handler where signed-out is a valid answer reads the session itself and returns its own shape.

### Scope the CSRF check to server-function handlers

An identity provider's redirect and a back-channel POST arrive cross-site by design, so a fixed route that accepts one sits outside the check.

## Keep a real HTTP route for callers outside the app bundle

A server route is for a caller outside the bundle that needs a fixed URL: a redirect target, an `<a href>`, an `EventSource`, a health probe, a callback.
Everything else is a server function.

### Stream from a server function

Return a raw `Response`; it crosses the RPC untouched, and the request `signal` fires when the browser hangs up.
Exempt a long stream from the server idle timeout, or the runtime kills it mid-response.

## Reach a server function from the data layer only

The query-options builder calls `$threads` and owns the key, the `queryFn`, the unwrap and the mapping.
Components read the builder, and anything else a screen needs (a refresh, a page size, a download href) is a member of the same slice.

## Mock each `$functions` module under vitest

Vitest skips the Start compiler, so an untransformed `createServerFn` returns nothing and the RPC boundary is the only seam.
Mock each `$functions` module once, in the shared setup, with a stand-in that speaks the real wire, so the existing HTTP mocks keep working.

One line per server function; a suite that needs more overrides the module.
Module tests cover what the stand-in omits, such as identity headers.
`anti-slop/no-module-mocking` is off for module tests and the stand-in only.
