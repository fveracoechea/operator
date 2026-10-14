---
"@fveracoechea/operator": patch
---

The `bun` skill now has a `bun test` section from Jarvis.
It tells an agent to run each test file with `--isolate`, to name no path root in the `test` script, to import the code under test after `mock.module`, and to set each mock default again after `jest.resetAllMocks`.
It also tells an agent to assert the parts of an `Intl` format, and to wait for a removed element without `expect` on a DOM node.
