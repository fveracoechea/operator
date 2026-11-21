# Own server configuration and state lifetimes

## Read server configuration inside an operation

Declare environment variables in validated files, `.server.ts` for server-only values and `.client.ts` for values the bundler may inline, and read `process.env` or `import.meta.env` nowhere else.
Validate them at startup, so a bad value fails the boot.

In a full-stack app, a module reads a server value inside the operation that needs it, never at load time:

```ts
/** `baseURL` per call: `ServerEnv` is read at call time, never at load time. */
function billingRequest(session: Session) {
  return {
    baseURL: ServerEnv.BILLING_BASE_URL,
    headers: {authorization: `Bearer ${session.token}`},
  }
}
```

A client-side test imports the route tree, and a top-level read of a server value throws before the test starts.
An expensive connection can be a lazy singleton, opened on the first call and closed by the application owner at shutdown.

## Keep durable shared state in its external owner

Prefer an existing database or KV for persistent or shared application state.
Examples include workflow progress, deduplication records and data that multiple server processes must agree on.
Use that store's transactions or atomic operations when concurrent callers must agree.
A process-local map cannot provide cross-process consistency or survive a restart.
Avoid adding a store when the application already has the required one.

## Bound necessary internal state by its lifetime

This applies on a server, full-stack or server-only.
A top-level variable is shared by every request in the process.
A visitor's state lives in the session, in the request's context, or in the request's query client.
Necessary request-local and transient state can stay inside the module.
A request owns its temporary buffers and abort controller, and releases resources when it ends.

A listener adapter can own a subscriber set, timers and connection status for its lifecycle.
Return an unsubscribe or dispose operation, and name the caller that invokes it.
Remove listeners, clear timers and close owned connections on disposal, including error and cancellation paths.
That lifecycle state does not replace durable shared application state.

In an SPA, the query cache holds server data and the URL holds what the URL owns.
A top-level store that copies either one is a second source of truth.
