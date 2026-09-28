# Cross to the server with a server function

A server function lives in a deep module that owns both sides of the server boundary.
The `deep-modules` skill covers the module's entry files, its interface object and its tests.
Depth also keeps secrets here. The base URL, the token and the retry policy stay behind the interface object and never reach the browser.

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

The feature's query options call `$threads` and own the key, the `queryFn`, the unwrap and the mapping.
Anything else a screen needs (a refresh, a page size, a download href) is a member of the same slice.
The feature's own components import the slice through a relative path, and a `$` aggregator that re-exports it is for route loaders and other modules (`deep-modules`).
