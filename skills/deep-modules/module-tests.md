# Test a deep module

## Test the module through its interface

A test file sits beside the unit it covers and carries its name: `main.server.test.ts` beside `main.server.ts`.
The test calls the public constants or functions the way a caller does, including operations on an exported object.
Assert caller-observed results and effects.
Tests follow the chosen production architecture rather than imposing a factory or a new public method.
Change the interface when real callers need a missing use case.
Otherwise, exercise private logic through that use case or a focused beside-test, without exporting it solely for tests.

A module whose interface is `$functions.ts` is tested through its server functions.
Its own test uses a `createServerFn` stand-in that runs the validator and then the handler, so the test reaches the server code the RPC would run.

## Use function-level injection or fake a public collaborator

When an operation accepts a function dependency, pass a fake directly.
For the `reminderPreview` example in [module-shape.md](module-shape.md):

```ts
expect(await reminderPreview('absent', '2026-11-21', async () => undefined))
  .toEqual({status: 'missing'})
```

For imported collaborators, replace the public entry module at the same specifier production imports:

```ts
const cache = {get: mock(), set: mock()}

await mock.module('@/modules/cache/main.server', () => ({Cache: cache}))
await mock.module('@/env.server', () => ({ServerEnv: env}))
```

That is Bun's `mock.module`, and Vitest writes the same fake with `vi.mock`.
The module's own files run real in its tests.
When one of them wraps an outside dependency, fake that dependency's module, not the file that wraps it.
Mock no private implementation files.
Such mocks couple tests to file layout and break on refactors that change no behaviour.
For `sendReminder`, fake the public `InvoiceStore` and `Mailer` entries, then assert both the returned result and the mail.
Cover policy refusals too, such as a settled invoice that sends no mail.
Use the test runner's mock setup and import ordering, and restore fakes or isolate globals so tests cannot leak replacements.

## Stand in for `$functions` modules in a caller's test

This applies to a full-stack app on TanStack Start.
The test runner does not run the TanStack Start compiler, so an untransformed `createServerFn` has no transport.
The RPC boundary is the only seam, so a test of a route or another module fakes each `$functions.ts` module once, in the shared test setup, with a stand-in that speaks the real wire.
The existing HTTP fakes then keep working.

Give the stand-in one line per server function.
A suite that needs more overrides the module for that file.
The module's own tests, with the `createServerFn` stand-in above, cover what this stand-in leaves out, such as identity headers.
If the host enables `anti-slop/no-module-mocking`, scope its exception to these public-boundary tests and stand-ins.

## Test a UI member through the real route tree

This applies to an SPA or a full-stack module that has a UI.
A route's behaviour is the composition, so a test of `<Invoices.UI.OverdueList />` in its place mounts the real route tree and provider stack.
A full mount is slow, so a route test asserts what only the composition can break, and the module's own tests cover the rest.

## Drive a server module's routes through the real server

This applies to a server-only app.
A module test calls the public operation.
A route test starts the server on a free port, or calls its `fetch` handler with a real `Request`, and asserts the status and the body.
The route is a caller, so a route test fakes the module at its entry file and never reaches past it.
