# Keep configuration and request state out of load time

## Read server configuration inside a method

Declare environment variables in validated files, `.server.ts` for server-only values and `.client.ts` for values the bundler may inline, and read `process.env` or `import.meta.env` nowhere else.
Validate them at startup, so a bad value fails the boot.

### Operator environment ownership

In Operator, use `Environment.read()` from `modules/environment/main.ts` for validated values.
The CLI reads the startup snapshot once.
Use `Environment.child(overrides)` for subprocess environments and `Environment.parse(values)` for supplied module inputs.
`operator/env-through-schema` rejects raw environment reads and writes outside that owner and its exact fake-tool exemptions in `.oxlintrc.json`.
Tests have no general exemption.
Supply isolated `HOME`, `XDG_CONFIG_HOME`, and `XDG_STATE_HOME` values to CLI children.
`OperatorHome.resolve()` owns Operator paths and refuses real default settings or state roots in test mode, including aliases and descendants.
The preload requires test mode, and tests do not change the parent environment.

In a full-stack app, a module reads a server value inside the method that needs it, never at load time:

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
A connection that is expensive to open is a lazy singleton, opened on the first call.

## Keep per-user state out of top-level variables

This applies on a server, full-stack or server-only.
A top-level variable is shared by every request in the process.
A visitor's state lives in the session, in the request's context, or in the request's query client.

In an SPA, the query cache holds server data and the URL holds what the URL owns.
A top-level store that copies either one is a second source of truth.
