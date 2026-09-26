---
name: bun
description: Use when writing or reviewing Bun code including runtime, bun test, Bun.serve, bundler, bun install, or scripts.
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
