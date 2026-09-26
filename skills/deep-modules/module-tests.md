# Test a deep module

## Test the module through its interface

A test file sits beside the unit it covers and carries its name: `main.server.test.ts` beside `main.server.ts`.
The test calls the interface object the way a route does, and asserts what the caller observes.
A module whose interface is `$functions.ts` is tested through its server functions, with a stand-in `createServerFn` that runs the validator and then the handler.
When a behaviour is hard to reach through the interface, the module has the wrong shape, so fix the interface and not the test.

## Fake another module at its entry file

A test replaces a collaborator module at the same specifier its callers import:

```ts
const cache = {get: mock(), set: mock()}

await mock.module('@/modules/cache/main.server', () => ({Cache: cache}))
await mock.module('@/env.server', () => ({ServerEnv: env}))
```

That is Bun's `mock.module`, and Vitest writes the same fake with `vi.mock`.
The module's own files run real in its tests.
When one of them wraps an outside dependency, fake that dependency's module, not the file that wraps it.
A fake at an internal file couples the test to the module's file layout, and the test breaks on a refactor that changes no behaviour.

## Stand in for server functions at the RPC boundary

This applies to a full-stack app on TanStack Start.
The test runner does not run the TanStack Start compiler, so an untransformed `createServerFn` has no transport.
The RPC boundary is the only seam, so fake each `$functions.ts` module once, in the shared test setup, with a stand-in that speaks the real wire.
The existing HTTP fakes then keep working.

Give the stand-in one line per server function.
A suite that needs more overrides the module for that file.
The module's own tests cover what the stand-in leaves out, such as identity headers.
A lint rule that bans module mocks stays on everywhere else, and is off for module tests and the stand-in only.

## Test a UI member through the real route tree

This applies to an SPA or a full-stack module that has a UI.
A route's behaviour is the composition, so a test of `<Invoices.UI.OverdueList />` in its place mounts the real route tree and provider stack.
A full mount is slow, so a route test asserts what only the composition can break, and the module's own tests cover the rest.

## Drive a server module's routes through the real server

This applies to a server-only app.
A module test calls the interface object.
A route test starts the server on a free port, or calls its `fetch` handler with a real `Request`, and asserts the status and the body.
The route is a caller, so a route test fakes the module at its entry file and never reaches past it.
