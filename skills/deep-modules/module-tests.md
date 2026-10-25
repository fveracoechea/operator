# Test a deep module

## Test the module through its interface

A test sits beside the unit it covers and carries its name, such as `main.test.ts` beside `main.ts`.
Call the interface the way its caller does and assert on its result or effects.
Private files with logic also need direct beside-tests that import the private file.
Only same-folder `stem.test.ts` and `stem.<scenario>.test.ts` cover `stem.ts` for mutation testing.
Interface tests cover `main.ts`, not every private unit in the module.
Functions in `lib/` follow the same beside-test rule.

For Operator workflows, the public CLI is the primary test boundary.
Use real Git and SQLite with isolated device roots.
Control external tools at their process or network interfaces.
A refusal test also proves that prohibited writes and external actions did not occur.

## Fake a public interface or external boundary

Use a function fake or a scoped spy on a collaborator's public interface method.
Restore spies after each test.
Use a controlled executable or local server when the collaborator is an external tool or service.
Keep the code under test real.

Operator enforces `anti-slop/no-module-mocking` in production and tests.
It has no exception for entry-file replacement or shared test setup.
Replacing imports by path couples a test to loading and file layout instead of the caller's contract.

## Test a UI member through the real route tree

This applies to an SPA or a full-stack module with a UI.
Mount the real route tree and provider stack for behavior that depends on their composition.
Use module tests for behavior that does not need that composition.

## Test server boundaries through their real transport

For a server-only app, start the server on a free port or call its `fetch` handler with a real `Request`.
Assert on the status, body, and prohibited effects after refusal.
For full-stack server functions, use the framework's supported test transport so validation and handlers run together.
Do not add a production factory solely to let a test replace static imports.
