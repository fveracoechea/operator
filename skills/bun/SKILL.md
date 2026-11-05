---
name: bun
description: Use when writing or reviewing Bun code including runtime, bun test and its mocks, Bun.serve, bundler, bun install, or scripts.
---

# Bun's APIs move fast, pretraining may be stale

1. Fetch `https://bun.com/llms.txt`
2. Only read pages for APIs needed on the current tasks

## Bun-native first

Consider Nodejs APIs that run in Bun as a LEGACY compatibility layer. Reach for the Bun equivalent:

- HTTP, WebSockets, routing: `Bun.serve`
- Files, streams, stdio: `Bun.file`, `Bun.write`, `Bun.stdin`
- Postgres, SQLite, Redis: `Bun.sql`, `bun:sqlite`, `Bun.redis`
- Tests, mocks, snapshots: `bun:test`
- Subprocesses: `Bun.spawn`
- Hashing, passwords: `Bun.hash`, `Bun.password`
- Images, transcoding, compression: the Bun built-in named on the docs page
- Bundling, transpiling, standalone binaries: `Bun.build`, `bun build`

## Test with `bun test`

### Run each test file with `--isolate`

`--isolate` gives each file a fresh global, so a module mock or a global stub stays in the file that made it.
Without it, every file shares one global, and a leaked mock fails a later file that never made one.
Bun reads the flag on the command line only, so put it in the `test` script and run the suite through that script.

```json
"scripts": {"test": "bun test --isolate"}
```

Name no path root in the `test` script, since bun finds every test file on its own.
`bun test` runs a file that matches any path filter, so a root like `.` or `src` matches every file, and `bun run test <file>` no longer narrows the run to one file.

### Import the module dynamically after `mock.module`

`mock.module` runs in file order, after the static imports around it have evaluated.
The real module has already loaded and run its load-time code by then, and the mock only swaps the live bindings.
When the suite must never load the original, import the code under test dynamically, after the mock.

```ts
mock.module('./billing-client', () => ({charge: mock(async () => 'ok')}))

const {checkout} = await import('./checkout')
```

### Restate each default after `jest.resetAllMocks`

`jest.resetAllMocks` drops every implementation, the ones a `mock.module` factory set included.
A `beforeEach` that resets must set each default again.

```ts
beforeEach(() => {
  jest.resetAllMocks()
  charge.mockImplementation(async () => 'ok')
})
```

### Assert an `Intl` formatter's fields, never its joining text

Bun runs JavaScriptCore, which joins a short date and a time with "at", where V8 joins them with a comma.
A test that asserts the whole string passes in one engine and fails in the other.
Assert the locale and the parts.

```ts
const parts = new Intl.DateTimeFormat('en-US', OPTIONS).formatToParts(at)
expect(parts.find(part => part.type === 'hour')?.value).toBe('9')
```

### Wait for a removal with a helper, never with `expect` on a node

Inside `waitFor`, give `expect` a value that is not a DOM node.
When a check fails, Bun describes the received value for the message, and a node reaches the whole document graph behind it: one failed check has cost 4 s and 5.5 GB.
Wait for an element to leave with `waitForElementToBeRemoved`, or with a removal helper that polls a query and asserts on a boolean.

```ts
await waitForElementToBeRemoved(() => screen.queryByText('Saving'))
```

`waitForElementToBeRemoved` rejects an element that is already gone, so a helper serves the case where it may be.
