# Enforcement over prose

- Determinism wins over documentation and context files. A lint rule or a CLI check steers an agent at the moment it breaks the rule, costs no context until it fires, and saves a turn.
- A rule stated only in a document or a context file is a suggestion. The agent can skip it, and it costs context on every run. Make it a lint rule, a ruleset, or a CI check, and delete it from the document.
- When drift recurs, write a lint rule, not a stronger ADR.
- A lint message ends with the skill topic that explains the fix, and a test checks that the topic covers it. A pointer that no test checks goes stale, and the agent reads a topic that does not explain the fix.
- A lint disable comment states its reason. Turn on the linter's own check for it, not a bespoke branch in a custom rule.
- An agent hook is a nudge that saves a turn. Enforcement lives in CI. A mis-wired hook fails open.
- Every adapter of one check, such as the CLI, the hook, and the plugin, gets a parity test that gives each adapter the same input and expects the same findings. Adapters drift on settings that only one of them reads.
- Review workflows read their tooling from the base ref, so a PR cannot choose the tooling that scores it.
- Pin third-party actions by commit SHA. A tag is a name its owner can move.
- Verify every guard against a deliberate break. A guard that cannot fail is vacuous.
